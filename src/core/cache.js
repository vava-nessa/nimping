/**
 * @file cache.js
 * @description Persistent cache for ping results to speed up startup.
 *
 * 📖 Cache file location: <config-dir>/cache.json when a config dir is chosen
 * 📖   (--config-dir / FCM_CONFIG_DIR), else ~/.free-coding-models.cache.json.
 * 📖 File permissions: 0o600 (user read/write only — contains API timing data)
 *
 * 📖 Why caching matters:
 *    - Ping results don't change dramatically within 5 minutes
 *    - Repeated runs start instantly instead of waiting 10+ seconds
 *    - Fewer API rate limit hits for providers
 *
 * 📖 Cache structure:
 *   {
 *     "timestamp": 1712345678901,           // Last cache write time (ms since epoch)
 *     "models": {
 *       "nvidia/deepseek-ai/deepseek-v4-flash": {
 *         "avg": 245,
 *         "p95": 312,
 *         "jitter": 45,
 *         "stability": 87,
 *         "uptime": 95.5,
 *         "verdict": "Perfect",
 *         "status": "up",
 *         "httpCode": "200",
 *         "pings": [
 *           { "ms": 230, "code": "200" },
 *           { "ms": 260, "code": "200" }
 *         ]
 *       }
 *     },
 *     "providerTier": "normal"              // Ping cadence: "fast" | "normal" | "slow"
 *   }
 *
 * 📖 Cache TTL (time-to-live):
 *    - 5 minutes (300,000ms) for normal operations
 *    - Stale cache is ignored and models are re-pinged
 *
 * @functions
 *   → getCachePath() — Returns the cache file path
 *   → loadCache() — Reads cache from disk, returns null if missing/stale
 *   → saveCache(results, providerTier) — Writes current results to cache
 *   → clearCache() — Deletes cache file (useful for testing)
 *   → isCacheFresh(cache) — Checks if cache is within TTL
 *
 * @exports getCachePath, loadCache, saveCache, clearCache, isCacheFresh
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { getConfigDir } from './config.js'

// 📖 Cache TTL: 5 minutes in milliseconds
// 📖 Ping results are considered fresh for this duration
const CACHE_TTL = 5 * 60 * 1000

// 📖 Get cache file path — follows the chosen config dir (--config-dir /
// 📖 FCM_CONFIG_DIR) so the cache lands next to config.json + backups/;
// 📖 falls back to the classic ~/.free-coding-models.cache.json otherwise.
export function getCachePath() {
  const configDir = getConfigDir()
  if (configDir) return path.join(configDir, 'cache.json')
  const homeDir = os.homedir()
  return path.join(homeDir, '.free-coding-models.cache.json')
}

// 📖 Load cache from disk if it exists and is valid JSON
// 📖 Returns null if file doesn't exist, is invalid JSON, or is stale
export function loadCache() {
  const cachePath = getCachePath()

  try {
    if (!fs.existsSync(cachePath)) {
      return null
    }

    const raw = fs.readFileSync(cachePath, 'utf-8')
    const cache = JSON.parse(raw)

    // 📖 Validate cache structure — must have timestamp and models object
    if (!cache || typeof cache !== 'object' || !cache.timestamp || !cache.models) {
      return null
    }

    // 📖 Check if cache is stale (older than TTL)
    if (!isCacheFresh(cache)) {
      return null
    }

    return cache
  } catch (err) {
    // 📖 Silently fail on parse errors — cache is optional
    return null
  }
}

// 📖 Save current ping results to cache
// 📖 results: Array of model result objects from the TUI
// 📖 providerTier: Current ping cadence ("fast" | "normal" | "slow")
export function saveCache(results, providerTier = 'normal') {
  const cachePath = getCachePath()
  // 📖 Ensure parent dir exists (XDG first-run would otherwise ENOENT when cache lives in --config-dir)
  try {
    const parentDir = path.dirname(cachePath)
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { mode: 0o700, recursive: true })
  } catch { /* best-effort */ }

  try {
    const models = {}

    // 📖 Extract relevant data from each result object
    for (const result of results) {
      if (!result.modelId) continue

      models[result.modelId] = {
        avg: result.avg,
        p95: result.p95,
        jitter: result.jitter,
        stability: result.stability,
        uptime: result.uptime,
        verdict: result.verdict,
        status: result.status,
        httpCode: result.httpCode,
        // 📖 Only save last 20 pings to keep cache file small
        pings: (result.pings || []).slice(-20)
      }
    }

    const cache = {
      timestamp: Date.now(),
      models,
      providerTier
    }

    // 📖 Write with secure permissions (user read/write only).
    // 📖 chmod also tightens pre-existing files created before the mode option was added.
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), { mode: 0o600 })
    fs.chmodSync(cachePath, 0o600)
  } catch (err) {
    // 📖 Silently fail on write errors — caching is optional
  }
}

// 📖 Check if cache is within TTL (fresh) or expired (stale)
export function isCacheFresh(cache) {
  if (!cache || typeof cache.timestamp !== 'number') return false

  const age = Date.now() - cache.timestamp
  return age < CACHE_TTL
}

// 📖 Clear cache file — useful for testing or forcing fresh pings
export function clearCache() {
  const cachePath = getCachePath()

  try {
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath)
    }
  } catch (err) {
    // 📖 Silently fail — cache is optional
  }
}

// 📖 Get cache age in human-readable format (for debugging)
export function getCacheAge(cache) {
  if (!cache || typeof cache.timestamp !== 'number') return null

  const ageMs = Date.now() - cache.timestamp
  const ageSec = Math.floor(ageMs / 1000)

  if (ageSec < 60) return `${ageSec}s`
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m`
  return `${Math.floor(ageSec / 3600)}h`
}

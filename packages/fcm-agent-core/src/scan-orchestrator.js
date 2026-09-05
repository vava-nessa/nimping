/**
 * @file scan-orchestrator.js
 * @description Main scan/rank orchestrator (daemon-first, direct fallback) — shared core.
 *
 * @details
 *   Single public entry for "give me the best free coding models right now".
 *   Tries the local FCM daemon for pre-computed stats (~1s), then falls back to
 *   a direct parallel scan. Emits structured progress events (no rendering) so
 *   each adapter can present the scan its own way. Returns a normalized result
 *   with ranked models + diagnostics.
 *
 * @functions
 *   - scanBestFcmModel → Scan + rank, daemon-first with direct fallback
 *   - runFcmScan → Alias of scanBestFcmModel (back-compat for older adapters)
 */

import { queryDaemon } from './daemon-client.js'
import { directScan } from './direct-scanner.js'
import { rankModels } from './ranker.js'
import { isContextUsable, MIN_CONTEXT_WINDOW } from './model-config.js'
import { getKeyForProvider } from './api-keys.js'
// 📖 Relative import into the repo root (see direct-scanner.js): the package
// 📖 is only consumed in-repo via file: dependency, never from npm.
import { sources } from '../../../sources.js'

/**
 * 📖 Map a daemon model payload to the shared ScannedModel shape.
 *
 * @param {object} m - Daemon model entry
 * @returns {object} Normalized scanned model
 */
function mapDaemonModel(m) {
  const providerKey = m.providerKey
  const sourceUrl = sources[providerKey]?.url || ''
  const apiKey = getKeyForProvider(providerKey)

  // 📖 Map daemon status values ('up', 'down', 'pending')
  let status = m.status
  if (status === 'pending') status = 'down'

  return {
    modelId: m.modelId,
    label: m.label,
    tier: m.tier,
    sweScore: m.sweScore,
    ctxWindow: m.ctx,
    providerKey,
    providerName: m.origin || providerKey,
    providerUrl: sourceUrl,
    apiKey,
    status,
    latencyMs: typeof m.avg === 'number' ? m.avg : null,
    tps: m.benchmark?.tokensPerSecond || null,
    totalBenchMs: m.benchmark?.totalMs || null,
    stabilityScore: typeof m.stability === 'number' ? Math.round(m.stability * 100) : 100,
    hasKey: m.hasApiKey
  }
}

/**
 * 📖 Scan and rank available free coding models.
 *
 * @param {object} [options={}]
 * @param {'auto'|'daemon'|'direct'} [options.mode='auto'] - Scan strategy.
 *   `daemon` at host startup so direct probes never block boot; `direct` to
 *   bypass the daemon; `auto` = daemon-first with direct fallback.
 * @param {'pi'|'opencode'|'agent'} [options.target='agent'] - Host target (diagnostics only)
 * @param {function} [options.onProgress] - `(event) => void` structured progress
 * @param {function} [options.onNotify] - `(message, type) => void` transient notices
 * @param {AbortSignal} [options.signal] - Abort signal for the direct scan
 * @param {number} [options.minContextWindow=MIN_CONTEXT_WINDOW] - Context-safety floor
 * @param {number} [options.maxDirectCandidates=60] - Direct-scan ping cap (increased from 30)
 * @param {number} [options.maxBenchmarkCandidates=8] - Direct-scan benchmark cap (increased from 5)
 * @returns {Promise<object>} `{ source, scannedAt, ranked, bestModel, diagnostics }`
 */
export async function scanBestFcmModel(options = {}) {
  const mode = options.mode || 'auto'
  const target = options.target || 'agent'
  const minContextWindow = options.minContextWindow ?? MIN_CONTEXT_WINDOW
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const onNotify = typeof options.onNotify === 'function' ? options.onNotify : () => {}

  const rank = (models) => rankModels(models.filter((m) => isContextUsable(m, minContextWindow)))

  // ── Daemon path ──────────────────────────────────────────────────────────
  if (mode !== 'direct') {
    onProgress({ phase: 'daemon-check', message: '🔍 Checking FCM daemon...' })

    let daemonAvailable = false
    try {
      const daemonData = await queryDaemon()
      daemonAvailable = !!(daemonData && Array.isArray(daemonData.models))

      if (daemonAvailable) {
        onProgress({ phase: 'daemon-check', message: '📡 Mapping daemon models...' })
        const mapped = daemonData.models.map(mapDaemonModel)
        const ranked = rank(mapped)
        return {
          source: 'daemon',
          scannedAt: new Date().toISOString(),
          ranked,
          bestModel: ranked[0] || null,
          diagnostics: {
            target,
            daemonAvailable: true,
            candidateCount: mapped.length,
            rankedCount: ranked.length
          }
        }
      }
    } catch (err) {
      onNotify(`Daemon query failed: ${err.message}`, 'warning')
      if (mode === 'daemon') {
        return {
          source: 'daemon',
          scannedAt: new Date().toISOString(),
          ranked: [],
          bestModel: null,
          diagnostics: { target, daemonAvailable, error: err.message }
        }
      }
    }

    // 📖 mode === 'daemon' but daemon was unavailable and not erroring
    if (mode === 'daemon') {
      return {
        source: 'daemon',
        scannedAt: new Date().toISOString(),
        ranked: [],
        bestModel: null,
        diagnostics: { target, daemonAvailable }
      }
    }
  }

  // ── Direct fallback ──────────────────────────────────────────────────────
  onProgress({ phase: 'daemon-check', message: '🔌 Direct scan starting...' })

  const results = await directScan({
    onProgress,
    signal: options.signal,
    maxCandidates: options.maxDirectCandidates ?? 60,
    maxBenchmarkCandidates: options.maxBenchmarkCandidates ?? 8
  })

  const ranked = rank(results)
  return {
    source: 'direct',
    scannedAt: new Date().toISOString(),
    ranked,
    bestModel: ranked[0] || null,
    diagnostics: {
      target,
      daemonAvailable: false,
      candidateCount: results.length,
      rankedCount: ranked.length
    }
  }
}

/**
 * 📖 Back-compat alias. Older adapters imported `runFcmScan`; keep it working.
 */
export const runFcmScan = scanBestFcmModel

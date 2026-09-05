/**
 * @file probe-cache.js
 * @description Persistent cache for health-probe results, shared across CLI, daemon, and Tauri.
 *
 * @details
 *   📖 Why this exists:
 *   📖 - Today every `pnpm start` re-pings all ~238 models from scratch (10-30s cold start).
 *   📖 - A model returning `ok` < 24h ago is almost certainly still healthy — skip the ping.
 *   📖 - A model returning `broken` should always be re-probed (allows recovery detection)
 *   📖   AND hidden from the default view until it recovers.
 *
 *   📖 Freshness rules (in order):
 *   📖   1. No entry              → due for probe
 *   📖   2. probeVersion mismatch  → due for probe (silently re-probed, entry overwritten)
 *   📖   3. status === 'broken'    → only due AFTER `brokenCooldownMs(consecutiveFailures)`
 *   📖                            ✅ (issue #146: was always-due → caused quota burn on
 *   📖                            rate-limited providers like openrouter)
 *   📖   4. now - lastProbedAt >= ttlMs → due for probe
 *   📖   5. otherwise              → fresh, skip
 *
 *   📖 File location:
 *   📖   - $XDG_CACHE_HOME/free-coding-models/probe-cache.json if XDG_CACHE_HOME is set
 *   📖   - ~/.free-coding-models/probe-cache.json otherwise
 *
 *   📖 All surface modes (CLI TUI, Web Dashboard / daemon, Tauri Desktop) read/write the
 *   📖 same file. Concurrency between daemon and CLI is handled via read-merge-write on
 *   📖 every flush (see flushCache) plus the atomic tmp + rename helper from shared-helpers.
 *
 * @functions
 *   → getProbeCachePath()                       — Resolves the cache file path
 *   → loadCache({ path, now }?)                  — Reads + migrates the JSON file
 *   → flushCache({ path, cache, now }?)          — Atomic write of the cache
 *   → clearCache({ path }?)                      — Nukes the file (for --reprobe)
 *   → getModelsDueForProbe(providerKey, modelIds, opts?) → string[] of IDs needing ping
 *   → isCacheFresh(providerKey, modelId, opts?) → boolean freshness check
 *   → recordProbeResults(providerKey, results, opts?) → mutates in-memory cache
 *   → getCacheStats(opts?) → { total, ok, broken, freshCount, staleCount, ... }
 *   → getCachedResultsForProvider(providerKey, opts?) → array of synthesized results
 *   → brokenCooldownMs(failureCount)            — Backoff ladder for broken models (issue #146)
 *
 * @exports getProbeCachePath, loadCache, flushCache, clearCache,
 *          getModelsDueForProbe, isCacheFresh, recordProbeResults,
 *          getCacheStats, getCachedResultsForProvider,
 *          DEFAULT_PROBE_TTL_MS, BROKEN_COOLDOWN_STEPS_MS,
 *          brokenCooldownMs, CURRENT_PROBE_VERSION
 *
 * @see src/core/ping-loop.js — the integration point (skips fresh entries)
 * @see src/core/cache.js     — older per-session ping cache (5 min TTL, distinct concern)
 * @see src/core/shared-helpers.js — atomicWriteJson (used by flushCache)
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWriteJson } from './shared-helpers.js'

// ─── Constants ────────────────────────────────────────────────────────────────

/** 📖 Default probe-result freshness window — 24h. Override via opts.ttlMs. */
export const DEFAULT_PROBE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 📖 Cooldown ladder for broken models (issue #146). After a consecutive failure,
 * 📖 the model is treated as fresh for the duration returned by `brokenCooldownMs()`,
 * 📖 so the ping loop skips it instead of hammering it every 2–30s.
 * 📖 The ladder grows exponentially then plateaus: 30s → 1m → 2m → 5m.
 * 📖 Reaching the plateau (5min) caps the probe pressure on a permanently-broken
 * 📖 model at ~0.2 req/min instead of the previous ~30 req/min.
 */
export const BROKEN_COOLDOWN_STEPS_MS = [30_000, 60_000, 120_000, 300_000]

/**
 * 📖 brokenCooldownMs: Cooldown duration for a model that has failed N consecutive times.
 * 📖 Failure count is 1-indexed (1 = first failure, 2 = second, ...).
 * 📖 Saturates at the last entry of BROKEN_COOLDOWN_STEPS_MS.
 *
 * @param {number} failureCount
 * @returns {number} milliseconds (always >= 0)
 */
export function brokenCooldownMs(failureCount) {
  const n = Math.max(1, Math.floor(Number(failureCount) || 1))
  const idx = Math.min(n - 1, BROKEN_COOLDOWN_STEPS_MS.length - 1)
  return BROKEN_COOLDOWN_STEPS_MS[idx]
}

/**
 * 📖 Bump this number whenever ping behaviour changes (new endpoint, different prompt,
 * 📖 new provider factory from t7, etc.). On load, any entry whose probeVersion differs
 * 📖 is treated as due-for-probe and silently overwritten — no manual purge needed.
 */
export const CURRENT_PROBE_VERSION = 2

/** 📖 Cache file basename. Lives in a directory alongside other FCM state files. */
const CACHE_FILENAME = 'probe-cache.json'
const CACHE_DIRNAME = 'free-coding-models'

// ─── Module-level state ──────────────────────────────────────────────────────

/**
 * 📖 In-memory mirror of the on-disk cache. Loaded lazily on first call to
 * 📖 any function that needs it (loadCache / getModelsDueForProbe / etc.).
 * 📖 Mutations via recordProbeResults() update this object; flushCache() writes it.
 */
let _cache = null
let _cacheLoadedFrom = null  // path we last loaded from (for write-back)

/**
 * 📖 Composite `provider::model` keys pruned this session. flushCache() re-reads
 * 📖 the disk file before writing, and the read-merge-write pass would otherwise
 * 📖 resurrect exactly the entries pruneStaleEntries() just deleted (the disk file
 * 📖 still contains them until our write lands).
 */
const _sessionPrunedKeys = new Set()

// ─── Path resolution ──────────────────────────────────────────────────────────

/**
 * 📖 Resolves where the probe-cache JSON lives.
 * 📖 Honours XDG_CACHE_HOME when set (Linux/macOS convention), else falls back to ~/.free-coding-models.
 *
 * @returns {string} Absolute path to the cache file (may not exist yet).
 */
export function getProbeCachePath() {
  const xdg = process.env.XDG_CACHE_HOME
  const baseDir = xdg && xdg.trim()
    ? path.join(xdg, CACHE_DIRNAME)
    : path.join(os.homedir(), `.${CACHE_DIRNAME}`)
  return path.join(baseDir, CACHE_FILENAME)
}

// ─── Low-level load / flush / clear ───────────────────────────────────────────

/**
 * 📖 Empty cache shape — used as the default when no file exists or it cannot be parsed.
 * @returns {{ version: number, providers: Record<string, { models: Record<string, ProbeEntry> }> }}
 */
function emptyCache() {
  return { version: CURRENT_PROBE_VERSION, providers: {} }
}

/**
 * 📖 Read the cache JSON from disk. Returns an empty cache on any I/O or parse error.
 * 📖 Also normalises older versions by setting version = CURRENT_PROBE_VERSION so the
 * 📖 freshness check picks them up as due (the per-entry probeVersion mismatch handles it).
 *
 * @param {object} [opts]
 * @param {string} [opts.path]   — Override the cache file path (mainly for tests).
 * @returns {object} The loaded cache object.
 */
export function loadCache({ path: cachePath } = {}) {
  const target = cachePath ?? getProbeCachePath()

  let raw
  try {
    raw = fs.readFileSync(target, 'utf-8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyCache()
    // 📖 Any other read error — start fresh rather than crash.
    return emptyCache()
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 📖 Corrupt JSON — start fresh (atomic write means we should never see this,
    // 📖 but if the file is hand-edited or partially written by an older buggy version
    // 📖 we recover gracefully).
    return emptyCache()
  }

  // 📖 Structural validation — missing fields get filled with defaults.
  if (!parsed || typeof parsed !== 'object') return emptyCache()
  if (typeof parsed.version !== 'number') parsed.version = CURRENT_PROBE_VERSION
  if (!parsed.providers || typeof parsed.providers !== 'object') parsed.providers = {}
  for (const provider of Object.values(parsed.providers)) {
    if (!provider || typeof provider !== 'object') continue
    if (!provider.models || typeof provider.models !== 'object') provider.models = {}
  }

  _cache = parsed
  _cacheLoadedFrom = target
  return parsed
}

/**
 * 📖 Merge two cache objects: incoming wins on key collision, but absent fields
 * 📖 from incoming do NOT delete fields from base. Used by flushCache to merge
 * 📖 our in-memory mirror with whatever the on-disk file now contains (covers
 * 📖 the daemon + CLI running concurrently case).
 *
 * 📖 `excludeKeys` (optional Set of `provider::model`) drops matching base
 * 📖 entries: keys pruned this session must stay pruned instead of coming back
 * 📖 from the stale disk snapshot.
 */
function mergeCache(base, incoming, excludeKeys = null) {
  if (!base || typeof base !== 'object') return incoming
  if (!incoming || typeof incoming !== 'object') return base
  const out = { ...incoming, providers: { ...(incoming.providers || {}) } }
  for (const [providerKey, providerBucket] of Object.entries(base.providers || {})) {
    const incomingBucket = out.providers[providerKey] || { models: {} }
    const mergedModels = { ...(providerBucket?.models || {}), ...(incomingBucket.models || {}) }
    if (excludeKeys && excludeKeys.size > 0) {
      for (const modelId of Object.keys(mergedModels)) {
        if (excludeKeys.has(`${providerKey}::${modelId}`)) delete mergedModels[modelId]
      }
    }
    out.providers[providerKey] = { models: mergedModels }
  }
  return out
}

/**
 * 📖 Persist the in-memory cache to disk atomically (tmp + rename) with a
 * 📖 read-merge-write pass so concurrent daemons and CLIs don't clobber each
 * 📖 other. Worst case: one batch of deltas is merged twice (idempotent), or
 * 📖 a stale `lastProbedAt` survives briefly (acceptable per t1 risk register).
 *
 * @param {object} [opts]
 * @param {string} [opts.path]  — Override the cache file path.
 * @param {object} [opts.cache] — Override the in-memory cache (defaults to module state).
 * @returns {boolean} true on success, false on any I/O error.
 */
export function flushCache({ path: cachePath, cache } = {}) {
  const target = cachePath ?? _cacheLoadedFrom ?? getProbeCachePath()
  const localData = cache ?? _cache ?? emptyCache()

  // 📖 Read whatever is on disk RIGHT NOW (may have been written by another process
  // 📖 since we last loaded), and merge our deltas over the top.
  let onDisk = null
  try {
    const raw = fs.readFileSync(target, 'utf-8')
    onDisk = JSON.parse(raw)
    if (!onDisk || typeof onDisk !== 'object') onDisk = null
  } catch {
    onDisk = null
  }

  const merged = onDisk ? mergeCache(onDisk, localData, _sessionPrunedKeys) : localData

  try {
    atomicWriteJson(target, merged, 0o600)
    _cacheLoadedFrom = target
    _cache = merged
    // 📖 Deletions are now persisted: clear the set so entries re-added later by
    // 📖 another process (e.g. the model returned to the catalog) still merge in.
    _sessionPrunedKeys.clear()
    return true
  } catch {
    return false
  }
}

/**
 * 📖 Delete the cache file from disk. Used by `--reprobe` / `--no-cache` flags.
 * 📖 Also clears the in-memory mirror so the next call reloads from scratch.
 *
 * @param {object} [opts]
 * @param {string} [opts.path] — Override the cache file path.
 * @returns {boolean} true if the file was deleted (or didn't exist), false on error.
 */
export function clearCache({ path: cachePath } = {}) {
  const target = cachePath ?? getProbeCachePath()
  _cache = null
  _cacheLoadedFrom = null
  // 📖 The file is gone, so tracked deletions have nothing left to override.
  _sessionPrunedKeys.clear()
  try {
    fs.unlinkSync(target)
    return true
  } catch (err) {
    if (err && err.code === 'ENOENT') return true
    return false
  }
}

// ─── Module-state accessor ───────────────────────────────────────────────────

/**
 * 📖 Get the current in-memory cache, loading from disk if not yet loaded.
 * 📖 Pure-isolated: callers can pass `opts.cache` to avoid touching module state
 * 📖 (used by all freshness / stats functions for testability).
 */
function getCache(opts) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'cache')) return opts.cache
  if (_cache) return _cache
  return loadCache()
}

// ─── Freshness rules ─────────────────────────────────────────────────────────

/**
 * 📖 Decide which model IDs are due for a (re-)probe, given the current cache.
 * 📖 See file header for the 5 rules.
 *
 * @param {string} providerKey
 * @param {string[]} modelIds
 * @param {object} [opts]
 * @param {number} [opts.ttlMs=86400000]
 * @param {number} [opts.now=Date.now()]
 * @param {object} [opts.cache]            — Injected cache (skips module state + disk)
 * @param {number} [opts.probeVersion=2]
 * @returns {string[]} Subset of `modelIds` that need probing this cycle.
 */
export function getModelsDueForProbe(providerKey, modelIds, opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_PROBE_TTL_MS
  const now = opts.now ?? Date.now()
  const probeVersion = opts.probeVersion ?? CURRENT_PROBE_VERSION
  const cache = getCache(opts)
  const providerBucket = cache?.providers?.[providerKey]
  const models = providerBucket?.models ?? {}

  const due = []
  for (const id of modelIds) {
    const entry = models[id]
    // Rule 1: no entry → due
    if (!entry) { due.push(id); continue }
    // Rule 2: version mismatch → due (silently overwritten on next record)
    if (typeof entry.probeVersion !== 'number' || entry.probeVersion !== probeVersion) {
      due.push(id); continue
    }
    // Rule 3: broken → due only AFTER brokenCooldownMs elapsed (issue #146)
    // 📖 Previous behaviour re-pinged broken models every cycle, which burned
    // 📖 rate-limited providers' quota (openrouter: ~1000 req/day cap).
    // 📖 Now we honour an exponential backoff: 30s → 1m → 2m → 5m (plateau).
    if (entry.status === 'broken') {
      const cooldown = brokenCooldownMs(entry.consecutiveFailures ?? 1)
      if (now - entry.lastProbedAt < cooldown) continue
      due.push(id)
      continue
    }
    // Rule 4: TTL expired → due
    if (typeof entry.lastProbedAt !== 'number' || now - entry.lastProbedAt >= ttlMs) {
      due.push(id); continue
    }
    // Rule 5: fresh + ok → skip
  }
  return due
}

/**
 * 📖 Single-model freshness check. Returns true only when ALL conditions hold:
 * 📖   - entry exists
 * 📖   - probeVersion matches CURRENT_PROBE_VERSION
 * 📖   - status !== 'broken'
 * 📖   - now - lastProbedAt < ttlMs
 *
 * @param {string} providerKey
 * @param {string} modelId
 * @param {object} [opts]
 * @returns {boolean}
 */
export function isCacheFresh(providerKey, modelId, opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_PROBE_TTL_MS
  const now = opts.now ?? Date.now()
  const probeVersion = opts.probeVersion ?? CURRENT_PROBE_VERSION
  const cache = getCache(opts)
  const entry = cache?.providers?.[providerKey]?.models?.[modelId]
  if (!entry) return false
  if (typeof entry.probeVersion !== 'number' || entry.probeVersion !== probeVersion) return false
  if (entry.status === 'broken') {
    // 📖 Issue #146 — broken models are now FRESH for `brokenCooldownMs` after their
    // 📖 last failure, instead of always being due. This caps the probe pressure
    // 📖 on permanently-broken models at ~0.2 req/min instead of ~30 req/min.
    const cooldown = brokenCooldownMs(entry.consecutiveFailures ?? 1)
    return now - entry.lastProbedAt < cooldown
  }
  if (typeof entry.lastProbedAt !== 'number') return false
  return now - entry.lastProbedAt < ttlMs
}

// ─── Write path ───────────────────────────────────────────────────────────────

/**
 * 📖 Validate + normalise a single probe result into the on-disk shape.
 * 📖 Throws on garbage input — callers should catch and drop.
 */
function normaliseResult(r) {
  if (!r || typeof r !== 'object') throw new Error('probe result must be an object')
  if (typeof r.modelId !== 'string' || !r.modelId) throw new Error('modelId required')
  if (r.status !== 'ok' && r.status !== 'broken') throw new Error(`status must be 'ok' or 'broken'`)
  return {
    modelId: r.modelId,
    status: r.status,
    latencyMs: typeof r.latencyMs === 'number' && Number.isFinite(r.latencyMs) ? r.latencyMs : null,
    lastError: typeof r.lastError === 'string' ? r.lastError : null,
  }
}

/**
 * 📖 Persist a batch of probe results into the in-memory cache (and schedule a flush).
 * 📖 Per-result validation: bad entries are dropped, good ones are written.
 * 📖 The module-level cache is mutated in place; flushCache() is a separate call.
 *
 * @param {string} providerKey
 * @param {Array<{ modelId: string, status: 'ok'|'broken', latencyMs?: number, lastError?: string }>} results
 * @param {object} [opts]
 * @param {number} [opts.now=Date.now()]
 * @param {object} [opts.cache] — Optional explicit cache to mutate (skips module state).
 * @returns {{ written: number, dropped: number }} Counts for telemetry.
 */
export function recordProbeResults(providerKey, results, opts = {}) {
  const now = opts.now ?? Date.now()
  const cache = (opts && Object.prototype.hasOwnProperty.call(opts, 'cache')) ? opts.cache : getCache(opts)

  if (!cache.providers[providerKey]) {
    cache.providers[providerKey] = { models: {} }
  }
  const bucket = cache.providers[providerKey].models

  let written = 0
  let dropped = 0
  for (const raw of results || []) {
    try {
      const r = normaliseResult(raw)
      // 📖 Consecutive failure tracker (issue #146): drives the broken-cooldown ladder.
      // 📖 `ok` resets to 0; `broken` increments from the previous value (or 1 if absent).
      const prev = bucket[r.modelId]
      const consecutiveFailures = r.status === 'broken'
        ? ((prev && Number.isInteger(prev.consecutiveFailures)) ? prev.consecutiveFailures + 1 : 1)
        : 0
      bucket[r.modelId] = {
        status: r.status,
        lastProbedAt: now,
        latencyMs: r.latencyMs,
        lastError: r.lastError,
        probeVersion: CURRENT_PROBE_VERSION,
        consecutiveFailures,
      }
      // 📖 A live re-probe of a pruned model means it is catalogued again: stop
      // 📖 excluding it from disk merges.
      if (!opts || !Object.prototype.hasOwnProperty.call(opts, 'cache')) {
        _sessionPrunedKeys.delete(`${providerKey}::${r.modelId}`)
      }
      written++
    } catch {
      dropped++
    }
  }

  // 📖 Mark cache as dirty if we're touching module state. flushCache() picks it up later.
  if (!opts || !Object.prototype.hasOwnProperty.call(opts, 'cache')) {
    _cache = cache
  }

  return { written, dropped }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

/**
 * 📖 Aggregate stats over the current cache, useful for the TUI footer chip and
 * 📖 the daemon's /health endpoint.
 *
 * @param {object} [opts]
 * @param {number} [opts.ttlMs=86400000]
 * @param {number} [opts.now=Date.now()]
 * @param {object} [opts.cache]
 * @returns {{
 *   total: number,
 *   ok: number,
 *   broken: number,
 *   freshCount: number,   // ok + within TTL
 *   staleCount: number,   // ok but past TTL (would be due for probe under rules 1/4)
 *   dueCount: number,     // models that would be re-probed right now (broken + stale)
 *   hiddenCount: number,  // == broken
 *   providers: number,
 * }}
 */
export function getCacheStats(opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_PROBE_TTL_MS
  const now = opts.now ?? Date.now()
  const cache = getCache(opts)
  const probeVersion = opts.probeVersion ?? CURRENT_PROBE_VERSION

  let total = 0, ok = 0, broken = 0, freshCount = 0, staleCount = 0
  for (const providerBucket of Object.values(cache.providers ?? {})) {
    for (const entry of Object.values(providerBucket?.models ?? {})) {
      if (!entry) continue
      total++
      const isFresh = entry.status === 'ok'
        && typeof entry.probeVersion === 'number'
        && entry.probeVersion === probeVersion
        && typeof entry.lastProbedAt === 'number'
        && now - entry.lastProbedAt < ttlMs
      if (entry.status === 'ok') ok++
      else if (entry.status === 'broken') broken++
      if (isFresh) freshCount++
      else if (entry.status === 'ok') staleCount++
    }
  }

  return {
    total,
    ok,
    broken,
    freshCount,
    staleCount,
    dueCount: broken + staleCount,
    hiddenCount: broken,
    providers: Object.keys(cache.providers ?? {}).length,
  }
}

// ─── Synthesised results for the TUI ──────────────────────────────────────────

/**
 * 📖 Convert a provider's cache entries into the shape ping-loop emits so the TUI
 * 📖 can render them instantly on warm start. Only returns FRESH entries (rule 5);
 * 📖 broken/stale entries are intentionally excluded so the live ping will refresh them.
 *
 * 📖 Returned shape mirrors what `src/core/ping.js` builds for a successful ping,
 * 📖 so the downstream renderer / ranker don't need to know whether data is cached
 * 📖 or live. Minimum fields used by `render-table.js`:
 * 📖   modelId, providerKey, status ('up'|'down'), avg, p95, jitter, stability,
 * 📖   uptime, verdict, lastProbedAt, source ('cache'|'live')
 *
 * @param {string} providerKey
 * @param {object} [opts]
 * @param {number} [opts.ttlMs=86400000]
 * @param {number} [opts.now=Date.now()]
 * @param {object} [opts.cache]
 * @returns {Array<object>} Synthesised result objects (empty array if no fresh entries).
 */
export function getCachedResultsForProvider(providerKey, opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_PROBE_TTL_MS
  const now = opts.now ?? Date.now()
  const cache = getCache(opts)
  const probeVersion = opts.probeVersion ?? CURRENT_PROBE_VERSION
  const bucket = cache?.providers?.[providerKey]?.models ?? {}

  const out = []
  for (const [modelId, entry] of Object.entries(bucket)) {
    if (!entry || entry.status !== 'ok') continue
    if (typeof entry.probeVersion !== 'number' || entry.probeVersion !== probeVersion) continue
    if (typeof entry.lastProbedAt !== 'number') continue
    if (now - entry.lastProbedAt >= ttlMs) continue

    const latency = typeof entry.latencyMs === 'number' ? entry.latencyMs : 0
    out.push({
      modelId,
      providerKey,
      status: 'up',
      avg: latency,
      p95: latency,
      jitter: 0,
      stability: 100,
      uptime: 100,
      verdict: 'Cached',
      httpCode: '200',
      lastProbedAt: entry.lastProbedAt,
      source: 'cache',
      latencyMs: latency,
    })
  }
  return out
}

// ─── Pruning ──────────────────────────────────────────────────────────────────

/**
 * 📖 Drop entries whose modelId is no longer present in the live catalog.
 * 📖 Called once per boot from ping-loop to keep the cache file bounded as the
 * 📖 catalog evolves (providers add/remove models over time).
 *
 * @param {string} providerKey
 * @param {Set<string> | string[]} liveModelIds
 * @param {object} [opts]
 * @param {object} [opts.cache]
 * @returns {number} Number of entries pruned.
 */
export function pruneStaleEntries(providerKey, liveModelIds, opts = {}) {
  const cache = getCache(opts)
  const bucket = cache?.providers?.[providerKey]?.models
  if (!bucket) return 0

  const live = liveModelIds instanceof Set ? liveModelIds : new Set(liveModelIds)
  let pruned = 0
  for (const id of Object.keys(bucket)) {
    if (!live.has(id)) {
      delete bucket[id]
      // 📖 Remember the deletion so flushCache's read-merge-write does not
      // 📖 resurrect this entry from the still-stale disk file.
      if (!opts || !Object.prototype.hasOwnProperty.call(opts, 'cache')) {
        _sessionPrunedKeys.add(`${providerKey}::${id}`)
      }
      pruned++
    }
  }

  if (!opts || !Object.prototype.hasOwnProperty.call(opts, 'cache')) {
    _cache = cache
  }
  return pruned
}
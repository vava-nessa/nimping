/**
 * @file runtime-telemetry.js
 * @description Per-model runtime metrics captured by the daemon on every routed request.
 *
 * @details
 *   📖 Why this exists:
 *   📖 SWE-bench / tier scores are static and self-reported by providers — a model
 *   📖 can advertise 82% on SWE-bench and still fail 50% of real requests through a
 *   📖 flaky free-tier gateway. We track what *actually* happens on the wire:
 *   📖 - real success rate (success vs error calls)
 *   📖 - real avg tokens/second (throughput under our real traffic)
 *   📖 - recent calls (last 50, capped) for debugging
 *
 *   📖 Distinct from src/core/telemetry.js (which is product analytics sent
 *   📖 upstream to PostHog). This file is local-only by default and never leaves
 *   📖 the user's machine.
 *
 *   📖 Persistence: ~/.free-coding-models/runtime-telemetry.json (separate from
 *   📖 the probe-cache at probe-cache.json). Atomic write via shared-helpers.
 *
 *   📖 Derived fields (computed on read, never persisted):
 *   📖   avgLatencyMs        = totalLatencyMs / totalCalls
 *   📖   avgTokensPerSecond  = totalCompletionTokens / (totalLatencyMs / 1000)
 *   📖   successRate         = successCalls / totalCalls
 *
 * @functions
 *   → getRuntimeTelemetryPath()                              — Resolves the JSON file path
 *   → loadRuntimeTelemetry({ path, now }?)                   — Reads + validates the file
 *   → flushRuntimeTelemetry({ path, cache, now }?)           — Atomic write
 *   → clearRuntimeTelemetry({ path }?)                       — Nuke the file (for --clear-runtime)
 *   → recordModelCall(providerKey, modelId, callResult, opts?) → mutates in-memory cache
 *   → getModelTelemetry(providerKey, modelId, opts?)         → ModelTelemetry | null
 *   → getAllModelTelemetry(opts?)                            → Record<key, ModelTelemetry>
 *   → getRealWorldScore(providerKey, modelId, opts?)         → 0..100 | null (null below MIN_CALLS)
 *   → getCacheStats(opts?)                                   → aggregate counts for footer
 *   → pruneStaleEntries(maxAgeMs, opts?)                     → drop models not seen recently
 *
 * @exports getRuntimeTelemetryPath, loadRuntimeTelemetry, flushRuntimeTelemetry,
 *          clearRuntimeTelemetry, recordModelCall, getModelTelemetry,
 *          getAllModelTelemetry, getRealWorldScore, getCacheStats,
 *          pruneStaleEntries, DEFAULT_MIN_CALLS_FOR_SCORE, DEFAULT_REAL_WORLD_WEIGHTS,
 *          MAX_RECENT_CALLS
 *
 * @see src/core/telemetry.js    — product analytics (separate concern)
 * @see src/core/probe-cache.js  — persistent probe-cache (t1, separate file)
 * @see src/core/shared-helpers.js — atomicWriteJson (used by flushRuntimeTelemetry)
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWriteJson } from './shared-helpers.js'

// ─── Constants ────────────────────────────────────────────────────────────────

/** 📖 Below this many routed calls, getRealWorldScore returns null (not enough signal). */
export const DEFAULT_MIN_CALLS_FOR_SCORE = 5

/** 📖 recentCalls FIFO cap. Worst-case size: 238 models × 50 × ~200B ≈ 2.4 MB. */
export const MAX_RECENT_CALLS = 50

/** 📖 Composite-score weights. Tune with vava before shipping wider. */
export const DEFAULT_REAL_WORLD_WEIGHTS = Object.freeze({
  success: 0.60,
  speed:   0.25,
  recency: 0.15,
})

/** 📖 Filename lives in the same dir as the probe-cache for discoverability. */
const TELEMETRY_FILENAME = 'runtime-telemetry.json'
const STATE_DIRNAME = 'free-coding-models'

// ─── Module-level state ──────────────────────────────────────────────────────

/**
 * 📖 In-memory mirror of the on-disk file. Loaded lazily by the first function
 * 📖 that needs it (recordModelCall / getModelTelemetry / etc.).
 */
let _cache = null
let _cacheLoadedFrom = null

/**
 * 📖 Model keys (`provider::model`) pruned this session. The flush read-merge-write
 * 📖 re-reads the disk file, so without this set the merge would resurrect exactly
 * 📖 the entries pruneStaleEntries() just deleted.
 */
const _sessionPrunedKeys = new Set()

// ─── Path resolution ──────────────────────────────────────────────────────────

/**
 * 📖 Resolves where the runtime-telemetry JSON lives. Honours XDG_CACHE_HOME
 * 📖 when set, else falls back to ~/.free-coding-models/. The schema is local-only
 * 📖 so we put it under ~/.cache (the same dir as the probe-cache) — not under
 * 📖 ~/.config which is reserved for shipped config the user expects to back up.
 *
 * @returns {string} Absolute path to the file (may not exist yet).
 */
export function getRuntimeTelemetryPath() {
  const xdg = process.env.XDG_CACHE_HOME
  const baseDir = xdg && xdg.trim()
    ? path.join(xdg, STATE_DIRNAME)
    : path.join(os.homedir(), `.${STATE_DIRNAME}`)
  return path.join(baseDir, TELEMETRY_FILENAME)
}

// ─── Low-level load / flush / clear ──────────────────────────────────────────

function emptyCache() {
  return {
    version: 1,
    models: {},
    lastUpdated: 0,
  }
}

/**
 * 📖 Read the runtime-telemetry JSON from disk. Returns an empty cache on any
 * 📖 I/O or parse error — never crashes the daemon on a corrupt file.
 *
 * @param {object} [opts]
 * @param {string} [opts.path]   — Override the file path (mainly for tests).
 * @returns {object} The loaded cache.
 */
export function loadRuntimeTelemetry({ path: telemetryPath } = {}) {
  const target = telemetryPath ?? getRuntimeTelemetryPath()
  let raw
  try {
    raw = fs.readFileSync(target, 'utf-8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyCache()
    return emptyCache()
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyCache()
  }

  if (!parsed || typeof parsed !== 'object') return emptyCache()
  if (typeof parsed.version !== 'number') parsed.version = 1
  if (!parsed.models || typeof parsed.models !== 'object') parsed.models = {}
  if (typeof parsed.lastUpdated !== 'number') parsed.lastUpdated = 0

  // 📖 Walk every model entry and normalise.
  for (const [key, entry] of Object.entries(parsed.models)) {
    if (!entry || typeof entry !== 'object') {
      delete parsed.models[key]
      continue
    }
    entry.totalCalls = Number(entry.totalCalls) || 0
    entry.successCalls = Number(entry.successCalls) || 0
    entry.errorCalls = Number(entry.errorCalls) || 0
    entry.totalTokens = Number(entry.totalTokens) || 0
    entry.totalPromptTokens = Number(entry.totalPromptTokens) || 0
    entry.totalCompletionTokens = Number(entry.totalCompletionTokens) || 0
    entry.totalLatencyMs = Number(entry.totalLatencyMs) || 0
    entry.totalCost = Number(entry.totalCost) || 0
    if (!Array.isArray(entry.recentCalls)) entry.recentCalls = []
    if (typeof entry.lastUpdated !== 'number') entry.lastUpdated = 0
    // 📖 Backfill derived: split totalCalls into success+error if they're 0.
    if (entry.totalCalls > 0 && entry.successCalls === 0 && entry.errorCalls === 0) {
      // 📖 Unknown break-down — treat all as success to preserve the count signal.
      entry.successCalls = entry.totalCalls
    }
  }

  _cache = parsed
  _cacheLoadedFrom = target
  return parsed
}

/**
 * 📖 Persist the in-memory cache to disk atomically (tmp + rename). Uses the
 * 📖 same read-merge-write pattern as probe-cache.flushCache so the daemon +
 * 📖 CLI can share the file safely across processes.
 *
 * @param {object} [opts]
 * @param {string} [opts.path]
 * @param {object} [opts.cache]
 * @returns {boolean} true on success, false on I/O error.
 */
export function flushRuntimeTelemetry({ path: telemetryPath, cache } = {}) {
  const target = telemetryPath ?? _cacheLoadedFrom ?? getRuntimeTelemetryPath()
  const localData = cache ?? _cache ?? emptyCache()
  localData.lastUpdated = Date.now()

  let onDisk = null
  try {
    const raw = fs.readFileSync(target, 'utf-8')
    onDisk = JSON.parse(raw)
    if (!onDisk || typeof onDisk !== 'object') onDisk = null
  } catch {
    onDisk = null
  }

  // 📖 Merge: per-model, our deltas win on key collision. Keys pruned this
  // 📖 session stay deleted instead of coming back from the stale disk snapshot.
  const merged = onDisk && typeof onDisk === 'object' ? onDisk : { version: 1, models: {}, lastUpdated: 0 }
  if (!merged.models || typeof merged.models !== 'object') merged.models = {}
  for (const [key, entry] of Object.entries(localData.models)) {
    const base = merged.models[key]
    if (base && typeof base === 'object') {
      // 📖 Merge counters + append recent calls (caller-side already FIFO'd).
      merged.models[key] = {
        ...base,
        ...entry,
        recentCalls: entry.recentCalls,  // 📖 entry already has the full new FIFO list
        lastUpdated: Math.max(base.lastUpdated || 0, entry.lastUpdated || 0),
      }
    } else {
      merged.models[key] = entry
    }
  }
  if (_sessionPrunedKeys.size > 0) {
    for (const key of Object.keys(merged.models)) {
      if (_sessionPrunedKeys.has(key)) delete merged.models[key]
    }
  }
  merged.lastUpdated = Date.now()

  try {
    atomicWriteJson(target, merged, 0o600)
    _cacheLoadedFrom = target
    _cache = merged
    // 📖 Deletions are persisted now; stop excluding so future external writes
    // 📖 for the same keys still merge in.
    _sessionPrunedKeys.clear()
    return true
  } catch {
    return false
  }
}

/**
 * 📖 Delete the runtime-telemetry file. Used by `--clear-runtime` and tests.
 *
 * @param {object} [opts]
 * @param {string} [opts.path]
 * @returns {boolean}
 */
export function clearRuntimeTelemetry({ path: telemetryPath } = {}) {
  const target = telemetryPath ?? getRuntimeTelemetryPath()
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

function getCache(opts) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'cache')) return opts.cache
  if (_cache) return _cache
  return loadRuntimeTelemetry()
}

// ─── Write path ───────────────────────────────────────────────────────────────

/**
 * 📖 Validate + normalise a single callResult into a recordCall shape.
 * 📖 Throws on garbage so recordModelCall can drop it cleanly.
 */
function normaliseCallResult(r) {
  if (!r || typeof r !== 'object') throw new Error('callResult must be an object')
  const out = {
    success: r.success === true,
    latencyMs: typeof r.latencyMs === 'number' && Number.isFinite(r.latencyMs) ? r.latencyMs : 0,
    promptTokens: typeof r.promptTokens === 'number' && Number.isFinite(r.promptTokens) ? Math.max(0, Math.floor(r.promptTokens)) : 0,
    completionTokens: typeof r.completionTokens === 'number' && Number.isFinite(r.completionTokens) ? Math.max(0, Math.floor(r.completionTokens)) : 0,
    stopReason: typeof r.stopReason === 'string' ? r.stopReason : null,
    error: r.success === true ? null : (typeof r.error === 'string' ? r.error : 'unknown'),
  }
  out.totalTokens = out.promptTokens + out.completionTokens
  return out
}

/**
 * 📖 recordModelCall: append one routed request's outcome to the per-model store.
 * 📖 Updates the in-memory cache (caller schedules a flush). The recentCalls FIFO
 * 📖 is trimmed to MAX_RECENT_CALLS to bound the file size.
 *
 * @param {string} providerKey
 * @param {string} modelId
 * @param {{ success: boolean, latencyMs?: number, promptTokens?: number, completionTokens?: number, stopReason?: string, error?: string }} callResult
 * @param {object} [opts]
 * @param {number} [opts.now=Date.now()]
 * @param {object} [opts.cache]   — Optional explicit cache to mutate (skips module state).
 * @returns {{ written: boolean, error?: string }}
 */
export function recordModelCall(providerKey, modelId, callResult, opts = {}) {
  if (!providerKey || typeof providerKey !== 'string') return { written: false, error: 'invalid providerKey' }
  if (!modelId || typeof modelId !== 'string') return { written: false, error: 'invalid modelId' }
  const now = opts.now ?? Date.now()
  const cache = (opts && Object.prototype.hasOwnProperty.call(opts, 'cache')) ? opts.cache : getCache(opts)
  const key = `${providerKey}/${modelId}`

  let r
  try {
    r = normaliseCallResult(callResult)
  } catch (err) {
    return { written: false, error: err?.message || 'invalid callResult' }
  }

  let entry = cache.models[key]
  if (!entry) {
    entry = {
      providerKey,
      modelId,
      totalCalls: 0,
      successCalls: 0,
      errorCalls: 0,
      totalTokens: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalLatencyMs: 0,
      totalCost: 0,
      recentCalls: [],
      lastUpdated: 0,
    }
    cache.models[key] = entry
  }

  entry.totalCalls += 1
  if (r.success) entry.successCalls += 1
  else entry.errorCalls += 1
  entry.totalTokens += r.totalTokens
  entry.totalPromptTokens += r.promptTokens
  entry.totalCompletionTokens += r.completionTokens
  entry.totalLatencyMs += r.latencyMs
  entry.lastUpdated = now

  // 📖 FIFO trim — push to the front so recentCalls[0] is the newest.
  const call = {
    timestamp: now,
    provider: providerKey,
    model: modelId,
    success: r.success,
    latencyMs: r.latencyMs,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    totalTokens: r.totalTokens,
    tokensPerSecond: r.latencyMs > 0 ? r.completionTokens / (r.latencyMs / 1000) : 0,
    stopReason: r.stopReason,
    error: r.error,
  }
  entry.recentCalls.unshift(call)
  if (entry.recentCalls.length > MAX_RECENT_CALLS) {
    entry.recentCalls.length = MAX_RECENT_CALLS  // 📖 truncate to cap
  }

  if (!opts || !Object.prototype.hasOwnProperty.call(opts, 'cache')) {
    _cache = cache
    // 📖 A live re-record of a pruned model means it is routing again: stop
    // 📖 excluding it from disk merges.
    _sessionPrunedKeys.delete(key)
  }

  return { written: true }
}

// ─── Read path ────────────────────────────────────────────────────────────────

/**
 * 📖 Derived metrics computed on read (never persisted).
 * @typedef {object} ModelTelemetry
 * @property {string} providerKey
 * @property {string} modelId
 * @property {number} totalCalls
 * @property {number} successCalls
 * @property {number} errorCalls
 * @property {number} successRate        0..1
 * @property {number} totalTokens
 * @property {number} totalPromptTokens
 * @property {number} totalCompletionTokens
 * @property {number} totalLatencyMs
 * @property {number} avgLatencyMs       0 if totalCalls===0
 * @property {number} avgTokensPerSecond 0 if totalLatencyMs===0
 * @property {Array}  recentCalls        most-recent first, capped at MAX_RECENT_CALLS
 * @property {number} lastUpdated        ms epoch
 */

/**
 * 📖 getModelTelemetry: read the per-model telemetry snapshot + derived metrics.
 *
 * @param {string} providerKey
 * @param {string} modelId
 * @param {object} [opts]
 * @returns {ModelTelemetry | null}
 */
export function getModelTelemetry(providerKey, modelId, opts = {}) {
  if (!providerKey || !modelId) return null
  const cache = getCache(opts)
  const key = `${providerKey}/${modelId}`
  const entry = cache.models[key]
  if (!entry) return null
  return deriveMetrics(entry)
}

/**
 * 📖 Same as getModelTelemetry but for every model at once.
 * 📖 Returns an object keyed by `${providerKey}/${modelId}` for cheap lookup.
 *
 * @param {object} [opts]
 * @returns {Record<string, ModelTelemetry>}
 */
export function getAllModelTelemetry(opts = {}) {
  const cache = getCache(opts)
  const out = {}
  for (const [key, entry] of Object.entries(cache.models)) {
    if (!entry) continue
    out[key] = deriveMetrics(entry)
  }
  return out
}

/**
 * 📖 Internal: derive successRate / avgLatencyMs / avgTokensPerSecond from raw counters.
 */
function deriveMetrics(entry) {
  const totalCalls = entry.totalCalls || 0
  const totalLatencyMs = entry.totalLatencyMs || 0
  const totalCompletionTokens = entry.totalCompletionTokens || 0
  return {
    providerKey: entry.providerKey,
    modelId: entry.modelId,
    totalCalls,
    successCalls: entry.successCalls || 0,
    errorCalls: entry.errorCalls || 0,
    successRate: totalCalls > 0 ? (entry.successCalls || 0) / totalCalls : 0,
    totalTokens: entry.totalTokens || 0,
    totalPromptTokens: entry.totalPromptTokens || 0,
    totalCompletionTokens,
    totalLatencyMs,
    avgLatencyMs: totalCalls > 0 ? totalLatencyMs / totalCalls : 0,
    avgTokensPerSecond: totalLatencyMs > 0 ? totalCompletionTokens / (totalLatencyMs / 1000) : 0,
    recentCalls: Array.isArray(entry.recentCalls) ? entry.recentCalls : [],
    lastUpdated: entry.lastUpdated || 0,
  }
}

// ─── Real-world score (the ranking signal) ───────────────────────────────────

/**
 * 📖 sigmoid01: squashes (0, +inf) into (0, 1) so 50 tok/s = 0.5, 200 tok/s ≈ 0.95.
 * 📖 Tuned so that the typical free-tier sweet spot (30-80 tok/s) maps to 0.4-0.7.
 */
function sigmoid01(x, midpoint = 50) {
  // 📖 Logistic curve shifted so midpoint -> 0.5.
  const k = 0.04  // 📖 steepness — 50 -> 0.5, 100 -> ~0.88, 200 -> ~0.99
  return 1 / (1 + Math.exp(-k * (x - midpoint)))
}

/**
 * 📖 recencyDecay: 1.0 today, ~0.5 after 7 days, ~0.0 after 30 days.
 */
function recencyDecay(lastUpdatedMs, now = Date.now()) {
  if (!lastUpdatedMs) return 0
  const ageDays = (now - lastUpdatedMs) / (24 * 60 * 60 * 1000)
  if (ageDays < 0) return 1
  if (ageDays >= 30) return 0
  return Math.max(0, 1 - ageDays / 30)
}

/**
 * 📖 getRealWorldScore: composite 0..100 score for ranking, or null when below
 * 📖 the minimum-call threshold (so brand-new models don't get punished).
 *
 * 📖 Formula: successRate * 0.60 + speedScore * 0.25 + recencyBonus * 0.15
 * 📖   - successRate: 0..1 (straightforward)
 * 📖   - speedScore:   sigmoid01(avgTokensPerSecond) maps 50 tok/s -> 0.5
 * 📖   - recencyBonus: recencyDecay(lastUpdatedMs) -> 1.0 today, ~0 after 30d
 *
 * @param {string} providerKey
 * @param {string} modelId
 * @param {object} [opts]
 * @param {number} [opts.minCalls=DEFAULT_MIN_CALLS_FOR_SCORE]
 * @param {object} [opts.weights=DEFAULT_REAL_WORLD_WEIGHTS]
 * @returns {number | null}
 */
export function getRealWorldScore(providerKey, modelId, opts = {}) {
  const minCalls = opts.minCalls ?? DEFAULT_MIN_CALLS_FOR_SCORE
  const weights = opts.weights ?? DEFAULT_REAL_WORLD_WEIGHTS
  const m = getModelTelemetry(providerKey, modelId, opts)
  if (!m || m.totalCalls < minCalls) return null
  const now = opts.now ?? Date.now()
  const successRate = m.successRate
  const speedScore = sigmoid01(m.avgTokensPerSecond)
  const recencyBonus = recencyDecay(m.lastUpdated, now)
  const score = (successRate * weights.success) + (speedScore * weights.speed) + (recencyBonus * weights.recency)
  return Math.round(Math.max(0, Math.min(1, score)) * 100)
}

// ─── Stats + pruning ──────────────────────────────────────────────────────────

/**
 * 📖 getCacheStats: aggregate counts for the TUI footer + /stats endpoint.
 *
 * @param {object} [opts]
 * @returns {{
 *   modelsTracked: number,
 *   totalCalls: number,
 *   successCalls: number,
 *   errorCalls: number,
 *   modelsWithSignal: number,  // totalCalls >= DEFAULT_MIN_CALLS_FOR_SCORE
 * }}
 */
export function getCacheStats(opts = {}) {
  const cache = getCache(opts)
  const minCalls = opts.minCalls ?? DEFAULT_MIN_CALLS_FOR_SCORE
  let totalCalls = 0, successCalls = 0, errorCalls = 0, modelsWithSignal = 0
  for (const entry of Object.values(cache.models)) {
    if (!entry) continue
    totalCalls += entry.totalCalls || 0
    successCalls += entry.successCalls || 0
    errorCalls += entry.errorCalls || 0
    if ((entry.totalCalls || 0) >= minCalls) modelsWithSignal++
  }
  return {
    modelsTracked: Object.keys(cache.models).length,
    totalCalls,
    successCalls,
    errorCalls,
    modelsWithSignal,
  }
}

/**
 * 📖 pruneStaleEntries: drop entries not updated within maxAgeMs. Called on
 * 📖 daemon boot to keep the file bounded as the catalog evolves.
 *
 * @param {number} maxAgeMs
 * @param {object} [opts]
 * @param {object} [opts.cache]
 * @param {number} [opts.now=Date.now()]
 * @returns {number} Number of entries pruned.
 */
export function pruneStaleEntries(maxAgeMs, opts = {}) {
  const cache = getCache(opts)
  const now = opts.now ?? Date.now()
  let pruned = 0
  for (const [key, entry] of Object.entries(cache.models)) {
    if (!entry) continue
    if (!entry.lastUpdated || now - entry.lastUpdated > maxAgeMs) {
      delete cache.models[key]
      // 📖 Remember the deletion so flushRuntimeTelemetry's read-merge-write does
      // 📖 not resurrect this entry from the still-stale disk file.
      if (!opts || !Object.prototype.hasOwnProperty.call(opts, 'cache')) {
        _sessionPrunedKeys.add(key)
      }
      pruned++
    }
  }
  if (!opts || !Object.prototype.hasOwnProperty.call(opts, 'cache')) {
    _cache = cache
  }
  return pruned
}
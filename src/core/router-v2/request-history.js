/**
 * @file request-history.js
 * @description Persisted request history for Router v2.
 *
 * @details
 *   📖 v1 kept the last 20 request log entries in memory only: restart the
 *   daemon and the evidence was gone, which made "the router feels flaky"
 *   impossible to debug after the fact. v2 persists every routed request
 *   (bounded ring, atomic writes, debounced flush) with its full decision
 *   trace so the TUI overlay and the web page can show a durable fallback
 *   chain per request.
 *
 *   📖 Storage shape: a single JSON file `{ version, entries: [...] }` written
 *   with `atomicWriteJson`. Entries are capped (oldest dropped) and each one
 *   is routing metadata only: model keys, statuses, timings, error kinds.
 *   No prompts, no completions, no credentials.
 *
 * @functions
 *   → new RequestHistory({ path, logger, maxEntries }) - Load persisted history
 *   → history.append(entry) - Add one request record (debounced flush)
 *   → history.recent(limit) - Newest-first slice
 *   → history.stats() - Aggregate counters over the retained window
 *   → history.flush({ force }) / history.clear()
 *
 * @exports RequestHistory
 */

import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJson, safeJsonParse } from '../shared-helpers.js'

const STATE_VERSION = 1
const FLUSH_DEBOUNCE_MS = 2000
export const DEFAULT_MAX_ENTRIES = 500

export class RequestHistory {
  constructor({ path, logger, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.path = path
    this.logger = logger
    this.maxEntries = Math.max(10, maxEntries)
    this.entries = []
    this.dirty = false
    this.flushTimer = null
    this.load()
  }

  load() {
    try {
      if (!existsSync(this.path)) return
      const parsed = safeJsonParse(readFileSync(this.path, 'utf8'), null)
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return
      this.entries = parsed.entries
        .filter((entry) => entry && typeof entry === 'object' && typeof entry.request_id === 'string')
        .slice(-this.maxEntries)
    } catch (error) {
      this.logger?.warn?.('Request history load failed; starting fresh', { error: error?.message })
      this.entries = []
    }
  }

  /**
   * 📖 Append one completed request record. Expected shape (all routing
   * metadata, produced by the routeRequest finally-block):
   * `{ request_id, at, set, protocol, model_requested, served_model, outcome,
   *    attempts: [...], skipped: [...], wall_ms, tokens, stream,
   *    last_resort_used }`
   */
  append(entry) {
    if (!entry || typeof entry !== 'object') return
    this.entries.push(entry)
    while (this.entries.length > this.maxEntries) this.entries.shift()
    this.dirty = true
    this.scheduleFlush()
  }

  /** 📖 Newest-first slice for API responses and dashboards. */
  recent(limit = 50) {
    const n = Math.max(1, Math.min(limit, this.maxEntries))
    return this.entries.slice(-n).reverse()
  }

  /** 📖 Aggregate counters over the retained window (newest `window` entries). */
  stats({ window = this.maxEntries } = {}) {
    const slice = this.entries.slice(-Math.max(1, window))
    const total = slice.length
    let served = 0
    let failovers = 0
    let lastResort = 0
    let attemptsSum = 0
    let wallSum = 0
    let wallCount = 0
    for (const entry of slice) {
      if (entry.outcome === 'served') served += 1
      if ((entry.attempts?.length || 0) > 1) failovers += 1
      if (entry.last_resort_used === true) lastResort += 1
      attemptsSum += entry.attempts?.length || 0
      if (Number.isFinite(entry.wall_ms) && entry.wall_ms > 0) {
        wallSum += entry.wall_ms
        wallCount += 1
      }
    }
    return {
      retained: total,
      served,
      all_failed: total - served,
      failover_rate: total > 0 ? Math.round((failovers / total) * 100) / 100 : 0,
      success_rate: total > 0 ? Math.round((served / total) * 100) / 100 : null,
      last_resort_used: lastResort,
      avg_attempts: total > 0 ? Math.round((attemptsSum / total) * 100) / 100 : 0,
      avg_wall_ms: wallCount > 0 ? Math.round(wallSum / wallCount) : null,
    }
  }

  scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, FLUSH_DEBOUNCE_MS)
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref()
  }

  flush() {
    if (!this.dirty) return
    try {
      atomicWriteJson(this.path, { version: STATE_VERSION, entries: this.entries }, 0o600)
      this.dirty = false
    } catch (error) {
      this.logger?.warn?.('Request history write failed', { error: error?.message })
    }
  }

  clear() {
    this.entries = []
    this.dirty = true
    this.flush()
  }
}

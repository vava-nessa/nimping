/**
 * @file breaker-store.js
 * @description Persisted circuit breakers with a DEGRADED warning state for Router v2.
 *
 * @details
 *   📖 v1 kept circuit breakers in memory only: every daemon restart wiped
 *   them, and because the probe burst skips models that are still "fresh" in
 *   the shared probe cache, a model that went bad right before a restart
 *   happily received live traffic again until it failed three more times.
 *
 *   📖 v2 persists breaker state to disk (atomic write, debounced flush) and
 *   restores it on boot, so cooldowns survive restarts. It also adds two
 *   refinements:
 *   - DEGRADED: a warning state at 60% of the failure threshold. A degraded
 *     model is still routed (ranked below CLOSED models) and the dashboards
 *     show it amber, so users see trouble BEFORE the breaker trips.
 *   - Escalating backoff: each model remembers its `tripCount`; the cooldown
 *     multiplies per trip (capped at 16x the initial cooldown), so a flapping
 *     model does not re-enter rotation every 30 seconds.
 *
 * @functions
 *   → new BreakerStore({ path, logger }) - Create + load persisted breakers
 *   → store.ensure(key, initialCooldownMs) - Get or create a breaker entry
 *   → store.markFailure(key, params) - Apply a failure; may trip the breaker
 *   → store.markSuccess(key, initialCooldownMs) - Fully reset a breaker
 *   → store.evaluate(key) - Lazily promote OPEN → HALF_OPEN after cooldown
 *   → store.snapshot() / store.scheduleFlush() / store.flush()
 *
 * @exports BreakerStore
 */

import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJson, safeJsonParse } from '../shared-helpers.js'

const STATE_VERSION = 1
const FLUSH_DEBOUNCE_MS = 2000
// 📖 Entries untouched for 30 days are dropped so the file cannot grow forever.
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000
// 📖 cooldown escalation cap: initial * 2^4 = 16x.
const MAX_ESCALATION_STEPS = 4

function defaultBreaker(initialCooldownMs) {
  return {
    state: 'CLOSED',
    consecutiveFailures: 0,
    tripCount: 0,
    cooldownMs: initialCooldownMs,
    openedAt: null,
    lastError: null,
    authError: false,
    updatedAt: Date.now(),
  }
}

function sanitizeEntry(raw, now) {
  if (!raw || typeof raw !== 'object') return null
  const state = ['CLOSED', 'DEGRADED', 'OPEN', 'HALF_OPEN'].includes(raw.state) ? raw.state : 'CLOSED'
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : now
  if (now - updatedAt > ENTRY_TTL_MS) return null
  return {
    state,
    consecutiveFailures: Number.isFinite(raw.consecutiveFailures) ? Math.max(0, raw.consecutiveFailures) : 0,
    tripCount: Number.isFinite(raw.tripCount) ? Math.max(0, raw.tripCount) : 0,
    cooldownMs: Number.isFinite(raw.cooldownMs) && raw.cooldownMs > 0 ? raw.cooldownMs : 30_000,
    openedAt: Number.isFinite(raw.openedAt) ? raw.openedAt : null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, 300) : null,
    authError: raw.authError === true,
    updatedAt,
  }
}

export class BreakerStore {
  /**
   * @param {{ path: string, logger: object }} params
   *   `path` is the JSON state file; pass a per-test temp path to isolate.
   */
  constructor({ path, logger }) {
    this.path = path
    this.logger = logger
    this.breakers = new Map()
    this.dirty = false
    this.flushTimer = null
    this.load()
  }

  load() {
    try {
      if (!existsSync(this.path)) return
      const parsed = safeJsonParse(readFileSync(this.path, 'utf8'), null)
      if (!parsed || typeof parsed !== 'object') return
      const now = Date.now()
      const entries = parsed.breakers && typeof parsed.breakers === 'object' ? parsed.breakers : {}
      for (const [key, raw] of Object.entries(entries)) {
        const entry = sanitizeEntry(raw, now)
        if (entry) this.breakers.set(key, entry)
      }
      this.logger?.debug?.(`Restored ${this.breakers.size} persisted breaker(s)`)
    } catch (error) {
      this.logger?.warn?.('Breaker state load failed; starting fresh', { error: error?.message })
    }
  }

  ensure(key, initialCooldownMs = 30_000) {
    let entry = this.breakers.get(key)
    if (!entry) {
      entry = defaultBreaker(initialCooldownMs)
      this.breakers.set(key, entry)
    }
    return entry
  }

  /**
   * 📖 Lazily promote an OPEN breaker to HALF_OPEN once its cooldown elapsed.
   * Called right before candidate scoring so no timer is needed.
   */
  evaluate(key) {
    const entry = this.breakers.get(key)
    if (!entry || entry.state !== 'OPEN') return entry
    const elapsed = Date.now() - (entry.openedAt || 0)
    if (elapsed >= entry.cooldownMs) {
      entry.state = 'HALF_OPEN'
      entry.updatedAt = Date.now()
      this.dirty = true
      this.scheduleFlush()
    }
    return entry
  }

  /**
   * 📖 Apply a failure to a model breaker.
   * @returns {{ state: string, opened: boolean, degraded: boolean }}
   */
  markFailure(key, {
    detail = 'unknown',
    statusCode = null,
    failureThreshold = 3,
    initialCooldownMs = 30_000,
    maxCooldownMs = 300_000,
    backoffMultiplier = 2,
    authError = false,
  } = {}) {
    const entry = this.ensure(key, initialCooldownMs)
    const before = entry.state
    if (authError) {
      // 📖 Auth problems ride along on the breaker as a sticky flag but never
      // trip it: a dead key is a config issue, not an unhealthy model.
      entry.authError = true
      entry.lastError = detail
      entry.updatedAt = Date.now()
      this.dirty = true
      this.scheduleFlush()
      return { state: entry.state, opened: false, degraded: false }
    }
    entry.authError = false
    entry.consecutiveFailures += 1
    entry.lastError = detail
    entry.updatedAt = Date.now()

    const degradedThreshold = Math.max(1, Math.ceil(failureThreshold * 0.6))
    let opened = false
    let degraded = false
    if (entry.state === 'HALF_OPEN' || entry.consecutiveFailures >= failureThreshold) {
      entry.state = 'OPEN'
      entry.openedAt = Date.now()
      entry.tripCount += 1
      // 📖 Escalating backoff: each successive trip multiplies the cooldown,
      // capped so a flapping model can never disappear for hours.
      const escalation = Math.min(entry.tripCount - 1, MAX_ESCALATION_STEPS)
      entry.cooldownMs = Math.min(
        maxCooldownMs,
        Math.max(initialCooldownMs, initialCooldownMs * Math.pow(backoffMultiplier, escalation)),
      )
      opened = true
    } else if (entry.consecutiveFailures >= degradedThreshold) {
      if (entry.state === 'CLOSED') degraded = true
      entry.state = 'DEGRADED'
    }
    if (entry.state !== before || opened || degraded) this.dirty = true
    this.scheduleFlush()
    return { state: entry.state, opened, degraded }
  }

  /**
   * 📖 Full reset after a genuine success (routed traffic or a passing probe).
   */
  markSuccess(key, initialCooldownMs = 30_000) {
    const entry = this.breakers.get(key)
    if (!entry) return
    const changed = entry.state !== 'CLOSED' || entry.consecutiveFailures > 0 || entry.authError
    entry.state = 'CLOSED'
    entry.consecutiveFailures = 0
    entry.cooldownMs = initialCooldownMs
    entry.openedAt = null
    entry.lastError = null
    entry.authError = false
    entry.updatedAt = Date.now()
    // 📖 tripCount deliberately survives success: it is the escalating-backoff
    // memory. It decays only via the TTL prune.
    if (changed) {
      this.dirty = true
      this.scheduleFlush()
    }
  }

  setFlag(key, flag, value) {
    const entry = this.breakers.get(key)
    if (!entry) return
    entry[flag] = value
    entry.updatedAt = Date.now()
    this.dirty = true
    this.scheduleFlush()
  }

  get(key) {
    return this.breakers.get(key) || null
  }

  delete(key) {
    if (this.breakers.delete(key)) {
      this.dirty = true
      this.scheduleFlush()
    }
  }

  /**
   * 📖 Plain-object projection used by /stats, dashboards and persistence.
   * `authError`/`stale`/`unsupported` style derived labels are applied by the
   * caller; this returns the raw breaker fields.
   */
  snapshot() {
    const out = {}
    for (const [key, entry] of this.breakers.entries()) {
      out[key] = {
        state: entry.state,
        consecutiveFailures: entry.consecutiveFailures,
        tripCount: entry.tripCount,
        cooldownMs: entry.cooldownMs,
        openedAt: entry.openedAt,
        lastError: entry.lastError,
        authError: entry.authError,
      }
    }
    return out
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
      const payload = { version: STATE_VERSION, saved_at: new Date().toISOString(), breakers: this.snapshot() }
      atomicWriteJson(this.path, payload, 0o600)
      this.dirty = false
    } catch (error) {
      this.logger?.warn?.('Breaker state write failed', { error: error?.message })
    }
  }
}

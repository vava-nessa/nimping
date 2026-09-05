/**
 * @file lib/provider-quota-fetchers.js
 * @description Provider endpoint quota pollers + passive rate-limit header parser.
 *
 * Active fetchers (existing):
 *   - openrouter: GET https://openrouter.ai/api/v1/key
 *       derives percent from limit_remaining/limit (with fallback field names)
 *   - siliconflow: GET https://api.siliconflow.cn/v1/user/info
 *       returns balance info; percent is null (no limit field to derive from)
 *
 * Passive tracker (t2):
 *   - Every chat-completion response carries rate-limit headers (x-ratelimit-*).
 *   - processResponseHeaders() parses those headers in 6 priority variants and
 *     writes to an in-memory map, kept fresh per `STALENESS_MS` (5 min default).
 *   - getQuota() merges the passive snapshot with the latest active fetch,
 *     returning whichever is freshest — so quota is *always* live when traffic
 *     flows, with the active fetcher as a safety net for idle periods.
 *   - Zero extra network requests: the headers are already on every response.
 *
 * Features:
 *   - TTL cache (default 60s) prevents hammering endpoints
 *   - Error backoff (default 15s) after failures
 *   - Injectable fetch + time for testing
 *   - API keys are never logged
 *   - Case-insensitive header parsing (some proxies vary casing)
 *
 * @exports parseOpenRouterResponse(data) → number|null
 * @exports parseSiliconFlowResponse(data) → { balance, chargeBalance, totalBalance }|null
 * @exports createProviderQuotaFetcher(options) → fetcher(providerKey, apiKey) → Promise<number|null>
 * @exports fetchProviderQuota(providerKey, apiKey, options) → Promise<number|null>
 * @exports extractQuota(headers) → { remaining, limit, percent, source, windowType }|null
 * @exports processResponseHeaders(providerKey, headers, opts?) → boolean
 * @exports getQuota(providerKey, opts?) → QuotaSnapshot|null
 * @exports getAllQuotas(opts?) → ReadonlyMap<string, QuotaSnapshot>
 * @exports formatQuotaStatus(providerKey, opts?) → string|undefined
 * @exports resetPassiveQuota() — clear the in-memory passive map (tests)
 * @exports HEADER_PAIRS — readonly array of [remainingKey, limitKey] pairs in priority order
 * @exports STALENESS_MS — passive snapshots older than this are considered stale
 * @exports QUOTA_WINDOW_LABELS — map of windowType → short label for tooltips
 */

// ─── Response parsers (pure, no I/O) ─────────────────────────────────────────

import { createHash } from 'node:crypto'

/**
 * Parse an OpenRouter /api/v1/key response into a quota percent [0,100] or null.
 *
 * The endpoint may wrap fields in a `data` object or return them at root.
 * Field precedence:
 *   1. limit_remaining / limit
 *   2. remaining / total_limit
 *   3. remaining_credits / credits
 *
 * @param {unknown} responseData - Parsed JSON from the endpoint
 * @returns {number|null} Integer percent 0–100, or null when not derivable
 */
export function parseOpenRouterResponse(responseData) {
  if (responseData == null || typeof responseData !== 'object') return null

  // Unwrap .data if present, fall back to root
  const root = responseData.data != null && typeof responseData.data === 'object'
    ? responseData.data
    : responseData

  // Try field pairs in priority order
  const pairs = [
    ['limit_remaining', 'limit'],
    ['remaining', 'total_limit'],
    ['remaining_credits', 'credits'],
  ]

  for (const [remainingKey, limitKey] of pairs) {
    const remaining = parseFloat(root[remainingKey])
    const limit = parseFloat(root[limitKey])
    if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
      const pct = Math.round((remaining / limit) * 100)
      return Math.max(0, Math.min(100, pct))
    }
  }

  return null
}

/**
 * Parse a SiliconFlow /v1/user/info response.
 *
 * SiliconFlow does not expose a credit/quota limit, only the current balance.
 * A percentage cannot be reliably derived without knowing the original limit.
 *
 * Returns an object with raw balance fields when the response is well-formed,
 * or null when the response is missing/malformed/error.
 *
 * Callers may use { percent: null } as a signal that the provider responded
 * successfully but quota percentage is not available.
 *
 * @param {unknown} responseData - Parsed JSON from the endpoint
 * @returns {{ balance: number, chargeBalance: number, totalBalance: number, percent: null }|null}
 */
export function parseSiliconFlowResponse(responseData) {
  if (responseData == null || typeof responseData !== 'object') return null

  // SiliconFlow wraps payload in .data; code 20000 = success
  const data = responseData.data
  if (data == null || typeof data !== 'object') return null

  // Require a success indicator
  const code = responseData.code
  const status = responseData.status
  if (code !== 20000 && status !== true) return null

  const balance = parseFloat(data.balance)
  const chargeBalance = parseFloat(data.chargeBalance)
  const totalBalance = parseFloat(data.totalBalance)

  // All three fields must be numeric to be valid
  if (!Number.isFinite(balance) || !Number.isFinite(chargeBalance) || !Number.isFinite(totalBalance)) {
    return null
  }

  // We cannot derive a reliable percent without a "limit" (initial balance) field.
  // Return structured balance info with percent: null.
  return {
    balance,
    chargeBalance,
    totalBalance,
    percent: null,
  }
}

// ─── TTL cache + backoff ──────────────────────────────────────────────────────

/**
 * Create an in-memory cache entry.
 * @param {number|null} value
 * @param {number} expiresAt - Date.now() timestamp
 * @param {number} [resolvedAt=Date.now()] - when the value was actually fetched
 * @returns {{ value: number|null, expiresAt: number, resolvedAt: number }}
 */
function makeCacheEntry(value, expiresAt, resolvedAt = Date.now()) {
  return { value, expiresAt, resolvedAt }
}

// ─── Endpoint definitions ─────────────────────────────────────────────────────

const OPENROUTER_KEY_ENDPOINT = 'https://openrouter.ai/api/v1/key'
const SILICONFLOW_USER_ENDPOINT = 'https://api.siliconflow.cn/v1/user/info'

/**
 * @param {string} apiKey
 * @param {Function} fetchFn - injectable fetch
 * @returns {Promise<number|null>} quota percent or null
 */
async function fetchOpenRouterRaw(apiKey, fetchFn) {
  const resp = await fetchFn(OPENROUTER_KEY_ENDPOINT, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/vava-nessa/free-coding-models',
      'X-Title': 'free-coding-models',
    },
    signal: AbortSignal.timeout(5000),
  })
  if (!resp.ok) return null
  const data = await resp.json()
  return parseOpenRouterResponse(data)
}

/**
 * @param {string} apiKey
 * @param {Function} fetchFn - injectable fetch
 * @returns {Promise<number|null>} quota percent (always null for SiliconFlow) or null on error
 */
async function fetchSiliconFlowRaw(apiKey, fetchFn) {
  const resp = await fetchFn(SILICONFLOW_USER_ENDPOINT, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(5000),
  })
  if (!resp.ok) return null
  const data = await resp.json()
  const parsed = parseSiliconFlowResponse(data)
  // percent is always null for SiliconFlow (no limit field)
  return parsed !== null ? parsed.percent : null
}

// ─── Module-level default cache (used by fetchProviderQuota) ──────────────────

const DEFAULT_CACHE_TTL_MS = 60_000
const DEFAULT_ERROR_BACKOFF_MS = 15_000
/** @type {Map<string, { value: number|null, expiresAt: number, pendingPromise?: Promise<number|null> }>} */
const _defaultCache = new Map()

/**
 * Build a collision-resistant cache key from providerKey + apiKey.
 * Uses SHA-256 of the full apiKey so that keys sharing the same suffix
 * (e.g. 'account-A-SHARED12' vs 'account-B-SHARED12') do not collide.
 * The raw API key is never stored or logged.
 *
 * @param {string} providerKey
 * @param {string} apiKey
 * @returns {string}
 */
function makeCacheKey(providerKey, apiKey) {
  const hash = createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
  return `${providerKey}:${hash}`
}

// ─── createProviderQuotaFetcher ───────────────────────────────────────────────

/**
 * Create a stateful fetcher with its own TTL cache and error backoff.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchFn=fetch] - injectable fetch (defaults to global fetch)
 * @param {number} [options.cacheTtlMs=60000] - TTL for successful results
 * @param {number} [options.errorBackoffMs=15000] - TTL after errors (prevents spam)
 * @returns {(providerKey: string, apiKey: string) => Promise<number|null>}
 */
export function createProviderQuotaFetcher({ fetchFn = fetch, cacheTtlMs = DEFAULT_CACHE_TTL_MS, errorBackoffMs = DEFAULT_ERROR_BACKOFF_MS } = {}) {
  /** @type {Map<string, { value: number|null, expiresAt: number, pendingPromise?: Promise<number|null> }>} */
  const cache = new Map()

  return async function fetcherInstance(providerKey, apiKey) {
    if (!apiKey) return null

    // Cache key uses a hash of the full key to avoid suffix-collision bugs
    const cacheKey = makeCacheKey(providerKey, apiKey)
    const now = Date.now()
    const cached = cache.get(cacheKey)

    // Reuse in-flight promise to prevent duplicate concurrent requests
    if (cached?.pendingPromise) {
      return cached.pendingPromise
    }

    // Return cached value if still fresh
    if (cached && cached.expiresAt > now) {
      return cached.value
    }

    // Dispatch to provider-specific fetcher
    const doFetch = providerKey === 'openrouter'
      ? () => fetchOpenRouterRaw(apiKey, fetchFn)
      : providerKey === 'siliconflow'
        ? () => fetchSiliconFlowRaw(apiKey, fetchFn)
        : null

    if (!doFetch) return null

    const pendingPromise = doFetch()
      .then((value) => {
        const finalValue = (typeof value === 'number' && Number.isFinite(value)) ? value : null
        cache.set(cacheKey, makeCacheEntry(finalValue, Date.now() + cacheTtlMs))
        return finalValue
      })
      .catch(() => {
        cache.set(cacheKey, makeCacheEntry(null, Date.now() + errorBackoffMs))
        return null
      })

    // Store pending promise to coalesce concurrent calls
    cache.set(cacheKey, {
      value: cached?.value ?? null,
      expiresAt: cached?.expiresAt ?? 0,
      pendingPromise,
    })

    return pendingPromise
  }
}

// ─── fetchProviderQuota (top-level convenience, uses module-level default cache) ──

/**
 * Fetch provider quota percent for a given provider + API key.
 *
 * Supported providers: 'openrouter', 'siliconflow'.
 * All other providers return null immediately.
 *
 * Options:
 *   - fetchFn: injectable fetch for testing (bypasses module-level cache when provided)
 *   - cacheTtlMs / errorBackoffMs: only used when fetchFn is provided (creates isolated fetcher)
 *
 * When called WITHOUT fetchFn, uses the module-level cache shared across all calls.
 *
 * @param {string} providerKey
 * @param {string} apiKey
 * @param {object} [options]
 * @param {Function} [options.fetchFn] - injectable fetch; when provided, creates a per-call fetcher
 * @param {number} [options.cacheTtlMs]
 * @param {number} [options.errorBackoffMs]
 * @returns {Promise<number|null>}
 */
export async function fetchProviderQuota(providerKey, apiKey, options = {}) {
  if (!apiKey) return null
  if (providerKey !== 'openrouter' && providerKey !== 'siliconflow') return null

  const { fetchFn, cacheTtlMs = DEFAULT_CACHE_TTL_MS, errorBackoffMs = DEFAULT_ERROR_BACKOFF_MS } = options

  // When a custom fetchFn is provided, create an isolated fetcher (for testing)
  if (fetchFn) {
    const fetcher = createProviderQuotaFetcher({ fetchFn, cacheTtlMs, errorBackoffMs })
    return fetcher(providerKey, apiKey)
  }

  // Default path: use module-level cache
  const cacheKey = makeCacheKey(providerKey, apiKey)
  const now = Date.now()
  const cached = _defaultCache.get(cacheKey)

  if (cached?.pendingPromise) return cached.pendingPromise
  if (cached && cached.expiresAt > now) return cached.value

  const doFetch = providerKey === 'openrouter'
    ? () => fetchOpenRouterRaw(apiKey, fetch)
    : () => fetchSiliconFlowRaw(apiKey, fetch)

  const pendingPromise = doFetch()
    .then((value) => {
      const finalValue = (typeof value === 'number' && Number.isFinite(value)) ? value : null
      const resolvedAt = Date.now()
      _defaultCache.set(cacheKey, makeCacheEntry(finalValue, resolvedAt + cacheTtlMs, resolvedAt))
      return finalValue
    })
    .catch(() => {
      _defaultCache.set(cacheKey, makeCacheEntry(null, Date.now() + errorBackoffMs))
      return null
    })

  _defaultCache.set(cacheKey, {
    value: cached?.value ?? null,
    expiresAt: cached?.expiresAt ?? 0,
    pendingPromise,
  })

  return pendingPromise
}

// ─── Passive rate-limit header tracker (t2) ───────────────────────────────────

/**
 * 📖 STALENESS_MS: how long a passive snapshot stays "fresh" before we prefer
 * 📖 the active fetcher result (or hide the chip entirely if neither is fresh).
 * 📖 Mirrors pi-free's 5-minute window. Override per call via opts.now - opts.maxAgeMs.
 */
export const STALENESS_MS = 5 * 60 * 1000

/**
 * 📖 HEADER_PAIRS: ordered list of [remainingKey, limitKey] pairs to try when
 * 📖 parsing a response's rate-limit headers. First pair where both values parse
 * 📖 as finite numbers AND limit > 0 wins. Order matters: most-specific (day,
 * 📖 tokens) comes before generic (requests) where applicable.
 *
 * 📖 Provenance:
 * 📖   - x-ratelimit-remaining-requests / x-ratelimit-limit-requests  → SambaNova
 * 📖   - x-ratelimit-remaining          / x-ratelimit-limit            → Mistral / generic
 * 📖   - ratelimit-remaining-requests    / ratelimit-limit-requests      → proxies that strip 'x-' prefix
 * 📖   - ratelimit-remaining             / ratelimit-limit               → same, generic
 * 📖   - x-ratelimit-remaining-requests-day / x-ratelimit-limit-requests-day → SambaNova daily window
 * 📖   - x-ratelimit-remaining-day / x-ratelimit-limit-day → generic daily
 */
export const HEADER_PAIRS = [
  ['x-ratelimit-remaining-requests', 'x-ratelimit-limit-requests'],
  ['x-ratelimit-remaining', 'x-ratelimit-limit'],
  ['ratelimit-remaining-requests', 'ratelimit-limit-requests'],
  ['ratelimit-remaining', 'ratelimit-limit'],
  ['x-ratelimit-remaining-requests-day', 'x-ratelimit-limit-requests-day'],
  ['x-ratelimit-remaining-day', 'x-ratelimit-limit-day'],
  ['x-ratelimit-remaining-tokens', 'x-ratelimit-limit-tokens'],
  ['x-ratelimit-remaining-tokens-minute', 'x-ratelimit-limit-tokens-minute'],
]

/**
 * 📖 QUOTA_WINDOW_LABELS: short tooltip labels keyed by windowType suffix
 * 📖 detected in the matched header pair name. Used by formatQuotaStatus to
 * 📖 indicate whether the user is looking at a per-minute or per-day window.
 */
export const QUOTA_WINDOW_LABELS = {
  day: 'day',
  requests: 'min',
  tokens: 'tok',
  'tokens-minute': 'tok/min',
}

/**
 * 📖 Internal: in-memory map of latest passive quota snapshot per provider.
 * 📖 Keyed by providerKey; never persisted to disk (passive tracking is local-only).
 */
const _passiveQuota = new Map() // providerKey -> QuotaSnapshot

/**
 * 📖 Case-insensitive header lookup. Accepts both Fetch `Headers` objects and
 * 📖 plain object literals (some test doubles pass plain objects).
 */
function readHeader(headers, key) {
  if (!headers) return null
  if (typeof headers.get === 'function') {
    return headers.get(key) ?? headers.get(key.toLowerCase()) ?? null
  }
  if (typeof headers === 'object') {
    if (key in headers) return headers[key]
    const lower = key.toLowerCase()
    if (lower in headers) return headers[lower]
    // 📖 Iterate as a last resort — some servers use unusual casings.
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lower) return headers[k]
    }
  }
  return null
}

/**
 * 📖 Parse rate-limit headers and extract a structured quota snapshot.
 * 📖 Returns null when no header pair matches (caller decides to keep stale).
 *
 * @param {Headers | Record<string, string> | null | undefined} headers
 * @returns {{ remaining: number, limit: number, percent: number, source: string, windowType: string } | null}
 */
export function extractQuota(headers) {
  for (const [remainingKey, limitKey] of HEADER_PAIRS) {
    const remainingRaw = readHeader(headers, remainingKey)
    const limitRaw = readHeader(headers, limitKey)
    if (remainingRaw == null || limitRaw == null) continue
    const remaining = Number.parseFloat(remainingRaw)
    const limit = Number.parseFloat(limitRaw)
    if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) continue
    const percent = Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)))
    // 📖 Derive windowType from the matching pair's key suffix.
    let windowType = 'requests'
    if (remainingKey.endsWith('-day')) windowType = 'day'
    else if (remainingKey.endsWith('-tokens-minute')) windowType = 'tokens-minute'
    else if (remainingKey.endsWith('-tokens')) windowType = 'tokens'
    return { remaining, limit, percent, source: remainingKey, windowType }
  }
  return null
}

/**
 * 📖 Internal: build a QuotaSnapshot from extractQuota() output + timestamp.
 */
function makeSnapshot(extracted, source = 'header', now = Date.now()) {
  return {
    remaining: extracted.remaining,
    limit: extracted.limit,
    percent: extracted.percent,
    windowType: extracted.windowType,
    headerSource: extracted.source,
    source,        // 'header' (passive) or 'endpoint' (active fetcher)
    lastUpdated: now,
  }
}

/**
 * 📖 processResponseHeaders: hook for the daemon reverse-proxy + ping responses.
 * 📖 Parses the response headers, writes the snapshot to the passive map, and
 * 📖 returns true if a snapshot was stored (so callers can decide to log).
 *
 * @param {string} providerKey
 * @param {Headers | Record<string, string> | null | undefined} headers
 * @param {object} [opts]
 * @param {number} [opts.now=Date.now()]
 * @returns {boolean} true if a snapshot was written
 */
export function processResponseHeaders(providerKey, headers, opts = {}) {
  if (!providerKey || typeof providerKey !== 'string') return false
  const now = opts.now ?? Date.now()
  const extracted = extractQuota(headers)
  if (!extracted) return false
  _passiveQuota.set(providerKey, makeSnapshot(extracted, 'header', now))
  return true
}

/**
 * 📖 Internal: read the latest active-fetcher snapshot for a provider. The active
 * 📖 fetcher uses a per-key Map of { value, expiresAt } entries; we synthesise a
 * 📖 QuotaSnapshot from that. Returns null if the active cache is empty/expired.
 */
function getActiveSnapshot(providerKey, now = Date.now()) {
  for (const [cacheKey, entry] of _defaultCache.entries()) {
    if (!cacheKey.startsWith(`${providerKey}:`)) continue
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) continue
    const value = entry.value
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    // 📖 lastUpdated must be when the value was actually fetched, not "now": a
    // 📖 TTL-cached value can be up to 60s old, and stamping it with now made it
    // 📖 always beat real passive header snapshots in getQuota's freshest-wins
    // 📖 pick while fabricating a fresh remaining/limit.
    const resolvedAt = typeof entry.resolvedAt === 'number'
      ? entry.resolvedAt
      : entry.expiresAt - DEFAULT_CACHE_TTL_MS
    return makeSnapshot(
      { remaining: value, limit: 100, percent: value, windowType: 'unknown', source: 'active_fetcher' },
      'endpoint',
      resolvedAt,
    )
  }
  return null
}

/**
 * 📖 getQuota: merge passive + active snapshots, return the freshest.
 * 📖 A snapshot is "stale" when older than STALENESS_MS. If both are stale,
 * 📖 returns null (caller should hide the chip).
 *
 * @param {string} providerKey
 * @param {object} [opts]
 * @param {number} [opts.now=Date.now()]
 * @param {number} [opts.maxAgeMs=STALENESS_MS]
 * @returns {QuotaSnapshot | null}
 */
export function getQuota(providerKey, opts = {}) {
  if (!providerKey) return null
  const now = opts.now ?? Date.now()
  const maxAgeMs = opts.maxAgeMs ?? STALENESS_MS
  const passive = _passiveQuota.get(providerKey) || null
  const active = getActiveSnapshot(providerKey, now)

  // 📖 Drop stale snapshots.
  const candidates = []
  if (passive && now - passive.lastUpdated <= maxAgeMs) candidates.push(passive)
  if (active && now - active.lastUpdated <= maxAgeMs) candidates.push(active)

  if (candidates.length === 0) return null
  // 📖 Freshest wins — tied timestamps prefer passive (it's the live signal).
  return candidates.reduce((a, b) => (a.lastUpdated >= b.lastUpdated ? a : b))
}

/**
 * 📖 getAllQuotas: snapshot of every provider we know about, merged passive+active.
 * 📖 Stale entries (older than maxAgeMs) are excluded. Used by /stats and the TUI footer.
 *
 * @param {object} [opts]
 * @returns {ReadonlyMap<string, QuotaSnapshot>}
 */
export function getAllQuotas(opts = {}) {
  const now = opts.now ?? Date.now()
  const maxAgeMs = opts.maxAgeMs ?? STALENESS_MS
  const out = new Map()
  // 📖 Union the keys from both passive and active stores so we don't miss a
  // 📖 provider whose latest signal only exists in one.
  const allKeys = new Set([..._passiveQuota.keys()])
  for (const cacheKey of _defaultCache.keys()) {
    const colon = cacheKey.indexOf(':')
    if (colon > 0) allKeys.add(cacheKey.slice(0, colon))
  }
  for (const providerKey of allKeys) {
    const q = getQuota(providerKey, { now, maxAgeMs })
    if (q) out.set(providerKey, q)
  }
  return out
}

/**
 * 📖 formatQuotaStatus: human-readable "⚠️ groq: 12/100 (12%) [day]" string.
 * 📖 Returns undefined when the snapshot is missing or stale (caller hides the chip).
 *
 * @param {string} providerKey
 * @param {object} [opts]
 * @returns {string | undefined}
 */
export function formatQuotaStatus(providerKey, opts = {}) {
  const snapshot = getQuota(providerKey, opts)
  if (!snapshot) return undefined
  const window = QUOTA_WINDOW_LABELS[snapshot.windowType] || snapshot.windowType
  const icon = snapshot.percent <= 10 ? '🚨' : snapshot.percent <= 25 ? '⚠️ ' : '📊'
  return `${icon} ${providerKey}: ${snapshot.remaining}/${snapshot.limit} (${snapshot.percent}%) [${window}]`
}

/**
 * 📖 resetPassiveQuota: clear the in-memory passive map. Test-only utility.
 */
export function resetPassiveQuota() {
  _passiveQuota.clear()
}

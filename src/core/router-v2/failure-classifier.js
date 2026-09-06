/**
 * @file failure-classifier.js
 * @description Typed failure classification for the Router v2 failover engine.
 *
 * @details
 *   📖 Router v1 treated almost every non-2xx the same way: increment
 *   `consecutiveFailures` and fail over. That punishes healthy models when the
 *   CLIENT payload is the problem (400/413/422 would burn 3 or 4 healthy
 *   models toward circuit-open for nothing), and it merges fundamentally
 *   different situations (dead key vs quota pause vs busy model) into one
 *   counter.
 *
 *   📖 v2 classifies every failure into a typed kind, and each kind carries an
 *   explicit policy: does the attempt fail over to the next candidate, does it
 *   damage the model's health (circuit breaker), does it block the whole
 *   provider (dead key), or does it pause the model for a quota window
 *   (Retry-After aware). The classifier is pure: it never mutates runtime
 *   state, so it is trivially unit-testable.
 *
 * @functions
 *   → classifyStatus(status) - Map an HTTP status code to a failure kind
 *   → classifyFailure(input) - Full verdict for a failure (kind + policy flags)
 *   → clientStatusForKind(kind) - Status code to send the client when every
 *     model in the set failed with that kind
 *
 * @exports FAILURE_KINDS, classifyStatus, classifyFailure, clientStatusForKind
 */

/**
 * 📖 Every failure kind the v2 router can produce. Kept as a plain frozen
 * object so tests and dashboards can enumerate them without relying on
 * `Object.keys` order of a TS enum-like structure.
 */
export const FAILURE_KINDS = Object.freeze({
  AUTH: 'auth_error',
  RATE_LIMIT: 'rate_limit',
  QUOTA: 'quota_exhausted',
  TIMEOUT: 'timeout',
  NETWORK: 'network_error',
  SERVER: 'provider_server_error',
  OVERLOADED: 'model_overloaded',
  INVALID_REQUEST: 'invalid_request',
  INVALID_JSON: 'invalid_json',
  EMPTY_CHOICES: 'empty_choices',
  EMPTY_CONTENT: 'empty_content',
  ERROR_PAYLOAD: 'error_payload',
  HTML: 'html_maintenance',
  EMPTY_STREAM: 'empty_stream',
  STREAM_STALL: 'stream_stall',
  PROVIDER_URL: 'provider_url_unresolvable',
})

// 📖 HTTP status → kind. 529 is the non-standard "Overloaded" status used by
// several inference providers: it is model-scoped (that specific model is
// busy), not a provider-wide outage.
const STATUS_KIND_MAP = new Map([
  [401, FAILURE_KINDS.AUTH],
  [403, FAILURE_KINDS.AUTH],
  [408, FAILURE_KINDS.TIMEOUT],
  [429, FAILURE_KINDS.RATE_LIMIT],
  [500, FAILURE_KINDS.SERVER],
  [502, FAILURE_KINDS.SERVER],
  [503, FAILURE_KINDS.SERVER],
  [504, FAILURE_KINDS.SERVER],
  [529, FAILURE_KINDS.OVERLOADED],
])

/**
 * 📖 Map an HTTP status code to a coarse failure kind.
 * @param {number} status
 * @returns {string} one of FAILURE_KINDS values
 */
export function classifyStatus(status) {
  const kind = STATUS_KIND_MAP.get(status)
  if (kind) return kind
  if (status >= 500) return FAILURE_KINDS.SERVER
  if (status >= 400) return FAILURE_KINDS.INVALID_REQUEST
  return FAILURE_KINDS.NETWORK
}

/**
 * 📖 Build the full policy verdict for a failure.
 *
 * @param {object} input
 * @param {string|null} [input.kind] - explicit kind (content-level failures);
 *   when omitted the kind is derived from `status`.
 * @param {number|null} [input.status] - upstream HTTP status
 * @param {number|null} [input.retryAfterMs] - parsed Retry-After from upstream
 * @returns {{
 *   kind: string,
 *   blame: 'provider'|'model'|'client',
 *   failover: boolean,
 *   healthDamage: boolean,
 *   blockProvider: boolean,
 *   quotaPauseMs: number|null,
 *   clientStatus: number,
 * }}
 */
export function classifyFailure({ kind = null, status = null, retryAfterMs = null } = {}) {
  const resolvedKind = kind || (status != null ? classifyStatus(status) : FAILURE_KINDS.NETWORK)

  switch (resolvedKind) {
    case FAILURE_KINDS.AUTH:
      // 📖 Dead or unauthorized key: fail over AND block the rest of this
      // provider for the request, but do NOT spin the circuit breaker: the
      // model itself is fine, the credential is not. markAuthError handles it.
      return {
        kind: resolvedKind,
        blame: 'provider',
        failover: true,
        healthDamage: false,
        blockProvider: true,
        quotaPauseMs: null,
        clientStatus: 401,
      }
    case FAILURE_KINDS.RATE_LIMIT:
    case FAILURE_KINDS.QUOTA: {
      // 📖 Rate limited: fail over and pause THIS model for the Retry-After
      // window (capped) so it stops eating traffic it cannot serve. Health
      // damage stays on: repeated 429s on every attempt legitimately mean
      // the model is not usable right now.
      const pauseMs = retryAfterMs != null ? Math.min(Math.max(0, retryAfterMs), 15 * 60 * 1000) : null
      return {
        kind: resolvedKind,
        blame: 'model',
        failover: true,
        healthDamage: true,
        blockProvider: false,
        quotaPauseMs: pauseMs,
        clientStatus: 429,
      }
    }
    case FAILURE_KINDS.INVALID_REQUEST:
      // 📖 Blame attribution fix: a 400/404/413/422 usually means the CLIENT
      // payload does not fit this model (unsupported tools, too-large body).
      // v2 still fails over (another model may accept the format) but never
      // counts it toward the circuit breaker, so one oversized payload can no
      // longer open circuits on three healthy models.
      return {
        kind: resolvedKind,
        blame: 'client',
        failover: true,
        healthDamage: false,
        blockProvider: false,
        quotaPauseMs: null,
        clientStatus: status || 400,
      }
    case FAILURE_KINDS.OVERLOADED:
      // 📖 529 "Overloaded" is scoped to the model, never the provider.
      return {
        kind: resolvedKind,
        blame: 'model',
        failover: true,
        healthDamage: true,
        blockProvider: false,
        quotaPauseMs: null,
        clientStatus: 529,
      }
    case FAILURE_KINDS.TIMEOUT:
    case FAILURE_KINDS.STREAM_STALL:
      return {
        kind: resolvedKind,
        blame: 'provider',
        failover: true,
        healthDamage: true,
        blockProvider: false,
        quotaPauseMs: null,
        clientStatus: 504,
      }
    case FAILURE_KINDS.NETWORK:
    case FAILURE_KINDS.SERVER:
    case FAILURE_KINDS.PROVIDER_URL:
      return {
        kind: resolvedKind,
        blame: 'provider',
        failover: true,
        healthDamage: true,
        blockProvider: false,
        quotaPauseMs: null,
        clientStatus: 502,
      }
    case FAILURE_KINDS.HTML:
      return {
        kind: resolvedKind,
        blame: 'provider',
        failover: true,
        healthDamage: true,
        blockProvider: false,
        quotaPauseMs: null,
        clientStatus: 503,
      }
    case FAILURE_KINDS.INVALID_JSON:
    case FAILURE_KINDS.EMPTY_CHOICES:
    case FAILURE_KINDS.EMPTY_CONTENT:
    case FAILURE_KINDS.ERROR_PAYLOAD:
    case FAILURE_KINDS.EMPTY_STREAM:
      // 📖 The notorious "HTTP 200 but garbage" family: the provider answered
      // with a usable transport envelope but no usable answer. These MUST fail
      // over and MUST count as real failures, otherwise the router "succeeds"
      // with empty output (v1's biggest blind spot).
      return {
        kind: resolvedKind,
        blame: 'provider',
        failover: true,
        healthDamage: true,
        blockProvider: false,
        quotaPauseMs: null,
        clientStatus: 502,
      }
    default:
      return {
        kind: resolvedKind,
        blame: 'provider',
        failover: true,
        healthDamage: true,
        blockProvider: false,
        quotaPauseMs: null,
        clientStatus: 502,
      }
  }
}

/**
 * 📖 Status code to send the client when every candidate failed with the same
 * kind. Used to refine the generic 503 "all models failed" response.
 * @param {string} kind
 * @returns {number}
 */
export function clientStatusForKind(kind) {
  return classifyFailure({ kind }).clientStatus
}

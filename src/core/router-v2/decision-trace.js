/**
 * @file decision-trace.js
 * @description Per-request routing decision trace for Router v2.
 *
 * @details
 *   📖 v1's request log had a single boolean `failover` tag: users could see
 *   THAT something switched, never WHY, and never which candidates were
 *   skipped (circuit open? quota pause? dead key?). v2 records an ordered
 *   trace for every request:
 *     - `skipped`: candidates excluded before any attempt, with the reason
 *     - `attempts`: what was actually dispatched, with status/latency/error
 *     - `served`: the model that produced the final answer
 *   The trace is attached to the response via short `x-fcm-v2-*` headers so
 *   agents can see routing decisions without opening a dashboard, and it is
 *   persisted to the request history for the TUI + web views.
 *
 *   📖 Privacy contract: traces carry routing metadata only (model keys,
 *   statuses, timings, error KIND strings). No prompts, no response bodies,
 *   no API keys, no upstream URLs.
 *
 * @functions
 *   → createDecisionTrace(input) - New trace object for a request
 *   → traceSkip(trace, model, reason) - Record a pre-dispatch skip
 *   → traceAttempt(trace, model, result) - Record a dispatch attempt
 *   → finishTrace(trace, result) - Close the trace with the final outcome
 *   → decisionHeaderValue(trace) - Compact single-line header value
 *   → traceSummary(trace) - Human-facing summary for logs and dashboards
 *
 * @exports createDecisionTrace, traceSkip, traceAttempt, finishTrace
 * @exports decisionHeaderValue, traceSummary
 */

import { randomUUID } from 'node:crypto'

/**
 * 📖 Create the trace object for one routed request.
 * @param {{ requestId?: string, set?: string, protocol?: 'openai'|'anthropic',
 *           modelRequested?: string, pinnedModel?: string|null }} input
 */
export function createDecisionTrace({ requestId = null, set = null, protocol = 'openai', modelRequested = null, pinnedModel = null } = {}) {
  return {
    request_id: requestId || `req-${randomUUID()}`,
    at: new Date().toISOString(),
    set,
    protocol,
    model_requested: modelRequested,
    pinned_model: pinnedModel,
    skipped: [],
    attempts: [],
    served_model: null,
    last_resort_used: false,
    outcome: null,
    wall_ms: null,
    tokens: 0,
  }
}

/**
 * 📖 Record that a candidate was excluded BEFORE any dispatch, with the
 * machine-readable reason (`circuit_open`, `quota_paused`, `auth_error`,
 * `stale`, `missing_key`, `provider_blocked`, ...).
 */
export function traceSkip(trace, model, reason) {
  if (!trace) return
  trace.skipped.push({ model, reason, at: new Date().toISOString() })
}

/**
 * 📖 Record a dispatch attempt. `result` mirrors the proxy functions' return
 * shape: `{ status, latencyMs, error }` where error is a failure KIND string.
 */
export function traceAttempt(trace, model, { status = null, latencyMs = null, error = null } = {}) {
  if (!trace) return
  trace.attempts.push({
    model,
    status,
    latency_ms: latencyMs,
    error: error || null,
    at: new Date().toISOString(),
  })
  trace.total_attempts = trace.attempts.length
}

/**
 * 📖 Close the trace. `outcome` is one of: 'served' | 'all_failed' |
 * 'client_aborted' | 'rejected' | 'overloaded'.
 */
export function finishTrace(trace, { outcome, servedModel = null, wallMs = null, lastResort = false, tokens = 0 } = {}) {
  if (!trace) return null
  trace.outcome = outcome
  trace.served_model = servedModel
  trace.wall_ms = wallMs
  trace.last_resort_used = lastResort === true
  trace.tokens = tokens
  return trace
}

/**
 * 📖 Compact single-line value for the `x-fcm-v2-decision` response header.
 * Format: `servedModel!outcome|attempt1:status->attempt2:status|skips=N`.
 * Header values must be ASCII one-liners, so model keys are already safe
 * (provider/model ids) and everything else is bounded and truncated.
 *
 * @returns {string}
 */
export function decisionHeaderValue(trace) {
  if (!trace) return 'unknown'
  const attempts = (trace.attempts || [])
    .map((a) => `${a.model}:${a.status ?? a.error ?? 'ERR'}`)
    .join('->')
    .slice(0, 300)
  const parts = [
    `${trace.served_model || 'none'}!${trace.outcome || 'pending'}`,
    attempts || 'no-attempts',
    `skips=${(trace.skipped || []).length}`,
  ]
  return parts.join('|').slice(0, 480)
}

/**
 * 📖 Human-facing one-liner for logs, TUI overlays and history tables.
 * @returns {string}
 */
export function traceSummary(trace) {
  if (!trace) return ''
  const chain = (trace.attempts || [])
    .map((a) => `${a.model}${a.error ? `(${a.error})` : a.status ? `(${a.status})` : ''}`)
    .join(' -> ')
  const skips = (trace.skipped || []).length
  const base = chain || 'no candidate dispatched'
  const suffix = skips > 0 ? ` [${skips} skipped]` : ''
  const lastResort = trace.last_resort_used ? ' [last-resort]' : ''
  return `${base}${suffix}${lastResort}`
}

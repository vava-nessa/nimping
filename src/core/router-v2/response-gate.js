/**
 * @file response-gate.js
 * @description Content-level response validation for Router v2.
 *
 * @details
 *   📖 The single biggest v1 blind spot: free providers sometimes answer
 *   HTTP 200 with an empty `choices` array, an embedded `error` object, or an
 *   SSE stream that closes without ever producing useful content. v1 counted
 *   all of those as SUCCESS, so the failover engine never fired and coding
 *   agents silently received nothing.
 *
 *   📖 The gate lives in two layers:
 *   - `validateChatCompletionPayload` checks a parsed non-streaming 200 body.
 *   - `createStreamReadinessTracker` inspects SSE chunks as they arrive and
 *     answers "has this stream produced anything useful yet?" so the daemon
 *     can hold the first chunks briefly, fail over on an error payload before
 *     anything reaches the client, and treat a content-less close as a real
 *     failure.
 *
 *   📖 "Useful content" means: a non-empty text delta, tool_calls, a legacy
 *   function_call, or reasoning tokens. A bare `{role: "assistant"}` first
 *   chunk is normal framing, not content. Reasoning-only output DOES count
 *   (some thinking models stream reasoning before text), so it is never
 *   treated as a failure.
 *
 * @functions
 *   → validateChatCompletionPayload(payload, opts) - Gate a parsed JSON body
 *   → createStreamReadinessTracker() - Incremental SSE usefulness tracker
 *   → estimateTokens(text) - Cheap completion-token estimate for streams
 *
 * @exports validateChatCompletionPayload, createStreamReadinessTracker, estimateTokens
 */

// 📖 A single SSE event larger than this cannot be a useful first frame of a
// coding answer; treat it as unparsable garbage rather than buffering forever.
const MAX_HOLD_BUFFER_BYTES = 256 * 1024

/**
 * 📖 Validate a parsed non-streaming chat-completion payload.
 *
 * @param {unknown} payload - the JSON.parse result of a 200 body
 * @param {{ mode?: 'strict'|'basic' }} [opts]
 *   - strict (default): also requires the first choice to carry actual
 *     content (text, tool_calls, function_call or reasoning).
 *   - basic: only rejects structural garbage (no choices, embedded error).
 * @returns {{ ok: boolean, reason: string|null, detail: string|null }}
 */
export function validateChatCompletionPayload(payload, { mode = 'strict' } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid_json', detail: 'payload is not an object' }
  }
  if (payload.error !== undefined && payload.error !== null) {
    const err = payload.error
    const detail = typeof err === 'object' && err !== null
      ? String(err.code || err.type || err.message || 'upstream error object').slice(0, 200)
      : String(err).slice(0, 200)
    return { ok: false, reason: 'error_payload', detail }
  }
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
    return { ok: false, reason: 'empty_choices', detail: 'choices missing or empty' }
  }
  if (mode === 'basic') return { ok: true, reason: null, detail: null }

  const choice = payload.choices[0]
  if (!choice || typeof choice !== 'object') {
    return { ok: false, reason: 'empty_content', detail: 'first choice is not an object' }
  }
  const msg = choice.message
  const content = typeof msg?.content === 'string' ? msg.content.trim() : ''
  const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0
  const hasFunctionCall = msg?.function_call != null
  const reasoning = typeof msg?.reasoning_content === 'string' ? msg.reasoning_content.trim() : ''
  const reasoningAlt = typeof msg?.reasoning === 'string' ? msg.reasoning.trim() : ''
  if (!content && !hasToolCalls && !hasFunctionCall && !reasoning && !reasoningAlt) {
    return { ok: false, reason: 'empty_content', detail: 'no text, tool_calls or reasoning in first choice' }
  }
  return { ok: true, reason: null, detail: null }
}

/**
 * 📖 Incremental tracker for SSE streams. Feed every decoded text chunk into
 * `observe()`; the tracker extracts `data:` JSON payloads and reports:
 *   - useful: seen real content (text delta, tool_calls, reasoning, ...)
 *   - errorPayload: an SSE `data:` frame carried an `error` object
 * The daemon combines those signals with its hold-buffer policy to decide
 * between flush-to-client, fail-over-before-first-byte, and "content-less
 * stream = failure".
 *
 * @returns {{
 *   observe(text: string): void,
 *   get useful(): boolean,
 *   get errorPayload(): boolean,
 *   get bytesSeen(): number,
 *   get unparsableFrames(): number,
 *   describe(): string,
 * }}
 */
export function createStreamReadinessTracker() {
  let useful = false
  let errorPayload = false
  let bytesSeen = 0
  let unparsableFrames = 0
  let lineRemainder = ''

  const inspectDataPayload = (raw) => {
    const trimmed = raw.trim()
    if (!trimmed || trimmed === '[DONE]') return
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      unparsableFrames += 1
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    if (parsed.error !== undefined && parsed.error !== null) {
      errorPayload = true
      return
    }
    const choices = parsed.choices
    if (!Array.isArray(choices)) return
    for (const choice of choices) {
      const delta = choice?.delta ?? choice?.message
      if (!delta || typeof delta !== 'object') continue
      const content = typeof delta.content === 'string' ? delta.content : ''
      if (content.length > 0) useful = true
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) useful = true
      if (delta.function_call != null) useful = true
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
      if (reasoning.length > 0) useful = true
      const reasoningAlt = typeof delta.reasoning === 'string' ? delta.reasoning : ''
      if (reasoningAlt.length > 0) useful = true
    }
  }

  return {
    observe(text) {
      if (typeof text !== 'string' || text.length === 0) return
      bytesSeen += Buffer.byteLength(text)
      const data = lineRemainder + text
      const lines = data.split('\n')
      // 📖 The last element is either an incomplete line (keep it for next
      // chunk) or an empty trailing piece after a final newline.
      lineRemainder = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        if (trimmed.startsWith('data:')) {
          inspectDataPayload(trimmed.slice(5))
          if (useful && errorPayload) return
        }
      }
    },
    get useful() { return useful },
    get errorPayload() { return errorPayload },
    get bytesSeen() { return bytesSeen },
    get unparsableFrames() { return unparsableFrames },
    get maxHoldBytes() { return MAX_HOLD_BUFFER_BYTES },
    describe() {
      return `useful=${useful} error=${errorPayload} bytes=${bytesSeen} unparsable=${unparsableFrames}`
    },
  }
}

/**
 * 📖 Cheap completion-token estimate for streamed responses where the
 * upstream never sends a usage block. Roughly 4 characters per token is the
 * usual rule of thumb for English/code; good enough for usage dashboards.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

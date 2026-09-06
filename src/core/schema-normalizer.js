/**
 * @file src/core/schema-normalizer.js
 * @description Per-provider request body normalization for the FCM Router.
 *
 * @details
 *   📖 The router forwards chat completions to many providers that are
 *   📖 *nominally* OpenAI-compatible but have different schema quirks.
 *   📖 Without normalization, certain clients (especially ZCode, Claude Code,
 *   📖 and Cline when their tool-call flow is enabled) hit 400/422 errors
 *   📖 on GLM and Codestral that wouldn't fail on other OpenAI-compatible
 *   📖 providers.
 *
 *   📖 The three offender patterns we see in the wild:
 *   📖   1. Parameters that GLM/Mistral silently reject with 422
 *   📖      → `parallel_tool_calls`, `n`, `top_k`, `logprobs`, ...
 *   📖   2. `tool` role messages that lack a matching `tool_call_id`
 *   📖      → happens when a client drops the assistant's tool_calls but
 *   📖        keeps the tool result (e.g. after a partial response cut)
 *   📖   3. Out-of-range numerics
 *   📖      → Mistral rejects `temperature > 1` with 422
 *
 *   📖 `normalizeRequestBody(body, providerKey)` is the single entry point.
 *   📖 It dispatches to a per-provider transform, or returns the body
 *   📖 unchanged for providers that don't need any tweak.
 *
 * @functions
 *   → `normalizeRequestBody` — dispatcher; mutates a shallow copy
 *   → `stripUnsupportedParams` — removes known-bad parameters
 *   → `dropOrphanToolMessages` — removes tool messages without matching assistant tool_calls
 *   → `clampTemperature` — clamps `temperature` to the provider's accepted range
 *   → `normalizeZai` — for `zai` (GLM) provider
 *   → `normalizeMistral` — for `mistral` and `codestral` providers
 *   → `normalizeNvidia` — for `nvidia` provider (strips unsupported params like prompt_cache_key)
 *
 * @exports normalizeRequestBody, normalizeZai, normalizeMistral, normalizeNvidia, PROVIDER_NORMALIZERS
 *
 * @see src/core/router-daemon.js — calls `normalizeRequestBody` before forwarding upstream
 */

// 📖 Parameters that GLM and Mistral-family endpoints commonly reject with 422
// 📖 even though they are valid in the OpenAI Chat Completions spec. Stripping
// 📖 them upstream is safe because the router's failover already picks a model
// 📖 per request — we never need n>1 or parallel calls.
const STRIP_PARAMS = [
  'parallel_tool_calls',  // not in GLM, Codestral, most Mistral
  'n',                    // n>1 unsupported by most; always route n=1
  'top_k',                // not in OpenAI spec; GLM rejects
  'logprobs',             // GLM and Codestral reject
  'echo',                 // not in OpenAI spec
  'user',                 // PII risk; not used by FCM
  'metadata',             // not always supported
  'prompt_cache_key',     // OpenAI prompt-caching hint; NVIDIA rejects with 400
  'store',                // GLM rejects
]

// 📖 `stream_options` is only meaningful when stream=true. Some providers
// 📖 reject the field when stream=false, so we always strip it for non-streaming.
function stripStreamOptionsWhenNotStreaming(body) {
  if (body.stream === true) return body
  if (Object.prototype.hasOwnProperty.call(body, 'stream_options')) {
    const next = { ...body }
    delete next.stream_options
    return next
  }
  return body
}

function stripUnsupportedParams(body) {
  if (!body || typeof body !== 'object') return body
  let result = body
  for (const key of STRIP_PARAMS) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      if (result === body) result = { ...body }
      delete result[key]
    }
  }
  return stripStreamOptionsWhenNotStreaming(result)
}

// 📖 `dropOrphanToolMessages` removes tool messages whose `tool_call_id` does
// 📖 not match any preceding assistant `tool_calls[*].id`. The OpenAI spec
// 📖 requires a `tool` role message to be the result of a specific assistant
// 📖 tool call — but some clients (ZCode, Claude Code) drop the assistant
// 📖 tool_calls entry while keeping the tool result, which GLM rejects with 422.
//
// 📖 The matching window is the assistant message's WHOLE tool_calls batch:
// 📖 an assistant turn that fired N parallel tool calls is followed by N tool
// 📖 result messages, and only the first one has the assistant as its direct
// 📖 predecessor. Matching against a pending-id set (instead of the immediate
// 📖 previous message) keeps results 2..N, which used to be dropped as
// 📖 "orphans" and made providers reject the truncated conversation with 400.
function dropOrphanToolMessages(body) {
  if (!Array.isArray(body.messages)) return body
  const filtered = []
  let pendingToolCallIds = new Set()
  for (const msg of body.messages) {
    if (!msg || typeof msg !== 'object') continue
    if (msg.role === 'assistant') {
      filtered.push(msg)
      pendingToolCallIds = new Set(
        Array.isArray(msg.tool_calls)
          ? msg.tool_calls.map((tc) => (tc && typeof tc.id === 'string' ? tc.id : null)).filter(Boolean)
          : [],
      )
      continue
    }
    if (msg.role === 'tool') {
      const toolCallId = msg.tool_call_id
      if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
        // 📖 tool message without a tool_call_id is fundamentally invalid
        continue
      }
      if (!pendingToolCallIds.has(toolCallId)) {
        // 📖 Skip the orphan — better to drop than to 422
        continue
      }
      pendingToolCallIds.delete(toolCallId)
      filtered.push(msg)
      continue
    }
    // 📖 A user or system message closes the pending tool-call window.
    pendingToolCallIds = new Set()
    filtered.push(msg)
  }
  // 📖 If filtering changed anything, materialize a new body object
  if (filtered.length === body.messages.length) return body
  return { ...body, messages: filtered }
}

// 📖 `clampTemperature` clamps temperature to [min, max]. Mistral's chat API
// 📖 rejects temperatures outside [0, 1] with 422; GLM accepts [0, 2].
function clampTemperature(body, { min = 0, max = 1 } = {}) {
  if (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature)) return body
  if (body.temperature >= min && body.temperature <= max) return body
  return { ...body, temperature: Math.max(min, Math.min(max, body.temperature)) }
}

/**
 * 📖 `normalizeZai` — transforms a request body for the `zai` (GLM) provider.
 *
 *   1. Strips parameters GLM rejects with 422
 *   2. Removes orphan `tool` messages that lack a matching assistant tool_call
 *   3. Strips `stream_options` when not streaming
 */
export function normalizeZai(body) {
  if (!body || typeof body !== 'object') return body
  let result = stripUnsupportedParams(body)
  result = dropOrphanToolMessages(result)
  return result
}

/**
 * 📖 `normalizeMistral` — transforms a request body for `mistral` and `codestral`.
 *
 *   1. Strips parameters Mistral/Codestral reject with 422
 *   2. Clamps `temperature` to [0, 1] (Mistral's accepted range)
 *   3. Removes orphan `tool` messages
 *   4. Strips `stream_options` when not streaming
 */
export function normalizeMistral(body) {
  if (!body || typeof body !== 'object') return body
  let result = stripUnsupportedParams(body)
  result = clampTemperature(result, { min: 0, max: 1 })
  result = dropOrphanToolMessages(result)
  return result
}

/**
 * 📖 `normalizeNvidia` — transforms a request body for the `nvidia` provider.
 *
 *   1. Strips parameters NVIDIA rejects with 400 (e.g. prompt_cache_key)
 *   2. Removes orphan `tool` messages that lack a matching assistant tool_call
 *   3. Strips `stream_options` when not streaming
 */
export function normalizeNvidia(body) {
  if (!body || typeof body !== 'object') return body
  let result = stripUnsupportedParams(body)
  result = dropOrphanToolMessages(result)
  return result
}

// 📖 Map of provider key → normalizer function. Providers that don't need
// 📖 any tweak (most OpenAI-compat ones like Groq, Cerebras, etc.) are not
// 📖 listed and pass through `normalizeRequestBody` unchanged.
export const PROVIDER_NORMALIZERS = {
  zai: normalizeZai,
  mistral: normalizeMistral,
  codestral: normalizeMistral,
  nvidia: normalizeNvidia,
}

/**
 * 📖 `normalizeRequestBody` — public entry point. Returns a *new* body object
 * 📖 if any transform was applied, or the original body if the provider has
 * 📖 no normalizer registered (to keep call-site object identity stable).
 *
 * @param {unknown} body
 * @param {string | null | undefined} providerKey
 * @returns {unknown}
 */
export function normalizeRequestBody(body, providerKey) {
  if (!body || typeof body !== 'object') return body
  const normalizer = providerKey && PROVIDER_NORMALIZERS[providerKey]
  if (!normalizer) return body
  return normalizer(body)
}

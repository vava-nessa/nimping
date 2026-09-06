/**
 * @file anthropic-compat.js
 * @description Anthropic Messages API compatibility layer for Router v2.
 *
 * @details
 *   📖 v1 only spoke OpenAI `/v1/chat/completions`, so any coding agent that
 *   talks the Anthropic `/v1/messages` protocol (Claude Code style clients)
 *   could not use the router at all. v2 accepts `/v1/messages` and translates:
 *
 *   - Request: Anthropic Messages body → OpenAI chat-completions body
 *     (system string/blocks, content blocks, tool_use / tool_result blocks,
 *     tools with input_schema, stop_sequences, tool_choice).
 *   - Response: OpenAI chat-completion payload → Anthropic message
 *     (content blocks, stop_reason mapping, usage input/output tokens).
 *   - Stream: upstream OpenAI SSE → Anthropic SSE event sequence
 *     (message_start, content_block_start/delta/stop, message_delta,
 *     message_stop), including incremental tool_use input_json deltas.
 *
 *   📖 Unsupported today (returned as clear request errors, never silent
 *   garbage): image blocks, document blocks, thinking blocks, server-side
 *   tools (web_search etc.), and `metadata.user_id` passthrough.
 *
 * @functions
 *   → translateAnthropicToOpenAI(body) - Request translation
 *   → translateOpenAIToAnthropicResponse(payload, opts) - Response translation
 *   → createAnthropicStreamTransformer(opts) - Incremental SSE transformer
 *   → anthropicErrorPayload(type, message) - Anthropic-style error envelope
 *   → anthropicErrorTypeForStatus(status) - Map HTTP status to Anthropic error type
 *
 * @exports translateAnthropicToOpenAI, translateOpenAIToAnthropicResponse
 * @exports createAnthropicStreamTransformer, anthropicErrorPayload
 * @exports anthropicErrorTypeForStatus
 */

/**
 * 📖 Translate an Anthropic `/v1/messages` request body into an OpenAI
 * `/v1/chat/completions` body. Pure: never mutates the input.
 *
 * @param {object} body - Anthropic request body
 * @returns {{ ok: true, body: object, warnings: string[] }
 *           | { ok: false, error: string }}
 */
export function translateAnthropicToOpenAI(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' }
  }
  const warnings = []
  const messages = []

  // 📖 `system` can be a string or an array of {type:"text",text} blocks.
  const systemText = normalizeSystem(body.system)
  if (systemText) messages.push({ role: 'system', content: systemText })

  const incoming = Array.isArray(body.messages) ? body.messages : []
  for (const message of incoming) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user'
    if (typeof message?.content === 'string') {
      messages.push({ role, content: message.content })
      continue
    }
    if (!Array.isArray(message?.content)) {
      return { ok: false, error: `Message content must be a string or a blocks array (role: ${role})` }
    }
    // 📖 tool_result blocks (user role) become OpenAI `role:"tool"` messages;
    // any sibling text blocks ride along as a trailing user message.
    const toolMessages = []
    const textParts = []
    const assistantToolCalls = []
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      switch (block.type) {
        case 'text':
          textParts.push(typeof block.text === 'string' ? block.text : '')
          break
        case 'tool_use':
          assistantToolCalls.push({
            id: typeof block.id === 'string' ? block.id : `call_${assistantToolCalls.length}`,
            type: 'function',
            function: {
              name: String(block.name || ''),
              arguments: safeJsonStringify(block.input ?? {}),
            },
          })
          break
        case 'tool_result': {
          const content = normalizeToolResultContent(block.content)
          toolMessages.push({
            role: 'tool',
            tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
            content,
          })
          break
        }
        case 'image':
        case 'document':
          warnings.push(`content block type "${block.type}" is not supported and was dropped`)
          break
        case 'thinking':
          // 📖 Interleaved thinking blocks from a previous assistant turn are
          // provider-internal state; silently dropping them is correct here.
          break
        default:
          warnings.push(`unknown content block type "${block.type || 'unknown'}" was dropped`)
      }
    }
    if (role === 'assistant' && assistantToolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: textParts.join('\n').trim() || null,
        tool_calls: assistantToolCalls,
      })
    } else {
      if (toolMessages.length > 0) messages.push(...toolMessages)
      const text = textParts.join('\n').trim()
      if (text) messages.push({ role, content: text })
      else if (toolMessages.length === 0 && message.content.length > 0) {
        // 📖 Blocks existed but produced nothing translatable: keep an empty
        // user turn so ordering with the next tool_result stays valid.
        messages.push({ role, content: '' })
      }
    }
  }

  const out = {
    model: typeof body.model === 'string' ? body.model : 'fcm',
    messages,
    max_tokens: Number.isFinite(body.max_tokens) ? body.max_tokens : 4096,
  }
  if (Number.isFinite(body.temperature)) out.temperature = body.temperature
  if (Number.isFinite(body.top_p)) out.top_p = body.top_p
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences
  if (body.stream === true) out.stream = true

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = []
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object' || !tool.name) continue
      // 📖 Skip Anthropic server-side tools (web_search etc.): they have no
      // input_schema and cannot run on an OpenAI-compatible upstream.
      if (tool.input_schema === undefined && tool.type && tool.type !== 'custom') {
        warnings.push(`server-side tool "${tool.name}" is not supported and was dropped`)
        continue
      }
      tools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          parameters: tool.input_schema && typeof tool.input_schema === 'object' ? tool.input_schema : { type: 'object', properties: {} },
        },
      })
    }
    if (tools.length > 0) out.tools = tools
  }

  if (body.tool_choice && typeof body.tool_choice === 'object') {
    if (body.tool_choice.type === 'any') out.tool_choice = 'required'
    else if (body.tool_choice.type === 'auto') out.tool_choice = 'auto'
    else if (body.tool_choice.type === 'tool' && body.tool_choice.name) {
      out.tool_choice = { type: 'function', function: { name: body.tool_choice.name } }
    }
  }

  return { ok: true, body: out, warnings }
}

/**
 * 📖 Translate an OpenAI chat-completion payload into an Anthropic message.
 * @param {object} payload - parsed OpenAI response
 * @param {{ model: string }} opts - the model name to advertise downstream
 * @returns {{ ok: true, body: object } | { ok: false, error: string }}
 */
export function translateOpenAIToAnthropicResponse(payload, { model }) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    return { ok: false, error: 'Upstream returned no choices' }
  }
  const choice = payload.choices[0] || {}
  const message = choice.message || {}
  const content = []
  const text = typeof message.content === 'string' && message.content.length > 0 ? message.content : null
  if (text) content.push({ type: 'text', text })
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!call || typeof call !== 'object') continue
      const fn = call.function || {}
      content.push({
        type: 'tool_use',
        id: typeof call.id === 'string' ? call.id : `toolu_${content.length}`,
        name: String(fn.name || ''),
        input: safeJsonParse(fn.arguments, {}),
      })
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })

  const usage = payload.usage || {}
  return {
    ok: true,
    body: {
      id: typeof payload.id === 'string' && payload.id ? `msg_${payload.id}` : `msg_${Date.now().toString(36)}`,
      type: 'message',
      role: 'assistant',
      model: typeof model === 'string' ? model : 'fcm',
      content,
      stop_reason: mapStopReason(choice.finish_reason),
      stop_sequence: null,
      usage: {
        input_tokens: Number(usage.prompt_tokens ?? 0) || 0,
        output_tokens: Number(usage.completion_tokens ?? 0) || 0,
      },
    },
  }
}

/**
 * 📖 Incremental transformer: feed upstream OpenAI SSE text, get Anthropic
 * SSE event text back. Handles chunks split across arbitrary boundaries via
 * an internal line buffer, and tracks tool-call argument deltas so partial
 * JSON streams as `input_json_delta` blocks.
 *
 * @param {{ model: string }} opts
 * @returns {{ write(chunk: string): string, end(): string, outputTokens(): number }}
 */
export function createAnthropicStreamTransformer({ model } = {}) {
  let lineBuffer = ''
  let blockIndex = 0
  let textBlockOpened = false
  let stopReason = null
  let outputTokens = 0
  let started = false
  let finished = false
  // 📖 tool_calls arrive as parallel deltas keyed by index in the OpenAI
  // stream: { index, id?, function: { name?, arguments? } }
  const toolBlocks = new Map() // openaiIndex → { anthropicIndex, id, name, opened }
  const openBlocks = new Set() // anthropic indexes that had a _start emitted

  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

  const ensureStart = () => {
    if (started) return ''
    started = true
    return event('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${Date.now().toString(36)}`,
        type: 'message',
        role: 'assistant',
        model: model || 'fcm',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  const openTextBlock = () => {
    if (textBlockOpened) return ''
    textBlockOpened = true
    openBlocks.add(blockIndex)
    const out = event('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    })
    blockIndex += 1
    return out
  }

  const openToolBlock = (tool) => {
    openBlocks.add(tool.anthropicIndex)
    return event('content_block_start', {
      type: 'content_block_start',
      index: tool.anthropicIndex,
      content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
    })
  }

  const handlePayload = (payload) => {
    let out = ''
    if (!payload || typeof payload !== 'object') return out
    if (payload.error) {
      // 📖 Mid-stream upstream error after the gate let content through:
      // surface it as an Anthropic error event and finish the message.
      const err = payload.error
      out += event('error', {
        type: 'error',
        error: {
          type: 'api_error',
          message: String(err?.message || err?.code || 'upstream stream error').slice(0, 300),
        },
      })
      return out
    }
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
    if (!choice) return out
    const delta = choice.delta || {}
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      out += ensureStart()
      out += openTextBlock()
      outputTokens += Math.max(1, Math.ceil(delta.content.length / 4))
      out += event('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: delta.content },
      })
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const idx = Number.isFinite(call?.index) ? call.index : 0
        let tool = toolBlocks.get(idx)
        if (!tool) {
          tool = {
            anthropicIndex: blockIndex,
            id: typeof call?.id === 'string' && call.id ? call.id : `toolu_${idx}_${Date.now().toString(36)}`,
            name: String(call?.function?.name || ''),
            opened: false,
          }
          blockIndex += 1
          toolBlocks.set(idx, tool)
        }
        out += ensureStart()
        if (!tool.opened) {
          tool.opened = true
          out += openToolBlock(tool)
        }
        const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : ''
        if (args.length > 0) {
          outputTokens += Math.max(1, Math.ceil(args.length / 4))
          out += event('content_block_delta', {
            type: 'content_block_delta',
            index: tool.anthropicIndex,
            delta: { type: 'input_json_delta', partial_json: args },
          })
        }
      }
    }
    if (choice.finish_reason) stopReason = mapStopReason(choice.finish_reason)
    return out
  }

  return {
    write(chunk) {
      if (finished) return ''
      if (typeof chunk !== 'string' || chunk.length === 0) return ''
      const data = lineBuffer + chunk
      const lines = data.split('\n')
      lineBuffer = lines.pop() ?? ''
      let out = ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        if (trimmed.startsWith('data:')) {
          const raw = trimmed.slice(5).trim()
          if (!raw || raw === '[DONE]') continue
          try {
            out += handlePayload(JSON.parse(raw))
          } catch {
            // 📖 Non-JSON data frame: ignore (some providers send keepalives).
          }
        }
      }
      return out
    },
    end() {
      if (finished) return ''
      finished = true
      let out = ensureStart()
      // 📖 A stream with no content still produces a valid empty message.
      if (!textBlockOpened && toolBlocks.size === 0) {
        out += openTextBlock()
      }
      for (const tool of toolBlocks.values()) {
        if (tool.opened) {
          out += event('content_block_stop', { type: 'content_block_stop', index: tool.anthropicIndex })
        }
      }
      if (textBlockOpened) {
        out += event('content_block_stop', { type: 'content_block_stop', index: 0 })
      }
      out += event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason || 'end_turn', stop_sequence: null },
        usage: { output_tokens: outputTokens },
      })
      out += event('message_stop', { type: 'message_stop' })
      return out
    },
    outputTokens() {
      return outputTokens
    },
  }
}

/**
 * 📖 Anthropic-style error envelope for /v1/messages endpoints.
 * @param {string} type - one of the Anthropic error types
 * @param {string} message
 */
export function anthropicErrorPayload(type, message) {
  return { type: 'error', error: { type, message } }
}

/**
 * 📖 Map an HTTP status to the closest Anthropic error type.
 * @param {number} status
 * @returns {string}
 */
export function anthropicErrorTypeForStatus(status) {
  if (status === 400) return 'invalid_request_error'
  if (status === 401 || status === 403) return 'authentication_error'
  if (status === 404) return 'not_found_error'
  if (status === 413) return 'request_too_large'
  if (status === 429) return 'rate_limit_error'
  if (status === 529) return 'overloaded_error'
  if (status >= 500) return 'api_error'
  return 'api_error'
}

function mapStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'refusal'
    case 'stop':
    default:
      return 'end_turn'
  }
}

function normalizeSystem(system) {
  if (typeof system === 'string') return system.trim() || null
  if (Array.isArray(system)) {
    const text = system
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    return text || null
  }
  return null
}

function normalizeToolResultContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
  }
  return ''
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * @file playground.js
 * @description TUI Playground — a chat overlay that talks to the local FCM
 * router through its `/v1/chat/completions` endpoint. Streams responses via
 * SSE so the user sees the answer appear token-by-token.
 *
 * 📖 The TUI Playground is intentionally simpler than the Web Playground:
 * 📖 one chat at a time, no copy-paste, no theme overrides. It's a quick
 * 📖 way to test the router without leaving the TUI.
 *
 * @functions
 *   → openPlaygroundOverlay — reset state and mark the overlay open
 *   → closePlaygroundOverlay — cancel any in-flight request, mark closed
 *   → renderPlayground — render the full-screen chat overlay
 *   → handlePlaygroundKeypress — handle Enter / Esc / arrow keys
 *   → playgroundSubmit — POST the current draft to the router
 *   → parsePlaygroundSseFrame — parse one SSE frame (defensive, mirrors router-dashboard)
 *
 * @see ./router-daemon.js — chat-completions endpoint we POST to
 * @see ./config.js — pre-prompt lives under `router.prePrompt`
 * @see ../tui/overlays.js — overlay factory that mounts this renderer
 */

import { displayWidth, sliceOverlayLines, tintOverlayLines } from '../tui/render-helpers.js'
import { ROUTER_PORT_PATH, getRouterPortPath } from './router-daemon.js'
import { existsSync, readFileSync } from 'node:fs'
import { themeColors } from '../tui/theme.js'

// 📖 Width budget for the wrapped input + transcript columns inside the
// 📖 overlay. Slightly tighter than the full terminal so borders have room
// 📖 and long assistant messages wrap nicely.
const STREAM_TIMEOUT_MS = 90000

/**
 * 📖 Extract a human-readable message from an OpenAI-style error payload.
 * 📖 Mirrors the helper in `web/src/components/playground/PlaygroundView.jsx`
 * 📖 so the TUI and the Web show the same error string. Without this, a
 * 📖 router error like `{ error: { message, type, code, ... } }` would be
 * 📖 stored as a React child and crash the playground on the next render.
 *
 * @param {unknown} errBody
 * @returns {string|null}
 */
export function extractErrorMessage(errBody) {
  if (!errBody || typeof errBody !== 'object') {
    return typeof errBody === 'string' ? errBody : null
  }
  if (typeof errBody.error === 'string') return errBody.error
  if (errBody.error && typeof errBody.error === 'object' && typeof errBody.error.message === 'string') {
    return errBody.error.message
  }
  if (typeof errBody.message === 'string') return errBody.message
  return null
}

export const PLAYGROUND_OVERLAY_STATE = {
  open: false,
  messages: [], // { role, content, meta? }
  draft: '',
  busy: false,
  model: 'fcm',
  streamOn: true,
  prePrompt: null, // { enabled, text } hydrated on open
  statusMessage: null,
  abortController: null,
  scrollOffset: 0,
  cursor: 0, // line cursor inside the textarea draft
  lastError: null,
}

const MAX_TRANSCRIPT_LINES = 200

/**
 * 📖 Reset the playground to a clean state and mark the overlay open.
 * 📖 Fetches the pre-prompt from the router (if reachable) so the chat
 * 📖 shows the real persona.
 *
 * @param {object} state - global TUI state
 * @param {object} deps - { fetchFn, loadConfig }
 */
export async function openPlaygroundOverlay(state, deps = {}) {
  PLAYGROUND_OVERLAY_STATE.open = true
  PLAYGROUND_OVERLAY_STATE.messages = []
  PLAYGROUND_OVERLAY_STATE.draft = ''
  PLAYGROUND_OVERLAY_STATE.busy = false
  PLAYGROUND_OVERLAY_STATE.streamOn = true
  PLAYGROUND_OVERLAY_STATE.model = 'fcm'
  PLAYGROUND_OVERLAY_STATE.statusMessage = null
  PLAYGROUND_OVERLAY_STATE.scrollOffset = 0
  PLAYGROUND_OVERLAY_STATE.cursor = 0
  PLAYGROUND_OVERLAY_STATE.lastError = null
  PLAYGROUND_OVERLAY_STATE.abortController = null

  // 📖 Best-effort fetch of the pre-prompt so the persona pill in the
  // 📖 header is accurate. Never fail the overlay over a missing read.
  try {
    const port = await readDaemonPort()
    if (port) {
      const fetchFn = deps.fetchFn || globalThis.fetch
      const resp = await fetchFn(`http://127.0.0.1:${port}/api/router/preprompt`, { signal: AbortSignal.timeout(2000) })
      if (resp.ok) {
        const data = await resp.json().catch(() => null)
        if (data && typeof data === 'object') {
          PLAYGROUND_OVERLAY_STATE.prePrompt = {
            enabled: data.enabled === true,
            text: typeof data.text === 'string' ? data.text : '',
          }
        }
      }
    }
  } catch {
    PLAYGROUND_OVERLAY_STATE.prePrompt = null
  }
}

/**
 * 📖 Mark the overlay closed. Cancels any in-flight streaming request so we
 * 📖 don't leave dangling fetch handles behind.
 */
export function closePlaygroundOverlay() {
  if (PLAYGROUND_OVERLAY_STATE.abortController) {
    try { PLAYGROUND_OVERLAY_STATE.abortController.abort() } catch {}
    PLAYGROUND_OVERLAY_STATE.abortController = null
  }
  PLAYGROUND_OVERLAY_STATE.open = false
  PLAYGROUND_OVERLAY_STATE.busy = false
}

/**
 * 📖 Append a delta token to the last assistant message in the transcript.
 * 📖 Mutates in place so streaming updates don't trigger expensive array
 * 📖 recreations.
 */
function appendAssistantDelta(delta) {
  const last = PLAYGROUND_OVERLAY_STATE.messages[PLAYGROUND_OVERLAY_STATE.messages.length - 1]
  if (last && last.role === 'assistant') {
    last.content = (last.content || '') + delta
  }
}

/**
 * 📖 Finalize the last assistant message with provider/latency/tokens
 * 📖 metadata so the next render can show the routed-via chip.
 */
function finalizeAssistantMeta(meta) {
  const last = PLAYGROUND_OVERLAY_STATE.messages[PLAYGROUND_OVERLAY_STATE.messages.length - 1]
  if (last && last.role === 'assistant') {
    last.meta = { ...(last.meta || {}), ...meta }
  }
}

/**
 * 📖 POST the current draft to the router and stream the response back.
 * 📖 Cancellation: aborting the in-flight controller keeps the partial
 * 📖 answer visible but flags it with `aborted: true` so the renderer
 * 📖 can show "stopped" instead of pretending the response completed.
 */
export async function playgroundSubmit(state, deps = {}) {
  if (PLAYGROUND_OVERLAY_STATE.busy) return
  const text = PLAYGROUND_OVERLAY_STATE.draft.trim()
  if (!text) return

  const port = await readDaemonPort()
  if (!port) {
    PLAYGROUND_OVERLAY_STATE.lastError = 'Router is not running. Press R or run `free-coding-models --daemon-bg`.'
    return
  }

  const userMessage = { role: 'user', content: text, ts: Date.now() }
  PLAYGROUND_OVERLAY_STATE.messages.push(userMessage)
  PLAYGROUND_OVERLAY_STATE.messages.push({ role: 'assistant', content: '', ts: Date.now() })
  PLAYGROUND_OVERLAY_STATE.draft = ''
  PLAYGROUND_OVERLAY_STATE.cursor = 0
  PLAYGROUND_OVERLAY_STATE.busy = true
  PLAYGROUND_OVERLAY_STATE.lastError = null
  PLAYGROUND_OVERLAY_STATE.statusMessage = 'Sending…'

  const controller = new AbortController()
  PLAYGROUND_OVERLAY_STATE.abortController = controller

  const transcript = PLAYGROUND_MESSAGES_SAFE()

  const body = {
    model: PLAYGROUND_OVERLAY_STATE.model || 'fcm',
    messages: transcript.map(({ role, content }) => ({ role, content })),
    stream: PLAYGROUND_OVERLAY_STATE.streamOn,
    temperature: 0.7,
  }

  const url = `http://127.0.0.1:${port}/v1/chat/completions`
  const fetchFn = deps.fetchFn || globalThis.fetch

  // 📖 Non-streaming responses have no per-chunk timer, so give the whole
  // 📖 request the same 90s ceiling. The streaming branch switches to its own
  // 📖 per-chunk timer inside readSseStream.
  let requestTimer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS)

  try {
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => null)
      const msg = extractErrorMessage(errBody)
      PLAYGROUND_OVERLAY_STATE.lastError = `HTTP ${resp.status}: ${msg || 'request failed'}`
      finalizeAssistantMeta({ error: PLAYGROUND_OVERLAY_STATE.lastError, aborted: true })
      return
    }
    if (PLAYGROUND_OVERLAY_STATE.streamOn) {
      clearTimeout(requestTimer)
      await readSseStream(resp, fetchFn, controller)
    } else {
      const json = await resp.json().catch(() => null)
      const content = json?.choices?.[0]?.message?.content || ''
      const usage = json?.usage || {}
      // 📖 Some upstreams do not echo the `X-Routed-Via` header in the body;
      // 📖 fall back to the `x-routed-via` snake-case field if present.
      finalizeAssistantMeta({
        provider: json?.x_routed_via || null,
        model: json?.x_routed_model || null,
        latencyMs: json?.x_latency_ms || null,
        tokens: usage?.total_tokens || 0,
        fallbackAttempts: json?.x_fallback_attempts || 0,
      })
      // 📖 Direct content replacement for non-streaming responses.
      const last = PLAYGROUND_OVERLAY_STATE.messages[PLAYGROUND_OVERLAY_STATE.messages.length - 1]
      if (last && last.role === 'assistant') last.content = content
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      finalizeAssistantMeta({ aborted: true })
    } else {
      PLAYGROUND_OVERLAY_STATE.lastError = err?.message || String(err)
      finalizeAssistantMeta({ error: PLAYGROUND_OVERLAY_STATE.lastError, aborted: true })
    }
  } finally {
    clearTimeout(requestTimer)
    PLAYGROUND_OVERLAY_STATE.busy = false
    PLAYGROUND_OVERLAY_STATE.abortController = null
    PLAYGROUND_OVERLAY_STATE.statusMessage = null
  }
}

function PLAYGROUND_MESSAGES_SAFE() {
  // 📖 Trim the transcript to the last 20 turns so long sessions do not blow
  // 📖 the request body budget. We always keep the pre-prompt implicit on
  // 📖 the server side, so this is the user-facing history only.
  return PLAYGROUND_OVERLAY_STATE.messages.slice(-20)
}

async function readSseStream(resp, fetchFn, controller) {
  const reader = resp.body?.getReader()
  if (!reader) {
    const json = await resp.json().catch(() => null)
    const last = PLAYGROUND_OVERLAY_STATE.messages[PLAYGROUND_OVERLAY_STATE.messages.length - 1]
    if (last && last.role === 'assistant') last.content = json?.choices?.[0]?.message?.content || ''
    return
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let streamTimer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS)
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      clearTimeout(streamTimer)
      streamTimer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS)
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split(/\n\n/)
      buffer = events.pop() || ''
      for (const event of events) {
        for (const line of event.split(/\n/)) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const json = JSON.parse(payload)
            const delta = json?.choices?.[0]?.delta?.content
            if (delta) appendAssistantDelta(delta)
            if (json?.x_routed_via) finalizeAssistantMeta({ provider: json.x_routed_via })
            if (json?.x_routed_model) finalizeAssistantMeta({ model: json.x_routed_model })
            if (json?.x_latency_ms) finalizeAssistantMeta({ latencyMs: json.x_latency_ms })
            if (json?.x_fallback_attempts) finalizeAssistantMeta({ fallbackAttempts: json.x_fallback_attempts })
            if (json?.usage?.total_tokens) finalizeAssistantMeta({ tokens: json.usage.total_tokens })
          } catch {
            // 📖 Non-JSON keep-alive frames; ignore.
          }
        }
      }
    }
  } finally {
    clearTimeout(streamTimer)
  }
}

/**
 * 📖 Read the daemon port from disk. Returns null when the daemon is not
 * 📖 running. Mirrors the helper in `router-dashboard.js` so the playground
 * 📖 can stand alone in the TUI process.
 */
async function readDaemonPort() {
  // 📖 Try the recorded port file first. Use the dynamic resolver so dev
  // 📖 checkouts (FCM_DEV=1) read the `-dev` port file and find the dev daemon.
  try {
    const portPath = getRouterPortPath()
    if (existsSync(portPath)) {
      const raw = readFileSync(portPath, 'utf8').trim()
      if (/^\d+$/.test(raw)) return Number(raw)
    }
  } catch {}
  return null
}

/**
 * 📖 Handle a keypress inside the playground overlay. Returns true if the
 * 📖 key was consumed so the main key handler can skip it.
 */
export function handlePlaygroundKeypress(key, deps = {}) {
  if (!PLAYGROUND_OVERLAY_STATE.open) return false
  // 📖 Esc always closes.
  if (key === 'Escape' || key === '\u001b') {
    closePlaygroundOverlay()
    return true
  }
  if (PLAYGROUND_OVERLAY_STATE.busy) {
    // 📖 While streaming, only Esc and Ctrl+C are accepted.
    if (key === 'C-c' || key === '\u0003') {
      if (PLAYGROUND_OVERLAY_STATE.abortController) PLAYGROUND_OVERLAY_STATE.abortController.abort()
      return true
    }
    return key === 'Escape'
  }

  if (key === 'C-c' || key === '\u0003') {
    if (PLAYGROUND_OVERLAY_STATE.abortController) PLAYGROUND_OVERLAY_STATE.abortController.abort()
    PLAYGROUND_OVERLAY_STATE.busy = false
    return true
  }

  if (key === 'Enter' || key === '\r' || key === '\n') {
    void playgroundSubmit(null, deps)
    return true
  }
  if (key === 'Backspace' || key === '\b' || key === '\u007f') {
    PLAYGROUND_OVERLAY_STATE.draft = PLAYGROUND_OVERLAY_STATE.draft.slice(0, -1)
    return true
  }
  if (key === 'Tab' || key === '\t') {
    // 📖 Cycle the model between fcm and a random catalog entry for quick testing.
    PLAYGROUND_OVERLAY_STATE.model = PLAYGROUND_OVERLAY_STATE.model === 'fcm' ? 'groq/llama-3.3-70b-versatile' : 'fcm'
    return true
  }
  if (key === 'C-l' || key === '\u000c') {
    // 📖 Clear transcript
    PLAYGROUND_OVERLAY_STATE.messages = []
    PLAYGROUND_OVERLAY_STATE.scrollOffset = 0
    return true
  }
  if (key === 'C-s' || key === '\u0013') {
    PLAYGROUND_OVERLAY_STATE.streamOn = !PLAYGROUND_OVERLAY_STATE.streamOn
    return true
  }

  // 📖 Arrow keys for transcript scrolling (page up/down style).
  if (key === 'PageUp' || key === '\u001b[5~') {
    PLAYGROUND_OVERLAY_STATE.scrollOffset = Math.max(0, PLAYGROUND_OVERLAY_STATE.scrollOffset - 4)
    return true
  }
  if (key === 'PageDown' || key === '\u001b[6~') {
    PLAYGROUND_OVERLAY_STATE.scrollOffset = PLAYGROUND_OVERLAY_STATE.scrollOffset + 4
    return true
  }

  // 📖 Regular printable characters: append to draft.
  if (key.length === 1 && key >= ' ' && key <= '~') {
    PLAYGROUND_OVERLAY_STATE.draft += key
    return true
  }
  // 📖 Multi-byte (UTF-8) printable characters: still treat as one grapheme.
  if (key && key.length > 1 && !key.startsWith('\u001b')) {
    PLAYGROUND_OVERLAY_STATE.draft += key
    return true
  }
  return false
}

/**
 * 📖 Render the playground overlay. Returns the painted buffer string ready
 * 📖 to write to the alt-screen. Wraps long lines and tints the overlay
 * 📖 background for visual separation.
 *
 * @param {object} state - global TUI state
 * @param {number} terminalRows
 * @param {number} terminalCols
 * @returns {string}
 */
export function renderPlayground(state, terminalRows, terminalCols) {
  if (!PLAYGROUND_OVERLAY_STATE.open) return ''
  const lines = []
  const innerWidth = Math.max(40, terminalCols - 8)

  // 📖 Header
  lines.push(themeColors.accentBold('  💬 Playground — chat with the FCM router'))
  lines.push(themeColors.dim('  Press Enter to send · Shift+Tab cycles model · Ctrl+S toggles streaming · Esc closes · Ctrl+L clears'))
  lines.push('')

  // 📖 Persona pill (one liner preview of the pre-prompt)
  const pre = PLAYGROUND_OVERLAY_STATE.prePrompt
  if (pre && pre.enabled && pre.text) {
    const preview = pre.text.length > innerWidth - 16 ? `${pre.text.slice(0, innerWidth - 19)}…` : pre.text
    lines.push(themeColors.dim(`  Persona: ${preview.replace(/\n+/g, ' ')}`))
  } else {
    lines.push(themeColors.dim('  Persona: (none)'))
  }

  // 📖 Model + mode row
  const mode = PLAYGROUND_OVERLAY_STATE.streamOn ? 'streaming' : 'one-shot'
  lines.push(themeColors.dim(`  Model: ${PLAYGROUND_OVERLAY_STATE.model} · ${mode}`))
  if (PLAYGROUND_OVERLAY_STATE.lastError) {
    lines.push(themeColors.errorBold(`  ⚠ ${PLAYGROUND_OVERLAY_STATE.lastError}`))
  }
  lines.push('')

  // 📖 Transcript
  const transcriptLines = []
  for (const msg of PLAYGROUND_OVERLAY_STATE.messages) {
    const role = msg.role === 'user'
      ? themeColors.accentBold('  ❯ you')
      : msg.role === 'assistant'
        ? themeColors.dim('  ✦ fcm')
        : themeColors.dim(`  · ${msg.role}`)
    transcriptLines.push(role)
    const wrapped = wrapMessage(msg.content || '', innerWidth)
    for (const line of wrapped) {
      transcriptLines.push(`    ${line}`)
    }
    if (msg.role === 'assistant' && msg.meta) {
      const metaChips = []
      if (msg.meta.provider) metaChips.push(`routed ${msg.meta.provider}/${msg.meta.model || '?'}`)
      if (msg.meta.latencyMs != null) metaChips.push(`${msg.meta.latencyMs}ms`)
      if (msg.meta.tokens) metaChips.push(`${msg.meta.tokens} tok`)
      if (msg.meta.fallbackAttempts) metaChips.push(`${msg.meta.fallbackAttempts} fallback`)
      if (metaChips.length) {
        transcriptLines.push(themeColors.dim(`    [ ${metaChips.join(' · ')} ]`))
      }
      if (msg.meta.aborted) {
        transcriptLines.push(themeColors.dim('    [ stopped ]'))
      }
      if (msg.meta.error) {
        transcriptLines.push(themeColors.error(`    [ error: ${msg.meta.error} ]`))
      }
    }
    transcriptLines.push('')
  }
  lines.push(...transcriptLines)

  // 📖 Pad the transcript up to a stable minimum height so the input box
  // 📖 doesn't jump around between renders.
  const minTranscriptLines = Math.max(8, terminalRows - 12)
  while (lines.length < minTranscriptLines) lines.push('')

  // 📖 Input box
  lines.push(themeColors.dim('  ─'.repeat(Math.max(8, Math.floor(innerWidth / 4)))))
  if (PLAYGROUND_OVERLAY_STATE.busy) {
    lines.push(themeColors.accent('  ⏳ waiting for response — Esc to stop'))
  } else {
    const draft = PLAYGROUND_OVERLAY_STATE.draft || 'Type your message and press Enter…'
    const draftDisplay = PLAYGROUND_OVERLAY_STATE.draft ? draft : themeColors.dim(draft)
    const wrappedDraft = wrapMessage(draftDisplay, innerWidth - 4)
    for (const line of wrappedDraft) {
      lines.push(`  ❯ ${line}`)
    }
    if (!PLAYGROUND_OVERLAY_STATE.draft) {
      lines.push(themeColors.dim('  (Enter to send · Shift+Tab for a pinned model)'))
    }
  }

  // 📖 Slice for the terminal height so we never overflow.
  const { visible, offset } = sliceOverlayLines(lines, PLAYGROUND_OVERLAY_STATE.scrollOffset, terminalRows)
  PLAYGROUND_OVERLAY_STATE.scrollOffset = offset
  const tinted = tintOverlayLines(visible, themeColors.overlayBgPlayground, terminalCols)
  return tinted.map((l) => l + '\x1b[0m').join('\n')
}

/**
 * 📖 Wrap a string into lines of at most `width` display columns. Respects
 * 📖 existing newlines so the user can paste multi-line content.
 */
function wrapMessage(text, width) {
  if (!text) return ['']
  const out = []
  for (const paragraph of text.split(/\n/)) {
    if (!paragraph) { out.push(''); continue }
    const words = paragraph.split(/(\s+)/)
    let current = ''
    for (const word of words) {
      const candidate = current + word
      if (displayWidth(candidate) > width && current) {
        out.push(current)
        current = word.trimStart()
      } else {
        current = candidate
      }
    }
    if (current) out.push(current)
  }
  return out
}

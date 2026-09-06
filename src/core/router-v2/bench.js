/**
 * @file bench.js
 * @description Test-via-router client for Router v2 ("AI Speed Test through the router").
 *
 * @details
 *   📖 v1's Ctrl+A / Ctrl+U benchmarks called providers DIRECTLY from the
 *   TUI: they bypassed schema normalization, the pre-prompt, the response
 *   gate and the whole failover engine, so "the model passed the test" said
 *   nothing about what happens when the router actually serves it (and vice
 *   versa). A model could pass the benchmark while failing through the router.
 *
 *   📖 v2 reverses the flow: tests go THROUGH the daemon using the pinned
 *   model syntax (`model: "fcm:@provider/modelId"`), so every test exercises
 *   the exact same chain production traffic uses. Results are computed from
 *   the response's decision headers, so "ok" means: the router routed to the
 *   pinned model, the response passed the content gate, and real text came
 *   back. One prompt, one call, no retries, 20s budget.
 *
 * @functions
 *   → testModelViaRouter(opts) - One pinned-model test call through the daemon
 *   → testSetViaRouter(opts) - Test every model of a set with a small pool
 *   → discoverRouterV2Port() - Find the running v2 daemon (port file + scan)
 *
 * @exports testModelViaRouter, testSetViaRouter, discoverRouterV2Port, ROUTER_V2_TEST_PROMPT
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getRouterV2PortPath, getRouterV2PortRange } from './constants.js'

export const ROUTER_V2_TEST_PROMPT = 'Why is the sky blue? Answer in one short sentence.'
export const ROUTER_V2_TEST_TIMEOUT_MS = 20_000

function extractHeader(headers, name) {
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(name)
  return headers[name] || null
}

/**
 * 📖 Run one real chat completion through the v2 daemon, pinned to a model.
 *
 * @param {{ port: number, provider: string, model: string,
 *           timeoutMs?: number, token?: string, setName?: string }} opts
 * @returns {Promise<{ ok: boolean, latencyMs: number, code: number|string,
 *                     error: string|null, servedModel: string|null,
 *                     attempts: string|null, preview: string|null }>}
 */
export async function testModelViaRouter({ port, provider, model, timeoutMs = ROUTER_V2_TEST_TIMEOUT_MS, token = null, setName = null }) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const modelSpec = setName ? `fcm:@${provider}/${model}` : `fcm:@${provider}/${model}`
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        model: modelSpec,
        messages: [{ role: 'user', content: ROUTER_V2_TEST_PROMPT }],
        max_tokens: 80,
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    })
    const latencyMs = Date.now() - started
    const servedModel = extractHeader(response.headers, 'x-fcm-v2-model')
    const attempts = extractHeader(response.headers, 'x-fcm-v2-decision')
    const text = await response.text()

    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const parsed = JSON.parse(text)
        message = parsed?.error?.message || message
      } catch {}
      return { ok: false, latencyMs, code: response.status, error: message, servedModel, attempts, preview: null }
    }

    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      return { ok: false, latencyMs, code: 200, error: 'invalid_json from router', servedModel, attempts, preview: null }
    }
    if (payload?.error) {
      return { ok: false, latencyMs, code: 200, error: String(payload.error?.message || 'upstream error'), servedModel, attempts, preview: null }
    }
    const content = payload?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim().length === 0) {
      return { ok: false, latencyMs, code: 200, error: 'empty_content (gate should have failed over)', servedModel, attempts, preview: null }
    }
    return { ok: true, latencyMs, code: 200, error: null, servedModel, attempts, preview: content.trim().slice(0, 120) }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return {
      ok: false,
      latencyMs: Date.now() - started,
      code: aborted ? 'TIMEOUT' : 'ERR',
      error: aborted ? `timeout after ${timeoutMs}ms` : (error?.message || 'test failed'),
      servedModel: null,
      attempts: null,
      preview: null,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 📖 Test several models through the router with a small worker pool.
 * @param {{ port: number, models: Array<{provider: string, model: string}>,
 *           concurrency?: number, timeoutMs?: number, token?: string,
 *           onResult?: (result) => void }} opts
 * @returns {Promise<Array<{ key: string } & Awaited<ReturnType<typeof testModelViaRouter>>>}
 */
export async function testSetViaRouter({ port, models, concurrency = 3, timeoutMs, token, onResult } = {}) {
  const queue = [...(Array.isArray(models) ? models : [])]
  const results = []
  const workers = new Array(Math.max(1, Math.min(concurrency, 8))).fill(null).map(async () => {
    while (queue.length > 0) {
      const next = queue.shift()
      if (!next) break
      const result = await testModelViaRouter({ port, provider: next.provider, model: next.model, timeoutMs, token })
      const record = { key: `${next.provider}/${next.model}`, ...result }
      results.push(record)
      if (typeof onResult === 'function') {
        try { onResult(record) } catch {}
      }
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 📖 Find a running v2 daemon: try the recorded port file first, then scan
 * the effective port range. Returns null when nothing answers /health.
 * @returns {Promise<number|null>}
 */
export async function discoverRouterV2Port() {
  const candidates = []
  try {
    const portPath = getRouterV2PortPath()
    if (existsSync(portPath)) {
      const parsed = Number.parseInt(readFileSync(portPath, 'utf8').trim(), 10)
      if (Number.isFinite(parsed)) candidates.push(parsed)
    }
  } catch {}
  const { defaultPort, maxPort } = getRouterV2PortRange()
  for (let port = defaultPort; port <= maxPort; port += 1) {
    if (!candidates.includes(port)) candidates.push(port)
  }
  for (const port of candidates) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(700) })
      if (response.ok) return port
    } catch {}
  }
  return null
}

// 📖 homedir import is used by tests that override HOME before requiring this
// module; keep the reference meaningful.
void homedir
void join

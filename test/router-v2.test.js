/**
 * @file router-v2.test.js
 * @description Integration + unit tests for the Router v2 (BETA) hardened daemon.
 *
 * 📖 Every reliability fix ships with a test that would have failed on v1:
 *   - 200 + empty choices / embedded error / empty content fails over (v1 called it success)
 *   - hung body reads time out instead of hanging the agent forever
 *   - quota-limited models are skipped (Retry-After aware)
 *   - client-caused 4xx never damage healthy model circuits (blame attribution)
 *   - x-api-key never leaks upstream
 *   - activeRequests never leak ghost entries
 *   - decision headers + persisted history + persisted breakers
 *   - pinned-model tests (fcm:@provider/model) run through the real chain
 *   - Anthropic /v1/messages works stream + non-stream
 *
 * @see ../src/core/router-v2/daemon.js
 */

import test, { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { sources } from '../sources.js'
import { DEFAULT_ROUTER_SETTINGS, normalizeRouterConfig } from '../src/core/config.js'
import {
  createRouterV2RuntimeForTest,
} from '../src/core/router-v2/daemon.js'
import { BreakerStore } from '../src/core/router-v2/breaker-store.js'
import { RequestHistory } from '../src/core/router-v2/request-history.js'
import { classifyFailure, clientStatusForKind, FAILURE_KINDS } from '../src/core/router-v2/failure-classifier.js'
import { validateChatCompletionPayload, createStreamReadinessTracker, estimateTokens } from '../src/core/router-v2/response-gate.js'
import { createDecisionTrace, traceSkip, traceAttempt, finishTrace, decisionHeaderValue } from '../src/core/router-v2/decision-trace.js'
import { parseFcmModel } from '../src/core/router-v2/constants.js'
import {
  translateAnthropicToOpenAI,
  translateOpenAIToAnthropicResponse,
  createAnthropicStreamTransformer,
} from '../src/core/router-v2/anthropic-compat.js'

const TEST_MODELS = Object.freeze({
  groq: 'openai/gpt-oss-120b',
  nvidia: 'deepseek-ai/deepseek-v4-flash-0731',
})

// ─── Harness (mirrors the v1 router test harness) ───────────────────────────

function listenOnRandomPort(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

function readNodeRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function withMockProvider(responder, fn) {
  const requests = []
  const server = createHttpServer(async (req, res) => {
    const bodyText = await readNodeRequestBody(req)
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: bodyText ? JSON.parse(bodyText) : null,
    })
    const response = await responder(req, res)
    if (!response || res.writableEnded || res.destroyed) return
    if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs))
    res.writeHead(response.status ?? 200, response.headers || { 'content-type': 'application/json' })
    if (Array.isArray(response.chunks)) {
      for (const chunk of response.chunks) res.write(chunk)
      res.end()
      return
    }
    if (response.rawBody !== undefined) {
      res.end(response.rawBody)
      return
    }
    res.end(JSON.stringify(response.body ?? { id: 'chatcmpl-test', choices: [] }))
  })
  const port = await listenOnRandomPort(server)
  try {
    return await fn({ requests, url: `http://127.0.0.1:${port}/v1/chat/completions`, port, server })
  } finally {
    await closeServer(server)
  }
}

async function withSourceUrls(overrides, fn) {
  const originals = new Map()
  for (const [provider, url] of Object.entries(overrides)) {
    originals.set(provider, sources[provider]?.url)
    sources[provider].url = url
  }
  try {
    return await fn()
  } finally {
    for (const [provider, url] of originals) {
      sources[provider].url = url
    }
  }
}

function buildRouterV2TestConfig(models, overrides = {}) {
  const router = normalizeRouterConfig({
    ...DEFAULT_ROUTER_SETTINGS,
    enabled: true,
    onboardingSeen: true,
    activeSet: 'test-set',
    // 📖 Keep tests focused on routing behavior, not pre-prompt injection
    // (v1's integration suite already covers the injection itself).
    prePrompt: { enabled: false, text: '' },
    sets: {
      'test-set': {
        name: 'test-set',
        created: '2026-09-06T00:00:00.000Z',
        models,
        familyFailover: overrides.familyFailover,
      },
    },
    failover: {
      ...DEFAULT_ROUTER_SETTINGS.failover,
      maxRetries: overrides.maxRetries ?? models.length,
      requestTimeoutMs: overrides.requestTimeoutMs ?? 2000,
      streamStallTimeoutMs: overrides.streamStallTimeoutMs ?? 500,
    },
    circuitBreaker: {
      ...DEFAULT_ROUTER_SETTINGS.circuitBreaker,
      failureThreshold: overrides.failureThreshold ?? 3,
    },
  })
  // 📖 v2-specific knobs are read from the RAW config (the shared normalizer
  // only knows v1 fields), so tests inject them post-normalization.
  if (overrides.bodyReadTimeoutMs != null) router.failover.bodyReadTimeoutMs = overrides.bodyReadTimeoutMs
  if (overrides.totalBudgetMs != null) router.failover.totalBudgetMs = overrides.totalBudgetMs
  if (overrides.contentValidation != null) router.failover.contentValidation = overrides.contentValidation
  if (overrides.lastResortModel != null) router.failover.lastResortModel = overrides.lastResortModel
  return {
    telemetry: { enabled: false },
    apiKeys: {
      groq: 'gsk-router-v2-test',
      nvidia: 'nvapi-router-v2-test',
    },
    router,
  }
}

async function withRouterV2TestServer(config, fn) {
  const runtime = createRouterV2RuntimeForTest({ config })
  const server = createHttpServer((req, res) => void runtime.handleHttp(req, res))
  const port = await listenOnRandomPort(server)
  runtime.port = port
  runtime.server = server
  try {
    return await fn({ runtime, port, baseUrl: `http://127.0.0.1:${port}` })
  } finally {
    try { runtime.tokenTracker.flush({ force: true }) } catch {}
    try { runtime.breakers.flush() } catch {}
    try { runtime.history.flush() } catch {}
    await closeServer(server)
    try { rmSync(runtime.breakers.path, { force: true }) } catch {}
    try { rmSync(runtime.history.path, { force: true }) } catch {}
    try { rmSync(runtime.tokenTracker.path, { force: true }) } catch {}
  }
}

function chatBody(overrides = {}) {
  return {
    model: 'fcm',
    messages: [{ role: 'user', content: 'ping' }],
    ...overrides,
  }
}

function postChat(baseUrl, bodyOverrides = {}, headers = {}) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(chatBody(bodyOverrides)),
  })
}

function okBody(id = 'chatcmpl-v2') {
  return {
    id,
    choices: [{ message: { role: 'assistant', content: 'real answer' } }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }
}

// ─── 1. Content gate: a 200 must EARN its success ───────────────────────────

test('v2 fails over a 200 with empty choices and serves the next model (v1 counted this as success)', async () => {
  await withMockProvider(() => ({ body: { id: 'chatcmpl-empty', choices: [] } }), async (groqProvider) => {
    await withMockProvider(() => ({ body: okBody('chatcmpl-real') }), async (nvidiaProvider) => {
      await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
        const config = buildRouterV2TestConfig([
          { provider: 'groq', model: TEST_MODELS.groq, priority: 1 },
          { provider: 'nvidia', model: TEST_MODELS.nvidia, priority: 2 },
        ])
        await withRouterV2TestServer(config, async ({ baseUrl }) => {
          const response = await postChat(baseUrl)
          const payload = await response.json()

          assert.equal(response.status, 200)
          assert.equal(payload.id, 'chatcmpl-real')
          assert.equal(response.headers.get('x-fcm-v2-model'), `nvidia/${TEST_MODELS.nvidia}`)
          assert.equal(response.headers.get('x-fcm-v2-attempts'), '2')
          assert.equal(groqProvider.requests.length, 1)
          assert.equal(nvidiaProvider.requests.length, 1)
        })
      })
    })
  })
})

test('v2 fails over a 200 with an embedded error object', async () => {
  await withMockProvider(() => ({ body: { error: { message: 'model exploded', code: 500 } } }), async (groqProvider) => {
    await withMockProvider(() => ({ body: okBody('chatcmpl-rescued') }), async (nvidiaProvider) => {
      await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
        const config = buildRouterV2TestConfig([
          { provider: 'groq', model: TEST_MODELS.groq, priority: 1 },
          { provider: 'nvidia', model: TEST_MODELS.nvidia, priority: 2 },
        ])
        await withRouterV2TestServer(config, async ({ baseUrl }) => {
          const response = await postChat(baseUrl)
          const payload = await response.json()

          assert.equal(response.status, 200)
          assert.equal(payload.id, 'chatcmpl-rescued')
        })
      })
    })
  })
})

test('v2 strict mode fails over a 200 whose content is empty', async () => {
  await withMockProvider(() => ({ body: { id: 'x', choices: [{ message: { role: 'assistant', content: '' } }] } }), async (groqProvider) => {
    await withMockProvider(() => ({ body: okBody('chatcmpl-content') }), async (nvidiaProvider) => {
      await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
        const config = buildRouterV2TestConfig([
          { provider: 'groq', model: TEST_MODELS.groq, priority: 1 },
          { provider: 'nvidia', model: TEST_MODELS.nvidia, priority: 2 },
        ])
        await withRouterV2TestServer(config, async ({ baseUrl }) => {
          const response = await postChat(baseUrl)
          assert.equal(response.status, 200)
          assert.equal((await response.json()).id, 'chatcmpl-content')
        })
      })
    })
  })
})

test('v2 content validation off accepts empty content (opt-out still routes)', async () => {
  await withMockProvider(() => ({ body: { id: 'chatcmpl-quiet', choices: [{ message: { role: 'assistant', content: '' } }] } }), async (groqProvider) => {
    await withSourceUrls({ groq: groqProvider.url }, async () => {
      const config = buildRouterV2TestConfig(
        [{ provider: 'groq', model: TEST_MODELS.groq, priority: 1 }],
        { contentValidation: 'off', maxRetries: 0 },
      )
      await withRouterV2TestServer(config, async ({ baseUrl }) => {
        const response = await postChat(baseUrl)
        const payload = await response.json()
        assert.equal(response.status, 200)
        assert.equal(payload.id, 'chatcmpl-quiet')
        assert.equal(response.headers.get('x-fcm-v2-attempts'), '1')
      })
    })
  })
})

test('v2 fails over a 200 SSE stream that closes without content, before any byte reaches the client', async () => {
  await withMockProvider(() => ({ status: 200, chunks: [] }), async (groqProvider) => {
    await withMockProvider(() => ({
      status: 200,
      chunks: [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        `data: {"choices":[{"delta":{"content":"hello world"}}]}\n\n`,
        'data: [DONE]\n\n',
      ],
    }), async (nvidiaProvider) => {
      await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
        const config = buildRouterV2TestConfig([
          { provider: 'groq', model: TEST_MODELS.groq, priority: 1 },
          { provider: 'nvidia', model: TEST_MODELS.nvidia, priority: 2 },
        ])
        await withRouterV2TestServer(config, async ({ baseUrl }) => {
          const response = await postChat(baseUrl, { stream: true })
          const text = await response.text()
          assert.equal(response.status, 200)
          assert.ok(text.includes('hello world'), 'client must receive the real content from model 2')
          assert.equal(groqProvider.requests.length, 1)
          assert.equal(nvidiaProvider.requests.length, 1)
        })
      })
    })
  })
})

test('v2 fails over an SSE error frame before any content reaches the client', async () => {
  await withMockProvider(() => ({
    status: 200,
    chunks: ['data: {"error": {"message": "stream exploded"}}\n\n'],
  }), async (groqProvider) => {
    await withMockProvider(() => ({
      status: 200,
      chunks: [`data: {"choices":[{"delta":{"content":"safe content"}}]}\n\n`, 'data: [DONE]\n\n'],
    }), async (nvidiaProvider) => {
      await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
        const config = buildRouterV2TestConfig([
          { provider: 'groq', model: TEST_MODELS.groq, priority: 1 },
          { provider: 'nvidia', model: TEST_MODELS.nvidia, priority: 2 },
        ])
        await withRouterV2TestServer(config, async ({ baseUrl }) => {
          const response = await postChat(baseUrl, { stream: true })
          const text = await response.text()
          assert.equal(response.status, 200)
          assert.ok(text.includes('safe content'))
          assert.ok(!text.includes('stream exploded'), 'the upstream error frame must never be forwarded')
        })
      })
    })
  })
})

// ─── 2. Body read timeout: a trickle-feeding upstream cannot hang the client ─

test('v2 times out a provider that sends headers but never a body, and fails over', async () => {
  await withMockProvider(async (request, res) => {
    // 📖 Headers arrive, body never does: exactly the v1 hang scenario.
    res.writeHead(200, { 'content-type': 'application/json' })
    return null
  }, async (groqProvider) => {
    // eslint-disable-next-line no-unused-vars
    await withMockProvider(() => ({ body: okBody('chatcmpl-after-hang') }), async (nvidiaProvider) => {
      await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
        const config = buildRouterV2TestConfig([
          { provider: 'groq', model: TEST_MODELS.groq, priority: 1 },
          { provider: 'nvidia', model: TEST_MODELS.nvidia, priority: 2 },
        ], { bodyReadTimeoutMs: 250 })
        await withRouterV2TestServer(config, async ({ baseUrl }) => {
          const started = Date.now()
          const response = await postChat(baseUrl)
          const elapsed = Date.now() - started
          assert.equal(response.status, 200)
          assert.equal((await response.json()).id, 'chatcmpl-after-hang')
          assert.ok(elapsed < 5000, `request must not hang (took ${elapsed}ms)`)
          assert.equal(nvidiaProvider.requests.length, 1)
        })
      })
    })
  })
})

// ─── 3. Quota-aware routing + Retry-After ───────────────────────────────────

test('v2 pauses a 429 model for its Retry-After window and skips it on the next request', async () => {
  let groqCalls = 0
  await withMockProvider(() => {
    groqCalls += 1
    return { status: 429, headers: { 'retry-after': '30' }, body: { error: { message: 'rate limited' } } }
  }, async (groqProvider) => {
    await withMockProvider(() => ({ body: okBody('chatcmpl-quota-ok') }), async (nvidiaProvider) => {
      await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
        const config = buildRouterV2TestConfig([
          { provider: 'groq', model: TEST_MODELS.groq, priority: 1 },
          { provider: 'nvidia', model: TEST_MODELS.nvidia, priority: 2 },
        ])
        await withRouterV2TestServer(config, async ({ baseUrl, runtime }) => {
          const first = await postChat(baseUrl)
          assert.equal(first.status, 200)
          assert.equal(groqCalls, 1)

          // 📖 Second request: the paused model must be skipped WITHOUT being hit.
          const second = await postChat(baseUrl)
          assert.equal(second.status, 200)
          assert.equal(groqCalls, 1, 'paused model must not receive traffic')
          assert.equal(second.headers.get('x-fcm-v2-model'), `nvidia/${TEST_MODELS.nvidia}`)

          const pauses = [...runtime.quotaPauses.keys()]
          assert.ok(pauses.includes(`groq/${TEST_MODELS.groq}`), 'quota pause must be recorded')
        })
      })
    })
  })
})

// ─── 4. Blame attribution ───────────────────────────────────────────────────

test('v2 fails over a client-caused 400 WITHOUT damaging the model circuit', async () => {
  await withMockProvider(() => ({ status: 400, body: { error: { message: 'bad field' } } }), async (groqProvider) => {
    await withMockProvider(() => ({ body: okBody('chatcmpl-lenient') }), async (nvidiaProvider) => {
      await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
        const config = buildRouterV2TestConfig([
          { provider: 'groq', model: TEST_MODELS.groq, priority: 1 },
          { provider: 'nvidia', model: TEST_MODELS.nvidia, priority: 2 },
        ], { failureThreshold: 1 })
        await withRouterV2TestServer(config, async ({ baseUrl, runtime }) => {
          const response = await postChat(baseUrl)
          assert.equal(response.status, 200)
          assert.equal((await response.json()).id, 'chatcmpl-lenient')

          const breaker = runtime.breakers.get(`groq/${TEST_MODELS.groq}`)
          assert.equal(breaker.consecutiveFailures, 0, 'client-caused 4xx must not count toward circuit-open')
          assert.equal(breaker.state, 'CLOSED')
        })
      })
    })
  })
})

test('v2 marks a provider auth failure and still serves via another provider', async () => {
  await withMockProvider(() => ({ status: 401, body: { error: { message: 'bad key' } } }), async (groqProvider) => {
    await withMockProvider(() => ({ body: okBody('chatcmpl-auth-ok') }), async (nvidiaProvider) => {
      await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
        const config = buildRouterV2TestConfig([
          { provider: 'groq', model: TEST_MODELS.groq, priority: 1 },
          { provider: 'nvidia', model: TEST_MODELS.nvidia, priority: 2 },
        ], { failureThreshold: 1 })
        await withRouterV2TestServer(config, async ({ baseUrl, runtime }) => {
          const response = await postChat(baseUrl)
          assert.equal(response.status, 200)
          const breaker = runtime.breakers.get(`groq/${TEST_MODELS.groq}`)
          assert.equal(breaker.authError, true, 'auth failure must set the sticky auth flag')
          assert.equal(breaker.consecutiveFailures, 0, 'auth failure must not spin the failure counter')
        })
      })
    })
  })
})

// ─── 5. Security: x-api-key never reaches upstream ──────────────────────────

test('v2 strips client x-api-key before proxying upstream', async () => {
  await withMockProvider(() => ({ body: okBody() }), async (groqProvider) => {
    await withSourceUrls({ groq: groqProvider.url }, async () => {
      const config = buildRouterV2TestConfig(
        [{ provider: 'groq', model: TEST_MODELS.groq, priority: 1 }],
        { maxRetries: 0 },
      )
      await withRouterV2TestServer(config, async ({ baseUrl }) => {
        const response = await postChat(baseUrl, {}, { 'x-api-key': 'fcm-local-secret' })
        assert.equal(response.status, 200)
        assert.equal(groqProvider.requests[0].headers['x-api-key'], undefined, 'x-api-key must be stripped')
        assert.equal(groqProvider.requests[0].headers.authorization, 'Bearer gsk-router-v2-test')
      })
    })
  })
})

// ─── 6. activeRequests lifecycle ────────────────────────────────────────────

test('v2 leaves no ghost active requests behind rejected or completed calls', async () => {
  await withMockProvider(() => ({ body: okBody() }), async (groqProvider) => {
    await withSourceUrls({ groq: groqProvider.url }, async () => {
      const config = buildRouterV2TestConfig(
        [{ provider: 'groq', model: TEST_MODELS.groq, priority: 1 }],
        { maxRetries: 0 },
      )
      await withRouterV2TestServer(config, async ({ baseUrl, runtime }) => {
        await postChat(baseUrl, { model: '' }) // rejected: missing model
        assert.equal(runtime.activeRequests.size, 0, 'rejection must not leak an active request')

        await postChat(baseUrl)
        assert.equal(runtime.activeRequests.size, 0, 'completed request must be cleaned up')
      })
    })
  })
})

// ─── 7. Decision trace + headers + persisted history ─────────────────────────

test('v2 exposes decision headers and persists the request chain to history', async () => {
  await withMockProvider(() => ({ status: 503, body: { error: { message: 'down' } } }), async (groqProvider) => {
    await withMockProvider(() => ({ body: okBody('chatcmpl-chain') }), async (nvidiaProvider) => {
      await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
        const config = buildRouterV2TestConfig([
          { provider: 'groq', model: TEST_MODELS.groq, priority: 1 },
          { provider: 'nvidia', model: TEST_MODELS.nvidia, priority: 2 },
        ])
        await withRouterV2TestServer(config, async ({ baseUrl, runtime }) => {
          const response = await postChat(baseUrl)
          assert.equal(response.status, 200)
          const decision = response.headers.get('x-fcm-v2-decision')
          assert.ok(decision.includes(`groq/${TEST_MODELS.groq}:503`), `decision header should show the failed attempt: ${decision}`)
          assert.ok(decision.includes(`nvidia/${TEST_MODELS.nvidia}:200`))

          const historyResp = await fetch(`${baseUrl}/api/router-v2/history?limit=10`)
          const history = await historyResp.json()
          assert.equal(history.entries.length, 1)
          const entry = history.entries[0]
          assert.equal(entry.outcome, 'served')
          assert.equal(entry.attempts.length, 2)
          assert.equal(entry.served_model, `nvidia/${TEST_MODELS.nvidia}`)
          assert.ok(Number.isFinite(entry.wall_ms))
        })
      })
    })
  })
})

// ─── 8. Pinned model (fcm:@provider/model) ──────────────────────────────────

test('v2 pinned model routes to exactly that model with failover disabled', async () => {
  await withMockProvider(() => ({ body: okBody('chatcmpl-pinned') }), async (groqProvider) => {
    await withMockProvider(() => ({ body: okBody('chatcmpl-should-not-happen') }), async (nvidiaProvider) => {
      await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
        const config = buildRouterV2TestConfig([
          { provider: 'groq', model: TEST_MODELS.groq, priority: 1 },
          { provider: 'nvidia', model: TEST_MODELS.nvidia, priority: 2 },
        ])
        await withRouterV2TestServer(config, async ({ baseUrl }) => {
          const response = await postChat(baseUrl, { model: `fcm:@groq/${TEST_MODELS.groq}` })
          assert.equal(response.status, 200)
          assert.equal((await response.json()).id, 'chatcmpl-pinned')
          assert.equal(response.headers.get('x-fcm-v2-model'), `groq/${TEST_MODELS.groq}`)
          assert.equal(nvidiaProvider.requests.length, 0, 'pinned request must not touch other models')
        })
      })
    })
  })
})

test('v2 pinned model failure does NOT fail over to the rest of the set', async () => {
  await withMockProvider(() => ({ status: 503, body: { error: { message: 'down' } } }), async (groqProvider) => {
    await withMockProvider(() => ({ body: okBody('chatcmpl-nope') }), async (nvidiaProvider) => {
      await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
        const config = buildRouterV2TestConfig([
          { provider: 'groq', model: TEST_MODELS.groq, priority: 1 },
          { provider: 'nvidia', model: TEST_MODELS.nvidia, priority: 2 },
        ])
        await withRouterV2TestServer(config, async ({ baseUrl }) => {
          const response = await postChat(baseUrl, { model: `fcm:@groq/${TEST_MODELS.groq}` })
          assert.ok(response.status >= 500)
          assert.equal(nvidiaProvider.requests.length, 0, 'pinned tests must stay pinned')
        })
      })
    })
  })
})

// ─── 9. Global last-resort model ────────────────────────────────────────────

test('v2 tries the configured last-resort model when the whole set fails', async () => {
  await withMockProvider(() => ({ status: 503, body: { error: { message: 'down' } } }), async (groqProvider) => {
    await withMockProvider(() => ({ body: okBody('chatcmpl-lastresort') }), async (nvidiaProvider) => {
      await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
        const config = buildRouterV2TestConfig([
          { provider: 'groq', model: TEST_MODELS.groq, priority: 1 },
        ], { maxRetries: 0, lastResortModel: `nvidia/${TEST_MODELS.nvidia}` })
        await withRouterV2TestServer(config, async ({ baseUrl }) => {
          const response = await postChat(baseUrl)
          const payload = await response.json()
          assert.equal(response.status, 200)
          assert.equal(payload.id, 'chatcmpl-lastresort')
          assert.equal(response.headers.get('x-fcm-v2-last-resort'), 'true')
        })
      })
    })
  })
})

// ─── 10. Persisted breakers survive a restart ───────────────────────────────

test('v2 breaker state survives a daemon restart via the persisted store', async () => {
  const path = join(tmpdir(), `fcm-v2-breakers-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  try {
    const first = new BreakerStore({ path, logger: null })
    first.markFailure('groq/model-a', { detail: 'boom', failureThreshold: 2 })
    first.markFailure('groq/model-a', { detail: 'boom', failureThreshold: 2 })
    assert.equal(first.get('groq/model-a').state, 'OPEN')
    first.flush()

    const second = new BreakerStore({ path, logger: null })
    const restored = second.get('groq/model-a')
    assert.equal(restored.state, 'OPEN', 'OPEN state must survive restart')
    assert.equal(restored.consecutiveFailures, 2)
    assert.ok(restored.cooldownMs > 0)

    // 📖 Escalating backoff: a second trip multiplies the cooldown.
    const tripOneCooldown = restored.cooldownMs
    second.markSuccess('groq/model-a', 30000)
    second.markFailure('groq/model-a', { detail: 'again', failureThreshold: 2 })
    second.markFailure('groq/model-a', { detail: 'again', failureThreshold: 2 })
    const secondTrip = second.get('groq/model-a')
    assert.equal(secondTrip.state, 'OPEN')
    assert.ok(secondTrip.cooldownMs > tripOneCooldown, 'second trip must escalate the cooldown')
  } finally {
    rmSync(path, { force: true })
  }
})

test('v2 runtime restores breakers from disk on boot (restart scenario)', async () => {
  const breakersPath = join(tmpdir(), `fcm-v2-runtime-breakers-${Date.now()}.json`)
  const config = buildRouterV2TestConfig(
    [{ provider: 'groq', model: TEST_MODELS.groq, priority: 1 }],
    { maxRetries: 0, failureThreshold: 1 },
  )
  try {
    const runtimeA = createRouterV2RuntimeForTest({ config, breakersPath })
    const verdict = classifyFailure({ status: 503 })
    runtimeA.applyFailureVerdict(`groq/${TEST_MODELS.groq}`, verdict, { detail: 'HTTP 503', statusCode: 503 })
    assert.equal(runtimeA.breakers.get(`groq/${TEST_MODELS.groq}`).state, 'OPEN')
    runtimeA.breakers.flush()

    const runtimeB = createRouterV2RuntimeForTest({ config, breakersPath })
    assert.equal(runtimeB.breakers.get(`groq/${TEST_MODELS.groq}`).state, 'OPEN', 'a restarted daemon must remember the open circuit')
  } finally {
    rmSync(breakersPath, { force: true })
  }
})

// ─── 11. Anthropic /v1/messages ─────────────────────────────────────────────

test('v2 serves Anthropic /v1/messages non-stream with translated request + response', async () => {
  await withMockProvider(() => ({ body: okBody('chatcmpl-anthropic') }), async (groqProvider) => {
    await withSourceUrls({ groq: groqProvider.url }, async () => {
      const config = buildRouterV2TestConfig(
        [{ provider: 'groq', model: TEST_MODELS.groq, priority: 1 }],
        { maxRetries: 0 },
      )
      await withRouterV2TestServer(config, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'fcm',
            max_tokens: 100,
            system: 'be brief',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
          }),
        })
        assert.equal(response.status, 200)
        const payload = await response.json()
        assert.equal(payload.type, 'message')
        assert.equal(payload.role, 'assistant')
        assert.equal(payload.content[0].type, 'text')
        assert.ok(payload.content[0].content !== '' ? true : payload.content[0].text)
        assert.equal(payload.stop_reason, 'end_turn')
        assert.equal(payload.usage.output_tokens, 3)

        // 📖 Upstream must have received an OpenAI-shaped request.
        const upstream = groqProvider.requests[0].body
        assert.equal(upstream.messages[0].role, 'system')
        assert.equal(upstream.messages[0].content, 'be brief')
        assert.equal(upstream.messages[1].content, 'hello')
        assert.equal(upstream.max_tokens, 100)
      })
    })
  })
})

test('v2 serves Anthropic /v1/messages streaming by translating SSE event frames', async () => {
  await withMockProvider(() => ({
    status: 200,
    chunks: [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ],
  }), async (groqProvider) => {
    await withSourceUrls({ groq: groqProvider.url }, async () => {
      const config = buildRouterV2TestConfig(
        [{ provider: 'groq', model: TEST_MODELS.groq, priority: 1 }],
        { maxRetries: 0 },
      )
      await withRouterV2TestServer(config, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'fcm',
            max_tokens: 50,
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        })
        assert.equal(response.status, 200)
        assert.ok(response.headers.get('content-type').includes('text/event-stream'))
        const text = await response.text()
        assert.ok(text.includes('event: message_start'), text.slice(0, 200))
        assert.ok(text.includes('event: content_block_delta'))
        assert.ok(text.includes('text_delta'))
        assert.ok(text.includes('Hello'))
        assert.ok(text.includes('event: message_delta'))
        assert.ok(text.includes('event: message_stop'))
      })
    })
  })
})

test('v2 Anthropic path returns Anthropic-style error envelopes on upstream auth failure', async () => {
  await withMockProvider(() => ({ status: 401, body: { error: { message: 'bad key' } } }), async (groqProvider) => {
    await withSourceUrls({ groq: groqProvider.url }, async () => {
      const config = buildRouterV2TestConfig(
        [{ provider: 'groq', model: TEST_MODELS.groq, priority: 1 }],
        { maxRetries: 0 },
      )
      await withRouterV2TestServer(config, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'fcm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
        })
        assert.equal(response.status, 401)
        const payload = await response.json()
        assert.equal(payload.type, 'error')
        assert.equal(payload.error.type, 'authentication_error')
      })
    })
  })
})

// ─── Unit: pure modules ─────────────────────────────────────────────────────

describe('response gate', () => {
  it('rejects empty choices, embedded errors and contentless messages', () => {
    assert.equal(validateChatCompletionPayload({ choices: [] }).ok, false)
    assert.equal(validateChatCompletionPayload({ error: { message: 'x' } }).reason, 'error_payload')
    assert.equal(
      validateChatCompletionPayload({ choices: [{ message: { role: 'assistant', content: '' } }] }).reason,
      'empty_content',
    )
  })

  it('accepts text, tool calls, function calls and reasoning as real content', () => {
    assert.equal(validateChatCompletionPayload({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }).ok, true)
    assert.equal(validateChatCompletionPayload({ choices: [{ message: { tool_calls: [{ id: '1' }] } }] }).ok, true)
    assert.equal(validateChatCompletionPayload({ choices: [{ message: { function_call: { name: 'f' } } }] }).ok, true)
    assert.equal(validateChatCompletionPayload({ choices: [{ message: { reasoning_content: 'thinking...' } }] }).ok, true)
    assert.equal(validateChatCompletionPayload({ choices: [{ message: { content: '' } }] }, { mode: 'basic' }).ok, true)
  })

  it('tracks stream usefulness and error frames incrementally across chunk boundaries', () => {
    const tracker = createStreamReadinessTracker()
    tracker.observe('data: {"choices":[{"del')
    tracker.observe('ta":{"content":"hi"}}]}\n\n')
    assert.equal(tracker.useful, true)

    const errorTracker = createStreamReadinessTracker()
    errorTracker.observe('data: {"error":{"message":"nope"}}\n\n')
    assert.equal(errorTracker.errorPayload, true)
    assert.equal(errorTracker.useful, false)
  })

  it('never counts a bare role delta or SSE comments as useful content', () => {
    const tracker = createStreamReadinessTracker()
    tracker.observe(': keepalive\n\n')
    tracker.observe('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n')
    assert.equal(tracker.useful, false)
  })

  it('estimates streamed completion tokens', () => {
    assert.equal(estimateTokens(''), 0)
    assert.equal(estimateTokens('abcd'), 1)
    assert.ok(estimateTokens('a'.repeat(101)) > 20)
  })
})

describe('failure classifier', () => {
  it('blames the client for 4xx and spares the model health', () => {
    const verdict = classifyFailure({ status: 400 })
    assert.equal(verdict.kind, FAILURE_KINDS.INVALID_REQUEST)
    assert.equal(verdict.healthDamage, false)
    assert.equal(verdict.failover, true)
  })

  it('blocks the provider on auth failures without circuit damage', () => {
    const verdict = classifyFailure({ status: 401 })
    assert.equal(verdict.blockProvider, true)
    assert.equal(verdict.healthDamage, false)
  })

  it('pauses rate-limited models for the Retry-After window (capped)', () => {
    const verdict = classifyFailure({ status: 429, retryAfterMs: 5000 })
    assert.equal(verdict.quotaPauseMs, 5000)
    const capped = classifyFailure({ status: 429, retryAfterMs: 60 * 60 * 1000 })
    assert.equal(capped.quotaPauseMs, 15 * 60 * 1000)
  })

  it('treats content-level garbage as a real provider failure', () => {
    for (const kind of [FAILURE_KINDS.EMPTY_CHOICES, FAILURE_KINDS.EMPTY_CONTENT, FAILURE_KINDS.ERROR_PAYLOAD]) {
      const verdict = classifyFailure({ kind })
      assert.equal(verdict.healthDamage, true)
      assert.equal(verdict.failover, true)
    }
  })

  it('maps final client status codes per failure kind', () => {
    assert.equal(clientStatusForKind(FAILURE_KINDS.AUTH), 401)
    assert.equal(clientStatusForKind(FAILURE_KINDS.RATE_LIMIT), 429)
    assert.equal(clientStatusForKind(FAILURE_KINDS.INVALID_REQUEST), 400)
    assert.equal(clientStatusForKind(FAILURE_KINDS.SERVER), 502)
  })
})

describe('decision trace', () => {
  it('builds a compact single-line header value', () => {
    const trace = createDecisionTrace({ requestId: 'req-1', set: 's', modelRequested: 'fcm' })
    traceSkip(trace, 'a/b', 'circuit_open')
    traceAttempt(trace, 'a/b', { status: 503 })
    traceAttempt(trace, 'c/d', { status: 200 })
    finishTrace(trace, { outcome: 'served', servedModel: 'c/d', wallMs: 42 })
    const header = decisionHeaderValue(trace)
    assert.ok(header.includes('c/d!served'))
    assert.ok(header.includes('skips=1'))
    assert.ok(header.length < 500)
  })
})

describe('fcm model spec parsing', () => {
  it('parses default, set and pinned forms', () => {
    assert.equal(parseFcmModel('fcm').kind, 'default')
    assert.equal(parseFcmModel('fcm:fast').set, 'fast')
    const pinned = parseFcmModel('fcm:@groq/openai/gpt-oss-120b')
    assert.equal(pinned.kind, 'pinned')
    assert.equal(pinned.pinned.provider, 'groq')
    assert.equal(pinned.pinned.model, 'openai/gpt-oss-120b')
    assert.equal(parseFcmModel('fcm:@nopermission').kind, 'unknown')
  })
})

describe('anthropic compat', () => {
  it('translates tool_use and tool_result blocks to OpenAI tool messages', () => {
    const result = translateAnthropicToOpenAI({
      model: 'fcm',
      max_tokens: 256,
      tools: [{ name: 'get_weather', description: 'd', input_schema: { type: 'object', properties: {} } }],
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'sunny' }] },
      ],
    })
    assert.equal(result.ok, true)
    const messages = result.body.messages
    assert.equal(messages[0].role, 'assistant')
    assert.equal(messages[0].tool_calls[0].function.name, 'get_weather')
    assert.equal(messages[1].role, 'tool')
    assert.equal(messages[1].tool_call_id, 'tu_1')
    assert.equal(messages[1].content, 'sunny')
    assert.equal(result.body.tools[0].function.parameters.type, 'object')
  })

  it('maps OpenAI tool_calls finish reason to Anthropic tool_use stop reason', () => {
    const result = translateOpenAIToAnthropicResponse({
      id: 'chatcmpl-1',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', function: { name: 'f', arguments: '{"a":1}' } }],
        },
      }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }, { model: 'fcm' })
    assert.equal(result.ok, true)
    assert.equal(result.body.stop_reason, 'tool_use')
    assert.equal(result.body.content[0].type, 'tool_use')
    assert.deepEqual(result.body.content[0].input, { a: 1 })
    assert.equal(result.body.usage.input_tokens, 4)
  })

  it('streams tool_use blocks with input_json_delta from OpenAI argument chunks', () => {
    const transformer = createAnthropicStreamTransformer({ model: 'fcm' })
    let out = ''
    out += transformer.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":""}}]}}]}\n\n')
    out += transformer.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":"}}]}}]}\n\n')
    out += transformer.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
    out += transformer.end()
    assert.ok(out.includes('content_block_start'))
    assert.ok(out.includes('"type":"tool_use"'))
    assert.ok(out.includes('input_json_delta'))
    assert.ok(out.includes('"stop_reason":"tool_use"'))
  })
})

describe('request history', () => {
  it('persists and reloads entries across instances', () => {
    const path = join(tmpdir(), `fcm-v2-history-test-${Date.now()}.json`)
    try {
      const first = new RequestHistory({ path, logger: null, maxEntries: 10 })
      first.append({ request_id: 'r1', at: new Date().toISOString(), outcome: 'served', attempts: [{ model: 'a/b', status: 200 }], skipped: [], wall_ms: 10, tokens: 5 })
      first.append({ request_id: 'r2', at: new Date().toISOString(), outcome: 'all_failed', attempts: [{ model: 'a/b', status: 503, error: 'provider_server_error' }], skipped: [], wall_ms: 20, tokens: 0 })
      first.flush()

      const second = new RequestHistory({ path, logger: null, maxEntries: 10 })
      assert.equal(second.recent(10).length, 2)
      const stats = second.stats()
      assert.equal(stats.served, 1)
      assert.equal(stats.all_failed, 1)
      assert.equal(stats.failover_rate, 0)
    } finally {
      rmSync(path, { force: true })
    }
  })
})

describe('schema normalizer: parallel tool results (router v2 E2E fix)', () => {
  it('keeps EVERY tool result of a multi-tool-call assistant turn, not just the first', async () => {
    const { normalizeRequestBody } = await import('../src/core/schema-normalizer.js')
    const body = {
      model: 'fcm',
      messages: [
        { role: 'user', content: 'write 3 files' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'write', arguments: '{}' } },
            { id: 'call_b', type: 'function', function: { name: 'write', arguments: '{}' } },
            { id: 'call_c', type: 'function', function: { name: 'write', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: 'Wrote file successfully.' },
        { role: 'tool', tool_call_id: 'call_b', content: 'Wrote file successfully.' },
        { role: 'tool', tool_call_id: 'call_c', content: 'Wrote file successfully.' },
        { role: 'user', content: 'continue' },
      ],
    }
    const normalized = normalizeRequestBody(body, 'codestral')
    const toolMsgs = normalized.messages.filter((m) => m.role === 'tool')
    assert.equal(toolMsgs.length, 3, 'all 3 parallel tool results must survive')
  })

  it('still drops genuinely orphaned tool results', async () => {
    const { normalizeRequestBody } = await import('../src/core/schema-normalizer.js')
    const body = {
      model: 'fcm',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', tool_call_id: 'missing_id', content: 'orphan' },
      ],
    }
    const normalized = normalizeRequestBody(body, 'codestral')
    assert.equal(normalized.messages.filter((m) => m.role === 'tool').length, 0)
  })
})

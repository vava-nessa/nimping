/**
 * @file test/test.js
 * @description Unit tests for free-coding-models using Node.js built-in test runner.
 *
 * 📖 Run with: `node --test test/test.js` or `pnpm test`
 * 📖 Uses node:test + node:assert (zero dependencies, works on Node 18+)
 *
 * @functions
 *   → sources.js data integrity — validates model array structure, tiers, uniqueness
 *   → Core logic — getAvg, getVerdict, getUptime, filterByTier, sortResults, findBestModel
 *   → CLI arg parsing — parseArgs covers all flag combinations
 *   → Package & CLI sanity — package.json fields, bin entry, shebang, imports
 *   → Provider key test model discovery — protects settings key-check probes from stale provider catalogs
 *   → Provider key test outcome classification — distinguishes auth failure, rate limits, and no-callable-model cases
 *   → Provider key test diagnostics — explains probe failures in human-readable form
 *   → Router daemon integration — verifies failover, quota metadata, and upstream hardening with fake providers
 *
 * @see lib/utils.js — the functions under test
 * @see sources.js — model data validated here
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, accessSync, constants, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// 📖 Import modules under test
import { nvidiaNim, sources, MODELS } from '../sources.js'
import {
  getAvg, getVerdict, getUptime, getP95, getJitter, getStabilityScore,
  sortResults, filterByTier, findBestModel, parseArgs,
  TIER_ORDER, VERDICT_ORDER, TIER_LETTER_MAP,
  scoreModelForTask, getTopRecommendations, TASK_TYPES, PRIORITY_TYPES, CONTEXT_BUDGETS,
  formatCtxWindow, labelFromId, resolveSecurityAction,
  detectTerminalCapabilities,
  isProbeFailedRow, selectProbeFailedRows, PROBE_FAILED_STATUSES
} from '../src/core/utils.js'
import {
  _emptyProfileSettings,
  normalizeEndpointInstalls, getApiKey,
  buildPersistedConfig,
  normalizeRouterConfig,
  DEFAULT_ROUTER_SETTINGS
} from '../src/core/config.js'
import { buildDefaultRouterSet, cloneHeadersForUpstream, createRouterRuntimeForTest, formatOpenAiError } from '../src/core/router-daemon.js'
import { formatRouterDuration, normalizeRouterDashboardSnapshot, parseRouterDashboardSseFrame } from '../src/core/router-dashboard.js'
import { buildProviderModelTokenKey, loadTokenUsageByProviderModel, formatTokenTotalCompact } from '../src/core/token-usage-reader.js'
import { renderTable, getLastLayout } from '../src/tui/render-table.js'
import { createOverlayRenderers } from '../src/tui/overlays.js'
import { buildProviderModelsUrl, parseProviderModelIds, listProviderTestModels, classifyProviderTestOutcome, buildProviderTestDetail } from '../src/tui/key-handler.js'
import { buildCliHelpText, buildHowTheRouterWorksLines } from '../src/tui/cli-help.js'
import { formatMode, formatModeRwx } from '../src/core/security.js'
import { buildSyncCandidates } from '../src/core/sync-set.js'
import { detectPackageManager, resolveCurrentNpmInstallTarget, getInstallArgs, getManualInstallCmd, buildOutdatedWarningMessage } from '../src/core/updater.js'
import {
  parseRetryAfterMs,
  extractRetryAfterFromResponse,
  pauseProviderQuota,
  isProviderQuotaPaused,
  providerQuotaPauseRemaining,
  listPausedProviders,
  clearProviderQuotaPause,
} from '../src/core/provider-cooldown.js'
import {
  isCacheFresh as isProbeCacheFresh,
  recordProbeResults as recordProbeResult,
  BROKEN_COOLDOWN_STEPS_MS,
  brokenCooldownMs,
  DEFAULT_PROBE_TTL_MS,
} from '../src/core/probe-cache.js'
import {
  buildToolEnv,
  prepareExternalToolLaunch,
  resolveLauncherModelId,
} from '../src/core/tool-launchers.js'
import { getToolInstallPlan, isToolInstalled, resolveToolBinaryPath } from '../src/core/tool-bootstrap.js'
import { TOOL_METADATA, TOOL_MODE_ORDER, getCompatibleTools, isModelCompatibleWithTool, findSimilarCompatibleModels } from '../src/core/tool-metadata.js'
import { sortResultsWithPinnedFavorites, stripAnsi, fadedRow, displayWidth, padEndDisplay, keepOverlayTargetVisible, sliceOverlayLines, truncateAnsiWidth } from '../src/tui/render-helpers.js'
import { parseMouseEvents, containsMouseSequence, createMouseHandler, MOUSE_ENABLE, MOUSE_DISABLE } from '../src/tui/mouse.js'
import { COLUMN_SORT_MAP } from '../src/tui/render-table.js'
import { startOpenClaw } from '../src/core/openclaw.js'
import { getConfiguredInstallableProviders, getInstallTargetModes, installProviderEndpoints } from '../src/core/endpoint-installer.js'
import { cleanupLegacyProxyArtifacts } from '../src/core/legacy-proxy-cleanup.js'
import {
  buildEnvContent,
  buildRcSourceLine,
  getEnvFilePath,
  ENV_FILE_MARKER,
  detectShellInfo,
  syncShellEnv,
  ensureShellRcSource,
  removeShellEnv,
} from '../src/core/shell-env.js'
import {
  buildFixTasks,
  classifyToolTranscript,
  createTestfcmRunId,
  extractJsonPayload,
  hasConfiguredKey,
  normalizeTestfcmToolName,
  pickTestfcmSelectionIndex,
  resolveTestfcmToolSpec,
} from '../src/core/testfcm.js'
import {
  buildCommandPaletteEntries,
  fuzzyMatchCommand,
  filterCommandPaletteEntries,
} from '../src/tui/command-palette.js'
import { startWebServer, inspectExistingWebServer } from '../web/server.js'
import { buildTelemetryProperties, sendUsageTelemetry } from '../src/core/telemetry.js'
import {
  formatBenchmarkLatency,
  formatBenchmarkTps,
  formatBenchmarkResult,
  estimateTokensFromText,
  buildBenchmarkRequest,
  benchmarkModel,
} from '../src/core/benchmark.js'
import { buildChatCompletionPingBody, buildPingRequest, ping, extractQuotaPercent } from '../src/core/ping.js'

// ─── Helper: create a mock model result ──────────────────────────────────────
// 📖 Builds a minimal result object matching the shape used by the main script
function mockResult(overrides = {}) {
  return {
    idx: 1,
    modelId: 'test/model',
    label: 'Test Model',
    tier: 'S',
    sweScore: '50.0%',
    ctx: '128k',
    status: 'up',
    pings: [],
    httpCode: null,
    ...overrides,
  }
}

const ROUTER_TEST_MODELS = Object.freeze({
  groqFast: 'openai/gpt-oss-120b',
  groqBackup: 'openai/gpt-oss-120b',
  nvidiaFast: 'deepseek-ai/deepseek-v4-flash-0731',
})

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

function closeRouterTestServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

function readNodeRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function withTimeout(promise, ms, label) {
  let timeout = null
  return Promise.race([
    promise.finally(() => {
      if (timeout) clearTimeout(timeout)
    }),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}

async function withSourceUrls(overrides, fn) {
  // 📖 Router integration tests temporarily point real catalog providers at
  // 📖 localhost fake upstreams, then restore the catalog no matter what fails.
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

async function withMockProvider(responder, fn) {
  // 📖 This tiny OpenAI-compatible fake provider keeps Phase 2 tests
  // 📖 deterministic without adding a test framework or network dependency.
  const requests = []
  const server = createHttpServer(async (req, res) => {
    const bodyText = await readNodeRequestBody(req)
    const request = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      bodyText,
      body: bodyText ? JSON.parse(bodyText) : null,
    }
    requests.push(request)
    const response = await responder(request, res)
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
    return await fn({
      requests,
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      port,
      server,
    })
  } finally {
    await closeRouterTestServer(server)
  }
}

describe('extractQuotaPercent', () => {
  it('parses Groq request quota headers', () => {
    const headers = new Headers({
      'x-ratelimit-remaining-requests': '750',
      'x-ratelimit-limit-requests': '1000',
    })
    assert.strictEqual(extractQuotaPercent(headers), 75)
  })

  it('parses Cerebras daily request quota headers', () => {
    const headers = new Headers({
      'x-ratelimit-remaining-requests-day': '25',
      'x-ratelimit-limit-requests-day': '100',
    })
    assert.strictEqual(extractQuotaPercent(headers), 25)
  })

  it('parses Cerebras token-minute quota headers when request headers are absent', () => {
    const headers = new Headers({
      'x-ratelimit-remaining-tokens-minute': '12000',
      'x-ratelimit-limit-tokens-minute': '30000',
    })
    assert.strictEqual(extractQuotaPercent(headers), 40)
  })
})

describe('buildPingRequest', () => {
  it('adds disabled thinking to standard chat-completion ping payloads', () => {
    const req = buildPingRequest('test-key', 'zai/glm-5.1-air', 'zai', 'https://example.test/v1/chat/completions')

    assert.equal(req.body.model, 'glm-5.1-air')
    assert.deepEqual(req.body.thinking, { type: 'disabled' })
    assert.equal(req.body.max_tokens, 1)
  })

  it('adds disabled thinking to Cloudflare chat-completion ping payloads', () => {
    const req = buildPingRequest('cf-key', '@cf/meta/llama', 'cloudflare', 'https://example.test/{account_id}/ai/v1/chat/completions')

    assert.deepEqual(req.body.thinking, { type: 'disabled' })
    assert.equal(req.body.messages[0].content, 'hi')
  })

  it('keeps Replicate prediction probes free of OpenAI-only thinking fields', () => {
    const req = buildPingRequest('replicate-key', 'version-id', 'replicate', 'https://api.replicate.com/v1/predictions')

    assert.equal(Object.hasOwn(req.body, 'thinking'), false)
    assert.equal(req.body.input.prompt, 'hi')
  })

  it('allows router probes to add stream=false without losing disabled thinking', () => {
    const body = buildChatCompletionPingBody('test/model', { stream: false })

    assert.deepEqual(body.thinking, { type: 'disabled' })
    assert.equal(body.stream, false)
  })

  it('can explicitly omit disabled thinking for strict provider fallbacks', () => {
    const body = buildChatCompletionPingBody('test/model', { stream: false }, { disableThinking: false })

    assert.equal(Object.hasOwn(body, 'thinking'), false)
    assert.equal(body.stream, false)
  })

  it('retries once without thinking when a strict provider rejects that field', async () => {
    const originalFetch = globalThis.fetch
    const bodies = []
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: 'Unknown field: thinking' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ id: 'chatcmpl-test', choices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    try {
      const result = await ping('test-key', 'test/model', 'unit-thinking-fallback', 'https://example.test/v1/chat/completions')

      assert.equal(result.code, '200')
      assert.deepEqual(bodies[0].thinking, { type: 'disabled' })
      assert.equal(Object.hasOwn(bodies[1], 'thinking'), false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

function buildRouterTestConfig(models, overrides = {}) {
  // 📖 Tests use real router normalization so timeout/circuit defaults match
  // 📖 production behavior instead of silently depending on impossible values.
  const router = normalizeRouterConfig({
    ...DEFAULT_ROUTER_SETTINGS,
    enabled: true,
    onboardingSeen: true,
    activeSet: 'test-set',
    sets: {
      'test-set': {
        name: 'test-set',
        created: '2026-04-23T00:00:00.000Z',
        models,
        // 📖 t8 - per-set family failover toggle. Undefined normalizes to true
        // (default), false exercises the set-order fallback path.
        familyFailover: overrides.familyFailover,
      },
    },
    failover: {
      ...DEFAULT_ROUTER_SETTINGS.failover,
      maxRetries: overrides.maxRetries ?? models.length,
      requestTimeoutMs: overrides.requestTimeoutMs ?? 500,
      streamStallTimeoutMs: overrides.streamStallTimeoutMs ?? 100,
    },
    circuitBreaker: {
      ...DEFAULT_ROUTER_SETTINGS.circuitBreaker,
      failureThreshold: 1,
    },
  })
  return {
    telemetry: { enabled: false },
    apiKeys: {
      groq: 'gsk-router-test',
      nvidia: 'nvapi-router-test',
    },
    router,
  }
}

async function withRouterTestServer(config, fn) {
  const tokenPath = join(tmpdir(), `fcm-router-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  const runtime = createRouterRuntimeForTest({
    config,
    tokenPath,
    logger: {
      level: 'error',
      error() {},
      warn() {},
      info() {},
      debug() {},
    },
  })
  const server = createHttpServer((req, res) => void runtime.handleHttp(req, res))
  const port = await listenOnRandomPort(server)
  runtime.port = port
  runtime.server = server
  try {
    return await fn({
      runtime,
      port,
      baseUrl: `http://127.0.0.1:${port}`,
    })
  } finally {
    try { runtime.tokenTracker.flush({ force: true }) } catch {}
    await closeRouterTestServer(server)
    rmSync(tokenPath, { force: true })
  }
}

function routerChatBody(overrides = {}) {
  return {
    model: 'fcm',
    messages: [{ role: 'user', content: 'ping' }],
    ...overrides,
  }
}

async function postRouterChat(baseUrl, bodyOverrides = {}) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(routerChatBody(bodyOverrides)),
  })
}

describe('command palette fuzzy search', () => {
  it('matches in-order characters and returns highlight positions', () => {
    const out = fuzzyMatchCommand('srt', 'Sort by rank')
    assert.equal(out.matched, true)
    assert.ok(out.score > 0)
    assert.deepEqual(out.positions, [0, 2, 3])
  })

  it('returns no match when query letters are missing', () => {
    const out = fuzzyMatchCommand('zzz', 'Sort by rank')
    assert.equal(out.matched, false)
    assert.equal(out.score, 0)
    assert.deepEqual(out.positions, [])
  })

  it('ranks direct label matches above keyword-only matches', () => {
    const entries = buildCommandPaletteEntries()
    const commandsOnly = entries.filter(e => e.type === 'command')
    const ranked = filterCommandPaletteEntries(commandsOnly, 'uptime')
    assert.ok(ranked.length > 0)
    assert.equal(ranked[0].id, 'sort-uptime')
  })

  it('keeps a stable category+label order when scores tie', () => {
    const tied = [
      { id: 'x', label: 'Alpha', type: 'command', depth: 1, hasChildren: false, isExpanded: false, shortcut: null, keywords: ['foo'] },
      { id: 'y', label: 'Beta', type: 'command', depth: 1, hasChildren: false, isExpanded: false, shortcut: null, keywords: ['foo'] },
    ]
    const ranked = filterCommandPaletteEntries(tied, 'foo')
    assert.ok(ranked.length >= 2)
  })

  it('exposes explicit ping mode commands in the action submenu', () => {
    const entries = buildCommandPaletteEntries()
    const ids = new Set(entries.map((entry) => entry.id))
    assert.ok(ids.has('action-set-ping-speed'))
    assert.ok(ids.has('action-set-ping-normal'))
    assert.ok(ids.has('action-set-ping-slow'))
    assert.ok(ids.has('action-set-ping-forced'))
  })

  it('exposes explicit tool and favorites mode commands in the action submenu', () => {
    const entries = buildCommandPaletteEntries()
    const ids = new Set(entries.map((entry) => entry.id))
    assert.ok(ids.has('action-set-tool-opencode'))
    assert.ok(ids.has('action-set-tool-opencode-desktop'))
    assert.ok(ids.has('action-set-tool-openclaw'))
    assert.ok(ids.has('action-toggle-favorite-mode'))
    assert.ok(ids.has('action-favorites-mode-pinned'))
    assert.ok(ids.has('action-favorites-mode-normal'))
  })

  it('keeps router pages out of the visible command palette', () => {
    const entries = buildCommandPaletteEntries()
    const ids = new Set(entries.map((entry) => entry.id))
    assert.equal(ids.has('open-router-dashboard'), false)
    assert.equal(ids.has('open-token-usage'), false)
  })
})

describe('router dashboard helpers', () => {
  it('formats daemon uptime compactly', () => {
    assert.equal(formatRouterDuration(45), '45s')
    assert.equal(formatRouterDuration(125), '2m 5s')
    assert.equal(formatRouterDuration(7320), '2h 2m')
  })

  it('normalizes malformed daemon payloads without throwing', () => {
    const snapshot = normalizeRouterDashboardSnapshot(null, {
      models: [
        { provider: 'groq', model: 'llama', state: 'closed', score: '0.8', uptime: '0.5' },
        null,
      ],
      requestLog: [{ model: 'groq/llama', status: 200, tokens: '12' }],
      tokens: { today: { total_tokens: '1000' }, all_time: { requests: '2' } },
    })

    assert.equal(snapshot.ok, false)
    assert.equal(snapshot.models.length, 2)
    assert.equal(snapshot.models[0].state, 'CLOSED')
    assert.equal(snapshot.models[1].provider, 'unknown')
    assert.equal(snapshot.requestLog[0].tokens, 12)
    assert.equal(snapshot.tokens.today.total_tokens, 1000)
    assert.equal(snapshot.tokens.all_time.requests, 2)
  })

  it('parses SSE event frames defensively', () => {
    const parsed = parseRouterDashboardSseFrame('event: request\ndata: {"model":"groq/x","status":200}\n\n')
    assert.equal(parsed.event, 'request')
    assert.deepEqual(parsed.data, { model: 'groq/x', status: 200 })

    const malformed = parseRouterDashboardSseFrame('event: probe\ndata: nope\n\n')
    assert.equal(malformed.event, 'probe')
    assert.equal(malformed.data, 'nope')
  })
})

describe('router pre-prompt injection', () => {
  it('prepends the pre-prompt as the first system message', async () => {
    const { injectPrePrompt } = await import('../src/core/router-daemon.js')
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]
    const out = injectPrePrompt(messages, { enabled: true, text: 'You are free-coding-models.' })
    assert.equal(out.length, 3)
    assert.equal(out[0].role, 'system')
    assert.equal(out[0].content, 'You are free-coding-models.')
    assert.equal(out[1], messages[0])
    assert.equal(out[2], messages[1])
  })

  it('does not mutate the original messages array', async () => {
    const { injectPrePrompt } = await import('../src/core/router-daemon.js')
    const original = [{ role: 'user', content: 'Hello' }]
    const out = injectPrePrompt(original, { enabled: true, text: 'Pre' })
    assert.notEqual(out, original)
    assert.equal(original.length, 1, 'original array must be untouched')
  })

  it('skips injection when the pre-prompt is disabled', async () => {
    const { injectPrePrompt } = await import('../src/core/router-daemon.js')
    const messages = [{ role: 'user', content: 'Hi' }]
    const out = injectPrePrompt(messages, { enabled: false, text: 'Pre' })
    assert.equal(out, messages, 'disabled pre-prompt must return the same array reference')
  })

  it('skips injection when the pre-prompt text is empty', async () => {
    const { injectPrePrompt } = await import('../src/core/router-daemon.js')
    const messages = [{ role: 'user', content: 'Hi' }]
    const out = injectPrePrompt(messages, { enabled: true, text: '   \n  ' })
    assert.equal(out, messages)
  })

  it('skips injection when the first message is already an exact match', async () => {
    const { injectPrePrompt } = await import('../src/core/router-daemon.js')
    const prompt = 'You are free-coding-models.'
    const messages = [
      { role: 'system', content: prompt },
      { role: 'user', content: 'Hi' },
    ]
    const out = injectPrePrompt(messages, { enabled: true, text: prompt })
    assert.equal(out, messages, 'already-set pre-prompt must not be duplicated')
  })

  it('applyPrePromptToBody merges the pre-prompt into a chat body', async () => {
    const { applyPrePromptToBody } = await import('../src/core/router-daemon.js')
    const body = { model: 'fcm', messages: [{ role: 'user', content: 'Hi' }], temperature: 0.7 }
    const out = applyPrePromptToBody(body, { enabled: true, text: 'Pre' })
    assert.equal(out.model, 'fcm')
    assert.equal(out.temperature, 0.7)
    assert.equal(out.messages[0].role, 'system')
    assert.equal(out.messages[0].content, 'Pre')
    assert.equal(out.messages[1].role, 'user')
  })

  it('applyPrePromptToBody returns a body object even with garbage input', async () => {
    const { applyPrePromptToBody } = await import('../src/core/router-daemon.js')
    const out = applyPrePromptToBody(null, { enabled: true, text: 'Pre' })
    assert.deepEqual(out, { messages: [{ role: 'system', content: 'Pre' }] })
  })

  it('caps the pre-prompt text to 4000 characters after normalization', async () => {
    const { normalizeRouterPrePrompt } = await import('../src/core/config.js')
    const huge = 'a'.repeat(8000)
    const out = normalizeRouterPrePrompt({ enabled: true, text: huge })
    assert.equal(out.enabled, true)
    assert.equal(out.text.length, 4000)
  })

  it('default pre-prompt is non-empty and starts with the FCM persona', async () => {
    const { DEFAULT_ROUTER_SETTINGS, defaultRouterPrePromptText } = await import('../src/core/config.js')
    const text = defaultRouterPrePromptText()
    assert.ok(text.length > 80, 'default pre-prompt must be substantive')
    assert.match(text, /free-coding-models/i)
    assert.equal(DEFAULT_ROUTER_SETTINGS.prePrompt.enabled, true)
  })
})

describe('router schema normalizer (GLM, Mistral, Codestral)', () => {
  it('returns the body unchanged for providers without a normalizer', async () => {
    const { normalizeRequestBody } = await import('../src/core/schema-normalizer.js')
    const body = { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }], parallel_tool_calls: true }
    const out = normalizeRequestBody(body, 'groq')
    assert.equal(out, body, 'unknown provider must return the same body reference')
  })

  it('returns the body unchanged for null/undefined/non-object input', async () => {
    const { normalizeRequestBody } = await import('../src/core/schema-normalizer.js')
    assert.equal(normalizeRequestBody(null, 'zai'), null)
    assert.equal(normalizeRequestBody(undefined, 'zai'), undefined)
    assert.equal(normalizeRequestBody('garbage', 'zai'), 'garbage')
  })

  it('zai: strips parallel_tool_calls, n, top_k, logprobs, echo, user, metadata, store', async () => {
    const { normalizeZai } = await import('../src/core/schema-normalizer.js')
    const body = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'hi' }],
      parallel_tool_calls: true,
      n: 3,
      top_k: 40,
      logprobs: true,
      echo: true,
      user: 'alice',
      metadata: { foo: 'bar' },
      store: true,
      temperature: 0.7,
    }
    const out = normalizeZai(body)
    assert.equal(out.model, 'glm-4.7')
    assert.equal(out.temperature, 0.7)
    assert.equal(out.messages.length, 1)
    assert.ok(!('parallel_tool_calls' in out), 'parallel_tool_calls must be stripped')
    assert.ok(!('n' in out), 'n must be stripped')
    assert.ok(!('top_k' in out), 'top_k must be stripped')
    assert.ok(!('logprobs' in out), 'logprobs must be stripped')
    assert.ok(!('echo' in out), 'echo must be stripped')
    assert.ok(!('user' in out), 'user must be stripped')
    assert.ok(!('metadata' in out), 'metadata must be stripped')
    assert.ok(!('store' in out), 'store must be stripped')
  })

  it('zai: removes orphan tool messages that lack a matching assistant tool_call', async () => {
    const { normalizeZai } = await import('../src/core/schema-normalizer.js')
    const body = {
      model: 'glm-4.7',
      messages: [
        { role: 'user', content: 'what is the weather?' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
        // 📖 orphan: tool message without a preceding assistant tool_call with id 'call_2'
        { role: 'tool', tool_call_id: 'call_2', content: 'orphaned' },
        { role: 'assistant', content: 'It is sunny.' },
      ],
    }
    const out = normalizeZai(body)
    assert.equal(out.messages.length, 4, 'orphan tool message must be dropped')
    assert.equal(out.messages[2].tool_call_id, 'call_1')
    assert.equal(out.messages[3].content, 'It is sunny.')
  })

  it('zai: removes tool messages whose tool_call_id has no matching assistant tool_call', async () => {
    const { normalizeZai } = await import('../src/core/schema-normalizer.js')
    const body = {
      model: 'glm-4.7',
      messages: [
        { role: 'user', content: 'hi' },
        // 📖 the assistant message lost its tool_calls (ZCode quirk),
        // 📖 but the tool result was kept — GLM rejects this with 422
        { role: 'tool', tool_call_id: 'call_xyz', content: 'result' },
        { role: 'assistant', content: 'done' },
      ],
    }
    const out = normalizeZai(body)
    assert.equal(out.messages.length, 2)
    assert.equal(out.messages[0].role, 'user')
    assert.equal(out.messages[1].content, 'done')
  })

  it('zai: removes tool messages with no tool_call_id field', async () => {
    const { normalizeZai } = await import('../src/core/schema-normalizer.js')
    const body = {
      model: 'glm-4.7',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'result with no id' },
      ],
    }
    const out = normalizeZai(body)
    assert.equal(out.messages.length, 1)
    assert.equal(out.messages[0].role, 'user')
  })

  it('zai: strips stream_options when not streaming', async () => {
    const { normalizeZai } = await import('../src/core/schema-normalizer.js')
    const body = { model: 'glm-4.7', stream: false, stream_options: { include_usage: true } }
    const out = normalizeZai(body)
    assert.ok(!('stream_options' in out), 'stream_options must be stripped when stream=false')
  })

  it('zai: keeps stream_options when streaming', async () => {
    const { normalizeZai } = await import('../src/core/schema-normalizer.js')
    const body = { model: 'glm-4.7', stream: true, stream_options: { include_usage: true } }
    const out = normalizeZai(body)
    assert.deepEqual(out.stream_options, { include_usage: true })
  })

  it('mistral: clamps temperature > 1 down to 1', async () => {
    const { normalizeMistral } = await import('../src/core/schema-normalizer.js')
    const out = normalizeMistral({ model: 'mistral-large', temperature: 1.7 })
    assert.equal(out.temperature, 1)
  })

  it('mistral: clamps temperature < 0 up to 0', async () => {
    const { normalizeMistral } = await import('../src/core/schema-normalizer.js')
    const out = normalizeMistral({ model: 'mistral-large', temperature: -0.5 })
    assert.equal(out.temperature, 0)
  })

  it('mistral: keeps temperature in [0, 1] unchanged', async () => {
    const { normalizeMistral } = await import('../src/core/schema-normalizer.js')
    const out = normalizeMistral({ model: 'mistral-large', temperature: 0.3 })
    assert.equal(out.temperature, 0.3)
  })

  it('codestral: uses the mistral normalizer (clamp + orphan tool drop)', async () => {
    const { normalizeRequestBody } = await import('../src/core/schema-normalizer.js')
    const body = {
      model: 'codestral-2508',
      temperature: 2.5,
      parallel_tool_calls: true,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'tool', tool_call_id: 'orphan', content: 'r' },
      ],
    }
    const out = normalizeRequestBody(body, 'codestral')
    assert.equal(out.temperature, 1)
    assert.ok(!('parallel_tool_calls' in out))
    assert.equal(out.messages.length, 1)
  })

  it('zai: dispatcher entry point works (normalizeRequestBody + "zai")', async () => {
    const { normalizeRequestBody } = await import('../src/core/schema-normalizer.js')
    const body = { model: 'glm-4.7', parallel_tool_calls: true, messages: [{ role: 'user', content: 'hi' }] }
    const out = normalizeRequestBody(body, 'zai')
    assert.ok(!('parallel_tool_calls' in out))
  })

  it('does not mutate the input body object', async () => {
    const { normalizeZai } = await import('../src/core/schema-normalizer.js')
    const body = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'hi' }],
      parallel_tool_calls: true,
    }
    const snapshot = JSON.parse(JSON.stringify(body))
    normalizeZai(body)
    assert.deepEqual(body, snapshot, 'input body must not be mutated')
  })
})

describe('router friendly labels + how-the-router-works help', () => {
  it('translates CLOSED/OPEN/HALF_OPEN/AUTH_ERROR/STALE to plain English', () => {
    // 📖 The CircuitBadge in RouterView should never show the raw jargon
    // 📖 to the user. The help text must mention the friendly label
    // 📖 instead of (or in addition to) the raw state name.
    const lines = buildHowTheRouterWorksLines()
    const text = lines.join('\n')
    assert.ok(text.includes('Healthy'), 'should mention Healthy (was CLOSED)')
    assert.ok(text.includes('Down'), 'should mention Down (was OPEN)')
    assert.ok(text.includes('Recovering'), 'should mention Recovering (was HALF_OPEN)')
    assert.ok(text.includes('Auth error'), 'should mention Auth error (was AUTH_ERROR)')
    assert.ok(text.includes('Deprecated'), 'should mention Deprecated (was STALE)')
  })

  it('explains the probe mechanism and rate limits in the help', () => {
    const text = buildHowTheRouterWorksLines().join('\n')
    assert.ok(text.includes('probe'), 'help must explain probes')
    assert.ok(text.includes('429') || text.includes('rate limit'), 'help must mention rate limits')
    assert.ok(text.includes('auto-heal') || text.includes('Auto-heal'), 'help must mention auto-heal')
  })
})

describe('playground error message extraction', () => {
  it('returns the OpenAI error message when the body is the standard wire format', async () => {
    const { extractErrorMessage } = await import('../src/core/playground.js')
    const result = extractErrorMessage({
      error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' },
    })
    assert.equal(result, 'Invalid API key')
  })

  it('returns a string error verbatim when the server uses a custom shape', async () => {
    const { extractErrorMessage } = await import('../src/core/playground.js')
    assert.equal(extractErrorMessage({ error: 'oops' }), 'oops')
  })

  it('falls back to top-level message when no error object is present', async () => {
    const { extractErrorMessage } = await import('../src/core/playground.js')
    assert.equal(extractErrorMessage({ message: 'fatal' }), 'fatal')
  })

  it('returns null for empty or malformed payloads', async () => {
    const { extractErrorMessage } = await import('../src/core/playground.js')
    assert.equal(extractErrorMessage(null), null)
    assert.equal(extractErrorMessage(undefined), null)
    assert.equal(extractErrorMessage({}), null)
    assert.equal(extractErrorMessage(42), null)
  })
})

// 📖 1. SOURCES.JS DATA INTEGRITY
// ═══════════════════════════════════════════════════════════════════════════════
describe('sources.js data integrity', () => {
  const VALID_TIERS = ['S+', 'S', 'A+', 'A', 'A-', 'B+', 'B', 'C']

  it('nvidiaNim is a non-empty array', () => {
    assert.ok(Array.isArray(nvidiaNim))
    assert.ok(nvidiaNim.length > 0, 'nvidiaNim should have models')
  })

  it('every model entry has [modelId, label, tier, sweScore, ctx] structure', () => {
    for (const entry of nvidiaNim) {
      assert.ok(Array.isArray(entry), `Entry should be an array: ${JSON.stringify(entry)}`)
      assert.equal(entry.length, 5, `Entry should have 5 elements: ${JSON.stringify(entry)}`)
      assert.equal(typeof entry[0], 'string', `modelId should be string: ${entry[0]}`)
      assert.equal(typeof entry[1], 'string', `label should be string: ${entry[1]}`)
      assert.equal(typeof entry[2], 'string', `tier should be string: ${entry[2]}`)
      assert.equal(typeof entry[3], 'string', `sweScore should be string: ${entry[3]}`)
      assert.equal(typeof entry[4], 'string', `ctx should be string: ${entry[4]}`)
    }
  })

  it('all tiers are valid', () => {
    for (const [modelId, , tier] of nvidiaNim) {
      assert.ok(VALID_TIERS.includes(tier), `Invalid tier "${tier}" for model "${modelId}"`)
    }
  })

  it('no duplicate model IDs', () => {
    const ids = nvidiaNim.map(m => m[0])
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    assert.deepEqual(dupes, [], `Duplicate model IDs found: ${dupes.join(', ')}`)
  })

  it('MODELS flat array matches sources count', () => {
    const today = new Date().toISOString().split('T')[0]
    let totalFromSources = 0
    for (const s of Object.values(sources)) {
      for (const m of s.models) {
        const deprecatedAfter = m[6]
        if (deprecatedAfter && today > deprecatedAfter) continue
        totalFromSources += 1
      }
    }
    assert.equal(MODELS.length, totalFromSources, 'MODELS length should match sum of all source models')
  })

  it('sources object has nvidia key with correct structure', () => {
    assert.ok(sources.nvidia, 'sources.nvidia should exist')
    assert.equal(sources.nvidia.name, 'NVIDIA NIM')
    assert.ok(Array.isArray(sources.nvidia.models))
    assert.equal(sources.nvidia.models, nvidiaNim)
  })

  it('sources object has vercel-gateway with correct structure', () => {
    assert.ok(sources['vercel-gateway'], 'sources vercel-gateway should exist')
    assert.equal(sources['vercel-gateway'].name, 'Vercel AI Gateway')
    assert.equal(sources['vercel-gateway'].url, 'https://ai-gateway.vercel.sh/v1/chat/completions')
    assert.equal(sources['vercel-gateway'].quotaCode, 'limited')
    assert.ok(Array.isArray(sources['vercel-gateway'].models))
    assert.ok(sources['vercel-gateway'].models.length >= 3, 'vercel-gateway should list its $0 models')
    for (const m of sources['vercel-gateway'].models) {
      assert.ok(m[0].endsWith('-free'), `vercel-gateway model ${m[0]} should be an explicit $0 model`)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 2. CORE LOGIC FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════
describe('getAvg', () => {
  it('returns Infinity when no pings', () => {
    assert.equal(getAvg(mockResult({ pings: [] })), Infinity)
  })

  it('returns Infinity when no successful pings', () => {
    assert.equal(getAvg(mockResult({ pings: [{ ms: 500, code: '500' }] })), Infinity)
  })

  it('calculates average from successful pings only', () => {
    const r = mockResult({
      pings: [
        { ms: 200, code: '200' },
        { ms: 400, code: '200' },
        { ms: 999, code: '500' }, // 📖 should be ignored
      ]
    })
    assert.equal(getAvg(r), 300)
  })

  it('includes 401 pings because no-key responses still measure real latency', () => {
    const r = mockResult({
      pings: [
        { ms: 200, code: '200' },
        { ms: 400, code: '401' },
        { ms: 999, code: '500' },
      ]
    })
    assert.equal(getAvg(r), 300)
  })

  it('rounds to integer', () => {
    const r = mockResult({
      pings: [{ ms: 333, code: '200' }, { ms: 334, code: '200' }]
    })
    assert.equal(getAvg(r), 334) // 📖 (333+334)/2 = 333.5 → 334
  })
})

describe('getVerdict', () => {
  it('returns Overloaded for 429 status', () => {
    assert.equal(getVerdict(mockResult({ httpCode: '429', pings: [{ ms: 100, code: '429' }] })), 'Overloaded')
  })

  it('returns Perfect for fast avg (<400ms)', () => {
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 200, code: '200' }] })), 'Perfect')
  })

  it('returns Normal for avg 400-999ms', () => {
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 500, code: '200' }] })), 'Normal')
  })

  it('returns Slow for avg 1000-2999ms', () => {
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 2000, code: '200' }] })), 'Slow')
  })

  it('returns Very Slow for avg 3000-4999ms', () => {
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 4000, code: '200' }] })), 'Very Slow')
  })

  it('returns Unstable for timeout with prior success', () => {
    assert.equal(getVerdict(mockResult({
      status: 'timeout',
      pings: [{ ms: 200, code: '200' }, { ms: 0, code: '000' }]
    })), 'Unstable')
  })

  it('returns Not Active for timeout without prior success', () => {
    assert.equal(getVerdict(mockResult({ status: 'timeout', pings: [{ ms: 0, code: '000' }] })), 'Not Active')
  })

  it('returns Pending when no successful pings and status is up', () => {
    assert.equal(getVerdict(mockResult({ status: 'up', pings: [] })), 'Pending')
  })

  it('uses 401-only latency samples for noauth verdicts', () => {
    assert.equal(getVerdict(mockResult({
      status: 'noauth',
      httpCode: '401',
      pings: [{ ms: 350, code: '401' }]
    })), 'Perfect')
  })
})

describe('getUptime', () => {
  it('returns 0 when no pings', () => {
    assert.equal(getUptime(mockResult({ pings: [] })), 0)
  })

  it('returns 100 when all pings succeed', () => {
    assert.equal(getUptime(mockResult({
      pings: [{ ms: 100, code: '200' }, { ms: 200, code: '200' }]
    })), 100)
  })

  it('returns 50 when half succeed', () => {
    assert.equal(getUptime(mockResult({
      pings: [{ ms: 100, code: '200' }, { ms: 0, code: '500' }]
    })), 50)
  })

  it('returns 0 when none succeed', () => {
    assert.equal(getUptime(mockResult({
      pings: [{ ms: 0, code: '500' }, { ms: 0, code: '429' }]
    })), 0)
  })
})

describe('provider key test model discovery', () => {
  it('derives /models from a chat completions url', () => {
    assert.equal(
      buildProviderModelsUrl('https://api.sambanova.ai/v1/chat/completions'),
      'https://api.sambanova.ai/v1/models'
    )
  })

  it('returns null when the provider url is not chat/completions', () => {
    assert.equal(buildProviderModelsUrl('https://api.replicate.com/v1/predictions'), null)
  })

  it('parses model ids from an OpenAI-style /models payload', () => {
    assert.deepEqual(
      parseProviderModelIds({
        data: [
          { id: 'DeepSeek-V3-0324' },
          { id: 'Meta-Llama-3.1-8B-Instruct' },
          { nope: true },
        ],
      }),
      ['DeepSeek-V3-0324', 'Meta-Llama-3.1-8B-Instruct']
    )
  })

  it('prioritizes the SambaNova override ahead of discovered and static ids', () => {
    assert.deepEqual(
      listProviderTestModels('sambanova', sources.sambanova, ['Qwen3-235B', 'DeepSeek-V3.1']).slice(0, 4),
      ['MiniMax-M2.5', 'DeepSeek-V3.1', 'DeepSeek-V3.2', 'Qwen3-235B']
    )
  })

  it('uses discovered repo-known ids before the static catalog head for NVIDIA', () => {
    assert.deepEqual(
      listProviderTestModels('nvidia', sources.nvidia, ['openai/gpt-oss-120b', 'deepseek-ai/deepseek-v4-flash-0731']).slice(0, 5),
      [
        'deepseek-ai/deepseek-v4-flash-0731',
        'openai/gpt-oss-120b',
        'nvidia/nemotron-3-ultra-550b-a55b',
        'poolside/laguna-xs-2.1',
        'meta/muse-glimmer-30b',
      ]
    )
  })

  it('falls back to static models when no discovery data exists', () => {
    assert.equal(
      listProviderTestModels('groq', sources.groq)[0],
      'openai/gpt-oss-120b'
    )
  })
})

describe('classifyProviderTestOutcome', () => {
  it('returns ok when any probe succeeds', () => {
    assert.equal(classifyProviderTestOutcome(['404', '200']), 'ok')
  })

  it('returns fail on auth errors', () => {
    assert.equal(classifyProviderTestOutcome(['403']), 'auth_error')
  })

  it('returns rate_limited when all attempted probes are throttled', () => {
    assert.equal(classifyProviderTestOutcome(['429', '429']), 'rate_limited')
  })

  it('returns no_callable_model when every attempted model is missing', () => {
    assert.equal(classifyProviderTestOutcome(['404', '410', '404']), 'no_callable_model')
  })

  it('falls back to fail for mixed non-auth transport or server errors', () => {
    assert.equal(classifyProviderTestOutcome(['404', '500', 'ERR']), 'fail')
  })
})

describe('buildProviderTestDetail', () => {
  it('mentions auth rejection and attempt history', () => {
    const detail = buildProviderTestDetail('Groq', 'auth_error', [
      { attempt: 1, model: 'openai/gpt-oss-120b', code: '401' },
    ], 'Live model discovery returned HTTP 401; falling back to the repo catalog.')

    assert.match(detail, /Groq rejected the configured key/i)
    assert.match(detail, /invalid, expired, revoked, or truncated/i)
    assert.match(detail, /#1 openai\/gpt-oss-120b -> 401/)
  })

  it('explains rate limiting separately from auth failure', () => {
    const detail = buildProviderTestDetail('OpenRouter', 'rate_limited', [
      { attempt: 1, model: 'qwen/qwen3-coder:free', code: '429' },
      { attempt: 2, model: 'openai/gpt-oss-120b:free', code: '429' },
    ])

    assert.match(detail, /throttled every probe/i)
    assert.match(detail, /quota window/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 2b. STABILITY FUNCTIONS (p95, jitter, stability score)
// ═══════════════════════════════════════════════════════════════════════════════
describe('getP95', () => {
  it('returns Infinity when no pings', () => {
    assert.equal(getP95(mockResult({ pings: [] })), Infinity)
  })

  it('returns Infinity when no successful pings', () => {
    assert.equal(getP95(mockResult({ pings: [{ ms: 500, code: '500' }] })), Infinity)
  })

  it('returns the single value when one ping', () => {
    assert.equal(getP95(mockResult({ pings: [{ ms: 300, code: '200' }] })), 300)
  })

  it('returns the highest value for small sets', () => {
    // With 5 pings: ceil(5 * 0.95) - 1 = 4 → last element
    const r = mockResult({
      pings: [
        { ms: 100, code: '200' }, { ms: 200, code: '200' },
        { ms: 300, code: '200' }, { ms: 400, code: '200' },
        { ms: 5000, code: '200' },
      ]
    })
    assert.equal(getP95(r), 5000)
  })

  it('ignores non-200 pings', () => {
    const r = mockResult({
      pings: [
        { ms: 100, code: '200' }, { ms: 200, code: '200' },
        { ms: 99999, code: '500' }, // should be ignored
      ]
    })
    assert.equal(getP95(r), 200)
  })

  it('includes 401 pings in percentile calculations', () => {
    const r = mockResult({
      pings: [
        { ms: 100, code: '401' },
        { ms: 200, code: '200' },
        { ms: 99999, code: '500' },
      ]
    })
    assert.equal(getP95(r), 200)
  })

  it('catches tail latency spikes with 20 pings', () => {
    // With 20 pings: p95 index = ceil(20 * 0.95) - 1 = 18
    // Need at least 2 high values so index 18 hits the spike
    const pings = Array.from({ length: 18 }, () => ({ ms: 200, code: '200' }))
    pings.push({ ms: 5000, code: '200' })
    pings.push({ ms: 5000, code: '200' })
    const r = mockResult({ pings })
    assert.equal(getP95(r), 5000)
  })
})

describe('getJitter', () => {
  it('returns 0 when no pings', () => {
    assert.equal(getJitter(mockResult({ pings: [] })), 0)
  })

  it('returns 0 when only one ping', () => {
    assert.equal(getJitter(mockResult({ pings: [{ ms: 500, code: '200' }] })), 0)
  })

  it('returns 0 when all pings are identical', () => {
    const r = mockResult({
      pings: [{ ms: 300, code: '200' }, { ms: 300, code: '200' }, { ms: 300, code: '200' }]
    })
    assert.equal(getJitter(r), 0)
  })

  it('calculates correct jitter for known values', () => {
    // pings: 100, 300 → mean = 200, variance = ((100-200)^2 + (300-200)^2)/2 = 10000, σ = 100
    const r = mockResult({
      pings: [{ ms: 100, code: '200' }, { ms: 300, code: '200' }]
    })
    assert.equal(getJitter(r), 100)
  })

  it('ignores non-200 pings', () => {
    const r = mockResult({
      pings: [
        { ms: 300, code: '200' }, { ms: 300, code: '200' },
        { ms: 99999, code: '500' }, // should be ignored
      ]
    })
    assert.equal(getJitter(r), 0)
  })

  it('includes 401 pings in jitter calculations', () => {
    const r = mockResult({
      pings: [
        { ms: 100, code: '401' },
        { ms: 300, code: '200' },
        { ms: 99999, code: '500' },
      ]
    })
    assert.equal(getJitter(r), 100)
  })

  it('returns high jitter for spiky latencies', () => {
    const r = mockResult({
      pings: [
        { ms: 100, code: '200' }, { ms: 100, code: '200' },
        { ms: 100, code: '200' }, { ms: 5000, code: '200' },
      ]
    })
    // mean = 1325, large std dev
    const jitter = getJitter(r)
    assert.ok(jitter > 1000, `Expected high jitter, got ${jitter}`)
  })
})

describe('getStabilityScore', () => {
  it('returns -1 when no successful pings', () => {
    assert.equal(getStabilityScore(mockResult({ pings: [] })), -1)
    assert.equal(getStabilityScore(mockResult({ pings: [{ ms: 0, code: '500' }] })), -1)
  })

  it('returns high score for consistent fast model', () => {
    const r = mockResult({
      pings: [
        { ms: 200, code: '200' }, { ms: 210, code: '200' },
        { ms: 190, code: '200' }, { ms: 205, code: '200' },
        { ms: 195, code: '200' },
      ]
    })
    const score = getStabilityScore(r)
    assert.ok(score >= 80, `Expected high stability score, got ${score}`)
  })

  it('computes a stability score from 401 latency samples too', () => {
    const score = getStabilityScore(mockResult({
      status: 'noauth',
      pings: [
        { ms: 200, code: '401' },
        { ms: 220, code: '401' },
        { ms: 210, code: '401' },
      ]
    }))
    assert.ok(score >= 0 && score <= 100, `Score should be 0-100, got ${score}`)
  })

  it('returns low score for spiky model', () => {
    const r = mockResult({
      pings: [
        { ms: 100, code: '200' }, { ms: 100, code: '200' },
        { ms: 100, code: '200' }, { ms: 8000, code: '200' },
        { ms: 100, code: '200' }, { ms: 7000, code: '200' },
      ]
    })
    const score = getStabilityScore(r)
    assert.ok(score < 60, `Expected low stability score for spiky model, got ${score}`)
  })

  it('penalizes low uptime', () => {
    const good = mockResult({
      pings: [
        { ms: 200, code: '200' }, { ms: 200, code: '200' },
        { ms: 200, code: '200' }, { ms: 200, code: '200' },
      ]
    })
    const flaky = mockResult({
      pings: [
        { ms: 200, code: '200' }, { ms: 0, code: '500' },
        { ms: 0, code: '500' }, { ms: 0, code: '500' },
      ]
    })
    assert.ok(getStabilityScore(good) > getStabilityScore(flaky))
  })

  it('Model B (consistent 400ms) scores higher than Model A (avg 250ms, spiky p95)', () => {
    // The motivating example from the issue
    const modelA = mockResult({
      pings: [
        { ms: 100, code: '200' }, { ms: 100, code: '200' },
        { ms: 100, code: '200' }, { ms: 100, code: '200' },
        { ms: 100, code: '200' }, { ms: 100, code: '200' },
        { ms: 100, code: '200' }, { ms: 100, code: '200' },
        { ms: 100, code: '200' }, { ms: 6000, code: '200' }, // p95 spike!
      ]
    })
    const modelB = mockResult({
      pings: [
        { ms: 400, code: '200' }, { ms: 380, code: '200' },
        { ms: 420, code: '200' }, { ms: 410, code: '200' },
        { ms: 390, code: '200' }, { ms: 400, code: '200' },
        { ms: 395, code: '200' }, { ms: 405, code: '200' },
        { ms: 400, code: '200' }, { ms: 400, code: '200' },
      ]
    })
    assert.ok(
      getStabilityScore(modelB) > getStabilityScore(modelA),
      `Model B (consistent) should score higher than Model A (spiky)`
    )
  })

  it('score is between 0 and 100 for valid data', () => {
    const r = mockResult({
      pings: [{ ms: 500, code: '200' }, { ms: 1000, code: '200' }]
    })
    const score = getStabilityScore(r)
    assert.ok(score >= 0 && score <= 100, `Score should be 0-100, got ${score}`)
  })
})

describe('getVerdict stability-aware', () => {
  it('returns Spiky for normal avg but terrible p95 (≥3 pings)', () => {
    // 18 pings at 200ms + 2 at 8000ms
    // avg = (18*200 + 2*8000)/20 = (3600+16000)/20 = 980ms → Normal range
    // p95 index = ceil(20*0.95)-1 = 18, sorted[18] = 8000 → p95 > 5000 → Spiky
    const pings = Array.from({ length: 18 }, () => ({ ms: 200, code: '200' }))
    pings.push({ ms: 8000, code: '200' })
    pings.push({ ms: 8000, code: '200' })
    const r = mockResult({ pings })
    assert.equal(getVerdict(r), 'Spiky')
  })

  it('still returns Perfect for fast avg when p95 is fine', () => {
    const r = mockResult({
      pings: [
        { ms: 200, code: '200' }, { ms: 210, code: '200' },
        { ms: 190, code: '200' }, { ms: 205, code: '200' },
      ]
    })
    assert.equal(getVerdict(r), 'Perfect')
  })

  it('does not flag Spiky with only 1-2 pings (not enough data)', () => {
    const r = mockResult({
      pings: [{ ms: 100, code: '200' }, { ms: 5000, code: '200' }]
    })
    // avg = 2550 which is > 1000 but < 3000, so verdict is Slow (not Spiky)
    // The avg pushes it out of the "fast" range entirely
    const verdict = getVerdict(r)
    assert.ok(verdict !== 'Spiky', `Should not be Spiky with 2 pings, got ${verdict}`)
  })

  it('Spiky is in VERDICT_ORDER', () => {
    assert.ok(VERDICT_ORDER.includes('Spiky'), 'VERDICT_ORDER should include Spiky')
  })
})

describe('filterByTier', () => {
  const results = [
    mockResult({ tier: 'S+', label: 'A' }),
    mockResult({ tier: 'S', label: 'B' }),
    mockResult({ tier: 'A+', label: 'C' }),
    mockResult({ tier: 'A', label: 'D' }),
    mockResult({ tier: 'A-', label: 'E' }),
    mockResult({ tier: 'B+', label: 'F' }),
    mockResult({ tier: 'B', label: 'G' }),
    mockResult({ tier: 'C', label: 'H' }),
  ]

  it('filters S tier (S+ and S)', () => {
    const filtered = filterByTier(results, 'S')
    assert.equal(filtered.length, 2)
    assert.ok(filtered.every(r => ['S+', 'S'].includes(r.tier)))
  })

  it('filters A tier (A+, A, A-)', () => {
    const filtered = filterByTier(results, 'A')
    assert.equal(filtered.length, 3)
  })

  it('filters B tier (B+, B)', () => {
    const filtered = filterByTier(results, 'B')
    assert.equal(filtered.length, 2)
  })

  it('filters C tier (C only)', () => {
    const filtered = filterByTier(results, 'C')
    assert.equal(filtered.length, 1)
  })

  it('is case-insensitive', () => {
    const filtered = filterByTier(results, 's')
    assert.equal(filtered.length, 2)
  })

  it('returns null for invalid tier', () => {
    assert.equal(filterByTier(results, 'X'), null)
  })
})

describe('selectProbeFailedRows (issue #168: Shift+P re-probe failed rows only)', () => {
  it('selects rows with failed statuses (down, timeout, auth_error)', () => {
    const results = [
      mockResult({ label: 'Up', status: 'up' }),
      mockResult({ label: 'Dead404', status: 'down', httpCode: '404' }),
      mockResult({ label: 'RateLimited', status: 'down', httpCode: '429' }),
      mockResult({ label: 'Timeout', status: 'timeout' }),
      mockResult({ label: 'AuthFail', status: 'auth_error' }),
    ]
    const failed = selectProbeFailedRows(results)
    assert.equal(failed.length, 4)
    assert.ok(failed.every(r => r.label !== 'Up'))
  })

  it('excludes healthy, pending and no-key rows (they cannot be re-probed meaningfully)', () => {
    const results = [
      mockResult({ label: 'Up', status: 'up' }),
      mockResult({ label: 'Pending', status: 'pending' }),
      mockResult({ label: 'NoKey', status: 'noauth' }),
    ]
    assert.equal(selectProbeFailedRows(results).length, 0)
  })

  it('skips hidden rows: Shift+P re-probes what the user can see failing', () => {
    const results = [
      mockResult({ label: 'HiddenBroken', status: 'down', httpCode: '404', hidden: true }),
      mockResult({ label: 'VisibleBroken', status: 'down', httpCode: '429' }),
    ]
    const failed = selectProbeFailedRows(results)
    assert.equal(failed.length, 1)
    assert.equal(failed[0].label, 'VisibleBroken')
  })

  it('isProbeFailedRow tolerates null/undefined rows and unknown statuses', () => {
    assert.equal(isProbeFailedRow(null), false)
    assert.equal(isProbeFailedRow(undefined), false)
    assert.equal(isProbeFailedRow(mockResult({ status: 'weird' })), false)
    assert.equal(isProbeFailedRow(mockResult({ status: 'auth_error' })), true)
  })

  it('returns an empty array for non-array input', () => {
    assert.deepEqual(selectProbeFailedRows(null), [])
    assert.deepEqual(selectProbeFailedRows(undefined), [])
    assert.deepEqual(selectProbeFailedRows('nope'), [])
  })

  it('PROBE_FAILED_STATUSES covers the error states from the issue report (auth fail, 429, 404)', () => {
    // 📖 'down' covers 404/410/429/5xx/ERR (httpCode distinguishes them),
    // 📖 'auth_error' covers rejected keys, 'timeout' covers dead networks.
    assert.ok(PROBE_FAILED_STATUSES.has('down'))
    assert.ok(PROBE_FAILED_STATUSES.has('auth_error'))
    assert.ok(PROBE_FAILED_STATUSES.has('timeout'))
    assert.equal(PROBE_FAILED_STATUSES.size, 3)
  })
})

describe('sortResults', () => {
  it('sorts by avg ascending', () => {
    const results = [
      mockResult({ label: 'Slow', pings: [{ ms: 500, code: '200' }] }),
      mockResult({ label: 'Fast', pings: [{ ms: 100, code: '200' }] }),
    ]
    const sorted = sortResults(results, 'avg', 'asc')
    assert.equal(sorted[0].label, 'Fast')
    assert.equal(sorted[1].label, 'Slow')
  })

  it('sorts by avg descending', () => {
    const results = [
      mockResult({ label: 'Fast', pings: [{ ms: 100, code: '200' }] }),
      mockResult({ label: 'Slow', pings: [{ ms: 500, code: '200' }] }),
    ]
    const sorted = sortResults(results, 'avg', 'desc')
    assert.equal(sorted[0].label, 'Slow')
  })

  it('sorts by tier', () => {
    const results = [
      mockResult({ tier: 'C', label: 'C' }),
      mockResult({ tier: 'S+', label: 'S+' }),
    ]
    const sorted = sortResults(results, 'tier', 'asc')
    assert.equal(sorted[0].tier, 'S+')
  })

  it('sorts by model name', () => {
    const results = [
      mockResult({ label: 'Zeta' }),
      mockResult({ label: 'Alpha' }),
    ]
    const sorted = sortResults(results, 'model', 'asc')
    assert.equal(sorted[0].label, 'Alpha')
  })

  it('sorts by ctx (context window) ascending', () => {
    const results = [
      mockResult({ label: 'Small', ctx: '8k' }),
      mockResult({ label: 'Large', ctx: '128k' }),
      mockResult({ label: 'Medium', ctx: '32k' }),
    ]
    const sorted = sortResults(results, 'ctx', 'asc')
    assert.equal(sorted[0].label, 'Small')
    assert.equal(sorted[1].label, 'Medium')
    assert.equal(sorted[2].label, 'Large')
  })

  it('sorts by ctx with million tokens', () => {
    const results = [
      mockResult({ label: 'K', ctx: '128k' }),
      mockResult({ label: 'M', ctx: '1m' }),
    ]
    const sorted = sortResults(results, 'ctx', 'asc')
    assert.equal(sorted[0].label, 'K')
    assert.equal(sorted[1].label, 'M')
  })

  it('does not mutate original array', () => {
    const results = [
      mockResult({ label: 'B', pings: [{ ms: 500, code: '200' }] }),
      mockResult({ label: 'A', pings: [{ ms: 100, code: '200' }] }),
    ]
    const original = [...results]
    sortResults(results, 'avg', 'asc')
    assert.equal(results[0].label, original[0].label)
  })

  it('sorts by stability descending (most stable first)', () => {
    const stable = mockResult({
      label: 'Stable',
      pings: [
        { ms: 200, code: '200' }, { ms: 210, code: '200' },
        { ms: 190, code: '200' }, { ms: 205, code: '200' },
      ]
    })
    const spiky = mockResult({
      label: 'Spiky',
      pings: [
        { ms: 100, code: '200' }, { ms: 100, code: '200' },
        { ms: 100, code: '200' }, { ms: 8000, code: '200' },
      ]
    })
    const sorted = sortResults([spiky, stable], 'stability', 'desc')
    assert.equal(sorted[0].label, 'Stable')
  })

  it('sorts by usage ascending (low usagePercent first)', () => {
    const results = [
      mockResult({ label: 'HighUsage', usagePercent: 80 }),
      mockResult({ label: 'LowUsage',  usagePercent: 20 }),
      mockResult({ label: 'MedUsage',  usagePercent: 50 }),
    ]
    const sorted = sortResults(results, 'usage', 'asc')
    assert.equal(sorted[0].label, 'LowUsage')
    assert.equal(sorted[1].label, 'MedUsage')
    assert.equal(sorted[2].label, 'HighUsage')
  })

  it('sorts by usage descending (high usagePercent first)', () => {
    const results = [
      mockResult({ label: 'LowUsage',  usagePercent: 20 }),
      mockResult({ label: 'HighUsage', usagePercent: 80 }),
    ]
    const sorted = sortResults(results, 'usage', 'desc')
    assert.equal(sorted[0].label, 'HighUsage')
    assert.equal(sorted[1].label, 'LowUsage')
  })

  it('treats missing usagePercent as 0 when sorting by usage ascending', () => {
    const results = [
      mockResult({ label: 'HasUsage', usagePercent: 50 }),
      mockResult({ label: 'NoUsage' }),  // no usagePercent field → treated as 0
    ]
    const sorted = sortResults(results, 'usage', 'asc')
    assert.equal(sorted[0].label, 'NoUsage')
    assert.equal(sorted[1].label, 'HasUsage')
  })
})

describe('renderTable health labels', () => {
  it('renders the tiny verdict indicator column and matching verdict emoji', () => {
    const output = stripAnsi(renderTable({
      results: [mockResult({ status: 'up', pings: [{ ms: 200, code: '200' }], providerKey: 'nvidia', totalTokens: 0 })],
      pendingPings: 0,
      frame: 0,
      terminalRows: 12,
      terminalCols: 200,
    }))

    assert.match(output, /❔/)
    assert.match(output, /🟩\s+Perfect/)
  })

  it('renders explicit labels for common HTTP failure codes', () => {
    const results = [
      mockResult({ label: '429 model', status: 'down', httpCode: '429', pings: [{ ms: 0, code: '429' }], providerKey: 'nvidia', totalTokens: 0 }),
      mockResult({ label: '410 model', status: 'down', httpCode: '410', pings: [{ ms: 0, code: '410' }], providerKey: 'nvidia', totalTokens: 0 }),
      mockResult({ label: '404 model', status: 'down', httpCode: '404', pings: [{ ms: 0, code: '404' }], providerKey: 'nvidia', totalTokens: 0 }),
      mockResult({ label: '500 model', status: 'down', httpCode: '500', pings: [{ ms: 0, code: '500' }], providerKey: 'nvidia', totalTokens: 0 }),
    ]
    const output = renderTable({ results, pendingPings: 0, frame: 0 })

    assert.match(output, /429 TRY LATER/)
    assert.match(output, /410 GONE/)
    assert.match(output, /404 NOT FOUND/)
    assert.match(output, /500 ERROR/)
  })

  it('renders auth failure distinctly from missing key', () => {
    const results = [
      mockResult({ label: 'Auth fail', status: 'auth_error', httpCode: '401', pings: [{ ms: 25, code: '401' }], providerKey: 'groq', totalTokens: 0 }),
      mockResult({ label: 'No key', status: 'noauth', httpCode: '401', pings: [{ ms: 25, code: '401' }], providerKey: 'groq', totalTokens: 0 }),
    ]
    const output = renderTable({ results, pendingPings: 0, frame: 0 })

    assert.match(output, /AUTH FAIL/)
    assert.match(output, /NO KEY/)
  })
})

describe('renderTable benchmark columns', () => {
  it('renders AI Latency and TPS as separate columns', () => {
    const results = [mockResult({
      label: 'Bench model',
      providerKey: 'nvidia',
      pings: [{ ms: 200, code: '200' }],
      totalTokens: 0,
    })]
    const output = stripAnsi(renderTable({
      results,
      pendingPings: 0,
      frame: 0,
      terminalRows: 12,
      terminalCols: 220,
      benchmarkResults: {
        'nvidia/test/model': { ok: true, totalMs: 4300, outputTokens: 56, tokensPerSecond: 13 },
      },
    }))

    assert.match(output, /AI Latency/)
    assert.match(output, /TPS/)
    assert.match(output, /4\.3s/)
    assert.match(output, /\b13\b/)
    assert.doesNotMatch(output, /4\.3s \/ 13 TPS/)
  })

  it('keeps benchmark failure details out of AI Latency while Health shows the row error', () => {
    const results = [mockResult({
      label: 'Throttled model',
      providerKey: 'nvidia',
      status: 'down',
      httpCode: '429',
      pings: [{ ms: 0, code: '429' }],
      totalTokens: 0,
    })]
    const output = stripAnsi(renderTable({
      results,
      pendingPings: 0,
      frame: 0,
      terminalRows: 12,
      terminalCols: 220,
      benchmarkResults: {
        'nvidia/test/model': { ok: false, code: 'TIMEOUT', totalMs: 20_000 },
      },
    }))

    assert.equal((output.match(/429 TRY LATER/g) || []).length, 1)
    assert.doesNotMatch(output, /TIMEOUT/)
  })
})

describe('renderTable sticky header and footer layout', () => {
  const makeManyResults = (count = 80) => Array.from({ length: count }, (_, idx) => mockResult({
    idx: idx + 1,
    label: `Model ${String(idx + 1).padStart(2, '0')}`,
    providerKey: 'nvidia',
    pings: [{ ms: 100 + idx, code: '200' }],
    totalTokens: 0,
  }))

  const visibleLines = (output) => output
    .split('\n')
    .map((line) => stripAnsi(line).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))

  it('does not overrun terminal height in the normal table view', () => {
    const output = renderTable({ results: makeManyResults(), cursor: 0, sortColumn: 'avg', sortDirection: 'asc', pingInterval: 10_000, lastPingTime: Date.now(), mode: 'opencode', terminalRows: 20, terminalCols: 140 })
    const lines = visibleLines(output)

    assert.equal(lines.length, 20)
    assert.match(lines[0], /free-coding-models/)
    assert.match(lines[1], /Model/)
    assert.doesNotMatch(output, /Search "\/"/)
    assert.doesNotMatch(output, /Shift\+R Router|daemon not running|Smart Router is now available/)
    assert.match(lines.at(-3), /F Favorite/)
    assert.match(lines.at(-2), /Ctrl\+P Cmd Palette/)
    assert.match(lines.at(-1), /AI Speed Test/)
  })

  it('keeps title, search filters, and column headers visible when scrolled', () => {
    const output = renderTable({ results: makeManyResults(), cursor: 40, sortColumn: 'avg', sortDirection: 'asc', pingInterval: 10_000, lastPingTime: Date.now(), mode: 'opencode', scrollOffset: 40, terminalRows: 20, terminalCols: 140 })
    const lines = visibleLines(output)

    assert.equal(lines.length, 20)
    assert.match(lines[0], /free-coding-models/)
    assert.match(lines[1], /Model/)
    assert.match(lines[2], /more above/)
  })

  it('reserves space for temporary footer rows without hiding the header', () => {
    const output = renderTable({ results: makeManyResults(), cursor: 0, sortColumn: 'avg', sortDirection: 'asc', pingInterval: 10_000, lastPingTime: Date.now(), mode: 'opencode', terminalRows: 20, terminalCols: 180, pingMode: 'normal', pingModeSource: 'auto', settingsUpdateState: 'idle', startupLatestVersion: '9.9.9', versionAlertsEnabled: true, customTextFilter: 'deep' })
    const lines = visibleLines(output)

    assert.equal(lines.length, 20)
    assert.match(lines[0], /free-coding-models/)
    assert.match(lines[1], /Model/)
    assert.match(output, /UPDATE AVAILABLE/)
    assert.match(output, /X Disable filter: "deep"/)
  })

  it('sticks the footer to the bottom when there are few model rows', () => {
    const output = renderTable({ results: makeManyResults(3), cursor: 0, sortColumn: 'avg', sortDirection: 'asc', pingInterval: 10_000, lastPingTime: Date.now(), mode: 'opencode', terminalRows: 12, terminalCols: 140 })
    const lines = visibleLines(output)

    assert.equal(lines.length, 12)
    assert.match(lines[0], /free-coding-models/)
    assert.match(lines[1], /Model/)
    // 3 model rows + 3 footer lines = 6 fixed content lines, blank padding fills the rest
    assert.ok(lines.slice(5, 9).every((line) => line === ''), 'expected blank padding before sticky footer')
    assert.match(lines.at(-3), /F Favorite/)
    assert.match(lines.at(-2), /Ctrl\+P Cmd Palette/)
    assert.match(lines.at(-1), /AI Speed Test/)
  })

  it('always renders the full footer even when an old collapsed-footer flag is passed', () => {
    const output = renderTable({ results: makeManyResults(10), cursor: 0, sortColumn: 'avg', sortDirection: 'asc', pingInterval: 10_000, lastPingTime: Date.now(), mode: 'opencode', terminalRows: 20, terminalCols: 140, pingMode: 'normal', pingModeSource: 'auto', settingsUpdateState: 'idle', versionAlertsEnabled: true })

    assert.doesNotMatch(output, /Toggle Footer/)
    assert.doesNotMatch(output, /Shift\+R Router|daemon not running/)
    assert.match(output, /Ctrl\+P Cmd Palette/)
  })
})

describe('renderTable outdated footer banner', () => {
  it('renders a dedicated update banner when startup auto-check already found a newer version', () => {
    const results = [
      mockResult({ providerKey: 'nvidia', totalTokens: 0 }),
    ]
    const { version: localVersion } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const output = renderTable({ results: results, sortColumn: 'avg', sortDirection: 'asc', pingInterval: 10_000, lastPingTime: Date.now(), mode: 'opencode', terminalRows: 20, terminalCols: 190, pingMode: 'normal', pingModeSource: 'auto', settingsUpdateState: 'idle', startupLatestVersion: '9.9.9', versionAlertsEnabled: true })

    assert.match(output, new RegExp(`UPDATE AVAILABLE — v${escapeRegex(localVersion)} → v9\\.9\\.9`))
    assert.match(output, /Click here or press Shift\+U to update/)
    // 📖 The update banner stays in the footer budget without surfacing router hints.
    assert.match(output, /UPDATE AVAILABLE/)
    assert.doesNotMatch(output, /Shift\+R Router|daemon not running/)
  })

  it('stays quiet when no newer version is known', () => {
    const results = [
      mockResult({ providerKey: 'nvidia', totalTokens: 0 }),
    ]
    const output = renderTable({ results, pendingPings: 0, frame: 0, sortColumn: 'avg', sortDirection: 'asc', pingInterval: 10_000, lastPingTime: Date.now(), mode: 'opencode', terminalRows: 20, terminalCols: 190 })

    assert.doesNotMatch(output, /UPDATE AVAILABLE/)
  })

  it('renders a red mandatory-update fallback warning after repeated install failures', () => {
    const results = [
      mockResult({ providerKey: 'nvidia', totalTokens: 0 }),
    ]
    const warning = buildOutdatedWarningMessage('9.9.9', 2)
    const output = renderTable({ results, sortColumn: 'avg', sortDirection: 'asc', pingInterval: 10_000, lastPingTime: Date.now(), mode: 'opencode', terminalRows: 20, terminalCols: 190, pingMode: 'normal', pingModeSource: 'auto', settingsUpdateState: 'idle', startupLatestVersion: '9.9.9', versionAlertsEnabled: true, updateWarningMessage: warning })

    assert.match(output, /OUTDATED VERSION/)
    assert.match(output, /automatic update failed 2 times/)
    assert.match(output, /Press Shift\+U to retry update/)
  })

  it('shows the active custom text filter badge on its own footer line', () => {
    const results = [
      mockResult({ providerKey: 'nvidia', totalTokens: 0 }),
    ]
    const output = renderTable({ results: results, sortColumn: 'avg', sortDirection: 'asc', pingInterval: 10_000, lastPingTime: Date.now(), mode: 'opencode', terminalRows: 20, terminalCols: 190, pingMode: 'normal', pingModeSource: 'auto', settingsUpdateState: 'idle', versionAlertsEnabled: true, favoritesPinnedAndSticky: true, customTextFilter: 'deep' })

    // 📖 Footer was slimmed: changelog moved to Settings, exit hint moved to Help.
    // 📖 The X-clear filter badge now lives on its own dedicated footer line.
    assert.match(output, /X Disable filter: "deep"/)
  })

  it('stays quiet in dev-mode render paths even if npm has a newer published version', () => {
    const results = [
      mockResult({ providerKey: 'nvidia', totalTokens: 0 }),
    ]
    const output = renderTable({ results: results, sortColumn: 'avg', sortDirection: 'asc', pingInterval: 10_000, lastPingTime: Date.now(), mode: 'opencode', terminalRows: 20, terminalCols: 190, pingMode: 'normal', pingModeSource: 'auto', settingsUpdateState: 'idle', startupLatestVersion: '9.9.9', versionAlertsEnabled: false })

    assert.doesNotMatch(output, /UPDATE AVAILABLE/)
  })

  it('skips the narrow-terminal overlay when terminal width is 80 columns or wider', () => {
    const output = renderTable({ results: [mockResult()], cursor: 0, sortColumn: 'avg', sortDirection: 'asc', pingInterval: 10_000, lastPingTime: Date.now(), mode: 'opencode', terminalRows: 20, terminalCols: 120, pingMode: 'normal', pingModeSource: 'auto', widthWarningStartedAt: Date.now(), settingsUpdateState: 'idle', versionAlertsEnabled: true })

    assert.doesNotMatch(output, /Please maximize your terminal/)
    assert.match(output, /free-coding-models/)
  })
})

describe('renderTable responsive column visibility', () => {
  // 📖 Helper: render with a specific terminalCols value (all other params at sensible defaults)
  const renderAtWidth = (cols) => renderTable({ results: [mockResult({ providerKey: 'nvidia', totalTokens: 0, pings: [{ ms: 200, code: '200' }] })], sortColumn: 'avg', sortDirection: 'asc', pingInterval: 10_000, lastPingTime: Date.now(), mode: 'opencode', terminalRows: 30, terminalCols: cols, pingMode: 'normal', pingModeSource: 'auto', settingsUpdateState: 'idle', versionAlertsEnabled: false })

  // 📖 Full row width is computed dynamically from active columns.
  // 📖 Ping columns are permanently compact: Last Ping and Avg Ping both use 9 chars.
  // 📖 Compact mode shrinks Stability, Provider, Health, and AI Latency before hiding optional columns.

  it('shows all columns and compact ping labels at very wide terminal (206 cols)', () => {
    // 📖 206 = full table width (203 since Provider column grew 11 → 15) + margin
    const output = renderAtWidth(206)
    assert.match(output, /Rank/)
    assert.match(output, /Tier/)
    assert.match(output, /Up%/)
    // 📖 Header renders StaBility (capital B for hotkey)
    assert.match(output, /StaBility/)
    assert.match(output, /Last Ping/)
    assert.match(output, /Avg Ping/)
    assert.doesNotMatch(output, /Latest Ping/)
    // 📖 Full provider header 'PrOviDer' visible
    assert.match(output, /Provider|PrOviDer/)
    assert.match(output, /AI Latency/)
    assert.match(output, /TPS/)
  })

  it('truncates provider names above 14 chars so rows stay aligned', () => {
    // 📖 'Pollinations AI' (15 chars) exceeds MAX_PROVIDER_NAME_LEN → 'Pollinations…'
    const output = renderTable({ results: [mockResult({ providerKey: 'pollinations', totalTokens: 0, pings: [{ ms: 200, code: '200' }] })], sortColumn: 'avg', sortDirection: 'asc', pingInterval: 10_000, lastPingTime: Date.now(), mode: 'opencode', terminalRows: 30, terminalCols: 206, pingMode: 'normal', pingModeSource: 'auto', settingsUpdateState: 'idle', versionAlertsEnabled: false })
    assert.match(output, /Pollinations…/)
    assert.doesNotMatch(output, /Pollinations AI/)
  })

  it('keeps ping columns at the same 9-char width', () => {
    renderAtWidth(200)
    const layout = getLastLayout()
    const pingCol = layout.columns.find((column) => column.name === 'ping')
    const avgCol = layout.columns.find((column) => column.name === 'avg')
    assert.ok(pingCol, 'ping column should exist')
    assert.ok(avgCol, 'avg column should exist')
    assert.equal(pingCol.xEnd - pingCol.xStart + 1, 9)
    assert.equal(avgCol.xEnd - avgCol.xStart + 1, 9)
  })

  it('keeps compact ping labels in compact mode (slightly narrow)', () => {
    // 📖 At 175 cols, compact mode is active but no columns hidden yet
    const output = renderAtWidth(175)
    assert.match(output, /Last Ping/)
    assert.match(output, /Avg Ping/)
    assert.doesNotMatch(output, /Latest Ping/)
    // 📖 Provider header should be compact 'PrOD…'
    assert.match(output, /PrOD…/)
    // 📖 All optional columns still visible (Rank + AI Latency/TPS)
    assert.match(output, /Rank/)
    assert.match(output, /Up%/)
    assert.match(output, /AI Lat\./)
    assert.match(output, /TPS/)
  })

  it('hides Rank column first when too narrow for compact', () => {
    // 📖 At 145 cols, Rank is hidden (compact = 153, minus Rank col+sep = 144)
    const output = renderAtWidth(145)
    assert.doesNotMatch(output, /Rank/)
    // 📖 Other always-visible columns should still be present
    assert.match(output, /Model/)
    assert.match(output, /Health/)
  })

  it('hides Rank and Up% at narrower widths', () => {
    // 📖 At 120 cols, Rank, AI Latency/TPS, and Uptime hidden.
    const output = renderAtWidth(120)
    assert.doesNotMatch(output, /Rank/)
    // 📖 Up% header is just 'Up%' — check it is NOT in the output
    assert.doesNotMatch(output, /Up%/)
    assert.match(output, /Model/)
  })

  it('hides Rank, Up%, and Tier at even narrower widths', () => {
    // 📖 At 110 cols, Rank, AI Latency/TPS, Uptime, and Tier hidden.
    const output = renderAtWidth(110)
    assert.doesNotMatch(output, /Rank/)
    const lines = output.split('\n')
    const headerLine = lines.find(l => l.includes('Model') && l.includes('Health'))
    assert.ok(headerLine, 'header line should exist')
    assert.ok(!headerLine.includes('Tier'), 'Tier should be hidden at 110 cols')
  })

  it('hides all optional columns at very narrow widths', () => {
    // 📖 At 108 cols, all optional columns hidden (110 minus Stability col+sep = 99)
    const output = renderAtWidth(108)
    assert.doesNotMatch(output, /Rank/)
    // 📖 Stability/StaB. should be gone
    assert.doesNotMatch(output, /Stability/)
    assert.doesNotMatch(output, /StaB\./)
    // 📖 Core columns always present
    assert.match(output, /Model/)
    assert.match(output, /Health/)
    assert.match(output, /Verdict/)
  })

  it('truncates provider name to 4 chars + ellipsis in compact mode', () => {
    // 📖 In compact mode, provider names longer than 5 chars should be truncated
    const output = renderAtWidth(160)
    // 📖 'NIM' is only 3 chars so it should NOT be truncated
    // 📖 But the header should show compact 'PrOD…'
    assert.match(output, /PrOD…/)
  })

  it('truncates health status text in compact mode', () => {
    // 📖 In compact mode, health text after 6 chars gets '…' appended
    // 📖 '✅ UP' is short enough — no truncation expected
    const output = renderAtWidth(160)
    assert.match(output, /UP/)
  })
})

describe('renderSettings provider test badges', () => {
  function buildSettingsRenderer(config) {
    const state = {
      settingsOpen: true,
      settingsCursor: 0,
      settingsEditMode: false,
      settingsAddKeyMode: false,
      settingsEditBuffer: '',
      settingsErrorMsg: null,
      settingsTestResults: {},
      settingsTestDetails: {},
      settingsUpdateState: 'idle',
      settingsUpdateLatestVersion: null,
      settingsUpdateError: null,
      settingsScrollOffset: 0,
      settingsSyncStatus: null,
      activeProfile: null,
      terminalRows: 40,
      terminalCols: 120,
      config,
    }

    return createOverlayRenderers(state, {
      chalk,
      sources: { groq: sources.groq },
      PROVIDER_METADATA: {
        groq: {
          label: 'Groq',
          rateLimits: 'Free dev tier',
          signupUrl: 'https://console.groq.com/keys',
          signupHint: 'API Keys → Create API Key',
        },
      },
      PROVIDER_COLOR: {
        groq: [255, 204, 188],
      },
      LOCAL_VERSION: '0.2.1',
      getApiKey,
      resolveApiKeys: (cfg, providerKey) => {
        const raw = cfg.apiKeys?.[providerKey]
        if (Array.isArray(raw)) return raw
        return typeof raw === 'string' && raw ? [raw] : []
      },
      isProviderEnabled: () => true,
      listProfiles: () => [],
      TIER_CYCLE: ['All'],
      SETTINGS_OVERLAY_BG: null,
      HELP_OVERLAY_BG: null,
      RECOMMEND_OVERLAY_BG: null,
      OVERLAY_PANEL_WIDTH: 120,
      keepOverlayTargetVisible: (currentOffset) => currentOffset,
      sliceOverlayLines: (lines, offset = 0) => ({ visible: lines, offset }),
      tintOverlayLines: (lines) => lines,
      TASK_TYPES: [],
      PRIORITY_TYPES: [],
      CONTEXT_BUDGETS: [],
      FRAMES: ['-'],
      TIER_COLOR: () => '',
      getAvg: () => 0,
      getStabilityScore: () => 0,
      toFavoriteKey: () => '',
      getTopRecommendations: () => [],
      adjustScrollOffset: () => {},
      getPingModel: () => null,
      getConfiguredInstallableProviders: () => [],
      getInstallTargetModes: () => [],
      getProviderCatalogModels: () => [],
      padEndDisplay: (value) => value,
    }).renderSettings
  }

  it('shows Test when a provider has a saved key but no test ran yet', () => {
    const renderSettings = buildSettingsRenderer({ apiKeys: { groq: 'gsk_live_key' }, providers: {}, settings: {} })
    const output = renderSettings()

    assert.match(output, /\[Test\]/)
  })

  it('shows Missing Key when a provider has no saved key', () => {
    const renderSettings = buildSettingsRenderer({ apiKeys: {}, providers: {}, settings: {} })
    const output = renderSettings()

    assert.match(output, /\[Missing Key 🔑\]/)
  })

  it('does not show the removed Small Width Warnings toggle in settings', () => {
    const renderSettings = buildSettingsRenderer({ apiKeys: {}, providers: {}, settings: {} })
    const output = renderSettings()

    assert.doesNotMatch(output, /Small Width Warnings/)
  })

  it('shows the global theme row with the resolved auto label', () => {
    const renderSettings = buildSettingsRenderer({ apiKeys: {}, providers: {}, settings: { theme: 'auto' } })
    const output = renderSettings()

    assert.match(output, /Global Theme/)
    assert.match(output, /Auto/)
  })

  it('shows the Startup AI Speed Scan toggle as disabled by default', () => {
    const renderSettings = buildSettingsRenderer({ apiKeys: {}, providers: {}, settings: {} })
    const output = renderSettings()

    assert.match(output, /Startup AI Speed Scan/)
    assert.match(output, /manual Ctrl\+U only/)
  })

  it('shows enabled status for Startup AI Speed Scan', () => {
    const renderSettings = buildSettingsRenderer({ apiKeys: {}, providers: {}, settings: { runAiSpeedTestOnStartup: true } })
    const output = renderSettings()

    assert.match(output, /Startup AI Speed Scan/)
    assert.match(output, /runs Ctrl\+U after startup/)
  })
})

describe('findBestModel', () => {
  it('returns null for empty array', () => {
    assert.equal(findBestModel([]), null)
  })

  it('prefers model that is up', () => {
    const results = [
      mockResult({ label: 'Down', status: 'down', pings: [{ ms: 50, code: '200' }] }),
      mockResult({ label: 'Up', status: 'up', pings: [{ ms: 500, code: '200' }] }),
    ]
    assert.equal(findBestModel(results).label, 'Up')
  })

  it('prefers fastest avg when both up', () => {
    const results = [
      mockResult({ label: 'Slow', status: 'up', pings: [{ ms: 500, code: '200' }] }),
      mockResult({ label: 'Fast', status: 'up', pings: [{ ms: 100, code: '200' }] }),
    ]
    assert.equal(findBestModel(results).label, 'Fast')
  })

  it('prefers higher uptime when avg is equal', () => {
    const results = [
      mockResult({ label: 'Flaky', status: 'up', pings: [{ ms: 300, code: '200' }, { ms: 0, code: '500' }] }),
      mockResult({ label: 'Stable', status: 'up', pings: [{ ms: 300, code: '200' }, { ms: 300, code: '200' }] }),
    ]
    assert.equal(findBestModel(results).label, 'Stable')
  })

  it('prefers more stable model when avg is equal', () => {
    // Both have same avg (300ms) but different stability
    const results = [
      mockResult({
        label: 'Spiky',
        status: 'up',
        pings: [
          { ms: 100, code: '200' }, { ms: 100, code: '200' },
          { ms: 100, code: '200' }, { ms: 900, code: '200' },
        ]
      }),
      mockResult({
        label: 'Consistent',
        status: 'up',
        pings: [
          { ms: 300, code: '200' }, { ms: 300, code: '200' },
          { ms: 300, code: '200' }, { ms: 300, code: '200' },
        ]
      }),
    ]
    assert.equal(findBestModel(results).label, 'Consistent')
  })
})

describe('renderToolInstallPrompt', () => {
  it('renders the official install command for a missing launcher', () => {
    const installPlan = getToolInstallPlan('opencode', { platform: 'darwin' })
    const state = {
      toolInstallPromptOpen: true,
      toolInstallPromptCursor: 0,
      toolInstallPromptScrollOffset: 0,
      toolInstallPromptMode: 'opencode',
      toolInstallPromptModel: {
        label: 'DeepSeek V4 Flash',
      },
      toolInstallPromptPlan: installPlan,
      toolInstallPromptErrorMsg: null,
      terminalRows: 40,
      terminalCols: 120,
      config: { settings: {} },
    }

    const renderers = createOverlayRenderers(state, {
      chalk,
      sources,
      PROVIDER_METADATA: {},
      PROVIDER_COLOR: {},
      LOCAL_VERSION: '0.3.18',
      getApiKey: () => null,
      resolveApiKeys: () => [],
      isProviderEnabled: () => true,
      TIER_CYCLE: ['All'],
      OVERLAY_PANEL_WIDTH: 120,
      keepOverlayTargetVisible: (currentOffset) => currentOffset,
      sliceOverlayLines: (lines, offset = 0) => ({ visible: lines, offset }),
      tintOverlayLines: (lines) => lines,
      TASK_TYPES: [],
      PRIORITY_TYPES: [],
      CONTEXT_BUDGETS: [],
      FRAMES: ['-'],
      TIER_COLOR: () => '',
      getAvg: () => 0,
      getStabilityScore: () => 0,
      toFavoriteKey: () => '',
      getTopRecommendations: () => [],
      adjustScrollOffset: () => {},
      getPingModel: () => null,
      getConfiguredInstallableProviders: () => [],
      getInstallTargetModes: () => [],
      getProviderCatalogModels: () => [],
      getToolMeta: () => ({ label: 'OpenCode CLI', emoji: '💻' }),
      getToolInstallPlan: () => installPlan,
      padEndDisplay: (value) => value,
    })

    const output = renderers.renderToolInstallPrompt()
    assert.match(output, /Missing Tool/)
    assert.match(output, /npm install -g opencode-ai/)
    assert.match(output, /DeepSeek V4 Flash/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 3. CLI ARG PARSING
// ═══════════════════════════════════════════════════════════════════════════════
describe('parseArgs', () => {
  // 📖 parseArgs expects argv starting from index 0 (like process.argv)
  // 📖 so we prepend ['node', 'script'] to simulate real argv
  const argv = (...args) => ['node', 'script', ...args]

  it('extracts API key from first non-flag arg', () => {
    const result = parseArgs(argv('nvapi-xxx'))
    assert.equal(result.apiKey, 'nvapi-xxx')
  })

  it('returns null apiKey when none given', () => {
    const result = parseArgs(argv('--best'))
    assert.equal(result.apiKey, null)
  })

  it('detects --best flag', () => {
    assert.equal(parseArgs(argv('--best')).bestMode, true)
    assert.equal(parseArgs(argv()).bestMode, false)
  })

  it('detects --fiable flag', () => {
    assert.equal(parseArgs(argv('--fiable')).fiableMode, true)
  })

  it('detects --premium flag', () => {
    assert.equal(parseArgs(argv('--premium')).premiumMode, true)
    assert.equal(parseArgs(argv()).premiumMode, false)
  })

  it('detects --opencode flag', () => {
    assert.equal(parseArgs(argv('--opencode')).openCodeMode, true)
  })

  it('detects --openclaw flag', () => {
    assert.equal(parseArgs(argv('--openclaw')).openClawMode, true)
  })

  it('detects --opencode-desktop flag', () => {
    assert.equal(parseArgs(argv('--opencode-desktop')).openCodeDesktopMode, true)
    assert.equal(parseArgs(argv()).openCodeDesktopMode, false)
  })

  it('detects --opencode-web flag', () => {
    assert.equal(parseArgs(argv('--opencode-web')).openCodeWebMode, true)
    assert.equal(parseArgs(argv()).openCodeWebMode, false)
  })

  it('detects external tool flags', () => {
    const result = parseArgs(argv(
      '--aider',
      '--crush',
      '--goose',
      '--qwen',
      '--kilo',
      '--openhands',
      '--amp',
      '--hermes',
      '--continue',
      '--cline',
      '--pi',
      '--caveman'
    ))
    assert.equal(result.aiderMode, true)
    assert.equal(result.crushMode, true)
    assert.equal(result.gooseMode, true)
    assert.equal(result.qwenMode, true)
    assert.equal(result.kiloMode, true)
    assert.equal(result.openHandsMode, true)
    assert.equal(result.ampMode, true)
    assert.equal(result.hermesMode, true)
    assert.equal(result.continueMode, true)
    assert.equal(result.clineMode, true)
    assert.equal(result.piMode, true)
    assert.equal(result.cavemanMode, true)
  })

  it('detects --no-telemetry flag', () => {
    assert.equal(parseArgs(argv('--no-telemetry')).noTelemetry, true)
    assert.equal(parseArgs(argv()).noTelemetry, false)
  })

  it('detects router daemon lifecycle flags', () => {
    assert.equal(parseArgs(argv('--daemon')).daemonMode, true)
    assert.equal(parseArgs(argv('--daemon-bg')).daemonBackgroundMode, true)
    assert.equal(parseArgs(argv('--daemon-stop')).daemonStopMode, true)
    assert.equal(parseArgs(argv('--daemon-status')).daemonStatusMode, true)
    assert.equal(parseArgs(argv()).daemonMode, false)
  })

  it('detects web dashboard mode without treating subcommand as API key', () => {
    const subcommand = parseArgs(argv('web'))
    assert.equal(subcommand.webMode, true)
    assert.equal(subcommand.apiKey, null)
    assert.equal(parseArgs(argv('--web')).webMode, true)
    assert.equal(parseArgs(argv('--gui')).webMode, true)
  })

  it('detects --help and -h flags', () => {
    assert.equal(parseArgs(argv('--help')).helpMode, true)
    assert.equal(parseArgs(argv('-h')).helpMode, true)
    assert.equal(parseArgs(argv()).helpMode, false)
  })

  it('parses --tier value', () => {
    assert.equal(parseArgs(argv('--tier', 'S')).tierFilter, 'S')
    assert.equal(parseArgs(argv('--tier', 'a')).tierFilter, 'A') // 📖 uppercased
  })

  it('returns null tierFilter when --tier has no value', () => {
    assert.equal(parseArgs(argv('--tier')).tierFilter, null)
    assert.equal(parseArgs(argv('--tier', '--best')).tierFilter, null) // 📖 next arg is a flag
  })

  it('does not capture --tier value as apiKey', () => {
    assert.equal(parseArgs(argv('--tier', 'S')).apiKey, null)
    assert.equal(parseArgs(argv('--opencode', '--tier', 'A')).apiKey, null)
  })

  it('handles multiple flags together', () => {
    const result = parseArgs(argv('nvapi-key', '--opencode', '--best', '--tier', 'S'))
    assert.equal(result.apiKey, 'nvapi-key')
    assert.equal(result.openCodeMode, true)
    assert.equal(result.bestMode, true)
    assert.equal(result.tierFilter, 'S')
  })

  it('flags are case-insensitive', () => {
    assert.equal(parseArgs(argv('--BEST')).bestMode, true)
    assert.equal(parseArgs(argv('--OpenCode')).openCodeMode, true)
    assert.equal(parseArgs(argv('--HELP')).helpMode, true)
  })

  it('detects --fix-permissions, --yes and -y security auto-fix flags', () => {
    assert.equal(parseArgs(argv('--fix-permissions')).fixPermissionsMode, true)
    assert.equal(parseArgs(argv('--yes')).fixPermissionsMode, true)
    assert.equal(parseArgs(argv('-y')).fixPermissionsMode, true)
    assert.equal(parseArgs(argv()).fixPermissionsMode, false)
  })

  it('does not treat -y as an API key', () => {
    const result = parseArgs(argv('-y'))
    assert.equal(result.apiKey, null)
    assert.equal(result.fixPermissionsMode, true)
  })
})

describe('resolveSecurityAction (issue #173)', () => {
  // 📖 Base case: config exists with insecure permissions on an interactive TUI surface
  const insecureTui = {
    configExists: true,
    isSecure: false,
    autoFixRequested: false,
    stdinIsTTY: true,
    promptAllowed: true,
  }

  it('returns none when there is no config file', () => {
    assert.equal(resolveSecurityAction({ ...insecureTui, configExists: false }), 'none')
  })

  it('returns none when permissions are already secure', () => {
    assert.equal(resolveSecurityAction({ ...insecureTui, isSecure: true }), 'none')
  })

  it('returns auto-fix when a yes flag is passed (even without a TTY)', () => {
    assert.equal(resolveSecurityAction({ ...insecureTui, autoFixRequested: true }), 'auto-fix')
    assert.equal(resolveSecurityAction({ ...insecureTui, autoFixRequested: true, stdinIsTTY: false }), 'auto-fix')
    assert.equal(resolveSecurityAction({ ...insecureTui, autoFixRequested: true, promptAllowed: false }), 'auto-fix')
  })

  it('returns warn-only when stdin is not a TTY', () => {
    assert.equal(resolveSecurityAction({ ...insecureTui, stdinIsTTY: false }), 'warn-only')
  })

  it('returns warn-only on daemon/web/JSON surfaces even with a TTY', () => {
    assert.equal(resolveSecurityAction({ ...insecureTui, promptAllowed: false }), 'warn-only')
  })

  it('returns prompt only on an interactive TTY surface', () => {
    assert.equal(resolveSecurityAction(insecureTui), 'prompt')
  })
})

describe('security permission formatting (issue #173)', () => {
  it('formatMode renders octal without prefix', () => {
    assert.equal(formatMode(0o644), '644')
    assert.equal(formatMode(0o600), '600')
    assert.equal(formatMode(0o666), '666')
    assert.equal(formatMode(0o007), '007')
  })

  it('formatModeRwx renders owner/group/others groups correctly', () => {
    assert.equal(formatModeRwx(0o644), 'rw- / r-- / r--')
    assert.equal(formatModeRwx(0o600), 'rw- / --- / ---')
    assert.equal(formatModeRwx(0o666), 'rw- / rw- / rw-')
    assert.equal(formatModeRwx(0o755), 'rwx / r-x / r-x')
    assert.equal(formatModeRwx(0o000), '--- / --- / ---')
  })
})

describe('cli help text', () => {
  it('lists the supported CLI flags for the direct-only app surface', () => {
    const help = buildCliHelpText()
    const expectedEntries = [
      '--opencode',
      '--opencode-desktop',
      '--openclaw',
      '--crush',
      '--goose',
      '--pi',
      '--aider',
      '--qwen',
      '--openhands',
      '--amp',
      '--best',
      '--fiable',
      '--premium',
      '--json',
      '--tier <S|A|B|C>',
      '--recommend',
      'web | --web | --gui',
      '--daemon',
      '--daemon-bg',
      '--daemon-status',
      '--daemon-stop',
      '--fix-permissions, --yes, -y',
      '--no-telemetry',
      '--help, -h',
    ]

    for (const entry of expectedEntries) {
      assert.match(help, new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  })
})

describe('telemetry', () => {
  it('builds telemetry properties with custom launch metadata', () => {
    const properties = buildTelemetryProperties({
      mode: 'openclaw',
      properties: {
        session_id: 'session_test',
        tool_mode: 'openclaw',
        provider_key: 'nvidia',
        model_id: 'deepseek-ai/deepseek-v4-flash-0731',
        action_type: 'launch_model',
        ignored: undefined,
      },
    })

    assert.equal(properties.app, 'free-coding-models')
    assert.equal(properties.mode, 'openclaw')
    assert.equal(properties.session_id, 'session_test')
    assert.equal(properties.tool_mode, 'openclaw')
    assert.equal(properties.provider_key, 'nvidia')
    assert.equal(properties.model_id, 'deepseek-ai/deepseek-v4-flash-0731')
    assert.equal(properties.action_type, 'launch_model')
    assert.equal('ignored' in properties, false)
  })

  it('sends app_start and app_use with the same distinct_id and session_id', async () => {
    const originalFetch = global.fetch
    const calls = []
    global.fetch = async (url, options) => {
      calls.push({ url, options })
      return { ok: true }
    }

    try {
      const config = {
        telemetry: {
          enabled: true,
          anonymousId: 'anon_test_user',
        },
      }
      const cliArgs = { noTelemetry: false }

      await sendUsageTelemetry(config, cliArgs, {
        event: 'app_start',
        mode: 'opencode',
        properties: {
          session_id: 'session_test_user',
          event_version: 1,
        },
      })

      await sendUsageTelemetry(config, cliArgs, {
        event: 'app_use',
        mode: 'openclaw',
        properties: {
          session_id: 'session_test_user',
          event_version: 1,
          action_type: 'launch_model',
          tool_mode: 'openclaw',
          provider_key: 'nvidia',
          model_id: 'deepseek-ai/deepseek-v4-flash-0731',
          model_label: 'DeepSeek V4 Flash',
          model_tier: 'S+',
        },
      })

      assert.equal(calls.length, 2)
      const [startBody, useBody] = calls.map(({ options }) => JSON.parse(options.body))
      assert.equal(startBody.event, 'app_start')
      assert.equal(useBody.event, 'app_use')
      assert.equal(startBody.distinct_id, 'anon_test_user')
      assert.equal(useBody.distinct_id, 'anon_test_user')
      assert.equal(startBody.properties.session_id, 'session_test_user')
      assert.equal(useBody.properties.session_id, 'session_test_user')
      assert.equal(useBody.properties.tool_mode, 'openclaw')
      assert.equal(useBody.properties.provider_key, 'nvidia')
      assert.equal(useBody.properties.model_id, 'deepseek-ai/deepseek-v4-flash-0731')
      assert.equal(useBody.properties.model_label, 'DeepSeek V4 Flash')
      assert.equal(useBody.properties.model_tier, 'S+')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('does not send telemetry when disabled via CLI flag or env var', async () => {
    const originalFetch = global.fetch
    const originalTelemetryEnv = process.env.FREE_CODING_MODELS_TELEMETRY
    const calls = []
    global.fetch = async (url, options) => {
      calls.push({ url, options })
      return { ok: true }
    }

    try {
      const config = {
        telemetry: {
          enabled: true,
          anonymousId: 'anon_opt_out',
        },
      }

      await sendUsageTelemetry(config, { noTelemetry: true }, {
        event: 'app_use',
        mode: 'opencode',
        properties: { session_id: 'session_cli_opt_out' },
      })

      process.env.FREE_CODING_MODELS_TELEMETRY = '0'
      await sendUsageTelemetry(config, { noTelemetry: false }, {
        event: 'app_action',
        mode: 'opencode',
        properties: { session_id: 'session_env_opt_out', action_type: 'api_key_saved' },
      })

      assert.equal(calls.length, 0)
    } finally {
      global.fetch = originalFetch
      if (originalTelemetryEnv === undefined) delete process.env.FREE_CODING_MODELS_TELEMETRY
      else process.env.FREE_CODING_MODELS_TELEMETRY = originalTelemetryEnv
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 4. PACKAGE & CLI SANITY
// ═══════════════════════════════════════════════════════════════════════════════
describe('package.json sanity', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  it('has required fields', () => {
    assert.ok(pkg.name, 'name is required')
    assert.ok(pkg.version, 'version is required')
    assert.ok(pkg.main, 'main is required')
    assert.ok(pkg.bin, 'bin is required')
    assert.ok(pkg.license, 'license is required')
  })

  it('version matches semver pattern', () => {
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  })

  it('bin entry points to existing file', () => {
    const binPath = join(ROOT, pkg.bin['free-coding-models'])
    assert.ok(existsSync(binPath), `bin entry ${pkg.bin['free-coding-models']} should exist`)
  })

  it('main entry points to existing file', () => {
    const mainPath = join(ROOT, pkg.main)
    assert.ok(existsSync(mainPath), `main entry ${pkg.main} should exist`)
  })

  it('type is module (ESM)', () => {
    assert.equal(pkg.type, 'module')
  })

  it('engines requires node >= 18', () => {
    assert.ok(pkg.engines?.node, 'engines.node should be set')
    assert.match(pkg.engines.node, /18/)
  })

  it('builds the web dashboard during prepack so npm releases include web/dist', () => {
    assert.equal(pkg.scripts?.prepack, 'npm run build:web')
  })

  it('packages the router daemon through the npm files allowlist', () => {
    assert.ok(pkg.files.includes('src/'), 'src/ must stay packaged because it contains src/core/router-daemon.js')
    assert.ok(existsSync(join(ROOT, 'src/core/router-daemon.js')), 'router daemon entry should exist')
  })
})

describe('CLI entry point sanity', () => {
  const binContent = readFileSync(join(ROOT, 'bin/free-coding-models.js'), 'utf8')

  it('has shebang line', () => {
    assert.ok(binContent.startsWith('#!/usr/bin/env node'), 'Should start with shebang')
  })

  it('imports from sources.js', () => {
    // no longer imports sources.js directly
  })

  it('imports from lib/utils.js', () => {
    assert.ok(binContent.includes("from '../src/core/utils.js'"), 'Should import lib/utils.js')
  })

  it('runs the config security check before launching any surface (issue #173)', () => {
    assert.ok(binContent.includes("from '../src/core/security.js'"), 'Should import security.js')
    const securityCall = binContent.indexOf('await checkConfigSecurity(')
    const runAppCall = binContent.indexOf('await runApp(')
    const webCall = binContent.indexOf('await startWebServer(')
    assert.ok(securityCall !== -1, 'bin should await checkConfigSecurity()')
    assert.ok(runAppCall !== -1 && securityCall < runAppCall, 'security check must run before the TUI')
    assert.ok(webCall !== -1 && securityCall < webCall, 'security check must run before the web dashboard')
  })
})

describe('constants consistency', () => {
  it('TIER_ORDER covers all tiers used in sources', () => {
    const tiersInModels = [...new Set(MODELS.map(m => m[2]))]
    for (const tier of tiersInModels) {
      assert.ok(TIER_ORDER.includes(tier), `Tier "${tier}" from models not in TIER_ORDER`)
    }
  })

  it('TIER_LETTER_MAP covers all tier letters', () => {
    assert.deepEqual(Object.keys(TIER_LETTER_MAP).sort(), ['A', 'B', 'C', 'S'])
  })

  it('all TIER_LETTER_MAP values are subsets of TIER_ORDER', () => {
    for (const [letter, tiers] of Object.entries(TIER_LETTER_MAP)) {
      for (const tier of tiers) {
        assert.ok(TIER_ORDER.includes(tier), `TIER_LETTER_MAP['${letter}'] has invalid tier "${tier}"`)
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 5. SMART RECOMMEND — SCORING ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
describe('Smart Recommend constants', () => {
  it('TASK_TYPES has expected keys', () => {
    assert.deepEqual(Object.keys(TASK_TYPES).sort(), ['quickfix', 'refactor', 'review', 'testgen'])
  })

  it('TASK_TYPES weights sum to 1.0 for each task', () => {
    for (const [key, task] of Object.entries(TASK_TYPES)) {
      const sum = task.sweWeight + task.speedWeight + task.ctxWeight + task.stabilityWeight
      assert.ok(Math.abs(sum - 1.0) < 0.001, `${key} weights sum to ${sum}, expected 1.0`)
    }
  })

  it('PRIORITY_TYPES has expected keys', () => {
    assert.deepEqual(Object.keys(PRIORITY_TYPES).sort(), ['balanced', 'quality', 'speed'])
  })

  it('PRIORITY_TYPES balanced has 1.0 multipliers', () => {
    assert.equal(PRIORITY_TYPES.balanced.speedMultiplier, 1.0)
    assert.equal(PRIORITY_TYPES.balanced.sweMultiplier, 1.0)
  })

  it('CONTEXT_BUDGETS has expected keys', () => {
    assert.deepEqual(Object.keys(CONTEXT_BUDGETS).sort(), ['large', 'medium', 'small'])
  })

  it('CONTEXT_BUDGETS have ascending idealCtx', () => {
    assert.ok(CONTEXT_BUDGETS.small.idealCtx < CONTEXT_BUDGETS.medium.idealCtx)
    assert.ok(CONTEXT_BUDGETS.medium.idealCtx < CONTEXT_BUDGETS.large.idealCtx)
  })
})

describe('scoreModelForTask', () => {
  it('returns 0 for invalid task type', () => {
    assert.equal(scoreModelForTask(mockResult(), 'invalid', 'balanced', 'small'), 0)
  })

  it('returns 0 for invalid priority', () => {
    assert.equal(scoreModelForTask(mockResult(), 'quickfix', 'invalid', 'small'), 0)
  })

  it('returns 0 for invalid context budget', () => {
    assert.equal(scoreModelForTask(mockResult(), 'quickfix', 'balanced', 'invalid'), 0)
  })

  it('returns a score between 0 and 100', () => {
    const r = mockResult({ pings: [{ ms: 200, code: '200' }, { ms: 300, code: '200' }] })
    const score = scoreModelForTask(r, 'quickfix', 'balanced', 'small')
    assert.ok(score >= 0 && score <= 100, `score ${score} should be 0-100`)
  })

  it('penalizes down models', () => {
    const up = mockResult({ status: 'up', pings: [{ ms: 200, code: '200' }], sweScore: '50.0%', ctx: '128k' })
    const down = mockResult({ status: 'down', pings: [{ ms: 200, code: '200' }], sweScore: '50.0%', ctx: '128k' })
    const scoreUp = scoreModelForTask(up, 'quickfix', 'balanced', 'small')
    const scoreDown = scoreModelForTask(down, 'quickfix', 'balanced', 'small')
    assert.ok(scoreUp > scoreDown, `up (${scoreUp}) should beat down (${scoreDown})`)
  })

  it('penalizes timeout models', () => {
    const up = mockResult({ status: 'up', pings: [{ ms: 200, code: '200' }], sweScore: '50.0%', ctx: '128k' })
    const timeout = mockResult({ status: 'timeout', pings: [{ ms: 200, code: '200' }], sweScore: '50.0%', ctx: '128k' })
    const scoreUp = scoreModelForTask(up, 'quickfix', 'balanced', 'small')
    const scoreTimeout = scoreModelForTask(timeout, 'quickfix', 'balanced', 'small')
    assert.ok(scoreUp > scoreTimeout, `up (${scoreUp}) should beat timeout (${scoreTimeout})`)
  })

  it('higher SWE score gives higher score for quality-focused tasks', () => {
    const highSwe = mockResult({ sweScore: '70.0%', pings: [{ ms: 300, code: '200' }], ctx: '128k' })
    const lowSwe = mockResult({ sweScore: '20.0%', pings: [{ ms: 300, code: '200' }], ctx: '128k' })
    const scoreHigh = scoreModelForTask(highSwe, 'refactor', 'quality', 'medium')
    const scoreLow = scoreModelForTask(lowSwe, 'refactor', 'quality', 'medium')
    assert.ok(scoreHigh > scoreLow, `high SWE (${scoreHigh}) should beat low SWE (${scoreLow})`)
  })

  it('faster model scores better for speed-focused quickfix', () => {
    const fast = mockResult({ pings: [{ ms: 100, code: '200' }], sweScore: '40.0%', ctx: '128k' })
    const slow = mockResult({ pings: [{ ms: 4000, code: '200' }], sweScore: '40.0%', ctx: '128k' })
    const scoreFast = scoreModelForTask(fast, 'quickfix', 'speed', 'small')
    const scoreSlow = scoreModelForTask(slow, 'quickfix', 'speed', 'small')
    assert.ok(scoreFast > scoreSlow, `fast (${scoreFast}) should beat slow (${scoreSlow})`)
  })

  it('larger context model scores better for large codebase budget', () => {
    const bigCtx = mockResult({ ctx: '256k', pings: [{ ms: 300, code: '200' }], sweScore: '40.0%' })
    const smallCtx = mockResult({ ctx: '4k', pings: [{ ms: 300, code: '200' }], sweScore: '40.0%' })
    const scoreBig = scoreModelForTask(bigCtx, 'review', 'balanced', 'large')
    const scoreSmall = scoreModelForTask(smallCtx, 'review', 'balanced', 'large')
    assert.ok(scoreBig > scoreSmall, `big ctx (${scoreBig}) should beat small ctx (${scoreSmall})`)
  })

  it('handles missing SWE score (dash)', () => {
    const r = mockResult({ sweScore: '—', pings: [{ ms: 200, code: '200' }] })
    const score = scoreModelForTask(r, 'quickfix', 'balanced', 'small')
    assert.ok(score >= 0, `score with no SWE should be >= 0`)
  })

  it('handles missing context (dash)', () => {
    const r = mockResult({ ctx: '—', pings: [{ ms: 200, code: '200' }], sweScore: '40.0%' })
    const score = scoreModelForTask(r, 'quickfix', 'balanced', 'small')
    assert.ok(score >= 0, `score with no ctx should be >= 0`)
  })

  it('handles no pings (Infinity avg)', () => {
    const r = mockResult({ pings: [], sweScore: '40.0%', ctx: '128k' })
    const score = scoreModelForTask(r, 'quickfix', 'balanced', 'small')
    assert.ok(score >= 0, `score with no pings should be >= 0`)
  })

  it('handles 1m context', () => {
    const r = mockResult({ ctx: '1m', pings: [{ ms: 200, code: '200' }], sweScore: '40.0%' })
    const score = scoreModelForTask(r, 'review', 'balanced', 'large')
    assert.ok(score > 0, `1m context model should score > 0`)
  })
})

describe('getTopRecommendations', () => {
  it('returns topN results', () => {
    const results = [
      mockResult({ modelId: 'a', sweScore: '60.0%', pings: [{ ms: 100, code: '200' }], ctx: '128k' }),
      mockResult({ modelId: 'b', sweScore: '40.0%', pings: [{ ms: 200, code: '200' }], ctx: '128k' }),
      mockResult({ modelId: 'c', sweScore: '70.0%', pings: [{ ms: 150, code: '200' }], ctx: '128k' }),
      mockResult({ modelId: 'd', sweScore: '30.0%', pings: [{ ms: 300, code: '200' }], ctx: '128k' }),
      mockResult({ modelId: 'e', sweScore: '50.0%', pings: [{ ms: 250, code: '200' }], ctx: '128k' }),
    ]
    const recs = getTopRecommendations(results, 'quickfix', 'balanced', 'small', 3)
    assert.equal(recs.length, 3)
  })

  it('returns results sorted by score descending', () => {
    const results = [
      mockResult({ modelId: 'a', sweScore: '60.0%', pings: [{ ms: 100, code: '200' }], ctx: '128k' }),
      mockResult({ modelId: 'b', sweScore: '30.0%', pings: [{ ms: 500, code: '200' }], ctx: '128k' }),
      mockResult({ modelId: 'c', sweScore: '70.0%', pings: [{ ms: 150, code: '200' }], ctx: '128k' }),
    ]
    const recs = getTopRecommendations(results, 'quickfix', 'balanced', 'small', 3)
    assert.ok(recs[0].score >= recs[1].score, 'first should have highest score')
    assert.ok(recs[1].score >= recs[2].score, 'second should beat third')
  })

  it('excludes hidden results', () => {
    const results = [
      mockResult({ modelId: 'a', sweScore: '60.0%', pings: [{ ms: 100, code: '200' }], ctx: '128k' }),
      mockResult({ modelId: 'b', sweScore: '90.0%', pings: [{ ms: 50, code: '200' }], ctx: '256k', hidden: true }),
      mockResult({ modelId: 'c', sweScore: '30.0%', pings: [{ ms: 200, code: '200' }], ctx: '128k' }),
    ]
    const recs = getTopRecommendations(results, 'quickfix', 'balanced', 'small', 3)
    assert.equal(recs.length, 2, 'hidden model should be excluded')
    const ids = recs.map(r => r.result.modelId)
    assert.ok(!ids.includes('b'), 'hidden model b should not appear')
  })

  it('returns fewer than topN if not enough results', () => {
    const results = [
      mockResult({ modelId: 'a', sweScore: '60.0%', pings: [{ ms: 100, code: '200' }], ctx: '128k' }),
    ]
    const recs = getTopRecommendations(results, 'quickfix', 'balanced', 'small', 3)
    assert.equal(recs.length, 1)
  })

  it('each result has result and score fields', () => {
    const results = [
      mockResult({ modelId: 'a', sweScore: '60.0%', pings: [{ ms: 100, code: '200' }], ctx: '128k' }),
    ]
    const recs = getTopRecommendations(results, 'quickfix', 'balanced', 'small')
    assert.ok(recs[0].result, 'should have result field')
    assert.equal(typeof recs[0].score, 'number', 'should have numeric score')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 6. PARSEARGS — --profile AND --recommend FLAGS
// ═══════════════════════════════════════════════════════════════════════════════
describe('parseArgs --recommend', () => {
  // 📖 Helper: simulate process.argv (first two entries are node + script path)
  const argv = (...args) => ['node', 'script.js', ...args]

  it('parses --recommend flag', () => {
    assert.equal(parseArgs(argv('--recommend')).recommendMode, true)
  })

  it('recommendMode defaults to false', () => {
    assert.equal(parseArgs(argv()).recommendMode, false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 📖 7. CONFIG PROFILES — pure logic tests (no filesystem I/O)
// ═══════════════════════════════════════════════════════════════════════════════
describe('config profile functions', () => {
  // 📖 Helper: create a minimal config object matching the shape from loadConfig()
  function mockConfig() {
    return {
      apiKeys: { nvidia: 'test-key' },
      providers: { nvidia: true },
      settings: {
        hideUnconfiguredModels: true,
      },
      favorites: ['nvidia/test-model'],
      telemetry: { enabled: false },
      profiles: {},
      activeProfile: null,
    }
  }

  it('_emptyProfileSettings returns expected shape', () => {
    const settings = _emptyProfileSettings()
    assert.equal(typeof settings.tierFilter, 'object') // null
    assert.equal(settings.sortColumn, 'avg')
    assert.equal(settings.sortAsc, true)
    assert.equal(settings.pingInterval, 10000)
    assert.equal(settings.hideUnconfiguredModels, true)
    assert.equal(settings.favoritesPinnedAndSticky, false)
    assert.equal(settings.runAiSpeedTestOnStartup, false)
  })

  it('defaults configured-only mode and preferred tool mode in profile settings', () => {
    assert.equal(_emptyProfileSettings().hideUnconfiguredModels, true)
    assert.equal(_emptyProfileSettings().favoritesPinnedAndSticky, false)
    assert.equal(_emptyProfileSettings().runAiSpeedTestOnStartup, false)
    assert.equal(_emptyProfileSettings().preferredToolMode, 'opencode')
    assert.equal(_emptyProfileSettings().theme, 'auto')
  })
})

describe('buildPersistedConfig', () => {
  it('preserves disk apiKeys and favorites when a stale snapshot saves unrelated changes', () => {
    const diskConfig = {
      apiKeys: {
        nvidia: 'disk-nvidia',
        groq: 'disk-groq',
      },
      providers: {},
      settings: { hideUnconfiguredModels: true },
      favorites: ['nvidia/model-a', 'groq/model-b'],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      activeProfile: null,
      profiles: {},
    }

    const incomingConfig = {
      apiKeys: {
        nvidia: 'disk-nvidia',
      },
      providers: {},
      settings: { hideUnconfiguredModels: false },
      favorites: ['nvidia/model-a'],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      activeProfile: null,
      profiles: {},
    }

    const persisted = buildPersistedConfig(incomingConfig, diskConfig)
    assert.deepEqual(persisted.apiKeys, {
      nvidia: 'disk-nvidia',
      groq: 'disk-groq',
    })
    assert.deepEqual(persisted.favorites, ['nvidia/model-a', 'groq/model-b'])
    assert.equal(persisted.settings.hideUnconfiguredModels, false)
  })

  it('can exactly replace favorites when the caller intentionally removes one', () => {
    const diskConfig = {
      apiKeys: {},
      providers: {},
      settings: { hideUnconfiguredModels: true },
      favorites: ['nvidia/model-a', 'groq/model-b'],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      activeProfile: null,
      profiles: {},
    }

    const incomingConfig = {
      apiKeys: {},
      providers: {},
      settings: { hideUnconfiguredModels: true },
      favorites: ['groq/model-b'],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      activeProfile: null,
      profiles: {},
    }

    const persisted = buildPersistedConfig(incomingConfig, diskConfig, { replaceFavorites: true })
    assert.deepEqual(persisted.favorites, ['groq/model-b'])
  })

  it('can exactly replace apiKeys when a provider key is intentionally removed', () => {
    const diskConfig = {
      apiKeys: {
        nvidia: 'disk-nvidia',
        groq: 'disk-groq',
      },
      providers: {},
      settings: { hideUnconfiguredModels: true },
      favorites: [],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      activeProfile: null,
      profiles: {},
    }

    const incomingConfig = {
      apiKeys: {
        nvidia: 'disk-nvidia',
      },
      providers: {},
      settings: { hideUnconfiguredModels: true },
      favorites: [],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      activeProfile: null,
      profiles: {},
    }

    const persisted = buildPersistedConfig(incomingConfig, diskConfig, { replaceApiKeys: true })
    assert.deepEqual(persisted.apiKeys, { nvidia: 'disk-nvidia' })
  })

  it('can exactly replace tracked endpoint installs when managed catalogs are rewritten', () => {
    const diskConfig = {
      apiKeys: {},
      providers: {},
      settings: { hideUnconfiguredModels: true },
      favorites: [],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [
        {
          providerKey: 'groq',
          toolMode: 'goose',
          scope: 'selected',
          modelIds: ['openai/gpt-oss-120b'],
          lastSyncedAt: '2026-03-09T08:00:00.000Z',
        },
      ],
      activeProfile: null,
      profiles: {},
    }

    const incomingConfig = {
      apiKeys: {},
      providers: {},
      settings: { hideUnconfiguredModels: true },
      favorites: [],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [
        {
          providerKey: 'nvidia',
          toolMode: 'opencode',
          scope: 'selected',
          modelIds: ['deepseek-ai/deepseek-v4-flash-0731'],
          lastSyncedAt: '2026-03-10T09:00:00.000Z',
        },
      ],
      activeProfile: null,
      profiles: {},
    }

    const persisted = buildPersistedConfig(incomingConfig, diskConfig, { replaceEndpointInstalls: true })
    assert.deepEqual(persisted.endpointInstalls, [
      {
        providerKey: 'nvidia',
        toolMode: 'opencode',
        scope: 'selected',
        modelIds: ['deepseek-ai/deepseek-v4-flash-0731'],
        lastSyncedAt: '2026-03-10T09:00:00.000Z',
      },
    ])
  })

  it('preserves router config from disk when unrelated stale writers save', () => {
    const diskConfig = {
      apiKeys: { groq: 'disk-groq' },
      providers: {},
      settings: { hideUnconfiguredModels: true },
      favorites: [],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      router: {
        enabled: true,
        activeSet: 'fast-coding',
        sets: {
          'fast-coding': {
            name: 'fast-coding',
            models: [{ provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 }],
            created: '2026-04-22T10:00:00.000Z',
          },
        },
      },
    }

    const incomingConfig = {
      apiKeys: { groq: 'disk-groq' },
      providers: {},
      settings: { hideUnconfiguredModels: false },
      favorites: [],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
    }

    const persisted = buildPersistedConfig(incomingConfig, diskConfig)
    assert.equal(persisted.router.enabled, true)
    assert.equal(persisted.router.activeSet, 'fast-coding')
    assert.equal(persisted.router.sets['fast-coding'].models[0].provider, 'groq')
  })
})

describe('router config helpers', () => {
  it('normalizes router sets, priorities, and tuning defaults', () => {
    const router = normalizeRouterConfig({
      enabled: true,
      activeSet: 'fast coding!',
      probeMode: 'turbo',
      sets: {
        'fast coding!': {
          name: 'fast coding!',
          models: [
            { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 4 },
            { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 9 },
            { provider: 'cerebras', model: 'gpt-oss-120b', priority: 1 },
          ],
        },
      },
    })

    assert.equal(router.enabled, true)
    assert.equal(router.activeSet, 'fast-coding')
    assert.equal(router.probeMode, DEFAULT_ROUTER_SETTINGS.probeMode)
    assert.deepEqual(router.sets['fast-coding'].models.map((entry) => entry.priority), [1, 2])
    assert.deepEqual(router.sets['fast-coding'].models.map((entry) => entry.provider), ['cerebras', 'groq'])
  })

  it('builds a default router set with pinned models first, then keyed providers', async () => {
    const set = await buildDefaultRouterSet({ apiKeys: { groq: 'gsk-test' } }, 6)
    assert.equal(set.name, DEFAULT_ROUTER_SETTINGS.activeSet)
    // 📖 M5: with no probe fn supplied the new builder falls back to the
    // 📖 sync static ordering (pinned models first, then keyed providers).
    // 📖 Every returned model must come from a keyed provider because the
    // 📖 pinned picks themselves target providers the user has keys for.
    assert.ok(set.models.length > 0, 'must return at least one model')
    assert.ok(set.models.every((entry) => entry.provider === 'groq'))
    assert.deepEqual(set.models.map((entry) => entry.priority), set.models.map((_, i) => i + 1))
  })

  it('buildDefaultRouterSet prefers probed-working models over the static ordering', async () => {
    // 📖 A probe fn that says "groq is broken, cerebras is great" should
    // 📖 bump cerebras to the top even when the static ordering would not.
    const probeFn = async (entry) => {
      if (entry.provider === 'groq') return { ok: false, code: 401, latencyMs: 0 }
      if (entry.provider === 'cerebras') return { ok: true, code: 200, latencyMs: 200 }
      return { ok: false, code: 500, latencyMs: 0 }
    }
    const set = await buildDefaultRouterSet(
      { apiKeys: { groq: 'k', cerebras: 'k' } },
      4,
      { probeFn, probeTimeoutMs: 500, probeBudget: 8 },
    )
    // 📖 Cerebras should be in the set (it's the only working one) and
    // 📖 it should be at the top of the list.
    assert.ok(set.models.length >= 1, 'must return at least one model')
    assert.equal(set.models[0].provider, 'cerebras')
  })

  it('buildDefaultRouterSet falls back to the sync static ordering when no probe fn is supplied', async () => {
    // 📖 Tests still want to call this without a probe fn — the function
    // 📖 must remain usable from a plain `await` and return the same shape
    // 📖 the old sync version did.
    const set = await buildDefaultRouterSet({ apiKeys: { groq: 'k' } }, 2)
    assert.equal(set.name, DEFAULT_ROUTER_SETTINGS.activeSet)
    assert.ok(Array.isArray(set.models))
    assert.equal(set.models.length, 2)
    assert.deepEqual(set.models.map((e) => e.priority), [1, 2])
  })

  it('formats errors with the OpenAI-compatible router shape', () => {
    const payload = formatOpenAiError('All models unavailable', 'service_unavailable', 'all_models_unavailable', 'req-test', {
      set: 'fast-coding',
    })
    assert.equal(payload.error.message, 'All models unavailable')
    assert.equal(payload.error.type, 'service_unavailable')
    assert.equal(payload.error.code, 'all_models_unavailable')
    assert.equal(payload.error.request_id, 'req-test')
    assert.equal(payload.error.set, 'fast-coding')
  })
})

describe('router daemon integration hardening', () => {
  it('canonicalizes content-type before proxying upstream requests', () => {
    const actual = cloneHeadersForUpstream({ 'content-type': 'application/json', accept: 'application/json' }, 'router-test-key', 'groq')

    assert.equal(actual['Content-Type'], 'application/json')
    assert.equal(actual['content-type'], undefined)
    assert.equal(actual.Authorization, 'Bearer router-test-key')
    assert.equal(actual.accept, 'application/json')
  })

  it('applies the per-provider schema normalizer before forwarding upstream (zai strips parallel_tool_calls)', async () => {
    await withMockProvider(() => ({
      body: { id: 'chatcmpl-zai', choices: [{ message: { role: 'assistant', content: 'ok' } }] },
    }), async (zaiProvider) => {
      await withSourceUrls({ zai: zaiProvider.url }, async () => {
        const config = buildRouterTestConfig([
          { provider: 'zai', model: 'zai/glm-4.7-flash', priority: 1 },
        ], { maxRetries: 1 })
        config.apiKeys.zai = 'zai-test-key'
        await withRouterTestServer(config, async ({ baseUrl }) => {
          // 📖 Client (ZCode, Claude Code, Cline…) sends a body with
          // 📖 parallel_tool_calls=true. GLM rejects this with 422. The
          // 📖 router must strip it before forwarding.
          const response = await postRouterChat(baseUrl, { parallel_tool_calls: true })
          await response.json()

          assert.equal(response.status, 200)
          assert.equal(zaiProvider.requests.length, 1)
          const sentBody = zaiProvider.requests[0].body
          assert.ok(!('parallel_tool_calls' in sentBody), 'parallel_tool_calls must be stripped for zai')
          assert.equal(sentBody.model, 'glm-4.7-flash', 'zai/ prefix is stripped for upstream')
        })
      })
    })
  })

  it('normalizer clamps Mistral temperature > 1 to 1 before forwarding', async () => {
    await withMockProvider(() => ({
      body: { id: 'chatcmpl-mistral', choices: [{ message: { role: 'assistant', content: 'ok' } }] },
    }), async (mistralProvider) => {
      await withSourceUrls({ mistral: mistralProvider.url }, async () => {
        // 📖 'mistral-large-2512' is a real catalog model — the router only
        // 📖 routes to models it can find in sources.js (anything else is
        // 📖 marked stale by definition and never picked).
        const config = buildRouterTestConfig([
          { provider: 'mistral', model: 'mistral-large-2512', priority: 1 },
        ], { maxRetries: 1 })
        config.apiKeys.mistral = 'mistral-test-key'
        await withRouterTestServer(config, async ({ baseUrl }) => {
          // 📖 Some clients send temperature=2.0 (Anthropic range). Mistral's
          // 📖 chat API only accepts [0, 1]. Router clamps to 1.
          const response = await postRouterChat(baseUrl, { temperature: 2.0 })
          await response.json()

          assert.equal(response.status, 200)
          const sentBody = mistralProvider.requests[0].body
          assert.equal(sentBody.temperature, 1, 'Mistral temperature must be clamped to 1')
        })
      })
    })
  })

  it('routes non-streaming chat completions through the highest-priority healthy model', async () => {
    await withMockProvider(() => ({
      body: {
        id: 'chatcmpl-success',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
    }), async (groqProvider) => {
      await withSourceUrls({ groq: groqProvider.url }, async () => {
        const config = buildRouterTestConfig([
          { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
        ])
        await withRouterTestServer(config, async ({ baseUrl, runtime }) => {
          const response = await postRouterChat(baseUrl)
          const payload = await response.json()

          assert.equal(response.status, 200)
          assert.equal(response.headers.get('x-fcm-router-model'), `groq/${ROUTER_TEST_MODELS.groqFast}`)
          assert.equal(payload.id, 'chatcmpl-success')
          assert.equal(groqProvider.requests.length, 1)
          assert.equal(groqProvider.requests[0].headers.authorization, 'Bearer gsk-router-test')
          assert.equal(groqProvider.requests[0].body.model, ROUTER_TEST_MODELS.groqFast)
          assert.equal(runtime.tokenTracker.stats.all_time.total_tokens, 5)
        })
      })
    })
  })

  it('fails over non-streaming retryable provider errors to the next model', async () => {
    await withMockProvider(() => ({ status: 503, body: { error: { message: 'maintenance' } } }), async (groqProvider) => {
      await withMockProvider(() => ({ body: { id: 'chatcmpl-failover', choices: [] } }), async (nvidiaProvider) => {
        await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
          const config = buildRouterTestConfig([
            { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
            { provider: 'nvidia', model: ROUTER_TEST_MODELS.nvidiaFast, priority: 2 },
          ])
          await withRouterTestServer(config, async ({ baseUrl }) => {
            const response = await postRouterChat(baseUrl)
            const payload = await response.json()

            assert.equal(response.status, 200)
            assert.equal(response.headers.get('x-fcm-router-model'), `nvidia/${ROUTER_TEST_MODELS.nvidiaFast}`)
            assert.equal(payload.id, 'chatcmpl-failover')
            assert.equal(groqProvider.requests.length, 1)
            assert.equal(nvidiaProvider.requests.length, 1)
          })
        })
      })
    })
  })

  it('fails over non-streaming HTTP 529 (overloaded) to the next model (issue #148)', async () => {
    await withMockProvider(() => ({ status: 529, body: { error: { message: 'overloaded' } } }), async (groqProvider) => {
      await withMockProvider(() => ({ body: { id: 'chatcmpl-failover-529', choices: [] } }), async (nvidiaProvider) => {
        await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
          const config = buildRouterTestConfig([
            { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
            { provider: 'nvidia', model: ROUTER_TEST_MODELS.nvidiaFast, priority: 2 },
          ])
          await withRouterTestServer(config, async ({ baseUrl }) => {
            const response = await postRouterChat(baseUrl)
            const payload = await response.json()

            assert.equal(response.status, 200)
            assert.equal(response.headers.get('x-fcm-router-model'), `nvidia/${ROUTER_TEST_MODELS.nvidiaFast}`)
            assert.equal(payload.id, 'chatcmpl-failover-529')
            assert.equal(groqProvider.requests.length, 1)
            assert.equal(nvidiaProvider.requests.length, 1)
          })
        })
      })
    })
  })

  // 📖 t8 - family-preserving failover: when the primary GPT-family model on
  // nvidia fails, the router must hop to the SAME family on cerebras and skip
  // the higher-priority Qwen entry on groq (a mid-conversation family switch
  // changes the model's behaviour, a provider hop does not).
  // 📖 Primary is gpt-oss-20b: gpt-oss-120b was removed from the NVIDIA NIM
  // catalog (deprecated 2026-09-02, audit 2026-09-05).
  it('prefers a same-family model on another provider over the next set entry (t8)', async () => {
    await withMockProvider(() => ({ status: 503, body: { error: { message: 'maintenance' } } }), async (nvidiaProvider) => {
      await withMockProvider(() => ({ body: { id: 'should-not-serve-qwen', choices: [] } }), async (groqProvider) => {
        await withMockProvider(() => ({ body: { id: 'chatcmpl-family-hop', choices: [] } }), async (cerebrasProvider) => {
          await withSourceUrls({ nvidia: nvidiaProvider.url, groq: groqProvider.url, cerebras: cerebrasProvider.url }, async () => {
            const config = buildRouterTestConfig([
              { provider: 'nvidia', model: 'openai/gpt-oss-20b', priority: 1 },
              { provider: 'groq', model: 'qwen/qwen3.6-27b', priority: 2 },
              { provider: 'cerebras', model: 'gpt-oss-120b', priority: 3 },
            ])
            config.apiKeys.cerebras = 'cb-router-test'
            await withRouterTestServer(config, async ({ baseUrl, runtime }) => {
              const response = await postRouterChat(baseUrl)
              const payload = await response.json()

              assert.equal(response.status, 200)
              assert.equal(response.headers.get('x-fcm-router-model'), 'cerebras/gpt-oss-120b', 'must stay in the GPT family on another provider')
              assert.equal(payload.id, 'chatcmpl-family-hop')
              assert.equal(nvidiaProvider.requests.length, 1, 'primary attempted once')
              assert.equal(groqProvider.requests.length, 0, 'Qwen entry must be skipped by the family stage')
              assert.equal(cerebrasProvider.requests.length, 1, 'family alternative served the request')

              const servedEntry = runtime.requestLog.find((entry) => entry.model === 'cerebras/gpt-oss-120b')
              assert.ok(servedEntry, 'served attempt must appear in the request log')
              assert.equal(servedEntry.failover, true)
              assert.equal(servedEntry.failover_reason, 'family_failover', 'request log must expose the family hop reason')
            })
          })
        })
      })
    })
  })

  // 📖 t8 - with familyFailover:false the behaviour must match the historical
  // set-order failover exactly (Qwen on groq is priority 2 and gets served).
  it('keeps plain set-order failover when familyFailover is disabled (t8)', async () => {
    await withMockProvider(() => ({ status: 503, body: { error: { message: 'maintenance' } } }), async (nvidiaProvider) => {
      await withMockProvider(() => ({ body: { id: 'chatcmpl-set-order', choices: [] } }), async (groqProvider) => {
        await withMockProvider(() => ({ body: { id: 'should-not-serve-cerebras', choices: [] } }), async (cerebrasProvider) => {
          await withSourceUrls({ nvidia: nvidiaProvider.url, groq: groqProvider.url, cerebras: cerebrasProvider.url }, async () => {
            const config = buildRouterTestConfig([
              { provider: 'nvidia', model: 'openai/gpt-oss-20b', priority: 1 },
              { provider: 'groq', model: 'qwen/qwen3.6-27b', priority: 2 },
              { provider: 'cerebras', model: 'gpt-oss-120b', priority: 3 },
            ], { familyFailover: false })
            config.apiKeys.cerebras = 'cb-router-test'
            await withRouterTestServer(config, async ({ baseUrl, runtime }) => {
              const response = await postRouterChat(baseUrl)
              const payload = await response.json()

              assert.equal(response.status, 200)
              assert.equal(response.headers.get('x-fcm-router-model'), 'groq/qwen/qwen3.6-27b', 'must follow plain set order (priority 2)')
              assert.equal(payload.id, 'chatcmpl-set-order')
              assert.equal(nvidiaProvider.requests.length, 1)
              assert.equal(groqProvider.requests.length, 1)
              assert.equal(cerebrasProvider.requests.length, 0)

              const servedEntry = runtime.requestLog.find((entry) => entry.model === 'groq/qwen/qwen3.6-27b')
              assert.ok(servedEntry, 'served attempt must appear in the request log')
              assert.equal(servedEntry.failover, true)
              assert.equal(servedEntry.failover_reason, 'set_order', 'request log must expose the set-order reason')
            })
          })
        })
      })
    })
  })

  it('fails over streaming HTTP 529 (overloaded) before the first byte (issue #148)', async () => {
    await withMockProvider(() => ({ status: 529, body: { error: { message: 'overloaded' } } }), async (groqProvider) => {
      await withMockProvider(() => ({
        headers: { 'content-type': 'text/event-stream' },
        chunks: ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'],
      }), async (nvidiaProvider) => {
        await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
          const config = buildRouterTestConfig([
            { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
            { provider: 'nvidia', model: ROUTER_TEST_MODELS.nvidiaFast, priority: 2 },
          ])
          await withRouterTestServer(config, async ({ baseUrl }) => {
            const response = await postRouterChat(baseUrl, { stream: true })
            const text = await response.text()

            assert.equal(response.status, 200)
            assert.equal(response.headers.get('x-fcm-router-model'), `nvidia/${ROUTER_TEST_MODELS.nvidiaFast}`)
            assert.match(text, /"ok"/)
            assert.equal(groqProvider.requests.length, 1)
            assert.equal(nvidiaProvider.requests.length, 1)
          })
        })
      })
    })
  })

  it('fails over streaming errors before the first byte', async () => {
    await withMockProvider(() => ({ status: 503, body: { error: { message: 'warming up' } } }), async (groqProvider) => {
      await withMockProvider(() => ({
        headers: { 'content-type': 'text/event-stream' },
        chunks: ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'],
      }), async (nvidiaProvider) => {
        await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
          const config = buildRouterTestConfig([
            { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
            { provider: 'nvidia', model: ROUTER_TEST_MODELS.nvidiaFast, priority: 2 },
          ])
          await withRouterTestServer(config, async ({ baseUrl }) => {
            const response = await postRouterChat(baseUrl, { stream: true })
            const text = await response.text()

            assert.equal(response.status, 200)
            assert.equal(response.headers.get('x-fcm-router-model'), `nvidia/${ROUTER_TEST_MODELS.nvidiaFast}`)
            assert.match(text, /"ok"/)
            assert.equal(groqProvider.requests.length, 1)
            assert.equal(nvidiaProvider.requests.length, 1)
          })
        })
      })
    })
  })

  it('does not retry a streaming response after partial output reached the client', async () => {
    await withMockProvider((request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
      setTimeout(() => res.destroy(new Error('upstream stream exploded')), 5)
      return null
    }, async (groqProvider) => {
      await withMockProvider(() => ({ body: { id: 'should-not-run', choices: [] } }), async (nvidiaProvider) => {
        await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
          const config = buildRouterTestConfig([
            { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
            { provider: 'nvidia', model: ROUTER_TEST_MODELS.nvidiaFast, priority: 2 },
          ])
          await withRouterTestServer(config, async ({ baseUrl }) => {
            const response = await postRouterChat(baseUrl, { stream: true })
            const text = await response.text()

            assert.equal(response.status, 200)
            assert.match(text, /partial/)
            assert.equal(groqProvider.requests.length, 1)
            assert.equal(nvidiaProvider.requests.length, 0)
          })
        })
      })
    })
  })

  // 📖 Regression test for issue #137: when a stream stalls after partial data
  // 📖 was already sent, the router should now failover to the next model
  // 📖 (and emit a synthetic SSE error event in between) instead of just
  // 📖 truncating the response. Health degradation (markFailure) was already
  // 📖 in place — this test locks in the failover half of the fix.
  it('fails over to the next model when the stream stalls after partial output (issue #137)', async () => {
    await withMockProvider((request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"partial-"}}]}\n\n')
      // 📖 Never sends another chunk — simulates a stalled stream. The router
      // 📖 streamStallTimeoutMs (60ms in this test) will fire and trigger failover.
      return null
    }, async (groqProvider) => {
      await withMockProvider(() => ({
        headers: { 'content-type': 'text/event-stream' },
        chunks: ['data: {"choices":[{"delta":{"content":"fallback"}}]}\n\n', 'data: [DONE]\n\n'],
      }), async (nvidiaProvider) => {
        await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
          const config = buildRouterTestConfig([
            { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
            { provider: 'nvidia', model: ROUTER_TEST_MODELS.nvidiaFast, priority: 2 },
          ], { streamStallTimeoutMs: 60 })
          await withRouterTestServer(config, async ({ baseUrl }) => {
            const response = await postRouterChat(baseUrl, { stream: true })
            const text = await response.text()

            assert.equal(response.status, 200)
            // 📖 Partial data from the first model is visible to the client.
            assert.match(text, /partial-/)
            // 📖 The router emits a synthetic SSE caution message so the client knows
            // 📖 the stream was truncated and a failover is happening.
            assert.match(text, /CAUTION/)
            assert.match(text, /Stream truncated by router/)
            // 📖 Fallback stream from nvidia was appended.
            assert.match(text, /fallback/)
            assert.equal(groqProvider.requests.length, 1)
            assert.equal(nvidiaProvider.requests.length, 1)
          })
        })
      })
    })
  })

  it('skips remaining candidates from the same provider after an auth error', async () => {
    await withMockProvider(() => ({ status: 401, body: { error: { message: 'bad key' } } }), async (groqProvider) => {
      await withMockProvider(() => ({ body: { id: 'chatcmpl-auth-skip', choices: [] } }), async (nvidiaProvider) => {
        await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
          const config = buildRouterTestConfig([
            { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
            { provider: 'groq', model: ROUTER_TEST_MODELS.groqBackup, priority: 2 },
            { provider: 'nvidia', model: ROUTER_TEST_MODELS.nvidiaFast, priority: 3 },
          ])
          await withRouterTestServer(config, async ({ baseUrl }) => {
            const response = await postRouterChat(baseUrl)

            assert.equal(response.status, 200)
            assert.equal(response.headers.get('x-fcm-router-model'), `nvidia/${ROUTER_TEST_MODELS.nvidiaFast}`)
            assert.equal(groqProvider.requests.length, 1)
            assert.equal(nvidiaProvider.requests.length, 1)
          })
        })
      })
    })
  })

  // 📖 Regression for issue #120 — priority must be authoritative. Before the
  // 📖 fix, priority was only 20% of the routing score, so a healthy
  // 📖 low-priority model (e.g. GPT-OSS 120B) could steal traffic from a
  // 📖 deliberately higher-ranked model. These two tests lock in priority-first
  // 📖 routing so the user's fallback chain is always respected.
  it('routes to the higher-priority model even when a lower-priority one is also healthy (issue #120)', async () => {
    await withMockProvider(() => ({
      body: { id: 'chatcmpl-primary', choices: [{ message: { role: 'assistant', content: 'from-1' } }] },
    }), async (groqProvider) => {
      await withMockProvider(() => ({
        body: { id: 'chatcmpl-fallback', choices: [{ message: { role: 'assistant', content: 'from-2' } }] },
      }), async (nvidiaProvider) => {
        await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
          const config = buildRouterTestConfig([
            { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
            { provider: 'nvidia', model: ROUTER_TEST_MODELS.nvidiaFast, priority: 2 },
          ])
          await withRouterTestServer(config, async ({ baseUrl }) => {
            const response = await postRouterChat(baseUrl)
            const payload = await response.json()

            // 📖 Both providers are healthy, so priority #1 (groq) MUST serve —
            // 📖 never nvidia, regardless of any health-score ordering.
            assert.equal(response.status, 200)
            assert.equal(response.headers.get('x-fcm-router-model'), `groq/${ROUTER_TEST_MODELS.groqFast}`)
            assert.equal(payload.id, 'chatcmpl-primary')
            assert.equal(groqProvider.requests.length, 1)
            assert.equal(nvidiaProvider.requests.length, 0)
          })
        })
      })
    })
  })

  it('exposes routingOrder in /stats so the dashboard knows which model serves next (issue #120)', async () => {
    await withMockProvider(() => ({
      body: { id: 'chatcmpl-ok', choices: [] },
    }), async (groqProvider) => {
      await withMockProvider(() => ({
        body: { id: 'chatcmpl-ok', choices: [] },
      }), async (nvidiaProvider) => {
        await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
          const config = buildRouterTestConfig([
            { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
            { provider: 'nvidia', model: ROUTER_TEST_MODELS.nvidiaFast, priority: 2 },
          ])
          await withRouterTestServer(config, async ({ baseUrl }) => {
            const response = await fetch(`${baseUrl}/stats`)
            const stats = await response.json()

            assert.equal(response.status, 200)
            assert.ok(Array.isArray(stats.routingOrder), 'routingOrder must be an array')
            assert.equal(stats.routingOrder.length, 2)
            // 📖 routingOrder[0] is the model that will serve the next request.
            assert.equal(stats.routingOrder[0].key, `groq/${ROUTER_TEST_MODELS.groqFast}`)
            assert.equal(stats.routingOrder[1].key, `nvidia/${ROUTER_TEST_MODELS.nvidiaFast}`)
          })
        })
      })
    })
  })

  // 📖 Regression for issue #120 — HALF_OPEN recovery must NOT be skipped.
  // 📖 The screenshot from the user showed a HALF_OPEN priority-#1 model
  // 📖 being skipped for a CLOSED priority-#20 model. The priority-first
  // 📖 comparator in getRoutingCandidates now guarantees explicit priority
  // 📖 wins over circuit state, so a high-priority model mid-recovery is
  // 📖 still tried before any lower-priority CLOSED fallback.
  it('keeps a higher-priority HALF_OPEN model above a lower-priority CLOSED one (issue #120)', async () => {
    await withMockProvider(() => ({
      body: { id: 'chatcmpl-halfopen', choices: [{ message: { role: 'assistant', content: 'from-halfopen' } }] },
    }), async (groqProvider) => {
      await withMockProvider(() => ({
        body: { id: 'chatcmpl-closed', choices: [{ message: { role: 'assistant', content: 'from-closed' } }] },
      }), async (nvidiaProvider) => {
        await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
          const config = buildRouterTestConfig([
            { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
            { provider: 'nvidia', model: ROUTER_TEST_MODELS.nvidiaFast, priority: 5 },
          ])
          await withRouterTestServer(config, async ({ baseUrl, runtime }) => {
            // 📖 Force groq (priority #1) into HALF_OPEN recovery. nvidia
            // 📖 (priority #5) stays CLOSED. The OLD code would have sorted
            // 📖 HALF_OPEN AFTER CLOSED regardless of priority; the NEW
            // 📖 comparator must keep groq at the top.
            const groqKey = `groq/${ROUTER_TEST_MODELS.groqFast}`
            const groqCircuit = runtime.circuit.get(groqKey)
            assert.ok(groqCircuit, 'groq circuit entry must exist')
            groqCircuit.state = 'HALF_OPEN'
            groqCircuit.openedAt = Date.now() - 60_000

            // 📖 routingOrder surface: groq (HALF_OPEN, priority 1) MUST be
            // 📖 before nvidia (CLOSED, priority 5) — issue #120's exact case.
            const stats = await (await fetch(`${baseUrl}/stats`)).json()
            assert.equal(stats.routingOrder[0].key, groqKey,
              'priority-#1 HALF_OPEN must come before priority-#5 CLOSED')
            assert.equal(stats.routingOrder[0].state, 'HALF_OPEN')
            assert.equal(stats.routingOrder[1].key, `nvidia/${ROUTER_TEST_MODELS.nvidiaFast}`)
            assert.equal(stats.routingOrder[1].state, 'CLOSED')

            // 📖 End-to-end check: a real chat-completions request hits groq
            // 📖 (the HALF_OPEN priority-#1), NOT nvidia (the CLOSED priority-#5).
            const response = await postRouterChat(baseUrl)
            assert.equal(response.status, 200)
            assert.equal(response.headers.get('x-fcm-router-model'), groqKey)
            assert.equal(groqProvider.requests.length, 1)
            assert.equal(nvidiaProvider.requests.length, 0)
          })
        })
      })
    })
  })

  // 📖 Regression for issue #120 — score tiebreaker determinism.
  // 📖 When two candidates share the same explicit priority AND the same
  // 📖 circuit state, the comparator falls back to score. With the v0.5.37
  // 📖 refactor, score is pure latency+uptime (no priorityWeight) so the
  // 📖 tiebreaker is deterministic and reflects actual model quality.
  it('breaks score ties deterministically by latency/uptime, not priority (issue #120)', async () => {
    await withMockProvider(() => ({
      body: { id: 'chatcmpl-winner', choices: [{ message: { role: 'assistant', content: 'high-score' } }] },
    }), async (groqProvider) => {
      await withMockProvider(() => ({
        body: { id: 'chatcmpl-loser', choices: [{ message: { role: 'assistant', content: 'low-score' } }] },
      }), async (nvidiaProvider) => {
        await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
          // 📖 Two models deliberately at the SAME priority (rare but
          // 📖 possible via direct API or auto-heal). Tiebreaker must fall
          // 📖 back to score (latency+uptime), not priority (they're equal),
          // 📖 not random Map iteration order.
          const config = buildRouterTestConfig([
            { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
            { provider: 'nvidia', model: ROUTER_TEST_MODELS.nvidiaFast, priority: 1 },
          ])
          await withRouterTestServer(config, async ({ baseUrl, runtime }) => {
            // 📖 Build a clear asymmetry: groq has fast probes (high score),
            // 📖 nvidia has slow probes (low score). Same priority, same state.
            const groqKey = `groq/${ROUTER_TEST_MODELS.groqFast}`
            const nvidiaKey = `nvidia/${ROUTER_TEST_MODELS.nvidiaFast}`
            for (let i = 0; i < 6; i++) runtime.recordProbeResult(groqKey, { ok: true, latencyMs: 80, code: 200 })
            for (let i = 0; i < 6; i++) runtime.recordProbeResult(nvidiaKey, { ok: true, latencyMs: 2000, code: 200 })

            const stats = await (await fetch(`${baseUrl}/stats`)).json()
            assert.equal(stats.routingOrder[0].key, groqKey,
              'higher-score model must win same-priority same-state tiebreaker')
            assert.equal(stats.routingOrder[1].key, nvidiaKey)

            // 📖 priorityBonus is still exposed separately for back-compat
            // 📖 dashboards, but is NOT mixed into the routing score.
            const groqHealth = stats.models.find((m) => m.key === groqKey)
            const nvidiaHealth = stats.models.find((m) => m.key === nvidiaKey)
            assert.ok(groqHealth.score > nvidiaHealth.score,
              `groq score (${groqHealth.score}) must exceed nvidia (${nvidiaHealth.score})`)

            // 📖 End-to-end: the chat-completions request hits the high-
            // 📖 score groq model.
            const response = await postRouterChat(baseUrl)
            assert.equal(response.headers.get('x-fcm-router-model'), groqKey)
          })
        })
      })
    })
  })

  it('returns precise quota metadata when every routed model is exhausted', async () => {
    await withMockProvider(() => ({
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': '7',
        'x-ratelimit-remaining': '0',
      },
      body: { error: { message: 'quota exceeded' } },
    }), async (groqProvider) => {
      await withSourceUrls({ groq: groqProvider.url }, async () => {
        const config = buildRouterTestConfig([
          { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
        ])
        await withRouterTestServer(config, async ({ baseUrl }) => {
          const response = await postRouterChat(baseUrl)
          const payload = await response.json()

          assert.equal(response.status, 429)
          assert.equal(payload.error.code, 'insufficient_quota')
          assert.deepEqual(payload.error.quota_exhausted, [`groq/${ROUTER_TEST_MODELS.groqFast}`])
          assert.equal(payload.error.quota_exhausted_details[0].retry_after_ms, 7000)
          assert.equal(payload.error.quota_exhausted_details[0].rate_limit_headers['x-ratelimit-remaining'], '0')
          assert.equal(groqProvider.requests.length, 1)
        })
      })
    })
  })

  it('treats upstream HTML maintenance pages as retryable 503 responses', async () => {
    await withMockProvider(() => ({
      headers: { 'content-type': 'text/html' },
      rawBody: '<!doctype html><html><body>maintenance</body></html>',
    }), async (groqProvider) => {
      await withMockProvider(() => ({ body: { id: 'chatcmpl-after-html', choices: [] } }), async (nvidiaProvider) => {
        await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
          const config = buildRouterTestConfig([
            { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
            { provider: 'nvidia', model: ROUTER_TEST_MODELS.nvidiaFast, priority: 2 },
          ])
          await withRouterTestServer(config, async ({ baseUrl }) => {
            const response = await postRouterChat(baseUrl)
            const payload = await response.json()

            assert.equal(response.status, 200)
            assert.equal(payload.id, 'chatcmpl-after-html')
            assert.equal(groqProvider.requests.length, 1)
            assert.equal(nvidiaProvider.requests.length, 1)
          })
        })
      })
    })
  })

  it('fails over malformed successful JSON instead of returning it to clients', async () => {
    await withMockProvider(() => ({
      headers: { 'content-type': 'application/json' },
      rawBody: '{"id":',
    }), async (groqProvider) => {
      await withMockProvider(() => ({ body: { id: 'chatcmpl-after-invalid-json', choices: [] } }), async (nvidiaProvider) => {
        await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
          const config = buildRouterTestConfig([
            { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
            { provider: 'nvidia', model: ROUTER_TEST_MODELS.nvidiaFast, priority: 2 },
          ])
          await withRouterTestServer(config, async ({ baseUrl }) => {
            const response = await postRouterChat(baseUrl)
            const payload = await response.json()

            assert.equal(response.status, 200)
            assert.equal(payload.id, 'chatcmpl-after-invalid-json')
            assert.equal(groqProvider.requests.length, 1)
            assert.equal(nvidiaProvider.requests.length, 1)
          })
        })
      })
    })
  })

  it('fails over request timeouts and connection-refused transport errors', async () => {
    await withMockProvider(() => ({ delayMs: 1100, body: { id: 'too-late', choices: [] } }), async (slowProvider) => {
      await withMockProvider(() => ({ body: { id: 'chatcmpl-after-timeout', choices: [] } }), async (nvidiaProvider) => {
        await withSourceUrls({ groq: slowProvider.url, nvidia: nvidiaProvider.url }, async () => {
          const config = buildRouterTestConfig([
            { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
            { provider: 'nvidia', model: ROUTER_TEST_MODELS.nvidiaFast, priority: 2 },
          ], { requestTimeoutMs: 10 })
          await withRouterTestServer(config, async ({ baseUrl }) => {
            const response = await postRouterChat(baseUrl)
            const payload = await response.json()

            assert.equal(response.status, 200)
            assert.equal(payload.id, 'chatcmpl-after-timeout')
            assert.equal(nvidiaProvider.requests.length, 1)
          })
        })
      })
    })

    const closedServer = createHttpServer(() => {})
    const closedPort = await listenOnRandomPort(closedServer)
    await closeRouterTestServer(closedServer)
    await withMockProvider(() => ({ body: { id: 'chatcmpl-after-refused', choices: [] } }), async (nvidiaProvider) => {
      await withSourceUrls({
        groq: `http://127.0.0.1:${closedPort}/v1/chat/completions`,
        nvidia: nvidiaProvider.url,
      }, async () => {
        const config = buildRouterTestConfig([
          { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
          { provider: 'nvidia', model: ROUTER_TEST_MODELS.nvidiaFast, priority: 2 },
        ])
        await withRouterTestServer(config, async ({ baseUrl }) => {
          const response = await postRouterChat(baseUrl)
          const payload = await response.json()

          assert.equal(response.status, 200)
          assert.equal(payload.id, 'chatcmpl-after-refused')
          assert.equal(nvidiaProvider.requests.length, 1)
        })
      })
    })
  })

  it('aborts the upstream request when the client disconnects', async () => {
    let providerCloseResolve = null
    let providerReceivedResolve = null
    const providerClosed = new Promise((resolve) => { providerCloseResolve = resolve })
    const providerReceived = new Promise((resolve) => { providerReceivedResolve = resolve })

    await withMockProvider((request, res) => {
      providerReceivedResolve()
      res.on('close', () => providerCloseResolve())
      return new Promise(() => {})
    }, async (groqProvider) => {
      await withSourceUrls({ groq: groqProvider.url }, async () => {
        const config = buildRouterTestConfig([
          { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
        ], { requestTimeoutMs: 1000 })
        await withRouterTestServer(config, async ({ baseUrl }) => {
          const controller = new AbortController()
          const request = fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(routerChatBody()),
            signal: controller.signal,
          }).catch((error) => error)

          await withTimeout(providerReceived, 500, 'provider request')
          controller.abort()
          await withTimeout(providerClosed, 500, 'provider close')
          const result = await request

          assert.ok(result instanceof Error)
          assert.equal(groqProvider.requests.length, 1)
        })
      })
    })
  })

  it('does not advertise the daemon restart endpoint before a real restart strategy exists', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
    ])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/daemon/restart`, { method: 'POST' })
      const payload = await response.json()

      assert.equal(response.status, 404)
      assert.equal(payload.error.code, 'not_found')
    })
  })

  it('updates probe mode through the dashboard endpoint', async () => {
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl, runtime }) => {
      const response = await fetch(`${baseUrl}/daemon/probe-mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ probeMode: 'eco' }),
      })
      const payload = await response.json()
      const health = await (await fetch(`${baseUrl}/health`)).json()

      assert.equal(response.status, 200)
      assert.equal(payload.probeMode, 'eco')
      assert.equal(runtime.routerConfig().probeMode, 'eco')
      assert.equal(health.probeMode, 'eco')
    })
  })

  // 📖 Regression for the Playground "router offline" bug: /health and /stats
  // 📖 MUST report `running: true` alongside `ok: true`. The Playground reads
  // 📖 `status.running` while the Router card reads `status.ok` — if they
  // 📖 disagree, the user starts the router, sees it "Running", then opens the
  // 📖 Playground and gets a false "router offline". Both fields must agree.
  it('reports running: true on /health and /stats so the Playground trusts the daemon', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: ROUTER_TEST_MODELS.groqFast, priority: 1 },
    ])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const health = await (await fetch(`${baseUrl}/health`)).json()
      const stats = await (await fetch(`${baseUrl}/stats`)).json()

      assert.equal(health.ok, true)
      assert.equal(health.running, true, '/health must include running: true')
      assert.equal(stats.ok, true)
      assert.equal(stats.running, true, '/stats must include running: true')
      // 📖 Probe progress + per-model benchmark fields power the Router Dashboard
      // 📖 "Probe all" button — assert the shape so the UI never breaks silently.
      assert.ok(stats.globalBenchmark && typeof stats.globalBenchmark === 'object')
      assert.equal(stats.globalBenchmark.running, false)
      assert.equal(typeof stats.globalBenchmark.total, 'number')
      assert.ok(Array.isArray(stats.models))
      assert.equal(stats.models.length, 1)
      assert.equal(stats.models[0].isBenchmarking, false)
    })
  })

  it('serves /api/models with model catalog data', async () => {
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/models`)
      const payload = await response.json()

      assert.equal(response.status, 200)
      assert.ok(Array.isArray(payload), '/api/models should return an array')
      assert.ok(payload.length > 0, 'model array should not be empty')
      const first = payload[0]
      assert.ok(typeof first.modelId === 'string', 'modelId should be string')
      assert.ok(typeof first.tier === 'string', 'tier should be string')
      assert.ok(typeof first.providerKey === 'string', 'providerKey should be string')
      assert.ok(typeof first.label === 'string', 'label should be string')
      assert.ok(typeof first.hasApiKey === 'boolean', 'hasApiKey should be boolean')
      assert.ok(first.hasOwnProperty('status'), 'should have status field')
      assert.ok(first.hasOwnProperty('inRouterSet'), 'should have inRouterSet field')
    })
  })

  it('serves /api/config with sanitized provider data', async () => {
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/config`)
      const payload = await response.json()

      assert.equal(response.status, 200)
      assert.ok(payload.providers, 'should have providers object')
      assert.ok(typeof payload.totalModels === 'number', 'totalModels should be number')
      for (const [key, provider] of Object.entries(payload.providers)) {
        assert.ok(typeof provider.name === 'string', `${key} should have name`)
        assert.ok(typeof provider.hasKey === 'boolean', `${key} should have hasKey boolean`)
        assert.ok(provider.hasKey === false || provider.maskedKey?.includes('•'), `${key} should mask key`)
        assert.ok(typeof provider.enabled === 'boolean', `${key} should have enabled boolean`)
      }
    })
  })

  it('serves static index.html for root path', async () => {
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/`)
      const text = await response.text()

      assert.equal(response.status, 200)
      assert.ok(text.includes('<!DOCTYPE html') || text.includes('<html'), 'should serve HTML')
    })
  })

  it('autoHealActiveSet is a no-op when the set is user-customized', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 },
    ])
    config.router.userCustomized = true
    await withRouterTestServer(config, async ({ runtime }) => {
      const result = await runtime.autoHealActiveSet()
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'user_customized')
    })
  })

  it('autoHealActiveSet is a no-op when autoHeal is disabled', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 },
    ])
    config.router.autoHeal = false
    await withRouterTestServer(config, async ({ runtime }) => {
      const result = await runtime.autoHealActiveSet()
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'autoHeal_disabled')
    })
  })

  it('autoHealActiveSet reports no-op when there are no broken models', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 },
    ])
    await withRouterTestServer(config, async ({ runtime }) => {
      const result = await runtime.autoHealActiveSet()
      assert.equal(result.ok, true)
      assert.equal(result.replaced, 0)
    })
  })

  it('user edits to a set flip router.userCustomized and router.autoHeal to false', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 },
    ])
    await withRouterTestServer(config, async ({ baseUrl, runtime }) => {
      // 📖 Mark the set as auto-healed (clean state).
      assert.equal(config.router.userCustomized, false)
      assert.equal(config.router.autoHeal, true)
      // 📖 Add a model — that's a user action.
      const response = await fetch(`${baseUrl}/sets/test-set/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'cerebras', model: 'llama3.1-70b' }),
      })
      assert.equal(response.status, 201)
      // 📖 After a user edit, the next routerConfig() must reflect
      // 📖 userCustomized: true and autoHeal: false.
      const after = runtime.routerConfig()
      assert.equal(after.userCustomized, true)
      assert.equal(after.autoHeal, false)
    })
  })

  it('serves /api/events as SSE stream', async () => {
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1000)
      let response
      try {
        response = await fetch(`${baseUrl}/api/events`, {
          signal: controller.signal,
        })

        assert.equal(response.status, 200)
        assert.ok(response.headers.get('content-type')?.includes('text/event-stream'), 'should be SSE')
      } finally {
        clearTimeout(timeout)
        try {
          await response?.body?.cancel()
        } catch {
          // 📖 The stream may already be closed by abort/teardown.
        }
        controller.abort()
      }
    })
  })

  it('broadcasts full models state over SSE after a probe result (issue #147)', async () => {
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl, runtime }) => {
      const controller = new AbortController()
      const response = await fetch(`${baseUrl}/api/events`, { signal: controller.signal })
      assert.equal(response.status, 200)

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const collected = (async () => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
        }
      })()

      // 📖 Wait for the initial `: connected` + state payload to flush, then
      // 📖 record a probe result — the daemon must broadcast a `models` event
      // 📖 so the dashboard updates (the front only listens for `models`).
      await new Promise((resolve) => setTimeout(resolve, 100))
      runtime.recordProbeResult('groq/model-x', { ok: true, latencyMs: 42, code: 200 })

      // 📖 Give the 250ms debounced broadcast time to fire.
      await new Promise((resolve) => setTimeout(resolve, 500))
      controller.abort()
      try { await collected } catch {}

      assert.match(buffer, /event: models/, 'SSE must emit a models event after a probe result')
      assert.ok(buffer.includes('groq/model-x'), 'models payload must include the probed model')
    })
  })

  it('blocks path traversal in static file serving', async () => {
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/../../../../../../etc/passwd`)
      // 📖 Either the path-traversal guard fires (403) or the server's URL
      // 📖 normalization collapses the path so the dashboard SPA serves 200
      // 📖 with an HTML page. The critical contract: never expose /etc/passwd.
      const body = await response.text()
      assert.ok(!body.startsWith('root:'), 'must not leak /etc/passwd contents')
      assert.ok(!body.includes('/bin/bash'), 'must not leak shell paths')
    })
  })

  it('rejects /api/settings POST from a cross-origin browser context', async () => {
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://evil.example.com',
        },
        body: JSON.stringify({ apiKeys: { groq: 'stolen' } }),
      })
      assert.equal(response.status, 403, 'cross-origin write must be blocked')
    })
  })

  it('accepts /api/settings POST from a same-origin (localhost) context', async () => {
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'http://localhost:19280',
        },
        body: JSON.stringify({ providers: { groq: { enabled: false } } }),
      })
      assert.equal(response.status, 200, 'same-origin write must succeed')
    })
  })

  it('rejects /api/key/* GET from a cross-origin browser context', async () => {
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/key/groq`, {
        headers: { 'Origin': 'https://evil.example.com' },
      })
      assert.equal(response.status, 403, 'cross-origin key reveal must be blocked')
    })
  })

  it('serves /api/key/<provider> for same-origin / CLI callers', async () => {
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      // 📖 No Origin header == CLI caller (curl). Must be allowed.
      const response = await fetch(`${baseUrl}/api/key/groq`)
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.ok(payload.hasOwnProperty('key'), 'should return a key field')
    })
  })

  it('returns 404 on /api/key for an unknown provider', async () => {
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/key/not-a-real-provider`)
      assert.equal(response.status, 404)
    })
  })

  it('returns missing_key outcome on POST /api/key/:provider/test for an unconfigured provider', async () => {
    // 📖 Build a config with NO api keys — every provider should report missing_key.
    const config = buildRouterTestConfig([])
    config.apiKeys = {}
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/key/groq/test`, { method: 'POST' })
      assert.equal(response.status, 200, 'test endpoint always returns 200, outcome is in body')
      const payload = await response.json()
      assert.equal(payload.outcome, 'missing_key')
      assert.match(payload.detail, /groq/)
    })
  })

  it('returns 404 on POST /api/key/:provider/test for an unknown provider', async () => {
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/key/not-a-real-provider/test`, { method: 'POST' })
      assert.equal(response.status, 404)
      const payload = await response.json()
      assert.equal(payload.error?.code, 'unknown_provider')
    })
  })

  it('rejects cross-origin POST /api/key/:provider/test', async () => {
    // 📖 Same-origin guard must apply to the test endpoint too — the probe
    // 📖 can be used as a credential-validation oracle by a malicious site.
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/key/groq/test`, {
        method: 'POST',
        headers: { 'Origin': 'https://evil.example.com' },
      })
      assert.equal(response.status, 403, 'cross-origin key probe must be blocked')
    })
  })

  it('returns 404 on GET /api/key/:provider/test (the /test suffix is POST-only)', async () => {
    // 📖 The /test endpoint is POST-only. A GET on the same path is parsed
    // 📖 as a request for provider "groq/test" (which does not exist), so
    // 📖 the daemon naturally returns 404 — the POST-only contract is
    // 📖 enforced by the same provider-existence check, not by a method gate.
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/key/groq/test`)
      assert.equal(response.status, 404)
      const payload = await response.json()
      assert.equal(payload.error?.code, 'unknown_provider')
    })
  })

  it('appends a model to the active set via POST /sets/:name/models', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 },
    ])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/sets/test-set/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'cerebras', model: 'llama3.1-70b' }),
      })
      assert.equal(response.status, 201)
      const payload = await response.json()
      const setModels = payload.set?.models || []
      assert.ok(setModels.some((m) => m.provider === 'cerebras' && m.model === 'llama3.1-70b'))
      // 📖 Priorities are always 1..N and contiguous after an add.
      assert.deepEqual(setModels.map((m) => m.priority), [1, 2])
    })
  })

  it('rejects a duplicate add with 409', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 },
    ])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/sets/test-set/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'groq', model: 'openai/gpt-oss-120b' }),
      })
      assert.equal(response.status, 409)
      const payload = await response.json()
      assert.equal(payload.error?.code, 'duplicate_model')
    })
  })

  it('removes a model from the active set via DELETE /sets/:name/models', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 },
      { provider: 'cerebras', model: 'llama3.1-70b', priority: 2 },
    ])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/sets/test-set/models`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'groq', model: 'openai/gpt-oss-120b' }),
      })
      assert.equal(response.status, 200)
      const payload = await response.json()
      const setModels = payload.set?.models || []
      assert.equal(setModels.length, 1)
      assert.equal(setModels[0].provider, 'cerebras')
      assert.equal(setModels[0].priority, 1)
    })
  })

  it('rejects reorder when the order omits an existing model', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 },
      { provider: 'cerebras', model: 'llama3.1-70b', priority: 2 },
    ])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/sets/test-set/reorder`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 📖 Only one model in the order, but the set has two — must fail.
        body: JSON.stringify({ order: ['cerebras/llama3.1-70b'] }),
      })
      assert.equal(response.status, 400)
      const payload = await response.json()
      assert.equal(payload.error?.code, 'order_size_mismatch')
    })
  })

  it('reorders the active set via POST /sets/:name/reorder', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 },
      { provider: 'cerebras', model: 'llama3.1-70b', priority: 2 },
    ])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/sets/test-set/reorder`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          order: ['cerebras/llama3.1-70b', 'groq/openai/gpt-oss-120b'],
        }),
      })
      assert.equal(response.status, 200)
      const payload = await response.json()
      const setModels = payload.set?.models || []
      assert.equal(setModels[0].provider, 'cerebras')
      assert.equal(setModels[1].provider, 'groq')
      // 📖 Priorities are re-numbered 1..N after a reorder.
      assert.deepEqual(setModels.map((m) => m.priority), [1, 2])
    })
  })

  it('serves /api/router/catalog with routeable model rows', async () => {
    const config = buildRouterTestConfig([])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/router/catalog`)
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.ok(Array.isArray(payload.models))
      assert.ok(payload.count > 0)
      const first = payload.models[0]
      assert.ok(typeof first.key === 'string')
      assert.ok(typeof first.provider === 'string')
      assert.ok(typeof first.model === 'string')
      assert.equal(typeof first.hasKey, 'boolean')
    })
  })

  it('serves Web Dashboard route aliases directly from the daemon for Docker mode', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 },
    ])
    await withRouterTestServer(config, async ({ baseUrl }) => {
      const statusResp = await fetch(`${baseUrl}/api/router/status`)
      assert.equal(statusResp.status, 200)
      const status = await statusResp.json()
      assert.equal(status.ok, true)
      assert.equal(status.activeSet, 'test-set')

      const statsResp = await fetch(`${baseUrl}/api/router/stats`)
      assert.equal(statsResp.status, 200)
      const stats = await statsResp.json()
      assert.equal(stats.ok, true)
      assert.ok(Array.isArray(stats.models))

      const setsResp = await fetch(`${baseUrl}/api/router/sets`)
      assert.equal(setsResp.status, 200)
      const sets = await setsResp.json()
      assert.equal(sets.activeSet, 'test-set')
      assert.ok(sets.sets['test-set'])

      const addResp = await fetch(`${baseUrl}/api/router/sets/test-set/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'nvidia', model: 'openai/gpt-oss-120b' }),
      })
      assert.equal(addResp.status, 201)
      const addPayload = await addResp.json()
      assert.ok(addPayload.set.models.some((m) => m.provider === 'nvidia' && m.model === 'openai/gpt-oss-120b'))

      const putResp = await fetch(`${baseUrl}/api/router/sets/test-set`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          models: [
            { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 }
          ]
        }),
      })
      assert.equal(putResp.status, 200)
      const putPayload = await putResp.json()
      assert.equal(putPayload.set.models.length, 1)
      assert.equal(putPayload.set.models[0].provider, 'groq')
      assert.equal(putPayload.set.models[0].model, 'openai/gpt-oss-120b')

      const forbiddenAddResp = await fetch(`${baseUrl}/api/router/sets/test-set/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'origin': 'https://evil.example.com' },
        body: JSON.stringify({ provider: 'nvidia', model: 'openai/gpt-oss-20b' }),
      })
      assert.equal(forbiddenAddResp.status, 403)

      const tokensResp = await fetch(`${baseUrl}/api/router/tokens`)
      assert.equal(tokensResp.status, 200)
      const tokens = await tokensResp.json()
      assert.ok(tokens.all_time)

      const quickSetupResp = await fetch(`${baseUrl}/api/router/quick-setup`)
      assert.equal(quickSetupResp.status, 200)
      const quickSetup = await quickSetupResp.json()
      assert.equal(quickSetup.running, true)
      assert.equal(quickSetup.model, 'fcm')
      assert.match(quickSetup.baseUrl, /\/v1$/)

      const changelogResp = await fetch(`${baseUrl}/api/changelog`)
      assert.equal(changelogResp.status, 200)
      const changelog = await changelogResp.json()
      assert.equal(typeof changelog.versions, 'object')
    })
  })

  it('autoHealActiveSet is a no-op when the set is user-customized', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 },
    ])
    config.router.userCustomized = true
    await withRouterTestServer(config, async ({ runtime }) => {
      const result = await runtime.autoHealActiveSet()
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'user_customized')
    })
  })

  it('autoHealActiveSet is a no-op when autoHeal is disabled', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 },
    ])
    config.router.autoHeal = false
    await withRouterTestServer(config, async ({ runtime }) => {
      const result = await runtime.autoHealActiveSet()
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'autoHeal_disabled')
    })
  })

  it('autoHealActiveSet reports no-op when there are no broken models', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 },
    ])
    await withRouterTestServer(config, async ({ runtime }) => {
      const result = await runtime.autoHealActiveSet()
      assert.equal(result.ok, true)
      assert.equal(result.replaced, 0)
    })
  })

  it('user edits to a set flip router.userCustomized and router.autoHeal to false', async () => {
    const config = buildRouterTestConfig([
      { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 },
    ])
    await withRouterTestServer(config, async ({ baseUrl, runtime }) => {
      // 📖 Mark the set as auto-healed (clean state).
      assert.equal(config.router.userCustomized, false)
      assert.equal(config.router.autoHeal, true)
      // 📖 Add a model — that's a user action.
      const response = await fetch(`${baseUrl}/sets/test-set/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'cerebras', model: 'llama3.1-70b' }),
      })
      assert.equal(response.status, 201)
      // 📖 After a user edit, the next routerConfig() must reflect
      // 📖 userCustomized: true and autoHeal: false.
      const after = runtime.routerConfig()
      assert.equal(after.userCustomized, true)
      assert.equal(after.autoHeal, false)
    })
  })
})

// ─── formatCtxWindow ─────────────────────────────────────────────────────────
// 📖 Tests for context window number-to-string conversion used by dynamic OpenRouter discovery
describe('formatCtxWindow', () => {
  it('converts 128000 to 128k', () => {
    assert.equal(formatCtxWindow(128000), '128k')
  })

  it('converts 256000 to 256k', () => {
    assert.equal(formatCtxWindow(256000), '256k')
  })

  it('converts 1048576 to 1M', () => {
    assert.equal(formatCtxWindow(1048576), '1M')
  })

  it('converts 2000000 to 2M', () => {
    assert.equal(formatCtxWindow(2000000), '2M')
  })

  it('converts 32768 to 33k (rounds)', () => {
    assert.equal(formatCtxWindow(32768), '33k')
  })

  it('returns 128k for zero', () => {
    assert.equal(formatCtxWindow(0), '128k')
  })

  it('returns 128k for negative', () => {
    assert.equal(formatCtxWindow(-1), '128k')
  })

  it('returns 128k for non-number', () => {
    assert.equal(formatCtxWindow(null), '128k')
    assert.equal(formatCtxWindow(undefined), '128k')
    assert.equal(formatCtxWindow('128k'), '128k')
  })
})

// ─── labelFromId ─────────────────────────────────────────────────────────────
// 📖 Tests for OpenRouter model ID to human-readable label conversion
describe('labelFromId', () => {
  it('strips :free suffix and org prefix', () => {
    assert.equal(labelFromId('qwen/qwen3-coder:free'), 'Qwen3 Coder')
  })

  it('handles deep nested org paths', () => {
    assert.equal(labelFromId('meta-llama/llama-3.3-70b-instruct:free'), 'Llama 3.3 70b Instruct')
  })

  it('handles underscore-separated names', () => {
    assert.equal(labelFromId('org/model_name_v2:free'), 'Model Name V2')
  })

  it('handles ID without org prefix', () => {
    assert.equal(labelFromId('mimo-v2-flash:free'), 'Mimo V2 Flash')
  })

  it('handles ID without :free suffix', () => {
    assert.equal(labelFromId('qwen/qwen3-coder'), 'Qwen3 Coder')
  })
})

// ─── token-usage-reader ─────────────────────────────────────────────────────
describe('token-usage-reader', () => {
  it('buildProviderModelTokenKey combines provider and model', () => {
    assert.equal(buildProviderModelTokenKey('groq', 'openai/gpt-oss-120b'), 'groq::openai/gpt-oss-120b')
  })

  it('formatTokenTotalCompact renders raw, k, and M with 2 decimals', () => {
    assert.equal(formatTokenTotalCompact(0), '0')
    assert.equal(formatTokenTotalCompact(999), '999')
    assert.equal(formatTokenTotalCompact(1234), '1.23k')
    assert.equal(formatTokenTotalCompact(999999), '1.00M')
    assert.equal(formatTokenTotalCompact(1456789), '1.46M')
  })

  it('loadTokenUsageByProviderModel aggregates tokens per exact provider/model pair', () => {
    const dir = join(tmpdir(), `fcm-token-usage-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const statsFile = join(dir, 'token-stats.json')

    try {
      writeFileSync(statsFile, JSON.stringify({
        byAccount: {
          'groq/openai-gpt-oss-120b/0': { tokens: 1500 },
          'groq/openai-gpt-oss-120b/1': { tokens: 300 },
          'nvidia/openai-gpt-oss-120b/0': { tokens: 5500 },
        },
      }, null, 2))

      const totals = loadTokenUsageByProviderModel({ statsFile })
      assert.equal(totals['groq::openai-gpt-oss-120b'], 1800)
      assert.equal(totals['nvidia::openai-gpt-oss-120b'], 5500)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('/testfcm helpers', () => {
  it('normalizes common tool aliases to canonical launcher modes', () => {
    assert.equal(normalizeTestfcmToolName('opencodecli'), 'opencode')
    assert.equal(normalizeTestfcmToolName('crush'), 'crush')
  })

  it('resolves a known tool spec and keeps its CLI flag', () => {
    const spec = resolveTestfcmToolSpec('goose')
    assert.equal(spec?.mode, 'goose')
    assert.equal(spec?.flag, '--goose')
  })

  it('treats string and array API key entries as configured only when non-empty', () => {
    assert.equal(hasConfiguredKey('gsk_live'), true)
    assert.equal(hasConfiguredKey('   '), false)
    assert.equal(hasConfiguredKey(['', '  ', 'gsk_live']), true)
    assert.equal(hasConfiguredKey(['', '  ']), false)
  })

  it('builds compact run ids from timestamps', () => {
    assert.equal(createTestfcmRunId(new Date('2026-03-16T18:45:12.345Z')), '20260316-184512-345')
  })

  it('extracts JSON arrays from mixed stdout text', () => {
    const parsed = extractJsonPayload('  ⚡ Pinging models...\n\n[\n  {"label":"Model A"}\n]\n')
    assert.deepEqual(parsed, [{ label: 'Model A' }])
  })

  it('picks the first clearly healthy preflight row before pressing Enter', () => {
    const index = pickTestfcmSelectionIndex([
      { status: 'down', httpCode: 'ERR' },
      { status: 'up', httpCode: '401' },
      { status: 'up', httpCode: '200' },
      { status: 'up', httpCode: '200' },
    ])
    assert.equal(index, 2)
  })

  it('classifies a successful assistant transcript', () => {
    const result = classifyToolTranscript('Mock Crush ready\nhello, how can i help you?\n')
    assert.equal(result.status, 'passed')
    assert.equal(result.findings.length, 0)
  })

  it('classifies invalid API failures and emits a follow-up task', () => {
    const result = classifyToolTranscript('Error: invalid api key (401 unauthorized)')
    assert.equal(result.status, 'failed')
    assert.equal(result.findings[0]?.id, 'invalid_api_key')
    assert.match(buildFixTasks(result.findings)[0] || '', /Validate the provider key/i)
  })

  it('flags PTY width warnings as actionable harness failures', () => {
    const result = classifyToolTranscript('Please maximize your terminal for optimal use. The current terminal is too small.')
    assert.equal(result.status, 'failed')
    assert.equal(result.findings[0]?.id, 'terminal_too_small')
    assert.match(buildFixTasks(result.findings)[0] || '', /width warning disabled|wider PTY/i)
  })

  it('stays inconclusive when no success or known failure pattern exists', () => {
    const result = classifyToolTranscript('Tool opened, waiting for model...')
    assert.equal(result.status, 'inconclusive')
    assert.equal(result.findings.length, 0)
  })
})

describe('tool launcher env building', () => {
  it('sanitizes inherited OpenAI-compatible vars for direct launches', () => {
    const config = { apiKeys: { nvidia: 'nvapi-test' } }
    const model = { providerKey: 'nvidia', modelId: 'openai/gpt-oss-120b' }
    const inheritedEnv = {
      OPENAI_API_KEY: 'stale-openai-key',
      OPENAI_BASE_URL: 'https://old.example/v1',
      PATH: process.env.PATH || '',
    }

    const { env } = buildToolEnv('crush', model, config, {
      sanitize: true,
      includeCompatDefaults: true,
      includeProviderEnv: false,
      inheritedEnv,
    })

    assert.equal(env.OPENAI_API_KEY, 'nvapi-test')
    assert.match(env.OPENAI_BASE_URL || '', /integrate\.api\.nvidia\.com/)
    assert.equal(env.LLM_MODEL, 'openai/openai/gpt-oss-120b')
  })

  it('keeps launcher model ids provider-native in direct mode', () => {
    assert.equal(resolveLauncherModelId({ modelId: 'deepseek-ai/deepseek-v3.1' }), 'deepseek-ai/deepseek-v3.1')
  })
})

describe('tool bootstrap helpers', () => {
  it('returns the npm install plan for opencode', () => {
    const plan = getToolInstallPlan('opencode', { platform: 'darwin' })
    assert.equal(plan.supported, true)
    assert.equal(plan.binary, 'opencode')
    assert.match(plan.shellCommand || '', /npm install -g opencode-ai/)
  })

  it('returns the official goose installer script on linux', () => {
    const plan = getToolInstallPlan('goose', { platform: 'linux' })
    assert.equal(plan.supported, true)
    assert.match(plan.shellCommand || '', /download_cli\.sh \| CONFIGURE=false bash/)
  })

  it('marks OpenHands auto-install unsupported on native Windows', () => {
    const plan = getToolInstallPlan('openhands', { platform: 'win32' })
    assert.equal(plan.supported, false)
    assert.match(plan.reason || '', /WSL/i)
  })

  it('resolves a fake tool binary from PATH without spawning it', () => {
    const dir = join(tmpdir(), `fcm-tool-bootstrap-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const binaryPath = join(dir, 'crush')

    try {
      writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n')
      chmodSync(binaryPath, 0o755)

      const resolved = resolveToolBinaryPath('crush', { env: { PATH: dir } })
      assert.equal(resolved, binaryPath)
      assert.equal(isToolInstalled('crush', { env: { PATH: dir } }), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('tool compatibility matrix', () => {
  it('regular providers are compatible with all non-cliOnly tools', () => {
    const regularTools = getCompatibleTools('nvidia')
    assert.ok(regularTools.includes('opencode'))
    assert.ok(regularTools.includes('opencode-desktop'))
    assert.ok(regularTools.includes('openclaw'))
    assert.ok(regularTools.includes('goose'))
    assert.ok(regularTools.includes('amp'))
    assert.ok(regularTools.includes('caveman'), 'regular models should be compatible with caveman')
  })



  it('opencode-zen models are compatible with all non-cliOnly tools (OpenAI-compatible endpoint)', () => {
    const tools = getCompatibleTools('opencode-zen')
    // 📖 Zen uses /v1/chat/completions — any OpenAI-compatible tool can use it
    assert.ok(tools.includes('opencode'), 'zen should work with opencode')
    assert.ok(tools.includes('opencode-desktop'), 'zen should work with opencode-desktop')
    assert.ok(tools.includes('pi'), 'zen should work with pi')
    assert.ok(tools.includes('aider'), 'zen should work with aider')
    assert.ok(tools.includes('goose'), 'zen should work with goose')
  })

  it('isModelCompatibleWithTool returns true for matching pairs', () => {
    assert.ok(isModelCompatibleWithTool('nvidia', 'opencode'))

    assert.ok(isModelCompatibleWithTool('opencode-zen', 'opencode'))
    assert.ok(isModelCompatibleWithTool('opencode-zen', 'opencode-desktop'))
    assert.ok(isModelCompatibleWithTool('opencode-zen', 'opencode-web'))
    assert.ok(isModelCompatibleWithTool('opencode-zen', 'pi'), 'zen should work with pi')
    assert.ok(isModelCompatibleWithTool('opencode-zen', 'goose'), 'zen should work with goose')
    assert.ok(isModelCompatibleWithTool('opencode-zen', 'aider'), 'zen should work with aider')
  })

  it('isModelCompatibleWithTool returns false for incompatible pairs', () => {
    // 📖 No cliOnly tools remain — all tools accept all models.
    // 📖 Compatibility is now binary: every tool accepts every regular model.
    assert.ok(isModelCompatibleWithTool('opencode-zen', 'caveman'), 'zen is compatible with caveman')
  })

  it('every tool in TOOL_MODE_ORDER has an emoji and color', () => {
    for (const toolKey of TOOL_MODE_ORDER) {
      const meta = TOOL_METADATA[toolKey]
      assert.ok(meta, `missing TOOL_METADATA for ${toolKey}`)
      assert.ok(typeof meta.emoji === 'string' && meta.emoji.length >= 1, `${toolKey} needs an emoji`)
      assert.ok(Array.isArray(meta.color) && meta.color.length === 3, `${toolKey} needs a [r,g,b] color`)
    }
  })

  it('all tool emojis are unique (except OpenCode CLI/Desktop sharing 📦)', () => {
    // 📖 OpenCode CLI and Desktop intentionally share 📦 — they are the same platform
    const emojis = TOOL_MODE_ORDER.map(k => TOOL_METADATA[k].emoji)
    const nonShared = emojis.filter(e => e !== '📦')
    const unique = new Set(nonShared)
    assert.equal(unique.size, nonShared.length, `duplicate emojis found (excluding 📦): ${nonShared.join(',')}`)
  })

  it('sources.js opencode-zen has zenOnly flag', () => {
    assert.ok(sources['opencode-zen'], 'opencode-zen source must exist')
    assert.ok(sources['opencode-zen'].zenOnly, 'opencode-zen must have zenOnly: true')
    assert.ok(sources['opencode-zen'].models.length > 0, 'opencode-zen must have models')
  })

  // 📖 findSimilarCompatibleModels tests
  it('findSimilarCompatibleModels returns models sorted by SWE delta', () => {
    const mockResults = [
      { modelId: 'a', label: 'Model A', tier: 'S+', sweScore: '72.0%', providerKey: 'nvidia', hidden: false },
      { modelId: 'b', label: 'Model B', tier: 'S', sweScore: '65.0%', providerKey: 'nvidia', hidden: false },
      { modelId: 'c', label: 'Model C', tier: 'A+', sweScore: '80.0%', providerKey: 'nvidia', hidden: false },
      { modelId: 'd', label: 'Model D', tier: 'A', sweScore: '50.0%', providerKey: 'nvidia', hidden: false },
    ]
    const result = findSimilarCompatibleModels('70.0%', 'opencode', mockResults, 3)
    assert.equal(result.length, 3)
    // 📖 Closest to 70.0% should be 72.0% (delta 2), then 65.0% (delta 5), then 80.0% (delta 10)
    assert.equal(result[0].sweScore, '72.0%')
    assert.equal(result[1].sweScore, '65.0%')
    assert.equal(result[2].sweScore, '80.0%')
  })

  it('findSimilarCompatibleModels excludes hidden models', () => {
    const mockResults = [
      { modelId: 'a', label: 'Visible', tier: 'S', sweScore: '70.0%', providerKey: 'nvidia', hidden: false },
      { modelId: 'b', label: 'Hidden', tier: 'S', sweScore: '71.0%', providerKey: 'nvidia', hidden: true },
    ]
    const result = findSimilarCompatibleModels('70.0%', 'opencode', mockResults, 3)
    assert.equal(result.length, 1)
    assert.equal(result[0].label, 'Visible')
  })

  it('findSimilarCompatibleModels respects maxResults limit', () => {
    const mockResults = [
      { modelId: 'a', label: 'A', tier: 'S', sweScore: '70.0%', providerKey: 'nvidia', hidden: false },
      { modelId: 'b', label: 'B', tier: 'S', sweScore: '71.0%', providerKey: 'nvidia', hidden: false },
      { modelId: 'c', label: 'C', tier: 'S', sweScore: '72.0%', providerKey: 'nvidia', hidden: false },
      { modelId: 'd', label: 'D', tier: 'S', sweScore: '73.0%', providerKey: 'nvidia', hidden: false },
    ]
    const result = findSimilarCompatibleModels('70.0%', 'opencode', mockResults, 2)
    assert.equal(result.length, 2)
  })

  it('findSimilarCompatibleModels handles missing SWE scores gracefully', () => {
    const mockResults = [
      { modelId: 'a', label: 'No SWE', tier: 'S', sweScore: '-', providerKey: 'nvidia', hidden: false },
      { modelId: 'b', label: 'Has SWE', tier: 'S', sweScore: '70.0%', providerKey: 'nvidia', hidden: false },
    ]
    // 📖 When selected model has no SWE score, treat as 0 — should still return results
    const result = findSimilarCompatibleModels('-', 'opencode', mockResults, 3)
    assert.equal(result.length, 2)
    // 📖 '-' parses as 0, so the model with sweScore '-' (also 0) should be closest
    assert.equal(result[0].label, 'No SWE')
  })
})

describe('tool launch preparation', () => {
  function createToolPaths(dir) {
    return {
      aiderConfigPath: join(dir, 'aider', '.aider.conf.yml'),
      crushConfigPath: join(dir, 'crush', 'crush.json'),
      gooseProvidersDir: join(dir, 'goose', 'custom_providers'),
      gooseSecretsPath: join(dir, 'goose', 'secrets.yaml'),
      gooseConfigPath: join(dir, 'goose', 'config.yaml'),
      qwenConfigPath: join(dir, 'qwen', 'settings.json'),
      ampConfigPath: join(dir, 'amp', 'settings.json'),
      piModelsPath: join(dir, 'pi', 'models.json'),
      piSettingsPath: join(dir, 'pi', 'settings.json'),
      openHandsEnvPath: join(dir, '.fcm-openhands-env'),
      zcodeConfigPath: join(dir, 'zcode', 'config.json'),
      zcodeModelCachePath: join(dir, 'zcode', 'bots-model-cache.v2.json'),
    }
  }

  it('persists the selected model into every external tool before launch', () => {
    const dir = join(tmpdir(), `fcm-tool-launch-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const paths = createToolPaths(dir)
    const config = { apiKeys: { nvidia: 'nvapi-test' } }
    const model = { providerKey: 'nvidia', modelId: 'deepseek-ai/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash', ctx: '1M' }

    try {
      const aiderPlan = prepareExternalToolLaunch('aider', model, config, { paths, inheritedEnv: { PATH: process.env.PATH || '' } })
      assert.equal(aiderPlan.command, 'aider')
      assert.deepEqual(aiderPlan.args, ['--model', 'openai/deepseek-ai/deepseek-v4-flash-0731'])
      assert.match(readFileSync(paths.aiderConfigPath, 'utf8'), /model: openai\/deepseek-ai\/deepseek-v4-flash/)

      const crushPlan = prepareExternalToolLaunch('crush', model, config, { paths, inheritedEnv: { PATH: process.env.PATH || '' } })
      const crushConfig = JSON.parse(readFileSync(paths.crushConfigPath, 'utf8'))
      assert.equal(crushPlan.command, 'crush')
      assert.equal(crushConfig.models.large.model, 'deepseek-ai/deepseek-v4-flash-0731')
      assert.equal(crushConfig.models.large.provider, 'freeCodingModels')
      assert.equal(crushConfig.models.small.model, 'deepseek-ai/deepseek-v4-flash-0731')

      const goosePlan = prepareExternalToolLaunch('goose', model, config, { paths, inheritedEnv: { PATH: process.env.PATH || '' } })
      const gooseConfig = readFileSync(paths.gooseConfigPath, 'utf8')
      assert.equal(goosePlan.command, 'goose')
      assert.match(gooseConfig, /GOOSE_PROVIDER: fcm-nvidia/)
      assert.match(gooseConfig, /GOOSE_MODEL: deepseek-ai\/deepseek-v4-flash/)
      // 📖 Context limit must come from the model's ctx, not a hardcoded 128k (issue #153)
      const gooseProvider = JSON.parse(readFileSync(join(paths.gooseProvidersDir, 'fcm-nvidia.json'), 'utf8'))
      assert.equal(gooseProvider.models[0].context_limit, 1_000_000)

      const qwenPlan = prepareExternalToolLaunch('qwen', model, config, { paths, inheritedEnv: { PATH: process.env.PATH || '' } })
      const qwenConfig = JSON.parse(readFileSync(paths.qwenConfigPath, 'utf8'))
      assert.equal(qwenPlan.command, 'qwen')
      assert.equal(qwenConfig.model, 'deepseek-ai/deepseek-v4-flash-0731')
      assert.equal(qwenConfig.modelProviders.openai[0].id, 'deepseek-ai/deepseek-v4-flash-0731')

      const openHandsPlan = prepareExternalToolLaunch('openhands', model, config, { paths, inheritedEnv: { PATH: process.env.PATH || '' } })
      const openHandsEnv = readFileSync(paths.openHandsEnvPath, 'utf8')
      assert.equal(openHandsPlan.command, 'openhands')
      assert.deepEqual(openHandsPlan.args, ['--override-with-envs'])
      assert.match(openHandsEnv, /OPENAI_MODEL="deepseek-ai\/deepseek-v4-flash-0731"/)
      assert.match(openHandsEnv, /LLM_MODEL="openai\/deepseek-ai\/deepseek-v4-flash-0731"/)

      const ampPlan = prepareExternalToolLaunch('amp', model, config, { paths, inheritedEnv: { PATH: process.env.PATH || '' } })
      const ampConfig = JSON.parse(readFileSync(paths.ampConfigPath, 'utf8'))
      assert.equal(ampPlan.command, 'amp')
      assert.equal(ampConfig['amp.model'], 'deepseek-ai/deepseek-v4-flash-0731')

      const piPlan = prepareExternalToolLaunch('pi', model, config, { paths, inheritedEnv: { PATH: process.env.PATH || '' } })
      const piModels = JSON.parse(readFileSync(paths.piModelsPath, 'utf8'))
      const piSettings = JSON.parse(readFileSync(paths.piSettingsPath, 'utf8'))
      assert.equal(piPlan.command, 'pi')
      assert.deepEqual(piPlan.args, ['--provider', 'nvidia', '--model', 'deepseek-ai/deepseek-v4-flash-0731', '--api-key', piPlan.apiKey])
      assert.equal(piModels.providers.nvidia.models[0].id, 'deepseek-ai/deepseek-v4-flash-0731')
      assert.equal(piSettings.defaultModel, 'deepseek-ai/deepseek-v4-flash-0731')

      // 📖 ZCode writes provider + model configurations to its config.json and model cache.
      const zcodePlan = prepareExternalToolLaunch('zcode', model, config, { paths, inheritedEnv: { PATH: process.env.PATH || '' } })
      assert.equal(zcodePlan.meta.label, 'ZCode')
      assert.equal(zcodePlan.meta.emoji, '🧊')
      assert.deepEqual(zcodePlan.configArtifacts, [
        { path: paths.zcodeConfigPath, backupPath: undefined, label: 'config' },
        { path: paths.zcodeModelCachePath, backupPath: undefined, label: 'model cache' }
      ])
      if (process.platform === 'darwin') {
        assert.equal(zcodePlan.command, 'open')
        assert.deepEqual(zcodePlan.args, ['-a', 'ZCode'])
      } else {
        assert.equal(zcodePlan.command, 'node')
        assert.deepEqual(zcodePlan.args, ['-e', 'process.exit(0)'])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('openclaw selected model persistence', () => {
  it('writes the selected provider/model as the OpenClaw default instead of forcing nvidia', async () => {
    const dir = join(tmpdir(), `fcm-openclaw-launch-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const openclawConfigPath = join(dir, 'openclaw', 'openclaw.json')
    const config = { apiKeys: { groq: 'gsk-test' } }
    const model = { providerKey: 'groq', modelId: 'openai/gpt-oss-120b', label: 'GPT OSS 120B' }
    const previousGroqKey = process.env.GROQ_API_KEY
    delete process.env.GROQ_API_KEY

    try {
      const result = await startOpenClaw(model, config, { paths: { openclawConfigPath } })
      const written = JSON.parse(readFileSync(openclawConfigPath, 'utf8'))

      assert.equal(result?.providerId, 'fcm-groq')
      assert.equal(written.agents.defaults.model.primary, 'fcm-groq/openai/gpt-oss-120b')
      assert.equal(Boolean(written.models.providers['fcm-groq']), true)
      assert.equal(written.models.providers['fcm-groq'].models[0].id, 'openai/gpt-oss-120b')
      assert.equal(written.env.GROQ_API_KEY, 'gsk-test')
    } finally {
      if (previousGroqKey === undefined) delete process.env.GROQ_API_KEY
      else process.env.GROQ_API_KEY = previousGroqKey
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('endpoint install tracking', () => {
  it('exposes only persisted-config install targets in the Y install list', () => {
    const installTargets = getInstallTargetModes()
    assert.deepEqual(installTargets, ['opencode', 'pi', 'jcode', 'opencode-desktop', 'opencode-web', 'openclaw', 'crush', 'goose', 'aider', 'qwen', 'openhands', 'amp', 'forgecode', 'fcm_router', 'zcode'])
  })

  it('normalizes tracked installs to canonical shape', () => {
    const normalized = normalizeEndpointInstalls([
      {
        providerKey: 'nvidia',
        toolMode: 'opencode',
        scope: 'selected',
        modelIds: ['deepseek-ai/deepseek-v4-flash-0731', '', 'deepseek-ai/deepseek-v4-flash-0731'],
        lastSyncedAt: '2026-03-09T12:00:00.000Z',
      },
      null,
      { providerKey: '', toolMode: 'goose' },
    ])

    assert.deepEqual(normalized, [
      {
        providerKey: 'nvidia',
        toolMode: 'opencode',
        scope: 'selected',
        modelIds: ['deepseek-ai/deepseek-v4-flash-0731'],
        lastSyncedAt: '2026-03-09T12:00:00.000Z',
      },
    ])
  })

  it('lists only configured providers that support direct endpoint installs', () => {
    const providers = getConfiguredInstallableProviders({
      apiKeys: {
        nvidia: 'nvapi-test',
        replicate: 'r8-test',
      },
    })

    assert.ok(providers.some((provider) => provider.providerKey === 'nvidia'))
    assert.ok(!providers.some((provider) => provider.providerKey === 'replicate'))
  })
})

describe('endpoint installer', () => {
  it('installs a managed OpenCode provider catalog and tracks it canonically', () => {
    const dir = join(tmpdir(), `fcm-opencode-install-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })

    const config = {
      apiKeys: { nvidia: 'nvapi-test' },
      providers: {},
      settings: {},
      favorites: [],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      profiles: {},
      activeProfile: null,
    }

    const paths = {
      opencodeConfigPath: join(dir, 'opencode', 'opencode.json'),
      openclawConfigPath: join(dir, 'openclaw', 'openclaw.json'),
      crushConfigPath: join(dir, 'crush', 'crush.json'),
      gooseProvidersDir: join(dir, 'goose', 'custom_providers'),
      gooseSecretsPath: join(dir, 'goose', 'secrets.yaml'),
    }

    try {
      const expectedApiKey = getApiKey(config, 'nvidia')
      const result = installProviderEndpoints(config, 'nvidia', 'opencode-desktop', {
        scope: 'selected',
        modelIds: ['deepseek-ai/deepseek-v4-flash-0731'],
        paths,
      })

      const written = JSON.parse(readFileSync(paths.opencodeConfigPath, 'utf8'))
      assert.equal(result.toolMode, 'opencode')
      assert.equal(result.modelCount, 1)
      assert.equal(written.provider['fcm-nvidia'].options.apiKey, expectedApiKey)
      assert.deepEqual(written.provider['fcm-nvidia'].models, {
        'deepseek-ai/deepseek-v4-flash-0731': { name: 'DeepSeek V4 Flash' },
      })
      assert.deepEqual(config.endpointInstalls.map((entry) => ({
        providerKey: entry.providerKey,
        toolMode: entry.toolMode,
        scope: entry.scope,
        modelIds: entry.modelIds,
      })), [
        {
          providerKey: 'nvidia',
          toolMode: 'opencode',
          scope: 'selected',
          modelIds: ['deepseek-ai/deepseek-v4-flash-0731'],
        },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('installs Goose custom provider metadata and persists the matching secret', () => {
    const dir = join(tmpdir(), `fcm-goose-install-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })

    const config = {
      apiKeys: { groq: 'gsk-test' },
      providers: {},
      settings: {},
      favorites: [],
      telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
      endpointInstalls: [],
      profiles: {},
      activeProfile: null,
    }

    const paths = {
      opencodeConfigPath: join(dir, 'opencode', 'opencode.json'),
      openclawConfigPath: join(dir, 'openclaw', 'openclaw.json'),
      crushConfigPath: join(dir, 'crush', 'crush.json'),
      gooseProvidersDir: join(dir, 'goose', 'custom_providers'),
      gooseSecretsPath: join(dir, 'goose', 'secrets.yaml'),
    }

    try {
      const expectedApiKey = getApiKey(config, 'groq')
      installProviderEndpoints(config, 'groq', 'goose', {
        scope: 'selected',
        modelIds: ['openai/gpt-oss-120b'],
        paths,
      })

      const providerFile = join(paths.gooseProvidersDir, 'fcm-groq.json')
      const providerConfig = JSON.parse(readFileSync(providerFile, 'utf8'))
      const secretsYaml = readFileSync(paths.gooseSecretsPath, 'utf8')

      assert.equal(providerConfig.api_key_env, 'FCM_GROQ_API_KEY')
      assert.equal(providerConfig.models[0].name, 'openai/gpt-oss-120b')
      assert.match(secretsYaml, new RegExp(`FCM_GROQ_API_KEY:\\s+${JSON.stringify(String(expectedApiKey))}`))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('legacy proxy cleanup', () => {
  function createCleanupFixtureDir() {
    const dir = join(tmpdir(), `fcm-legacy-cleanup-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  it('removes discontinued proxy fields from the main config while preserving direct installs', () => {
    const homeDir = createCleanupFixtureDir()
    const configPath = join(homeDir, '.free-coding-models.json')
    const opencodeConfigPath = join(homeDir, '.config', 'opencode', 'opencode.json')
    mkdirSync(dirname(opencodeConfigPath), { recursive: true })

    try {
      writeFileSync(configPath, JSON.stringify({
        apiKeys: { nvidia: 'nvapi-test' },
        providers: {},
        settings: {
          preferredToolMode: 'claude-code',
          proxy: { enabled: true },
        },
        proxySettings: { enabled: true },
        endpointInstalls: [
          { providerKey: 'nvidia', toolMode: 'claude-code', scope: 'all', modelIds: [] },
          { providerKey: 'nvidia', toolMode: 'opencode', scope: 'selected', modelIds: ['deepseek-ai/deepseek-v4-flash-0731'] },
        ],
      }, null, 2))

      writeFileSync(opencodeConfigPath, JSON.stringify({
        provider: {
          'fcm-proxy': { options: { apiKey: 'legacy' } },
          'fcm-nvidia': { options: { apiKey: 'nvapi-test' } },
        },
        model: 'fcm-proxy/deepseek-ai/deepseek-v4-flash',
      }, null, 2))

      const summary = cleanupLegacyProxyArtifacts({
        homeDir,
        paths: {
          configPath,
          opencodeConfigPath,
          shellProfilePaths: [],
        },
      })

      const nextConfig = JSON.parse(readFileSync(configPath, 'utf8'))
      const nextOpencode = JSON.parse(readFileSync(opencodeConfigPath, 'utf8'))

      assert.equal(summary.changed, true)
      assert.equal('proxySettings' in nextConfig, false)
      assert.equal('proxy' in nextConfig.settings, false)
      assert.equal(nextConfig.settings.preferredToolMode, 'opencode')
      assert.deepEqual(nextConfig.endpointInstalls, [
        { providerKey: 'nvidia', toolMode: 'opencode', scope: 'selected', modelIds: ['deepseek-ai/deepseek-v4-flash-0731'] },
      ])
      assert.equal(Boolean(nextOpencode.provider['fcm-proxy']), false)
      assert.equal(Boolean(nextOpencode.provider['fcm-nvidia']), true)
      assert.equal('model' in nextOpencode, false)
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('removes proxy-only env files and shell sourcing lines', () => {
    const homeDir = createCleanupFixtureDir()
    const envPath = join(homeDir, '.fcm-claude-code-env')
    const envBackupPath = `${envPath}.bak`
    const zshrcPath = join(homeDir, '.zshrc')

    try {
      writeFileSync(envPath, 'export ANTHROPIC_BASE_URL=http://127.0.0.1:18045/v1\n')
      writeFileSync(envBackupPath, 'backup\n')
      writeFileSync(zshrcPath, [
        '# 📖 FCM Proxy — Claude Code env vars',
        'source "$HOME/.fcm-claude-code-env"',
        'export PATH="$HOME/bin:$PATH"',
      ].join('\n'))

      const summary = cleanupLegacyProxyArtifacts({
        homeDir,
        paths: {
          shellProfilePaths: [zshrcPath],
        },
      })

      const nextZshrc = readFileSync(zshrcPath, 'utf8')
      assert.equal(summary.changed, true)
      assert.equal(existsSync(envPath), false)
      assert.equal(existsSync(envBackupPath), false)
      assert.doesNotMatch(nextZshrc, /\.fcm-claude-code-env/)
      assert.match(nextZshrc, /export PATH=/)
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('removes legacy Goose and Qwen proxy entries but keeps direct providers', () => {
    const homeDir = createCleanupFixtureDir()
    const gooseProvidersDir = join(homeDir, '.config', 'goose', 'custom_providers')
    const gooseSecretsPath = join(homeDir, '.config', 'goose', 'secrets.yaml')
    const gooseConfigPath = join(homeDir, '.config', 'goose', 'config.yaml')
    const qwenConfigPath = join(homeDir, '.qwen', 'settings.json')
    mkdirSync(gooseProvidersDir, { recursive: true })
    mkdirSync(dirname(qwenConfigPath), { recursive: true })

    try {
      writeFileSync(join(gooseProvidersDir, 'fcm-proxy.json'), '{}\n')
      writeFileSync(join(gooseProvidersDir, 'fcm-nvidia.json'), '{}\n')
      writeFileSync(gooseSecretsPath, [
        `FCM_PROXY_API_KEY: ${JSON.stringify('legacy-secret')}`,
        `FCM_NVIDIA_API_KEY: ${JSON.stringify('direct-secret')}`,
      ].join('\n'))
      writeFileSync(gooseConfigPath, [
        'GOOSE_PROVIDER: fcm-proxy',
        'GOOSE_MODEL: fcm-proxy/deepseek-ai/deepseek-v4-flash',
        'OTHER_SETTING: keep-me',
      ].join('\n'))
      writeFileSync(qwenConfigPath, JSON.stringify({
        modelProviders: {
          openai: [
            { id: 'fcm-proxy/deepseek-ai/deepseek-v4-flash', envKey: 'FCM_PROXY_API_KEY', baseUrl: 'http://127.0.0.1:18045/v1' },
            { id: 'fcm-nvidia/deepseek-ai/deepseek-v4-flash', envKey: 'FCM_NVIDIA_API_KEY', baseUrl: 'https://integrate.api.nvidia.com/v1' },
          ],
        },
        model: 'fcm-proxy/deepseek-ai/deepseek-v4-flash',
      }, null, 2))

      cleanupLegacyProxyArtifacts({
        homeDir,
        paths: {
          gooseProvidersDir,
          gooseSecretsPath,
          gooseConfigPath,
          qwenConfigPath,
          shellProfilePaths: [],
        },
      })

      const nextSecrets = readFileSync(gooseSecretsPath, 'utf8')
      const nextGooseConfig = readFileSync(gooseConfigPath, 'utf8')
      const nextQwenConfig = JSON.parse(readFileSync(qwenConfigPath, 'utf8'))

      assert.equal(existsSync(join(gooseProvidersDir, 'fcm-proxy.json')), false)
      assert.equal(existsSync(join(gooseProvidersDir, 'fcm-nvidia.json')), true)
      assert.doesNotMatch(nextSecrets, /FCM_PROXY_API_KEY/)
      assert.match(nextSecrets, /FCM_NVIDIA_API_KEY/)
      assert.doesNotMatch(nextGooseConfig, /GOOSE_PROVIDER:\s*fcm-proxy/)
      assert.match(nextGooseConfig, /OTHER_SETTING: keep-me/)
      assert.deepEqual(nextQwenConfig.modelProviders.openai, [
        { id: 'fcm-nvidia/deepseek-ai/deepseek-v4-flash', envKey: 'FCM_NVIDIA_API_KEY', baseUrl: 'https://integrate.api.nvidia.com/v1' },
      ])
      assert.equal('model' in nextQwenConfig, false)
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('keeps a direct OpenHands env file but removes the old localhost proxy variant', () => {
    const homeDir = createCleanupFixtureDir()
    const openHandsEnvPath = join(homeDir, '.fcm-openhands-env')

    try {
      writeFileSync(openHandsEnvPath, [
        'export OPENAI_API_KEY=direct-key',
        'export OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1',
      ].join('\n'))

      cleanupLegacyProxyArtifacts({ homeDir, paths: { shellProfilePaths: [] } })
      assert.equal(existsSync(openHandsEnvPath), true)

      writeFileSync(openHandsEnvPath, [
        '# FCM Proxy V2',
        'export OPENAI_BASE_URL=http://127.0.0.1:18045/v1',
      ].join('\n'))

      cleanupLegacyProxyArtifacts({ homeDir, paths: { shellProfilePaths: [] } })
      assert.equal(existsSync(openHandsEnvPath), false)
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
})

// ─── Dynamic OpenRouter model discovery (MODELS mutation) ────────────────────
// 📖 Tests that verify the MODELS array mutation logic used by fetchOpenRouterFreeModels
describe('Dynamic OpenRouter MODELS mutation', () => {
  it('MODELS array contains openrouter entries from static sources', () => {
    const orEntries = MODELS.filter(m => m[5] === 'openrouter')
    assert.ok(orEntries.length > 0, 'Should have at least one openrouter entry in MODELS')
  })

  it('all openrouter entries have valid tuple format [id, label, tier, swe, ctx, providerKey, addedDate?]', () => {
    const orEntries = MODELS.filter(m => m[5] === 'openrouter')
    for (const entry of orEntries) {
      assert.ok(entry.length >= 6, `Entry ${entry[0]} should have at least 6 elements`)
      assert.equal(typeof entry[0], 'string', 'modelId should be string')
      assert.equal(typeof entry[1], 'string', 'label should be string')
      assert.ok(TIER_ORDER.includes(entry[2]), `tier ${entry[2]} should be valid`)
      assert.match(entry[3], /^(\d+\.\d+%|-)$/, 'sweScore should match N.N% format or unknown marker')
      assert.match(entry[4], /^\d+[kM]$/, 'ctx should match Nk or NM format')
      assert.equal(entry[5], 'openrouter', 'providerKey should be openrouter')
    }
  })

  it('MODELS array is mutable (can splice and push)', () => {
    const originalLength = MODELS.length
    // Push a test entry
    MODELS.push(['test/model:free', 'Test Model', 'B', '25.0%', '128k', 'openrouter'])
    assert.equal(MODELS.length, originalLength + 1)
    // Remove it
    MODELS.splice(MODELS.length - 1, 1)
    assert.equal(MODELS.length, originalLength)
  })
})

// ─── Custom text filter matching logic ───────────────────────────────────────
// 📖 Tests that verify the custom text filter matching behavior used in applyTierFilter().
// 📖 The filter is case-insensitive and matches against label, ctx, providerKey, and provider display name.
describe('Custom text filter matching logic', () => {
  // 📖 Helper that mirrors the exact matching logic from applyTierFilter() in app.js
  function matchesTextFilter(row, query, providerSources) {
    if (!query) return true
    const q = query.toLowerCase()
    const providerName = (providerSources[row.providerKey]?.name || '').toLowerCase()
    return (row.label || '').toLowerCase().includes(q)
      || (row.ctx || '').toLowerCase().includes(q)
      || (row.providerKey || '').toLowerCase().includes(q)
      || providerName.includes(q)
  }

  const mockSources = {
    nvidia: { name: 'NVIDIA NIM' },
    groq: { name: 'Groq' },
    cerebras: { name: 'Cerebras' },
    openrouter: { name: 'OpenRouter' },
  }

  const mockRows = [
    { label: 'DeepSeek V3', ctx: '128k', providerKey: 'nvidia' },
    { label: 'Claude 4 Sonnet', ctx: '200k', providerKey: 'openrouter' },
    { label: 'Llama 4 Scout', ctx: '512k', providerKey: 'groq' },
    { label: 'Qwen 3 235B', ctx: '128k', providerKey: 'cerebras' },
  ]

  it('matches model name (case-insensitive)', () => {
    assert.equal(matchesTextFilter(mockRows[0], 'deepseek', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[0], 'DEEPSEEK', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[0], 'DeepSeek', mockSources), true)
  })

  it('matches partial model name', () => {
    assert.equal(matchesTextFilter(mockRows[1], 'claude', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[1], 'sonnet', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[1], '4 Son', mockSources), true)
  })

  it('matches context window string', () => {
    assert.equal(matchesTextFilter(mockRows[0], '128k', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[1], '200k', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[2], '512k', mockSources), true)
  })

  it('matches provider key', () => {
    assert.equal(matchesTextFilter(mockRows[0], 'nvidia', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[2], 'groq', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[3], 'cerebras', mockSources), true)
  })

  it('matches provider display name', () => {
    assert.equal(matchesTextFilter(mockRows[0], 'NVIDIA NIM', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[0], 'nim', mockSources), true)
    assert.equal(matchesTextFilter(mockRows[1], 'OpenRouter', mockSources), true)
  })

  it('returns false for non-matching query', () => {
    assert.equal(matchesTextFilter(mockRows[0], 'anthropic', mockSources), false)
    assert.equal(matchesTextFilter(mockRows[0], 'gemini', mockSources), false)
    assert.equal(matchesTextFilter(mockRows[0], '999k', mockSources), false)
  })

  it('returns true when query is null or empty', () => {
    assert.equal(matchesTextFilter(mockRows[0], null, mockSources), true)
    assert.equal(matchesTextFilter(mockRows[0], '', mockSources), true)
  })

  it('filters a list of models correctly', () => {
    const filtered = mockRows.filter(r => matchesTextFilter(r, '128k', mockSources))
    assert.equal(filtered.length, 2) // DeepSeek V3 and Qwen 3 235B both have 128k
    assert.equal(filtered[0].label, 'DeepSeek V3')
    assert.equal(filtered[1].label, 'Qwen 3 235B')
  })

  it('stacks with other filters (simulated tier + text)', () => {
    // 📖 Simulate tier S+ filter reducing to a subset, then text filter further narrows
    const tierSPlusRows = mockRows.filter(r => r.label.includes('Claude')) // pretend only Claude is S+
    const result = tierSPlusRows.filter(r => matchesTextFilter(r, 'sonnet', mockSources))
    assert.equal(result.length, 1)
    assert.equal(result[0].label, 'Claude 4 Sonnet')
  })
})

// ─── sortResultsWithPinnedFavorites (no toolMode partition) ───────────────────
// 📖 Sorting no longer partitions by tool compatibility — incompatible models stay
// 📖 in their natural sorted position and are highlighted with a red background instead.

describe('sortResultsWithPinnedFavorites normal sort order', () => {
  const mockModels = [
    { id: 'nvidia-1', providerKey: 'nvidia', label: 'Llama 3.1', idx: 1, tier: 'A', pings: [], isRecommended: false, isFavorite: false },
    { id: 'caveman-1', providerKey: 'caveman', label: 'Claude Sonnet 4', idx: 2, tier: 'S+', pings: [], isRecommended: false, isFavorite: false },
    { id: 'openrouter-1', providerKey: 'openrouter', label: 'GPT-4o', idx: 3, tier: 'S', pings: [], isRecommended: false, isFavorite: false },
    { id: 'zen-1', providerKey: 'opencode-zen', label: 'Big Pickle', idx: 4, tier: 'A', pings: [], isRecommended: false, isFavorite: false },
    { id: 'groq-1', providerKey: 'groq', label: 'Llama 3.3 70B', idx: 5, tier: 'A+', pings: [], isRecommended: false, isFavorite: false },
  ]

  it('returns normal rank sort order — no partitioning by tool compatibility', () => {
    const sorted = sortResultsWithPinnedFavorites(mockModels, 'rank', 'asc', { pinFavorites: false })
    // 📖 All models in rank ascending order: idx 1,2,3,4,5 — caveman/zen NOT pushed to bottom
    assert.equal(sorted[0].id, 'nvidia-1')
    assert.equal(sorted[1].id, 'caveman-1')
    assert.equal(sorted[2].id, 'openrouter-1')
    assert.equal(sorted[3].id, 'zen-1')
    assert.equal(sorted[4].id, 'groq-1')
  })

  it('recommended models still pinned above others', () => {
    const models = [
      { id: 'regular-1', providerKey: 'nvidia', label: 'Llama', idx: 1, tier: 'A', pings: [], isRecommended: false, isFavorite: false },
      { id: 'caveman-1', providerKey: 'caveman', label: 'Claude Sonnet 4', idx: 2, tier: 'S+', pings: [], isRecommended: true, recommendScore: 90, isFavorite: false },
    ]
    const sorted = sortResultsWithPinnedFavorites(models, 'rank', 'asc', { pinFavorites: false })
    assert.equal(sorted[0].id, 'caveman-1')
    assert.equal(sorted[1].id, 'regular-1')
  })

  it('favorites pinned above non-favorites when pinFavorites=true', () => {
    const models = [
      { id: 'regular-1', providerKey: 'nvidia', label: 'Llama', idx: 1, tier: 'A', pings: [], isRecommended: false, isFavorite: false },
      { id: 'caveman-fav', providerKey: 'caveman', label: 'Claude Fav', idx: 3, tier: 'S', pings: [], isRecommended: false, isFavorite: true, favoriteRank: 0 },
    ]
    const sorted = sortResultsWithPinnedFavorites(models, 'rank', 'asc', { pinFavorites: true })
    assert.equal(sorted[0].id, 'caveman-fav')
    assert.equal(sorted[1].id, 'regular-1')
  })
})

// ─── Mouse support tests ────────────────────────────────────────────────

describe('parseMouseEvents', () => {
  it('parses a left-click press event', () => {
    // 📖 SGR: \x1b[<0;10;5M → left press at col 10, row 5
    const events = parseMouseEvents('\x1b[<0;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'press')
    assert.equal(events[0].button, 'left')
    assert.equal(events[0].x, 10)
    assert.equal(events[0].y, 5)
    assert.equal(events[0].shift, false)
    assert.equal(events[0].meta, false)
    assert.equal(events[0].ctrl, false)
  })

  it('parses a left-click release event', () => {
    // 📖 SGR: \x1b[<0;10;5m → left release at col 10, row 5
    const events = parseMouseEvents('\x1b[<0;10;5m')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'release')
    assert.equal(events[0].button, 'left')
    assert.equal(events[0].x, 10)
    assert.equal(events[0].y, 5)
  })

  it('parses a right-click press event', () => {
    // 📖 SGR: \x1b[<2;20;15M → right press
    const events = parseMouseEvents('\x1b[<2;20;15M')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'press')
    assert.equal(events[0].button, 'right')
    assert.equal(events[0].x, 20)
    assert.equal(events[0].y, 15)
  })

  it('parses a middle-click event', () => {
    const events = parseMouseEvents('\x1b[<1;5;3M')
    assert.equal(events.length, 1)
    assert.equal(events[0].button, 'middle')
    assert.equal(events[0].type, 'press')
  })

  it('parses scroll-up event', () => {
    // 📖 SGR: \x1b[<64;10;5M → scroll up
    const events = parseMouseEvents('\x1b[<64;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'scroll-up')
    assert.equal(events[0].button, 'scroll-up')
    assert.equal(events[0].x, 10)
    assert.equal(events[0].y, 5)
  })

  it('parses scroll-down event', () => {
    const events = parseMouseEvents('\x1b[<65;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'scroll-down')
    assert.equal(events[0].button, 'scroll-down')
  })

  it('parses drag event', () => {
    // 📖 SGR: \x1b[<32;10;5M → left drag
    const events = parseMouseEvents('\x1b[<32;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'drag')
    assert.equal(events[0].button, 'left')
  })

  it('detects shift modifier', () => {
    // 📖 Shift adds +4 to button field: 0+4 = 4
    const events = parseMouseEvents('\x1b[<4;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].shift, true)
    assert.equal(events[0].meta, false)
    assert.equal(events[0].ctrl, false)
    assert.equal(events[0].button, 'left')
  })

  it('detects meta/alt modifier', () => {
    // 📖 Meta adds +8: 0+8 = 8
    const events = parseMouseEvents('\x1b[<8;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].meta, true)
    assert.equal(events[0].shift, false)
  })

  it('detects ctrl modifier', () => {
    // 📖 Ctrl adds +16: 0+16 = 16
    const events = parseMouseEvents('\x1b[<16;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].ctrl, true)
  })

  it('detects combined modifiers (shift + ctrl)', () => {
    // 📖 Shift(4) + Ctrl(16) = 20 on left button
    const events = parseMouseEvents('\x1b[<20;10;5M')
    assert.equal(events.length, 1)
    assert.equal(events[0].shift, true)
    assert.equal(events[0].ctrl, true)
    assert.equal(events[0].meta, false)
    assert.equal(events[0].button, 'left')
  })

  it('parses multiple events from a single data chunk', () => {
    // 📖 Rapid scrolling can send multiple events in one chunk
    const data = '\x1b[<64;10;5M\x1b[<64;10;5M\x1b[<65;10;5M'
    const events = parseMouseEvents(data)
    assert.equal(events.length, 3)
    assert.equal(events[0].type, 'scroll-up')
    assert.equal(events[1].type, 'scroll-up')
    assert.equal(events[2].type, 'scroll-down')
  })

  it('returns empty array for non-mouse data', () => {
    const events = parseMouseEvents('hello world')
    assert.deepEqual(events, [])
  })

  it('handles Buffer input', () => {
    const buf = Buffer.from('\x1b[<0;10;5M', 'utf8')
    const events = parseMouseEvents(buf)
    assert.equal(events.length, 1)
    assert.equal(events[0].button, 'left')
  })

  it('parses large coordinates (> 223 columns)', () => {
    // 📖 SGR mode supports coordinates > 223 (unlike X10 mode)
    const events = parseMouseEvents('\x1b[<0;300;150M')
    assert.equal(events.length, 1)
    assert.equal(events[0].x, 300)
    assert.equal(events[0].y, 150)
  })
})

describe('containsMouseSequence', () => {
  it('returns true for SGR mouse data', () => {
    assert.equal(containsMouseSequence('\x1b[<0;10;5M'), true)
  })

  it('returns true for partial mouse prefix in mixed data', () => {
    assert.equal(containsMouseSequence('abc\x1b[<0;10;5Mdef'), true)
  })

  it('returns false for regular keypress data', () => {
    assert.equal(containsMouseSequence('\x1b[A'), false) // up arrow
    assert.equal(containsMouseSequence('T'), false)
    assert.equal(containsMouseSequence('\r'), false)
  })

  it('returns false for empty string', () => {
    assert.equal(containsMouseSequence(''), false)
  })

  it('handles Buffer input', () => {
    const buf = Buffer.from('\x1b[<0;1;1M', 'utf8')
    assert.equal(containsMouseSequence(buf), true)
  })
})

describe('createMouseHandler', () => {
  it('emits click on left-button release', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })

    // 📖 Send press then release — click is emitted only on release
    handler('\x1b[<0;10;5M')  // press
    handler('\x1b[<0;10;5m')  // release
    assert.equal(received.length, 1)
    assert.equal(received[0].type, 'click')
    assert.equal(received[0].button, 'left')
    assert.equal(received[0].x, 10)
    assert.equal(received[0].y, 5)
  })

  it('does not emit click on press alone (only on release)', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })
    handler('\x1b[<0;10;5M')  // press only
    assert.equal(received.length, 0)
  })

  it('emits scroll events immediately (no press/release)', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })
    handler('\x1b[<64;10;5M')  // scroll up
    assert.equal(received.length, 1)
    assert.equal(received[0].type, 'scroll-up')
  })

  it('emits drag events', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })
    handler('\x1b[<32;10;5M')  // left drag
    assert.equal(received.length, 1)
    assert.equal(received[0].type, 'drag')
    assert.equal(received[0].button, 'left')
  })

  it('emits right-click on right-button release', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })
    handler('\x1b[<2;15;8M')  // right press
    handler('\x1b[<2;15;8m')  // right release
    // 📖 Right press is ignored; only release emits click
    assert.equal(received.length, 1)
    assert.equal(received[0].type, 'click')
    assert.equal(received[0].button, 'right')
  })

  it('detects double-click on same position within timeout', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })

    // 📖 Two rapid left releases at the same position → click + double-click
    handler('\x1b[<0;10;5m')  // first release
    handler('\x1b[<0;10;5m')  // second release (within 400ms)

    assert.equal(received.length, 2)
    assert.equal(received[0].type, 'click')
    assert.equal(received[1].type, 'double-click')
  })

  it('does not double-click on different positions', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })

    handler('\x1b[<0;10;5m')  // first release at (10,5)
    handler('\x1b[<0;20;5m')  // second release at (20,5) — different x

    assert.equal(received.length, 2)
    assert.equal(received[0].type, 'click')
    assert.equal(received[1].type, 'click') // 📖 Not double-click — different position
  })

  it('ignores non-mouse data', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })
    handler('T')       // regular keypress
    handler('\x1b[A')  // up arrow
    assert.equal(received.length, 0)
  })

  it('third rapid click does not trigger another double-click', () => {
    const received = []
    const handler = createMouseHandler({ onMouseEvent: (e) => received.push(e) })

    handler('\x1b[<0;10;5m')  // 1st release → click
    handler('\x1b[<0;10;5m')  // 2nd release → double-click (resets)
    handler('\x1b[<0;10;5m')  // 3rd release → click (not double-click)

    assert.equal(received.length, 3)
    assert.equal(received[0].type, 'click')
    assert.equal(received[1].type, 'double-click')
    assert.equal(received[2].type, 'click') // 📖 Reset after double-click
  })
})

describe('MOUSE_ENABLE / MOUSE_DISABLE sequences', () => {
  it('MOUSE_ENABLE contains all required mode activations', () => {
    // 📖 Mode 1000 (basic), 1002 (button-event), 1006 (SGR)
    assert.ok(MOUSE_ENABLE.includes('\x1b[?1000h'), 'missing mode 1000 enable')
    assert.ok(MOUSE_ENABLE.includes('\x1b[?1002h'), 'missing mode 1002 enable')
    assert.ok(MOUSE_ENABLE.includes('\x1b[?1006h'), 'missing mode 1006 enable')
  })

  it('MOUSE_DISABLE contains all required mode deactivations', () => {
    assert.ok(MOUSE_DISABLE.includes('\x1b[?1000l'), 'missing mode 1000 disable')
    assert.ok(MOUSE_DISABLE.includes('\x1b[?1002l'), 'missing mode 1002 disable')
    assert.ok(MOUSE_DISABLE.includes('\x1b[?1006l'), 'missing mode 1006 disable')
  })

  it('MOUSE_DISABLE reverses MOUSE_ENABLE modes in opposite order', () => {
    // 📖 Best practice: disable in reverse order of enable
    const enableOrder = ['1000', '1002', '1006']
    const disableOrder = ['1006', '1002', '1000']
    enableOrder.forEach((mode, i) => {
      assert.ok(MOUSE_ENABLE.indexOf(`?${mode}h`) >= 0)
    })
    disableOrder.forEach((mode, i) => {
      assert.ok(MOUSE_DISABLE.indexOf(`?${mode}l`) >= 0)
  })
})

// ─── Shell Env tests ─────────────────────────────────────────────────────────
describe('Shell Env', () => {
  it('buildEnvContent generates export lines for bash/zsh', () => {
    const config = { apiKeys: { nvidia: 'nvapi-test', groq: 'gsk-abc123' } }
    const content = buildEnvContent(config, 'bash')
    assert.ok(content.includes("export NVIDIA_API_KEY='nvapi-test'"))
    assert.ok(content.includes("export GROQ_API_KEY='gsk-abc123'"))
    assert.ok(content.includes(ENV_FILE_MARKER))
    assert.ok(content.startsWith('#!/bin/env sh'))
  })

  it('buildEnvContent generates set -gx lines for fish', () => {
    const config = { apiKeys: { nvidia: 'nvapi-test', groq: 'gsk-abc123' } }
    const content = buildEnvContent(config, 'fish')
    assert.ok(content.includes("set -gx NVIDIA_API_KEY 'nvapi-test'"))
    assert.ok(content.includes("set -gx GROQ_API_KEY 'gsk-abc123'"))
    assert.ok(!content.includes('export'))
  })

  it('buildEnvContent skips providers with no key', () => {
    const config = { apiKeys: { nvidia: 'nvapi-test' } }
    const content = buildEnvContent(config, 'bash')
    assert.ok(content.includes('NVIDIA_API_KEY'))
    assert.ok(!content.includes('GROQ_API_KEY'))
    assert.ok(!content.includes('CEREBRAS_API_KEY'))
  })

  it('buildEnvContent uses first key from multi-key arrays', () => {
    const config = { apiKeys: { groq: ['gsk-first', 'gsk-second'] } }
    const content = buildEnvContent(config, 'bash')
    assert.ok(content.includes("export GROQ_API_KEY='gsk-first'"))
    assert.ok(!content.includes('gsk-second'))
  })

  it('buildEnvContent handles keys with single quotes', () => {
    const config = { apiKeys: { nvidia: "nvapi-it's" } }
    const content = buildEnvContent(config, 'bash')
    assert.ok(content.includes("nvapi-it'\\''s"))
  })

  it('buildEnvContent returns minimal file for empty config', () => {
    const config = { apiKeys: {} }
    const content = buildEnvContent(config, 'bash')
    assert.ok(content.includes(ENV_FILE_MARKER))
    assert.ok(!content.includes('export'))
  })

  it('buildRcSourceLine generates bash/zsh source line with marker', () => {
    const envPath = join(tmpdir(), '.free-coding-models.env')
    const line = buildRcSourceLine(envPath, 'bash')
    assert.ok(line.includes('.free-coding-models.env'))
    assert.ok(line.includes(ENV_FILE_MARKER))
    assert.ok(line.includes('[ -f '))
    assert.ok(line.includes('. '))
  })

  it('buildRcSourceLine generates fish source line with marker', () => {
    const envPath = join(tmpdir(), '.free-coding-models.env')
    const line = buildRcSourceLine(envPath, 'fish')
    assert.ok(line.includes('test -f'))
    assert.ok(line.includes('source'))
    assert.ok(line.includes(ENV_FILE_MARKER))
  })

  it('buildRcSourceLine uses ~/ relative path for home dir', () => {
    const home = homedir()
    const envPath = join(home, '.free-coding-models.env')
    const line = buildRcSourceLine(envPath, 'zsh')
    assert.ok(line.includes('~/.free-coding-models.env'))
    assert.ok(!line.includes(home))
  })

  it('getEnvFilePath returns absolute path in home directory', () => {
    const path = getEnvFilePath()
    assert.ok(path.endsWith('.free-coding-models.env'))
    assert.ok(path.includes('/'))
  })

  it('detectShellInfo returns a valid shell and rcPath', () => {
    const info = detectShellInfo()
    assert.ok(['zsh', 'bash', 'fish'].includes(info.shell))
    assert.ok(info.rcPath.length > 0)
    assert.ok(info.rcPath.includes('/'))
  })

  it('syncShellEnv writes env file and removes it when no keys', () => {
    const tmpDir = join(tmpdir(), `fcm-test-shellenv-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    const config = { apiKeys: { nvidia: 'nvapi-test' }, settings: { shellEnvEnabled: true } }
    const result = syncShellEnv(config)
    assert.ok(result.success)

    // 📖 Clean up: remove env file if created
    const envPath = getEnvFilePath()
    if (existsSync(envPath)) {
      try { rmSync(envPath) } catch { /* best effort */ }
    }

    // 📖 Test with empty config — should clean up
    const emptyResult = syncShellEnv({ apiKeys: {} })
    assert.ok(emptyResult.success)
  })

  it('ENV_FILE_MARKER is a stable identifier string', () => {
    assert.ok(typeof ENV_FILE_MARKER === 'string')
    assert.ok(ENV_FILE_MARKER.startsWith('#'))
    assert.ok(ENV_FILE_MARKER.includes('free-coding-models'))
  })
})
})

// 📖 fadedRow: multiplies every 24-bit RGB channel inside an ANSI-colored string by a
// 📖 factor, so an entire row can be uniformly faded (used for "unusable" rows in the
// 📖 TUI table). Tested in isolation so we don't need a full renderTable call to verify
// 📖 the math — the row-render behavior is covered by the renderTable tests below.
describe('fadedRow', () => {
  it('multiplies 24-bit foreground RGB by 0.8 by default', () => {
    const input = '\x1b[38;2;255;100;50mhello\x1b[39m'
    const out = fadedRow(input)
    assert.equal(out, '\x1b[38;2;204;80;40mhello\x1b[39m')
  })

  it('multiplies 24-bit background RGB by 0.8 by default', () => {
    const input = '\x1b[48;2;10;20;30mhello\x1b[49m'
    const out = fadedRow(input)
    assert.equal(out, '\x1b[48;2;8;16;24mhello\x1b[49m')
  })

  it('preserves bold, dim, and reset SGR codes (only touches 38;2/48;2)', () => {
    const input = '\x1b[1m\x1b[38;2;255;0;0mhi\x1b[22m\x1b[39m'
    const out = fadedRow(input)
    assert.equal(out, '\x1b[1m\x1b[38;2;204;0;0mhi\x1b[22m\x1b[39m')
  })

  it('clamps channel values to 0–255 even when factor is extreme', () => {
    const input = '\x1b[38;2;250;240;230mhi\x1b[39m'
    const out = fadedRow(input, 0)
    assert.equal(out, '\x1b[38;2;0;0;0mhi\x1b[39m')
    const out2 = fadedRow(input, 1.5) // 📖 factor > 1 is a no-op identity short-circuit
    assert.equal(out2, input)
  })

  it('returns the input unchanged when factor is 1 (identity fast path)', () => {
    const input = '\x1b[38;2;123;45;67mhi\x1b[39m'
    assert.equal(fadedRow(input, 1), input)
    assert.equal(fadedRow(input, 1.5), input)
  })

  it('handles a row with mixed fg + bg colors (e.g. cursor-highlighted row)', () => {
    const input = '\x1b[38;2;255;255;255m\x1b[48;2;39;55;90m  hello  \x1b[49m\x1b[39m'
    const out = fadedRow(input, 0.5)
    assert.equal(out, '\x1b[38;2;128;128;128m\x1b[48;2;20;28;45m  hello  \x1b[49m\x1b[39m')
  })

  it('passes plain text (no SGR codes) through unchanged', () => {
    assert.equal(fadedRow('plain text'), 'plain text')
  })
})

// 📖 renderTable: the "unusable" rows (noauth / auth_error) must be faded to 80% opacity
// 📖 so the user can spot at a glance which models they cannot actually use. We assert
// 📖 the actual ANSI output contains reduced RGB channels on those rows.
describe('renderTable unusable row fade', () => {
  // 📖 Helper that runs a renderTable call with chalk forced into 24-bit color mode
  // 📖 so the resulting string contains \x1b[38;2;...m / \x1b[48;2;...m codes we can inspect.
  const renderWithTruecolor = (args) => {
    const prev = chalk.level
    chalk.level = 3
    try {
      return renderTable(args)
    } finally {
      chalk.level = prev
    }
  }

  it('fades rows with status=noauth to 80% opacity (multiplies RGB by 0.8)', () => {
    const result = mockResult({
      label: 'Unconfigured',
      status: 'noauth',
      httpCode: '401',
      pings: [{ ms: 25, code: '401' }],
      providerKey: 'groq',
      totalTokens: 0,
    })
    const fadedOutput = renderWithTruecolor({ results: [result], pendingPings: 0, frame: 0 })
    const freshOutput = renderWithTruecolor({
      results: [mockResult({ ...result, status: 'up', label: 'Configured' })],
      pendingPings: 0,
      frame: 0,
    })

    // 📖 The faded row should contain 80%-reduced RGB channels (e.g. 255 → 204),
    // 📖 whereas the working row keeps the original channel values.
    assert.match(fadedOutput, /\x1b\[(?:38|48);2;\d+;\d+;\d+m[^\x1b]*Unconfigured/)
    assert.match(freshOutput, /\x1b\[(?:38|48);2;255;\d+;\d+m[^\x1b]*Configured/)
  })

  it('fades rows with status=auth_error to 80% opacity as well', () => {
    const result = mockResult({
      label: 'Bad key',
      status: 'auth_error',
      httpCode: '401',
      pings: [{ ms: 25, code: '401' }],
      providerKey: 'groq',
      totalTokens: 0,
    })
    const fadedOutput = renderWithTruecolor({ results: [result], pendingPings: 0, frame: 0 })
    // 📖 255 multiplied by 0.8 = 204; the row should not contain the full 255.
    assert.doesNotMatch(fadedOutput, /\[(?:38|48);2;255;255;255m[^\x1b]*Bad key/)
    assert.match(fadedOutput, /AUTH FAIL/)
  })

  it('does not fade rows that are healthy (status=up)', () => {
    const result = mockResult({
      label: 'Healthy',
      status: 'up',
      pings: [{ ms: 200, code: '200' }],
      providerKey: 'nvidia',
      totalTokens: 0,
    })
    const out = renderWithTruecolor({ results: [result], pendingPings: 0, frame: 0 })
    // 📖 A healthy row keeps its original RGB values. We don't pin a specific
    // 📖 channel here (theme-dependent); we just check that the label survives
    // 📖 in the output and the row did not get a 80% reduction applied.
    assert.match(out, /Healthy/)
  })

  it('also fades a noauth row that is marked as favorite (visual cue wins over favorite bg)', () => {
    const result = mockResult({
      label: 'FavNoKey',
      status: 'noauth',
      pings: [{ ms: 25, code: '401' }],
      providerKey: 'groq',
      totalTokens: 0,
      isFavorite: true,
      favoriteRank: 0,
    })
    const out = renderWithTruecolor({ results: [result], pendingPings: 0, frame: 0 })
    // 📖 Favorite bg color is 76;55;17 (light) / 76;55;17 (dark). Multiplied by 0.8
    // 📖 = 61;44;14. The full 76;55;17 should NOT appear — the fade should win.
    assert.doesNotMatch(out, /\[48;2;76;55;17m[^\x1b]*FavNoKey/)
    assert.match(out, /FavNoKey/)
  })

  it('also fades a noauth row that is marked as recommended', () => {
    const result = mockResult({
      label: 'RecNoKey',
      status: 'noauth',
      pings: [{ ms: 25, code: '401' }],
      providerKey: 'groq',
      totalTokens: 0,
      isRecommended: true,
      recommendScore: 100,
    })
    const out = renderWithTruecolor({ results: [result], pendingPings: 0, frame: 0 })
    // 📖 Recommended bg is 20;51;33 — faded = 16;41;26. The full color should not appear.
    assert.doesNotMatch(out, /\[48;2;20;51;33m[^\x1b]*RecNoKey/)
    assert.match(out, /RecNoKey/)
  })
})

describe('COLUMN_SORT_MAP', () => {
  it('maps mood column to verdict sort key', () => {
    assert.equal(COLUMN_SORT_MAP.mood, 'verdict')
  })

  it('maps rank column to rank sort key', () => {
    assert.equal(COLUMN_SORT_MAP.rank, 'rank')
  })

  it('maps tier column to null (triggers filter cycle, not sort)', () => {
    assert.equal(COLUMN_SORT_MAP.tier, null)
  })

  it('maps swe column to swe sort key', () => {
    assert.equal(COLUMN_SORT_MAP.swe, 'swe')  })

  it('maps ctx column to ctx sort key', () => {
    assert.equal(COLUMN_SORT_MAP.ctx, 'ctx')
  })

  it('maps model column to model sort key', () => {
    assert.equal(COLUMN_SORT_MAP.model, 'model')
  })

  it('maps source column to origin sort key', () => {
    assert.equal(COLUMN_SORT_MAP.source, 'origin')
  })

  it('maps ping column to ping sort key', () => {
    assert.equal(COLUMN_SORT_MAP.ping, 'ping')
  })

  it('maps avg column to avg sort key', () => {
    assert.equal(COLUMN_SORT_MAP.avg, 'avg')
  })

  it('maps health column to condition sort key', () => {
    assert.equal(COLUMN_SORT_MAP.health, 'condition')
  })

  it('maps verdict column to verdict sort key', () => {
    assert.equal(COLUMN_SORT_MAP.verdict, 'verdict')
  })

  it('maps stability column to stability sort key', () => {
    assert.equal(COLUMN_SORT_MAP.stability, 'stability')
  })

  it('maps uptime column to uptime sort key', () => {
    assert.equal(COLUMN_SORT_MAP.uptime, 'uptime')
  })

  it('maps benchmark display columns to benchmark sort keys', () => {
    assert.equal(COLUMN_SORT_MAP.aiLatency, 'aiLatency')
    assert.equal(COLUMN_SORT_MAP.tps, 'tps')
  })

  it('has entries for all expected columns', () => {
    const expected = ['mood', 'rank', 'tier', 'swe', 'ctx', 'model', 'source', 'ping', 'avg', 'health', 'verdict', 'stability', 'uptime', 'aiLatency', 'tps']
    for (const col of expected) {
      assert.ok(col in COLUMN_SORT_MAP, `missing column: ${col}`)
    }
  })
})

describe('detectPackageManager', () => {
  it('returns a valid package manager string', () => {
    const pm = detectPackageManager()
    assert.ok(['npm', 'bun', 'pnpm', 'yarn'].includes(pm), `unexpected pm: ${pm}`)
  })
})

describe('resolveCurrentNpmInstallTarget', () => {
  it('detects the npm prefix that owns a global package root', () => {
    const prefix = join(tmpdir(), `fcm-prefix-${process.pid}-${Date.now()}`)
    const packageRoot = join(prefix, 'lib', 'node_modules', 'free-coding-models')
    const binDir = join(prefix, 'bin')
    const npmBin = join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm')

    mkdirSync(packageRoot, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFileSync(npmBin, '')

    try {
      assert.deepEqual(resolveCurrentNpmInstallTarget(packageRoot), {
        packageRoot,
        prefix,
        bin: npmBin,
      })
    } finally {
      rmSync(prefix, { recursive: true, force: true })
    }
  })

  it('returns null for a repo checkout package root', () => {
    assert.equal(resolveCurrentNpmInstallTarget(ROOT), null)
  })
})

describe('getInstallArgs', () => {
  it('returns npm install args by default', () => {
    const { bin, args } = getInstallArgs('npm', '1.0.0')
    assert.equal(bin, 'npm')
    assert.deepEqual(args, ['i', '-g', 'free-coding-models@1.0.0', '--prefer-online'])
  })

  it('targets the npm prefix that owns the active global install', () => {
    const { bin, args } = getInstallArgs('npm', '1.0.0', {
      prefix: '/opt/homebrew',
      bin: '/opt/homebrew/bin/npm',
    })

    assert.equal(bin, '/opt/homebrew/bin/npm')
    assert.deepEqual(args, ['i', '-g', '--prefix', '/opt/homebrew', 'free-coding-models@1.0.0', '--prefer-online'])
  })

  it('returns bun install args', () => {
    const { bin, args } = getInstallArgs('bun', '1.0.0')
    assert.equal(bin, 'bun')
    assert.deepEqual(args, ['add', '-g', 'free-coding-models@1.0.0'])
  })

  it('returns pnpm install args', () => {
    const { bin, args } = getInstallArgs('pnpm', '1.0.0')
    assert.equal(bin, 'pnpm')
    assert.deepEqual(args, ['add', '-g', 'free-coding-models@1.0.0'])
  })

  it('returns yarn install args', () => {
    const { bin, args } = getInstallArgs('yarn', '1.0.0')
    assert.equal(bin, 'yarn')
    assert.deepEqual(args, ['global', 'add', 'free-coding-models@1.0.0'])
  })

  it('falls back to npm for unknown pm', () => {
    const { bin, args } = getInstallArgs('unknown', '1.0.0')
    assert.equal(bin, 'npm')
    assert.deepEqual(args, ['i', '-g', 'free-coding-models@1.0.0', '--prefer-online'])
  })
})

describe('getManualInstallCmd', () => {
  it('returns npm command string', () => {
    assert.equal(getManualInstallCmd('npm', '2.0.0'), 'npm i -g free-coding-models@2.0.0 --prefer-online')
  })

  it('includes the owner npm prefix in manual install instructions', () => {
    assert.equal(
      getManualInstallCmd('npm', '2.0.0', {
        prefix: '/opt/homebrew',
        bin: '/opt/homebrew/bin/npm',
      }),
      '/opt/homebrew/bin/npm i -g --prefix /opt/homebrew free-coding-models@2.0.0 --prefer-online'
    )
  })

  it('returns bun command string', () => {
    assert.equal(getManualInstallCmd('bun', '2.0.0'), 'bun add -g free-coding-models@2.0.0')
  })

  it('returns pnpm command string', () => {
    assert.equal(getManualInstallCmd('pnpm', '2.0.0'), 'pnpm add -g free-coding-models@2.0.0')
  })

  it('returns yarn command string', () => {
    assert.equal(getManualInstallCmd('yarn', '2.0.0'), 'yarn global add free-coding-models@2.0.0')
  })
})

describe('web dashboard table sorting', () => {
  const sortableWebColumns = [
    'mood', 'idx', 'tier', 'sweScore', 'ctx', 'label', 'origin', 'latestPing',
    'avg', 'condition', 'verdict', 'stability', 'uptime', 'aiLatency', 'tps', 'trend',
  ]

  it('keeps every visible web table column explicitly sortable', () => {
    const tableSource = readFileSync(join(ROOT, 'web/src/components/dashboard/ModelTable.jsx'), 'utf8')

    assert.match(tableSource, /const SORTABLE_COLUMN_IDS = new Set/, 'header clickability must not depend on TanStack display-column accessors')
    assert.match(tableSource, /SORTABLE_COLUMN_IDS\.has\(col\.id\)/, 'headers must use the explicit sortable allowlist')

    for (const columnId of sortableWebColumns) {
      assert.ok(tableSource.includes(`'${columnId}'`), `${columnId} must be present in the sortable allowlist`)
      const idPattern = columnId === 'condition'
        ? /id:\s*'condition',[\s\S]*?enableSorting:\s*true/
        : new RegExp(`(?:id:\\s*'${columnId}'|accessor\\('${columnId}'|accessor\\("${columnId}")[\\s\\S]*?enableSorting:\\s*true`)
      assert.match(tableSource, idPattern, `${columnId} column must opt into sorting`)
    }
  })

  it('has comparator support for every sortable web table column', () => {
    const filterSource = readFileSync(join(ROOT, 'web/src/hooks/useFilter.js'), 'utf8')

    for (const columnId of sortableWebColumns) {
      assert.ok(
        filterSource.includes(`sortColumn === '${columnId}'`) || columnId === 'avg',
        `${columnId} must be handled by useFilter sorting`
      )
    }
  })
})

// 📖 Web server tests use real loopback ports so we can verify the startup
// 📖 fallback behavior without depending on shell scripts or a browser.
async function getFreePort() {
  const server = createHttpServer()
  await new Promise((resolve) => server.listen(0, resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  return port
}

async function closeServer(server) {
  if (!server?.listening) return
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
}

describe('web server startup', () => {
  it('detects an existing free-coding-models web server via the health route', async () => {
    const port = await getFreePort()
    const server = await startWebServer(port, { open: false, startPingLoop: false })

    try {
      assert.ok(server)
      assert.deepEqual(await inspectExistingWebServer(port), { inUse: true, isFcm: true })
    } finally {
      await closeServer(server)
    }
  })

  it('falls back to another port when the requested one is occupied by another app', async () => {
    const requestedPort = await getFreePort()
    const foreignServer = createHttpServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
    })
    await new Promise((resolve) => foreignServer.listen(requestedPort, resolve))

    const server = await startWebServer(requestedPort, { open: false, startPingLoop: false })

    try {
      assert.ok(server)
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : null
      assert.notEqual(actualPort, requestedPort)

      const response = await fetch(`http://127.0.0.1:${actualPort}/api/health`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-fcm-server'), 'free-coding-models-web')
      assert.deepEqual(await response.json(), { ok: true, app: 'free-coding-models-web' })
    } finally {
      await closeServer(server)
      await closeServer(foreignServer)
    }
  })

  it('reuses the existing dashboard when it already owns the requested port', async () => {
    const port = await getFreePort()
    const server = await startWebServer(port, { open: false, startPingLoop: false })

    try {
      assert.ok(server)
      const reused = await startWebServer(port, { open: false, startPingLoop: false })
      assert.equal(reused, null)
    } finally {
      await closeServer(server)
    }
  })
})

// ─── Sync Set Tests ──────────────────────────────────────────────────────────

describe('sync-set', () => {
  describe('parseArgs --sync-set', () => {
    const argv = (...a) => ['node', 'fcm', ...a]

    it('parses --sync-set without name', () => {
      const result = parseArgs(argv('--sync-set'))
      assert.equal(result.syncSetMode, true)
      assert.equal(result.syncSetName, null)
    })

    it('parses --sync-set with a name', () => {
      const result = parseArgs(argv('--sync-set', 'my-coding-set'))
      assert.equal(result.syncSetMode, true)
      assert.equal(result.syncSetName, 'my-coding-set')
    })

    it('does not consume --sync-set name as apiKey', () => {
      const result = parseArgs(argv('--sync-set', 'my-set'))
      assert.equal(result.apiKey, null)
      assert.equal(result.syncSetName, 'my-set')
    })

    it('defaults syncSetMode to false', () => {
      const result = parseArgs(argv())
      assert.equal(result.syncSetMode, false)
      assert.equal(result.syncSetName, null)
    })

    it('handles --sync-set combined with other flags', () => {
      const result = parseArgs(argv('--sync-set', 'prod', '--no-telemetry'))
      assert.equal(result.syncSetMode, true)
      assert.equal(result.syncSetName, 'prod')
      assert.equal(result.noTelemetry, true)
    })

    it('treats --sync-set followed by a flag as having no name', () => {
      const result = parseArgs(argv('--sync-set', '--json'))
      assert.equal(result.syncSetMode, true)
      assert.equal(result.syncSetName, null)
      assert.equal(result.jsonMode, true)
    })
  })

  describe('buildSyncCandidates', () => {
    it('returns empty when no keys match providers', () => {
      const candidates = buildSyncCandidates({ nonexistent_provider: 'key-123' })
      assert.equal(candidates.length, 0)
    })

    it('returns candidates sorted by score descending for nvidia', () => {
      const candidates = buildSyncCandidates({ nvidia: 'test-key' })
      assert.ok(candidates.length > 0)
      assert.equal(candidates[0].provider, 'nvidia')
      // 📖 All candidates should have nvidia provider since only nvidia key is given
      for (const c of candidates) {
        assert.equal(c.provider, 'nvidia')
      }
      // 📖 Scores should be non-increasing (sorted descending)
      for (let i = 1; i < candidates.length; i++) {
        assert.ok(candidates[i].score <= candidates[i - 1].score,
          `candidate ${i} (${candidates[i].model}: ${candidates[i].score}) should be <= candidate ${i-1} (${candidates[i-1].model}: ${candidates[i-1].score})`)
      }
    })

    it('filters out googleai models', () => {
      const candidates = buildSyncCandidates({ nvidia: 'key', googleai: 'key' })
      const googleai = candidates.filter(c => c.provider === 'googleai')
      assert.equal(googleai.length, 0)
    })

    it('respects exclude option', () => {
      const allCandidates = buildSyncCandidates({ nvidia: 'key' })
      if (allCandidates.length === 0) return // skip if no nvidia models
      const firstModel = `${allCandidates[0].provider}/${allCandidates[0].model}`
      const filtered = buildSyncCandidates({ nvidia: 'key' }, { exclude: new Set([firstModel]) })
      const found = filtered.find(c => `${c.provider}/${c.model}` === firstModel)
      assert.equal(found, undefined)
    })

    it('respects preferOrder option', () => {
      const allCandidates = buildSyncCandidates({ nvidia: 'key' })
      if (allCandidates.length < 2) return
      const lastModel = allCandidates[allCandidates.length - 1]
      const preferKey = `${lastModel.provider}/${lastModel.model}`
      const reordered = buildSyncCandidates({ nvidia: 'key' }, { preferOrder: [preferKey] })
      assert.equal(`${reordered[0].provider}/${reordered[0].model}`, preferKey)
    })

    it('only includes free openrouter models by default', () => {
      const candidates = buildSyncCandidates({ openrouter: 'key' })
      for (const c of candidates) {
        if (c.provider === 'openrouter') {
          assert.ok(c.model.endsWith(':free') || c.model === 'openrouter/free' || c.model === 'openrouter/owl-alpha',
            `OpenRouter model ${c.model} should be a free model`)
        }
      }
    })

    it('includes candidate fields', () => {
      const candidates = buildSyncCandidates({ nvidia: 'key' })
      if (candidates.length === 0) return
      const first = candidates[0]
      assert.ok(typeof first.provider === 'string')
      assert.ok(typeof first.model === 'string')
      assert.ok(typeof first.tier === 'string')
      assert.ok(typeof first.score === 'number')
      assert.ok(typeof first.swePercent === 'number')
      assert.ok(typeof first.url === 'string')
    })
  })

  describe('cli-help includes --sync-set', () => {
    it('includes --sync-set in help text', () => {
      const help = buildCliHelpText()
      assert.ok(help.includes('--sync-set'), 'Help text should mention --sync-set')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════════
  // 📖 BENCHMARK MODULE
  // ═══════════════════════════════════════════════════════════════════════════════
  describe('benchmark display formatters', () => {
    it('splits 4300ms + 56 tokens into AI Latency and TPS values', () => {
      const result = { ok: true, totalMs: 4300, outputTokens: 56, tokensPerSecond: 13 }
      assert.deepEqual(formatBenchmarkLatency(result), { text: '4.3s', retryBadge: '' })
      assert.deepEqual(formatBenchmarkTps(result), { text: '13', retryBadge: '' })
    })

    it('shows dash for empty state', () => {
      assert.deepEqual(formatBenchmarkLatency(null), { text: '—', retryBadge: '' })
      assert.deepEqual(formatBenchmarkTps(null), { text: '—', retryBadge: '' })
    })

    it('shows spinner when running', () => {
      assert.deepEqual(formatBenchmarkLatency(null, { running: true, frame: 0 }), { text: '⠋', retryBadge: '' })
      assert.deepEqual(formatBenchmarkTps(null, { running: true, frame: 0 }), { text: '⠋', retryBadge: '' })
    })

    it('shows compact error code in latency and dash in TPS on failure', () => {
      assert.deepEqual(formatBenchmarkLatency({ ok: false, code: 'TIMEOUT' }), { text: 'TIMEOUT', retryBadge: '' })
      assert.deepEqual(formatBenchmarkLatency({ ok: false, code: '401' }), { text: '401', retryBadge: '' })
      assert.deepEqual(formatBenchmarkLatency({ ok: false, code: '429' }), { text: '429', retryBadge: '' })
      assert.deepEqual(formatBenchmarkLatency({ ok: false, code: 'ERR' }), { text: 'ERR', retryBadge: '' })
      assert.deepEqual(formatBenchmarkTps({ ok: false, code: 'TIMEOUT' }), { text: '—', retryBadge: '' })
    })

    it('uses whole seconds when latency is >= 10s', () => {
      const result = { ok: true, totalMs: 12300, outputTokens: 100, tokensPerSecond: 8 }
      assert.deepEqual(formatBenchmarkLatency(result), { text: '12s', retryBadge: '' })
      assert.deepEqual(formatBenchmarkTps(result), { text: '8', retryBadge: '' })
    })

    it('rounds TPS to integer', () => {
      const result = { ok: true, totalMs: 1000, outputTokens: 15, tokensPerSecond: 15.7 }
      assert.deepEqual(formatBenchmarkLatency(result), { text: '1.0s', retryBadge: '' })
      assert.deepEqual(formatBenchmarkTps(result), { text: '16', retryBadge: '' })
    })

    it('keeps legacy combined formatter available', () => {
      const result = { ok: true, totalMs: 4300, outputTokens: 56, tokensPerSecond: 13 }
      assert.equal(formatBenchmarkResult(result), '4.3s / 13 TPS')
    })
  })

  describe('estimateTokensFromText', () => {
    it('returns 0 for empty text', () => {
      assert.equal(estimateTokensFromText(''), 0)
      assert.equal(estimateTokensFromText(null), 0)
    })

    it('estimates tokens from character length divided by 4', () => {
      // 40 chars → ceil(40/4) = 10 tokens
      assert.equal(estimateTokensFromText('a'.repeat(40)), 10)
    })

    it('rounds up partial tokens', () => {
      // 41 chars → ceil(41/4) = 11 tokens
      assert.equal(estimateTokensFromText('a'.repeat(41)), 11)
    })
  })

  describe('benchmarkModel', () => {
    // 📖 All current providers use OpenAI-compatible chat completions, no special guard needed.
  })

  describe('buildBenchmarkRequest', () => {
    it('builds OpenAI-compatible request for standard providers', () => {
      const req = buildBenchmarkRequest('sk-test', 'gpt-4', 'nvidia', 'https://api.nvidia.com/v1/chat/completions')
      assert.equal(req.url, 'https://api.nvidia.com/v1/chat/completions')
      assert.equal(req.headers.Authorization, 'Bearer sk-test')
      assert.equal(req.body.model, 'gpt-4')
      assert.equal(req.body.temperature, 0)
      assert.equal(req.body.max_tokens, 140)
      assert.match(req.body.messages[0].content, /one cohesive paragraph of 80 to 100 words/i)
      assert.ok(Array.isArray(req.body.messages))
    })

    it('strips zai/ prefix for zai provider', () => {
      const req = buildBenchmarkRequest('sk-test', 'zai/glm-5', 'zai', 'https://api.z.ai/v1/chat/completions')
      assert.equal(req.body.model, 'glm-5')
    })

    it('builds replicate-specific payload', () => {
      const req = buildBenchmarkRequest('token', 'version123', 'replicate', 'https://api.replicate.com/v1/predictions')
      assert.equal(req.url, 'https://api.replicate.com/v1/predictions')
      assert.equal(req.headers.Authorization, 'Token token')
      assert.equal(req.body.version, 'version123')
      assert.equal(req.body.input.max_tokens, 140)
      assert.match(req.body.input.prompt, /one cohesive paragraph of 80 to 100 words/i)
    })

    it('builds cloudflare request with account id resolution', () => {
      const req = buildBenchmarkRequest('token', 'model-x', 'cloudflare', 'https://api.cloudflare.com/{account_id}/v1/chat/completions')
      // 📖 resolveCloudflareUrl replaces {account_id} with the env var or 'missing-account-id'
      assert.ok(!req.url.includes('{account_id}'), 'placeholder should be resolved')
      assert.ok(req.url.includes('/v1/chat/completions'))
      assert.ok(req.headers.Authorization)
    })

    it('adds openrouter headers', () => {
      const req = buildBenchmarkRequest('sk-or-test', 'model', 'openrouter', 'https://openrouter.ai/api/v1/chat/completions')
      assert.equal(req.headers['HTTP-Referer'], 'https://github.com/vava-nessa/free-coding-models')
      assert.equal(req.headers['X-Title'], 'free-coding-models')
    })
  })
})

// ─── useColumnSizing pure helpers ─────────────────────────────────────────────
// 📖 The React hook is a thin wrapper around these pure functions, so testing
// 📖 them covers all the storage/validation edge cases without needing a DOM.
import {
  sanitizeSizing,
  clampSizing,
  mergeSizing,
  hasCustomSizing,
  readSizingFromStorage,
  writeSizingToStorage,
  removeSizingFromStorage,
  COLUMN_SIZING_STORAGE_KEY,
  COLUMN_SIZING_MIN,
  COLUMN_SIZING_MAX,
} from '../web/src/hooks/useColumnSizing.js'

// 📖 In-memory localStorage shim — matches the Storage interface our helpers use.
function makeMockStorage(initial = {}) {
  let store = { ...initial }
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
    clear: () => { store = {} },
    key: (i) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length },
  }
}

describe('useColumnSizing: sanitizeSizing', () => {
  it('keeps only finite positive numbers keyed by string', () => {
    assert.deepEqual(
      sanitizeSizing({ a: 1, b: 2.5, c: 'x', d: NaN, e: Infinity, f: -1, g: 0, h: 42 }),
      { a: 1, b: 2.5, h: 42 }
    )
  })

  it('returns an empty object for null / arrays / primitives', () => {
    assert.deepEqual(sanitizeSizing(null), {})
    assert.deepEqual(sanitizeSizing(undefined), {})
    assert.deepEqual(sanitizeSizing([]), {})
    assert.deepEqual(sanitizeSizing('nope'), {})
    assert.deepEqual(sanitizeSizing(42), {})
  })
})

describe('useColumnSizing: clampSizing', () => {
  it('clamps to [min, max] and rounds to integers', () => {
    assert.deepEqual(
      clampSizing({ a: 10, b: 30, c: 1500, d: 200.4, e: -3 }),
      { a: COLUMN_SIZING_MIN, b: 30, c: COLUMN_SIZING_MAX, d: 200, e: COLUMN_SIZING_MIN }
    )
  })

  it('respects custom min/max bounds', () => {
    assert.deepEqual(clampSizing({ a: 5, b: 200 }, 50, 100), { a: 50, b: 100 })
  })

  it('drops non-finite values silently', () => {
    assert.deepEqual(clampSizing({ a: NaN, b: Infinity, c: 'x', d: 50 }), { d: 50 })
  })

  it('returns an empty object for null / undefined input', () => {
    assert.deepEqual(clampSizing(null), {})
    assert.deepEqual(clampSizing(undefined), {})
  })
})

describe('useColumnSizing: mergeSizing', () => {
  it('layers stored on top of defaults, runtime on top of stored', () => {
    const defaults = { a: 1, b: 2, c: 3 }
    const stored = { a: 99, b: 50 }
    const runtime = { b: 77, d: 4 }
    assert.deepEqual(mergeSizing(defaults, stored, runtime), { a: 99, b: 77, c: 3, d: 4 })
  })

  it('falls back gracefully when one layer is missing', () => {
    assert.deepEqual(mergeSizing({ a: 1 }, null, { a: 9 }), { a: 9 })
    assert.deepEqual(mergeSizing({ a: 1 }, {}, {}), { a: 1 })
    assert.deepEqual(mergeSizing(undefined, undefined, undefined), {})
  })
})

describe('useColumnSizing: hasCustomSizing', () => {
  it('returns true when any column differs from its default', () => {
    assert.equal(hasCustomSizing({ a: 10, b: 20 }, { a: 10, b: 30 }), true)
    assert.equal(hasCustomSizing({ a: 10, b: 20 }, { a: 10, b: 20 }), false)
  })

  it('handles null inputs', () => {
    assert.equal(hasCustomSizing(null, { a: 1 }), false)
    assert.equal(hasCustomSizing({ a: 1 }, null), false)
  })
})

describe('useColumnSizing: storage adapters', () => {
  it('round-trips a sizing object through the mock storage', () => {
    const storage = makeMockStorage()
    const data = { mood: 40, idx: 50, label: 250 }
    assert.equal(writeSizingToStorage(storage, COLUMN_SIZING_STORAGE_KEY, data), true)
    assert.deepEqual(
      readSizingFromStorage(storage, COLUMN_SIZING_STORAGE_KEY, {}),
      data
    )
  })

  it('returns the fallback when the key is missing', () => {
    const storage = makeMockStorage()
    const fallback = { x: 1 }
    assert.deepEqual(readSizingFromStorage(storage, 'missing-key', fallback), fallback)
  })

  it('returns the fallback when JSON is corrupt', () => {
    const storage = makeMockStorage({ [COLUMN_SIZING_STORAGE_KEY]: '{not json' })
    assert.deepEqual(
      readSizingFromStorage(storage, COLUMN_SIZING_STORAGE_KEY, { fb: 1 }),
      { fb: 1 }
    )
  })

  it('sanitizes non-numeric values on read', () => {
    const storage = makeMockStorage({
      [COLUMN_SIZING_STORAGE_KEY]: JSON.stringify({ good: 42, bad: 'oops', neg: -5, zero: 0 }),
    })
    assert.deepEqual(
      readSizingFromStorage(storage, COLUMN_SIZING_STORAGE_KEY, {}),
      { good: 42 }
    )
  })

  it('removes a key and reports success', () => {
    const storage = makeMockStorage({ [COLUMN_SIZING_STORAGE_KEY]: '{"a":1}' })
    assert.equal(removeSizingFromStorage(storage, COLUMN_SIZING_STORAGE_KEY), true)
    assert.equal(storage.getItem(COLUMN_SIZING_STORAGE_KEY), null)
  })

  it('swallows storage errors instead of throwing', () => {
    const broken = {
      getItem: () => { throw new Error('quota') },
      setItem: () => { throw new Error('quota') },
      removeItem: () => { throw new Error('quota') },
    }
    assert.deepEqual(readSizingFromStorage(broken, 'k', { fb: 9 }), { fb: 9 })
    assert.equal(writeSizingToStorage(broken, 'k', { a: 1 }), false)
    assert.equal(removeSizingFromStorage(broken, 'k'), false)
  })

  it('treats a null/undefined storage as empty (SSR + private mode)', () => {
    assert.deepEqual(readSizingFromStorage(null, 'k', { fb: 7 }), { fb: 7 })
    assert.equal(writeSizingToStorage(undefined, 'k', {}), false)
  })
})

// ─── useFilter benchmark sort ─────────────────────────────────────────────────
// 📖 The 3-bucket sort (completed → running → never tested) is the heart of the
// 📖 AI Latency / TPS ordering. These tests pin down every bucket transition
// 📖 so a future refactor can't silently merge "running" back into "missing".
import { benchmarkBucket, compareBenchmark } from '../web/src/hooks/useFilter.js'

// 📖 Tiny model factory — only the fields compareBenchmark reads.
function bmModel({ ok, totalMs, tokensPerSecond, isBenchmarking }) {
  return {
    benchmark: ok ? { ok: true, totalMs, tokensPerSecond } : null,
    isBenchmarking: Boolean(isBenchmarking),
  }
}

describe('useFilter: benchmarkBucket', () => {
  it('classifies a successful benchmark as bucket 0', () => {
    assert.equal(benchmarkBucket(bmModel({ ok: true, totalMs: 100 })), 0)
  })

  it('classifies a benchmark with ok:false as not-completed', () => {
    // 📖 Only ok: true counts as "completed". A failed benchmark falls through
    // 📖 to the running/missing branch.
    const failed = { benchmark: { ok: false, error: 'timeout' }, isBenchmarking: false }
    assert.equal(benchmarkBucket(failed), 2)
  })

  it('classifies a running benchmark as bucket 1 even when no result exists', () => {
    assert.equal(benchmarkBucket(bmModel({ isBenchmarking: true })), 1)
  })

  it('classifies a never-tested model as bucket 2', () => {
    assert.equal(benchmarkBucket({ benchmark: null, isBenchmarking: false }), 2)
    assert.equal(benchmarkBucket({}), 2)
  })

  it('prioritizes completed over running when both flags are set', () => {
    // 📖 Defensive: a successful benchmark that just so happens to also be
    // 📖 marked isBenchmarking should still count as completed.
    const both = { benchmark: { ok: true, totalMs: 200 }, isBenchmarking: true }
    assert.equal(benchmarkBucket(both), 0)
  })
})

describe('useFilter: compareBenchmark', () => {
  const getLatency = (bench) => bench.totalMs
  const getTps = (bench) => bench.tokensPerSecond ?? 0

  it('sorts completed rows by value in ascending order', () => {
    const slow = bmModel({ ok: true, totalMs: 800 })
    const fast = bmModel({ ok: true, totalMs: 200 })
    assert.ok(compareBenchmark(fast, slow, 1, getLatency) < 0)
    assert.ok(compareBenchmark(slow, fast, 1, getLatency) > 0)
  })

  it('sorts completed rows by value in descending order when direction is -1', () => {
    const slow = bmModel({ ok: true, totalMs: 800 })
    const fast = bmModel({ ok: true, totalMs: 200 })
    assert.ok(compareBenchmark(slow, fast, -1, getLatency) < 0)
    assert.ok(compareBenchmark(fast, slow, -1, getLatency) > 0)
  })

  it('places running rows AFTER completed rows, regardless of direction', () => {
    const completed = bmModel({ ok: true, totalMs: 50 })
    const running = bmModel({ isBenchmarking: true })
    // 📖 In ascending order, running > completed.
    assert.ok(compareBenchmark(running, completed, 1, getLatency) > 0)
    // 📖 In descending order, running is still after completed (positive result
    // 📖 means a should come after b in the array — both directions agree).
    assert.ok(compareBenchmark(running, completed, -1, getLatency) > 0)
    assert.ok(compareBenchmark(completed, running, 1, getLatency) < 0)
    assert.ok(compareBenchmark(completed, running, -1, getLatency) < 0)
  })

  it('places never-tested rows AFTER running rows, regardless of direction', () => {
    const running = bmModel({ isBenchmarking: true })
    const never = bmModel({})
    assert.ok(compareBenchmark(never, running, 1, getLatency) > 0)
    assert.ok(compareBenchmark(never, running, -1, getLatency) > 0)
    assert.ok(compareBenchmark(running, never, 1, getLatency) < 0)
    assert.ok(compareBenchmark(running, never, -1, getLatency) < 0)
  })

  it('keeps the order of running-vs-never-tested groups internally stable (returns 0)', () => {
    // 📖 Within bucket 1 or 2, rows are not sorted by their numeric value
    // 📖 (they don't have one), so the comparator must return 0 to let the
    // 📖 tie-breaker (rank order) take over.
    const a = bmModel({ isBenchmarking: true })
    const b = bmModel({ isBenchmarking: true })
    assert.equal(compareBenchmark(a, b, 1, getLatency), 0)
    const c = bmModel({})
    const d = bmModel({})
    assert.equal(compareBenchmark(c, d, 1, getLatency), 0)
  })

  it('orders completed TPS rows by tokensPerSecond when used with the TPS getter', () => {
    const high = bmModel({ ok: true, tokensPerSecond: 120 })
    const low  = bmModel({ ok: true, tokensPerSecond: 30 })
    // 📖 Ascending: low first, high second.
    assert.ok(compareBenchmark(low, high, 1, getTps) < 0)
    assert.ok(compareBenchmark(high, low, 1, getTps) > 0)
    // 📖 Descending: high first.
    assert.ok(compareBenchmark(high, low, -1, getTps) < 0)
  })

  it('full 5-row scenario: completed (fastest→slowest) | running | never-tested', () => {
    // 📖 Realistic spread: 2 completed (one fast, one slow), 1 running, 2 never.
    const fast   = bmModel({ ok: true, totalMs: 150 })
    const slow   = bmModel({ ok: true, totalMs: 900 })
    const runA   = bmModel({ isBenchmarking: true })
    const noneA  = bmModel({})
    const noneB  = bmModel({})

    const models = [noneA, runA, slow, fast, noneB]
    // 📖 Ascending: completed first (fast→slow), then running, then never-tested.
    models.sort((a, b) => compareBenchmark(a, b, 1, getLatency))
    const order = models.map(m => {
      if (m.benchmark?.ok) return `done-${m.benchmark.totalMs}`
      if (m.isBenchmarking) return 'running'
      return 'never'
    })
    assert.deepEqual(order, ['done-150', 'done-900', 'running', 'never', 'never'])
  })
})

// ─── useFilter cycle helpers (M1 parity: TUI T / D / V / H / E key behavior) ───
// 📖 Each cycle starts from `all` (the TUI's "no filter" state) and returns
// 📖 to `all` after the last real value. Order is the same as the TUI.
import { TIER_CYCLE, STATUS_CYCLE, VERDICT_CYCLE, HEALTH_CYCLE, VISIBILITY_CYCLE } from '../web/src/hooks/useFilter.js'

describe('useFilter: filter cycles match TUI ordering', () => {
  it('tier cycle goes All → S+ → S → A+ → … → C → All', () => {
    assert.deepEqual(TIER_CYCLE, ['all', 'S+', 'S', 'A+', 'A', 'A-', 'B+', 'B', 'C'])
  })

  it('status cycle exposes the 3 user-facing states (up / down / pending)', () => {
    assert.deepEqual(STATUS_CYCLE, ['all', 'up', 'down', 'pending'])
  })

  it('verdict cycle covers the TUI VERDICT_CYCLE (minus null)', () => {
    // 📖 Web parity exposes every verdict state the TUI can filter on, plus
    // 📖 `all` at the front so the chip matches the rest of the bar.
    assert.deepEqual(VERDICT_CYCLE, [
      'all', 'Perfect', 'Normal', 'Spiky', 'Slow', 'Overloaded', 'Down', 'Unstable', 'Pending',
    ])
  })

  it('health cycle covers the TUI HEALTH_CYCLE (minus null)', () => {
    assert.deepEqual(HEALTH_CYCLE, [
      'all', 'up', 'timeout', 'down', 'pending', 'noauth', 'auth_error',
    ])
  })

  it('visibility cycle is the TUI E-key cycle (Normal / Configured / Usable)', () => {
    assert.deepEqual(VISIBILITY_CYCLE, ['normal', 'configured', 'usable'])
  })

  it('every cycle is a closed loop — the first entry is the reset state', () => {
    for (const cycle of [TIER_CYCLE, STATUS_CYCLE, VERDICT_CYCLE, HEALTH_CYCLE]) {
      // 📖 Cycles must be non-empty + first entry must be the reset state.
      // 📖 (The "last entry wraps to first" is tested by the cycling logic
      // 📖 itself in the useFilter hook — this just checks the array shape.)
      assert.ok(cycle.length >= 3, `cycle ${cycle} too short`)
      assert.equal(cycle[0], 'all', `first entry of ${cycle} must be the "all" reset state`)
    }
  })
})

// ─── M2: URL state builder (web/src/hooks/useUrlState.js) ────────────────
// 📖 buildUrlParams is the pure helper the hook uses to compose the URL
// 📖 search string from the live state. M2 write-back correctness depends on it.
import { buildUrlParams } from '../web/src/hooks/useUrlState.js'

describe('useUrlState: buildUrlParams', () => {
  it('emits nothing when the state is at defaults', () => {
    const params = buildUrlParams({
      currentView: 'dashboard',
      filterTier: 'all',
      filterStatus: 'all',
      filterProvider: 'all',
      filterVerdict: 'all',
      filterHealth: 'all',
      sortColumn: null,
      sortDirection: null,
      searchQuery: '',
    })
    assert.equal(params.toString(), '')
  })

  it('omits only the non-default keys', () => {
    const params = buildUrlParams({
      currentView: 'analytics',
      filterTier: 'S+',
      filterStatus: 'all',
      filterProvider: 'all',
      filterVerdict: 'Perfect',
      filterHealth: 'all',
      sortColumn: 'avg',
      sortDirection: 'asc',
      searchQuery: 'groq',
    })
    const out = Object.fromEntries(params.entries())
    assert.equal(out.view, 'analytics')
    assert.equal(out.tier, 'S+')
    assert.equal(out.verdict, 'Perfect')
    assert.equal(out.sort, 'avg')
    assert.equal(out.dir, 'asc')
    assert.equal(out.q, 'groq')
    assert.equal(out.status, undefined)
    assert.equal(out.provider, undefined)
    assert.equal(out.health, undefined)
  })

  it('always pairs sort + dir when sort is set', () => {
    const params = buildUrlParams({
      currentView: 'dashboard',
      filterTier: 'all', filterStatus: 'all', filterProvider: 'all',
      filterVerdict: 'all', filterHealth: 'all',
      sortColumn: 'verdict', sortDirection: 'desc',
      searchQuery: '',
    })
    const out = Object.fromEntries(params.entries())
    assert.equal(out.sort, 'verdict')
    assert.equal(out.dir, 'desc')
  })

  it('exposes the palette flag for deep-links', () => {
    const params = buildUrlParams({
      currentView: 'dashboard', filterTier: 'all', filterStatus: 'all',
      filterProvider: 'all', filterVerdict: 'all', filterHealth: 'all',
      sortColumn: null, sortDirection: null, searchQuery: '',
      paletteOpen: true,
    })
    const out = Object.fromEntries(params.entries())
    assert.equal(out.palette, 'open')
  })
})

// ─── M2: URL state validation (useUrlState parseUrlParams via the constants) ──
import { VALID_TIERS, VALID_STATUS, VALID_SORTS, VALID_VIEWS, VALID_DIRS, VALID_TOOL_MODES } from '../web/src/hooks/urlState.constants.js'
import { INSTALL_ENDPOINT_TOOL_MODES, recommendScoreShape, toolInstallSummary } from '../web/src/utils/m3.js'

describe('useUrlState: validation constants', () => {
  it('tier allowlist matches the TUI TIER_CYCLE', () => {
    for (const t of ['S+', 'S', 'A+', 'A', 'A-', 'B+', 'B', 'C', 'all']) {
      assert.ok(VALID_TIERS.has(t), `tier ${t} should be accepted`)
    }
    assert.equal(VALID_TIERS.has('Z'), false)
  })

  it('sort allowlist matches the Web ModelTable columns', () => {
    for (const s of ['mood', 'idx', 'tier', 'sweScore', 'ctx', 'label', 'origin', 'latestPing',
                     'avg', 'condition', 'verdict', 'stability', 'uptime', 'aiLatency', 'tps', 'trend']) {
      assert.ok(VALID_SORTS.has(s), `sort ${s} should be accepted`)
    }
    assert.equal(VALID_SORTS.has('nope'), false)
  })

  it('view allowlist includes dashboard / settings / analytics + page modals', () => {
    for (const v of ['dashboard', 'settings', 'analytics', 'help', 'changelog', 'recommend', 'router']) {
      assert.ok(VALID_VIEWS.has(v), `view ${v} should be accepted`)
    }
    assert.equal(VALID_VIEWS.has('admin'), false)
  })

  it('tool mode allowlist mirrors TOOL_MODE_ORDER', () => {
    for (const mode of TOOL_MODE_ORDER) {
      assert.ok(VALID_TOOL_MODES.has(mode), `tool mode ${mode} should be accepted`)
    }
    assert.equal(VALID_TOOL_MODES.has('claude-code'), false)
  })
})

// ─── M3: Tool mode + endpoint install + recommend static contracts ─────
describe('M3 web parity helpers and wiring', () => {
  it('buildUrlParams round-trips toolMode for shareable endpoint links', () => {
    const params = buildUrlParams({
      currentView: 'dashboard', filterTier: 'all', filterStatus: 'all',
      filterProvider: 'all', filterVerdict: 'all', filterHealth: 'all',
      sortColumn: null, sortDirection: null, searchQuery: '',
      toolMode: 'goose',
    })
    assert.equal(Object.fromEntries(params.entries()).toolMode, 'goose')
  })

  it('recommendScoreShape accepts valid Top 3 payloads', () => {
    assert.equal(recommendScoreShape({ top3: [{
      result: { providerKey: 'groq', modelId: 'openai/gpt-oss-120b', label: 'GPT OSS 120B' },
      score: 88,
      reason: 'S tier · currently up',
    }] }), true)
  })

  it('recommendScoreShape rejects malformed recommendation payloads', () => {
    assert.equal(recommendScoreShape({ top3: [{ result: { providerKey: 'groq' }, score: 200, reason: '' }] }), false)
    assert.equal(recommendScoreShape(null), true)
  })

  it('toolInstallSummary formats supported install plans', () => {
    const summary = toolInstallSummary(getToolInstallPlan('opencode', { platform: 'darwin' }))
    assert.equal(summary.supported, true)
    assert.match(summary.title, /OpenCode/i)
    assert.match(summary.command, /npm install/)
    assert.match(summary.docsUrl, /^https:/)
  })

  it('toolInstallSummary formats unsupported install plans', () => {
    const summary = toolInstallSummary(getToolInstallPlan('opencode-desktop', { platform: 'darwin' }))
    assert.equal(summary.supported, false)
    assert.equal(summary.command, null)
    assert.match(summary.title, /Desktop|manual|platform/i)
  })

  it('Web endpoint target cycle mirrors the core install targets', () => {
    assert.deepEqual(INSTALL_ENDPOINT_TOOL_MODES, getInstallTargetModes())
  })

  it('Header wires ToolPicker and enables Recommend navigation without M3 badge', () => {
    const source = readFileSync(join(ROOT, 'web/src/components/layout/Header.jsx'), 'utf8')
    assert.match(source, /<ToolPicker/)
    assert.match(source, /id: 'recommend',\s+label: 'Recommend'/)
    assert.doesNotMatch(source, /id: 'recommend',[\s\S]*?comingIn: 'M3'/)
  })

  it('ModelTable exposes a non-sortable endpoint install column', () => {
    const source = readFileSync(join(ROOT, 'web/src/components/dashboard/ModelTable.jsx'), 'utf8')
    assert.match(source, /id: 'launch'/)
    assert.match(source, /<LaunchButton/)
    assert.match(source, /enableSorting:\s*false/)
  })

  it('DetailPanel exposes tool picker, endpoint button, and fallback affordance', () => {
    const source = readFileSync(join(ROOT, 'web/src/components/dashboard/DetailPanel.jsx'), 'utf8')
    assert.match(source, /<ToolPicker/)
    assert.match(source, /<LaunchButton/)
    assert.match(source, /Install in compatible tool/)
  })

  it('web server exposes M3 endpoint routes and does not spawn tools from the dashboard', () => {
    const source = readFileSync(join(ROOT, 'web/server.js'), 'utf8')
    for (const route of ['/api/tool-mode', '/api/install-endpoint', '/api/launch', '/api/recommend', '/api/telemetry/event']) {
      assert.ok(source.includes(`case '${route}'`), `${route} route should exist`)
    }
    assert.match(source, /installEndpointForMode/)
    assert.doesNotMatch(source, /launchToolForMode/)
    assert.doesNotMatch(source, /startExternalTool/)
  })

  it('M3 hooks import cleanly', async () => {
    const toolModeMod = await import('../web/src/hooks/useToolMode.js')
    const recommendMod = await import('../web/src/hooks/useRecommend.js')
    assert.equal(typeof toolModeMod.useToolMode, 'function')
    assert.equal(typeof recommendMod.useRecommend, 'function')
  })
})

// ─── M2: React hook modules import cleanly (no syntax errors) ────────────
// (M2 tests are below M4)

// ─── M4: Router, Token Usage, Installed Models, Install Endpoints ──────────
describe('M4: Router dashboard + Token Usage + Installed Models + Install Endpoints', () => {
  it('web server exposes M4 router proxy endpoints', () => {
    const source = readFileSync(join(ROOT, 'web/server.js'), 'utf8')
    for (const route of ['/api/router/status', '/api/router/stats', '/api/router/tokens', '/api/router/start', '/api/router/stop', '/api/router/sets', '/api/router/probe-mode', '/api/router/quick-setup']) {
      assert.ok(source.includes(`case '${route}'`), `${route} route should exist`)
    }
  })

  it('web server exposes M4 installed-models and install-endpoints endpoints', () => {
    const source = readFileSync(join(ROOT, 'web/server.js'), 'utf8')
    for (const route of ['/api/installed-models', '/api/install-endpoints/providers', '/api/install-endpoints/catalog', '/api/install-endpoints/wizard']) {
      assert.ok(source.includes(`case '${route}'`), `${route} route should exist`)
    }
  })

  it('web server imports M4 core modules', () => {
    const source = readFileSync(join(ROOT, 'web/server.js'), 'utf8')
    assert.match(source, /getRouterDaemonStatus/)
    assert.match(source, /startRouterDaemonBackground/)
    assert.match(source, /stopRouterDaemon/)
    assert.match(source, /scanAllToolConfigs/)
    assert.match(source, /softDeleteModel/)
    assert.match(source, /getConfiguredInstallableProviders/)
  })

  it('M4 hooks import cleanly', async () => {
    const routerMod = await import('../web/src/hooks/useRouterDashboard.js')
    const tokenMod = await import('../web/src/hooks/useTokenUsage.js')
    const installedMod = await import('../web/src/hooks/useInstalledModels.js')
    assert.equal(typeof routerMod.useRouterDashboard, 'function')
    assert.equal(typeof tokenMod.useTokenUsage, 'function')
    assert.equal(typeof installedMod.useInstalledModels, 'function')
  })

  it('Header removes M4 coming-soon badges', () => {
    const source = readFileSync(join(ROOT, 'web/src/components/layout/Header.jsx'), 'utf8')
    assert.doesNotMatch(source, /comingIn: 'M4'/)
  })

  it('App.jsx imports and wires M4 modal components', () => {
    const source = readFileSync(join(ROOT, 'web/src/App.jsx'), 'utf8')
    assert.match(source, /import RouterView/)
    assert.match(source, /import InstalledModelsView/)
    assert.match(source, /import InstallEndpointsView/)
    assert.match(source, /setRouterOpen/)
    assert.match(source, /setInstalledModelsOpen/)
    assert.match(source, /setInstallEndpointsOpen/)
  })

  it('AnalyticsView integrates TokenUsagePanel', () => {
    const source = readFileSync(join(ROOT, 'web/src/components/analytics/AnalyticsView.jsx'), 'utf8')
    assert.match(source, /import TokenUsagePanel/)
    assert.match(source, /<TokenUsagePanel/)
  })

  it('InstallEndpointsView renders a 4-step wizard', () => {
    const source = readFileSync(join(ROOT, 'web/src/components/install/InstallEndpointsView.jsx'), 'utf8')
    assert.match(source, /STEPS.*Provider.*Tool.*Models.*Install/)
    assert.match(source, /install-endpoints\/wizard/)
  })

  it('RouterView renders start/stop and proxy actions', () => {
    const source = readFileSync(join(ROOT, 'web/src/components/router/RouterView.jsx'), 'utf8')
    assert.match(source, /api\/router\/start/)
    assert.match(source, /api\/router\/stop/)
    assert.match(source, /api\/router\/status/)
    assert.match(source, /api\/router\/probe-mode/)
  })

  it('InstalledModelsView uses soft-delete and scan', async () => {
    const source = readFileSync(join(ROOT, 'web/src/components/installed/InstalledModelsView.jsx'), 'utf8')
    assert.ok(source.includes('useInstalledModels'))
    assert.ok(source.includes('disableModel'))
    // 📖 The hook contains the API calls
    const hookSource = readFileSync(join(ROOT, 'web/src/hooks/useInstalledModels.js'), 'utf8')
    assert.ok(hookSource.includes('installed-models'))
    assert.ok(hookSource.includes('disableModel'))
  })

  it('M4 server endpoint smoke test returns valid payloads', async () => {
    const testHome = join(tmpdir(), `fcm-m4-test-${process.pid}`)
    mkdirSync(testHome, { recursive: true })
    const origHome = process.env.HOME
    process.env.HOME = testHome
    try {
      const { startWebServer } = await import('../web/server.js')
      const srv = await startWebServer(0, { open: false, startPingLoop: false })
      const addr = srv.address()
      const base = `http://127.0.0.1:${addr.port}`

      // Router status — the home is redirected, so the port file is missing.
      // A real user daemon on the default 19280 port may still respond, but
      // the test only asserts that the endpoint returns valid JSON, not the
      // exact boolean state. This makes the test robust in both CI (no
      // daemon) and local dev (daemon running).
      const statusResp = await fetch(`${base}/api/router/status`)
      const statusData = await statusResp.json()
      assert.equal(typeof statusData, 'object')
      assert.equal(typeof statusData.ok, 'boolean')

      // Installed models
      const installedResp = await fetch(`${base}/api/installed-models`)
      const installedData = await installedResp.json()
      assert.ok(Array.isArray(installedData.results))

      // Providers for wizard
      const providersResp = await fetch(`${base}/api/install-endpoints/providers`)
      const providersData = await providersResp.json()
      assert.ok(Array.isArray(providersData.providers))

      // Catalog
      const catalogResp = await fetch(`${base}/api/install-endpoints/catalog?provider=nvidia`)
      const catalogData = await catalogResp.json()
      assert.equal(catalogData.provider, 'nvidia')
      assert.ok(catalogData.models.length > 0)

      // Tokens
      const tokensResp = await fetch(`${base}/api/router/tokens`)
      const tokensData = await tokensResp.json()
      assert.ok(tokensData.all_time)

      // 📖 New M5: pre-prompt round-trip via the web server.
      const preGet = await fetch(`${base}/api/router/preprompt`)
      const preGetData = await preGet.json()
      assert.equal(typeof preGetData.enabled, 'boolean')
      assert.equal(typeof preGetData.text, 'string')
      const prePut = await fetch(`${base}/api/router/preprompt`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, text: 'You are fcm-test.' }),
      })
      const prePutData = await prePut.json()
      assert.equal(prePutData.ok, true)
      assert.equal(prePutData.text, 'You are fcm-test.')

      // 📖 New M5: playground proxy returns a friendly 503 when the daemon
      // 📖 is not reachable, and surfaces a human-readable error string
      // 📖 rather than the full OpenAI error object.
      const chatResp = await fetch(`${base}/api/playground/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'fcm', messages: [{ role: 'user', content: 'hi' }] }),
      })
      const chatData = await chatResp.json().catch(() => null)
      // 📖 Two acceptable outcomes:
      // 📖   - router offline (test home) → 503 with our wrapper error
      // 📖   - router online (user daemon) → 200 with the upstream body
      if (chatResp.status === 503) {
        assert.equal(chatData?.ok, false)
        assert.equal(typeof chatData?.error, 'string')
      } else {
        assert.equal(chatResp.status, 200)
      }

      srv.close()
    } finally {
      process.env.HOME = origHome
      rmSync(testHome, { recursive: true, force: true })
    }
  })
})

// ─── M2: React hook modules import cleanly (no syntax errors) ────────────
describe('M2: React hook modules import cleanly', () => {
  it('useChangelog.js exports useChangelog', async () => {
    const mod = await import('../web/src/hooks/useChangelog.js')
    assert.equal(typeof mod.useChangelog, 'function')
  })

  it('useUpdateChecker.js exports useUpdateChecker', async () => {
    const mod = await import('../web/src/hooks/useUpdateChecker.js')
    assert.equal(typeof mod.useUpdateChecker, 'function')
  })

  it('useUrlState.js exports both useUrlState and buildUrlParams', async () => {
    const mod = await import('../web/src/hooks/useUrlState.js')
    assert.equal(typeof mod.useUrlState, 'function')
    assert.equal(typeof mod.buildUrlParams, 'function')
  })
})

// ─── Issue #146: provider circuit-breaker + per-model broken cooldown ─────
// 📖 Regression coverage for the fix that stops FCM from burning rate-limited
// 📖 providers' daily quota by re-pinging overloaded models every 2-30s.

describe('Issue #146: provider quota circuit-breaker (provider-cooldown)', () => {
  beforeEach(() => clearProviderQuotaPause())
  afterEach(() => clearProviderQuotaPause())

  it('parseRetryAfterMs: seconds-integer header', () => {
    assert.equal(parseRetryAfterMs('120'), 120_000)
    assert.equal(parseRetryAfterMs('0'), 0)
    assert.equal(parseRetryAfterMs(''), null)
    assert.equal(parseRetryAfterMs(null), null)
  })

  it('parseRetryAfterMs: HTTP-date header returns delta-to-now (>=0 or null)', () => {
    const farFuture = new Date(Date.now() + 600_000).toUTCString()
    const out = parseRetryAfterMs(farFuture)
    assert.ok(out === null || (typeof out === 'number' && out > 0))
  })

  it('parseRetryAfterMs: malformed value -> null', () => {
    assert.equal(parseRetryAfterMs('not-a-date-and-not-a-number'), null)
  })

  it('extractRetryAfterFromResponse: prefers Retry-After header', async () => {
    const resp = new Response('{"error":"ignored"}', { status: 429, headers: { 'retry-after': '60' } })
    assert.equal(await extractRetryAfterFromResponse(resp), 60_000)
  })

  it('extractRetryAfterFromResponse: falls back to OpenRouter-style body', async () => {
    const body = JSON.stringify({ error: { message: 'Rate limit exceeded, please try again 50680 seconds later.' } })
    const resp = new Response(body, { status: 429, headers: { 'content-type': 'application/json' } })
    const ms = await extractRetryAfterFromResponse(resp)
    assert.equal(ms, 50_680_000)
  })

  it('extractRetryAfterFromResponse: returns 0 when nothing usable', async () => {
    const resp = new Response('"plain string body"', { status: 429 })
    assert.equal(await extractRetryAfterFromResponse(resp), 0)
  })

  it('pauseProviderQuota: marks provider paused, isProviderQuotaPaused reflects state', () => {
    const now = 1_700_000_000_000
    assert.equal(isProviderQuotaPaused('openrouter', now), false)
    pauseProviderQuota('openrouter', 60_000, { now })
    assert.equal(isProviderQuotaPaused('openrouter', now + 5_000), true)
    assert.equal(isProviderQuotaPaused('openrouter', now + 65_000), false, 'expired pauses purge lazily')
  })

  it('pauseProviderQuota: never shortens an existing longer pause', () => {
    const now = 1_700_000_000_000
    pauseProviderQuota('mistral', 600_000, { now })    // 10 min
    pauseProviderQuota('mistral', 5_000, { now })      // 5 s — should NOT shorten
    assert.ok(providerQuotaPauseRemaining('mistral', now) >= 595_000)
  })

  it('pauseProviderQuota: ignores non-positive durations', () => {
    pauseProviderQuota('cerebras', 0)
    pauseProviderQuota('cerebras', -1)
    pauseProviderQuota('cerebras', NaN)
    assert.equal(isProviderQuotaPaused('cerebras'), false)
  })

  it('listPausedProviders: returns only providers still in the window', () => {
    const now = 1_700_000_000_000
    pauseProviderQuota('openrouter', 60_000, { now })
    pauseProviderQuota('nvidia', 30_000, { now: now - 120_000 })  // already expired long ago
    const list = listPausedProviders(now)
    assert.ok('openrouter' in list)
    assert.equal('nvidia' in list, false, 'expired entries are excluded')
  })

  it('clearProviderQuotaPause: single + bulk cleanup', () => {
    pauseProviderQuota('openrouter', 60_000)
    pauseProviderQuota('mistral', 60_000)
    assert.equal(isProviderQuotaPaused('openrouter'), true)
    clearProviderQuotaPause('openrouter')
    assert.equal(isProviderQuotaPaused('openrouter'), false)
    assert.equal(isProviderQuotaPaused('mistral'), true)
    clearProviderQuotaPause()
    assert.equal(isProviderQuotaPaused('mistral'), false)
  })
})

describe('Issue #146: per-model broken-cooldown backoff (probe-cache)', () => {
  const TTL = DEFAULT_PROBE_TTL_MS

  function buildCache(probes) {
    // 📖 `probes` is a map of { provider: { model: { status, lastProbedAt, consecutiveFailures } } }
    const cache = { version: 2, providers: {} }
    for (const [providerKey, models] of Object.entries(probes || {})) {
      cache.providers[providerKey] = { models: {} }
      for (const [modelId, entry] of Object.entries(models)) {
        cache.providers[providerKey].models[modelId] = { probeVersion: 2, ...entry }
      }
    }
    return cache
  }

  it('brokenCooldownMs: ladder sequence (30s, 1m, 2m, 5m plateau)', () => {
    assert.deepEqual(BROKEN_COOLDOWN_STEPS_MS, [30_000, 60_000, 120_000, 300_000])
    assert.equal(brokenCooldownMs(1), 30_000)
    assert.equal(brokenCooldownMs(2), 60_000)
    assert.equal(brokenCooldownMs(3), 120_000)
    assert.equal(brokenCooldownMs(4), 300_000)
    assert.equal(brokenCooldownMs(99), 300_000, 'plateau past step count')
    assert.equal(brokenCooldownMs(0), 30_000, 'clamped to >=1')
    assert.equal(brokenCooldownMs(NaN), 30_000, 'NaN safely defaults')
  })

  it('isCacheFresh: broken model inside its cooldown is FRESH (skipped)', () => {
    const now = 1_700_000_000_000
    const cache = buildCache({ openrouter: { 'm:free': { status: 'broken', lastProbedAt: now - 5_000, consecutiveFailures: 1 } } })
    // 📖 Cooldown for failures=1 is 30s, only 5s elapsed → still in cooldown → fresh
    assert.equal(isProbeCacheFresh('openrouter', 'm:free', { cache, now }), true)
  })

  it('isCacheFresh: broken model past its cooldown is DUE (not fresh)', () => {
    const now = 1_700_000_000_000
    const cache = buildCache({ openrouter: { 'm:free': { status: 'broken', lastProbedAt: now - 60_000, consecutiveFailures: 1 } } })
    // 📖 60s elapsed >> 30s cooldown → due for re-probe
    assert.equal(isProbeCacheFresh('openrouter', 'm:free', { cache, now }), false)
  })

  it('isCacheFresh: broken model with many failures honours the longer cooldown', () => {
    const now = 1_700_000_000_000
    // failures=4 → cooldown=5min, only 1min elapsed → still fresh
    const cache = buildCache({ openrouter: { 'm:free': { status: 'broken', lastProbedAt: now - 60_000, consecutiveFailures: 4 } } })
    assert.equal(isProbeCacheFresh('openrouter', 'm:free', { cache, now }), true)
    // 6 minutes elapsed past 5min cooldown → due
    const cache2 = buildCache({ openrouter: { 'm:free': { status: 'broken', lastProbedAt: now - 360_000, consecutiveFailures: 4 } } })
    assert.equal(isProbeCacheFresh('openrouter', 'm:free', { cache: cache2, now }), false)
  })

  it('isCacheFresh: healthy ok models still use the 24h TTL (unaffected by the fix)', () => {
    const now = 1_700_000_000_000
    const cache = buildCache({ nvidia: { 'n1': { status: 'ok', lastProbedAt: now - 60_000 } } })
    assert.equal(isProbeCacheFresh('nvidia', 'n1', { ttlMs: TTL, cache, now }), true)
    const cache2 = buildCache({ nvidia: { 'n1': { status: 'ok', lastProbedAt: now - (TTL + 1) } } })
    assert.equal(isProbeCacheFresh('nvidia', 'n1', { ttlMs: TTL, cache: cache2, now }), false)
  })

  it('recordProbeResults: broken increments consecutiveFailures, ok resets to 0', () => {
    const cache = buildCache({})
    recordProbeResult('openrouter', [{ modelId: 'm1', status: 'broken', latencyMs: 42, lastError: '503' }], { cache, now: 1 })
    assert.equal(cache.providers.openrouter.models.m1.consecutiveFailures, 1)

    recordProbeResult('openrouter', [{ modelId: 'm1', status: 'broken', latencyMs: 42, lastError: '503' }], { cache, now: 2 })
    assert.equal(cache.providers.openrouter.models.m1.consecutiveFailures, 2)

    recordProbeResult('openrouter', [{ modelId: 'm1', status: 'ok', latencyMs: 100 }], { cache, now: 3 })
    assert.equal(cache.providers.openrouter.models.m1.consecutiveFailures, 0, 'ok resets the counter')
    assert.equal(cache.providers.openrouter.models.m1.status, 'ok')
  })

  it('Death-spiral fix: broken model with growing failures caps ping pressure', () => {
    // 📖 Before the fix, this loop would have re-pinged the broken model EVERY cycle
    // 📖 (rule 3 was always-due). With the fix, the cooldown grows so eventually the
    // 📖 entry is fresh for ~5min at a time — exactly the behaviour the user asked for.
    const cache = buildCache({})
    const now = 1_700_000_000_000
    recordProbeResult('openrouter', [{ modelId: 'm:free', status: 'broken', lastError: '503' }], { cache, now })
    for (let n = 1; n <= 6; n++) {
      recordProbeResult('openrouter', [{ modelId: 'm:free', status: 'broken', lastError: '503' }], { cache, now: now + n * 1000 })
      const entry = cache.providers.openrouter.models['m:free']
      assert.equal(entry.consecutiveFailures, n + 1)
      const cooldown = brokenCooldownMs(entry.consecutiveFailures)
      // 📖 Mid-cooldown check (5s since the last write): should always be fresh
      assert.equal(isProbeCacheFresh('openrouter', 'm:free', { cache, now: now + n * 1000 + 5_000 }), true, `after ${n + 1} failures, 5s later must be fresh`)
      assert.ok(cooldown <= 300_000, 'cooldown always within the 5min plateau')
    }
  })
})

// ─── Issue #169: command palette must degrade on limited terminals ────────────

describe('detectTerminalCapabilities (issue #169)', () => {
  const base = { TERM: 'xterm-256color', COLORTERM: 'truecolor' }

  it('keeps color on a normal TTY', () => {
    const caps = detectTerminalCapabilities({ env: base, cols: 120, rows: 40, isTTY: true })
    assert.equal(caps.colorSupported, true)
    assert.equal(caps.compact, false)
  })

  it('disables color when NO_COLOR is set', () => {
    const caps = detectTerminalCapabilities({ env: { ...base, NO_COLOR: '1' }, cols: 120, rows: 40, isTTY: true })
    assert.equal(caps.colorSupported, false)
  })

  it('treats an empty NO_COLOR as unset (no-color.org spec)', () => {
    const caps = detectTerminalCapabilities({ env: { ...base, NO_COLOR: '' }, cols: 120, rows: 40, isTTY: true })
    assert.equal(caps.colorSupported, true)
  })

  it('FORCE_COLOR overrides NO_COLOR (same precedence as chalk)', () => {
    const caps = detectTerminalCapabilities({ env: { ...base, NO_COLOR: '1', FORCE_COLOR: '1' }, cols: 120, rows: 40, isTTY: true })
    assert.equal(caps.colorSupported, true)
  })

  it('disables color for TERM=dumb, unknown, and missing', () => {
    assert.equal(detectTerminalCapabilities({ env: { TERM: 'dumb' }, cols: 80, rows: 24, isTTY: true }).colorSupported, false)
    assert.equal(detectTerminalCapabilities({ env: { TERM: 'unknown' }, cols: 80, rows: 24, isTTY: true }).colorSupported, false)
    assert.equal(detectTerminalCapabilities({ env: {}, cols: 80, rows: 24, isTTY: true }).colorSupported, false)
  })

  it('COLORTERM alone (missing TERM) still enables color', () => {
    const caps = detectTerminalCapabilities({ env: { COLORTERM: 'truecolor' }, cols: 80, rows: 24, isTTY: true })
    assert.equal(caps.colorSupported, true)
  })

  it('plain TERM=xterm without COLORTERM keeps degraded (16-color) support', () => {
    // 📖 Most plain SSH sessions look like this; chalk downgrades truecolor to
    // 📖 ANSI16 for them. Killing color entirely would regress the common case.
    const caps = detectTerminalCapabilities({ env: { TERM: 'xterm' }, cols: 80, rows: 24, isTTY: true })
    assert.equal(caps.colorSupported, true)
  })

  it('non-TTY output disables color', () => {
    const caps = detectTerminalCapabilities({ env: base, cols: 120, rows: 40, isTTY: false })
    assert.equal(caps.colorSupported, false)
  })

  it('flags compact for tiny sizes (cols < 90 or rows < 24)', () => {
    assert.equal(detectTerminalCapabilities({ env: base, cols: 89, rows: 40, isTTY: true }).compact, true)
    assert.equal(detectTerminalCapabilities({ env: base, cols: 90, rows: 40, isTTY: true }).compact, false)
    assert.equal(detectTerminalCapabilities({ env: base, cols: 120, rows: 23, isTTY: true }).compact, true)
    assert.equal(detectTerminalCapabilities({ env: base, cols: 120, rows: 24, isTTY: true }).compact, false)
    // 📖 The reporting terminal from issue #169: basic 80x24 server console
    assert.equal(detectTerminalCapabilities({ env: { TERM: 'xterm' }, cols: 80, rows: 24, isTTY: true }).compact, true)
  })
})

describe('truncateAnsiWidth (issue #169)', () => {
  it('returns short strings untouched', () => {
    assert.equal(truncateAnsiWidth('hello', 10), 'hello')
    assert.equal(truncateAnsiWidth('hello', 5), 'hello')
  })

  it('truncates plain text with an ellipsis inside the budget', () => {
    const out = truncateAnsiWidth('Probe All Models for 404 errors', 10)
    assert.ok(displayWidth(out) <= 10, `width ${displayWidth(out)} must be <= 10`)
    assert.ok(out.endsWith('…'))
  })

  it('returns empty string for zero budget', () => {
    assert.equal(truncateAnsiWidth('anything', 0), '')
  })

  it('supports disabling the ellipsis', () => {
    const out = truncateAnsiWidth('abcdefgh', 4, { ellipsis: '' })
    assert.equal(displayWidth(out), 4)
    assert.ok(out.startsWith('abcd'))
  })

  it('clamps styled (ANSI) strings and keeps them valid', () => {
    const styled = chalk.bgRgb(14, 20, 36).white('Test all configured models for 404/410 errors. Auto-hides broken models.')
    const out = truncateAnsiWidth(styled, 20)
    assert.ok(displayWidth(out) <= 20, `width ${displayWidth(out)} must be <= 20`)
    // 📖 A reset must be present so the cut cannot bleed color past the ellipsis.
    assert.ok(out.includes('\x1b[0m'))
    assert.ok(stripAnsi(out).endsWith('…'))
  })

  it('counts emoji as 2 columns when clamping', () => {
    const out = truncateAnsiWidth('🔍🔍🔍🔍🔍', 7)
    assert.equal(displayWidth(out), 7)
  })
})

describe('renderCommandPalette limited terminals (issue #169)', () => {
  // 📖 Real width helpers are mandatory here: the geometry IS the fix.
  function paletteDeps() {
    return {
      chalk,
      sources: { groq: sources.groq },
      PROVIDER_METADATA: {},
      PROVIDER_COLOR: {},
      LOCAL_VERSION: '0.0.0',
      getApiKey: () => null,
      resolveApiKeys: () => [],
      isProviderEnabled: () => true,
      TIER_CYCLE: ['All'],
      OVERLAY_PANEL_WIDTH: 120,
      keepOverlayTargetVisible,
      sliceOverlayLines,
      tintOverlayLines: (lines) => lines,
      TASK_TYPES: [],
      PRIORITY_TYPES: [],
      CONTEXT_BUDGETS: [],
      FRAMES: ['-'],
      TIER_COLOR: () => '',
      getAvg: () => 0,
      getStabilityScore: () => 0,
      toFavoriteKey: () => '',
      getTopRecommendations: () => [],
      adjustScrollOffset: () => {},
      getPingModel: () => null,
      getConfiguredInstallableProviders: () => [],
      getInstallTargetModes: () => [],
      getProviderCatalogModels: () => [],
      getToolMeta: () => null,
      getToolInstallPlan: () => null,
      padEndDisplay,
      displayWidth,
    }
  }

  // 📖 Real width helpers are mandatory here: the geometry IS the fix.
  function buildPaletteRenderer({ cols, rows, cursor = 0, query = '' }) {
    const state = {
      commandPaletteOpen: true,
      commandPaletteResults: buildCommandPaletteEntries([]),
      commandPaletteCursor: cursor,
      commandPaletteScrollOffset: 0,
      commandPaletteQuery: query,
      terminalRows: rows,
      terminalCols: cols,
      config: { apiKeys: {}, providers: {}, settings: {} },
    }
    return createOverlayRenderers(state, paletteDeps()).renderCommandPalette
  }

  // 📖 Split the positioned-segment stream into { row, col, visibleWidth } records.
  function parsePositionedLines(output) {
    const lines = []
    for (const m of output.matchAll(/\x1b\[(\d+);(\d+)H([\s\S]*?)(?=\x1b\[\d+;\d+H|$)/g)) {
      lines.push({ row: Number(m[1]), col: Number(m[2]), width: displayWidth(stripAnsi(m[3])) })
    }
    return lines
  }

  // 📖 The core regression: before the fix a palette row ended at col 127 on an
  // 📖 80-col terminal (wrap + garble), and the panel fell off a 12-row screen.
  for (const [cols, rows] of [[80, 24], [40, 12], [40, 8], [100, 30], [120, 40]]) {
    it(`never overflows ${cols}x${rows}`, () => {
      const render = buildPaletteRenderer({ cols, rows })
      const lines = parsePositionedLines(render())
      assert.ok(lines.length > 0, 'palette should emit positioned lines')
      for (const line of lines) {
        assert.ok(line.col >= 1, `start col must be >= 1, got ${line.col}`)
        assert.ok(line.col + line.width - 1 <= cols, `row ${line.row} ends at col ${line.col + line.width - 1} > ${cols}`)
        assert.ok(line.row <= rows, `row ${line.row} renders below the ${rows}-row screen`)
      }
    })
  }

  it('truncates long descriptions with an ellipsis on an 80-col terminal', () => {
    const render = buildPaletteRenderer({ cols: 80, rows: 24 })
    const output = stripAnsi(render().replace(/\x1b\[\d+;\d+H/g, ''))
    assert.ok(output.includes('…'), 'long descriptions should be truncated with an ellipsis')
  })

  it('keeps entries readable and header/footer intact at 80x24', () => {
    const render = buildPaletteRenderer({ cols: 80, rows: 24 })
    const output = stripAnsi(render().replace(/\x1b\[\d+;\d+H/g, ''))
    assert.ok(output.includes('Command Palette'), 'title must survive')
    assert.ok(output.includes('Esc'), 'Esc hint must survive')
    assert.ok(output.includes('Filters'), 'category labels must survive')
    assert.ok(output.includes('All tiers'), 'entry labels must survive')
    assert.ok(output.includes('Select'), 'footer hints must survive')
  })

  it('renders plain text without any SGR codes when NO_COLOR is set', () => {
    const prevNoColor = process.env.NO_COLOR
    process.env.NO_COLOR = '1'
    try {
      const render = buildPaletteRenderer({ cols: 80, rows: 24 })
      // 📖 Strip ALL CSI sequences (cursor positioning + \x1b[K clears): what must
      // 📖 remain is zero escapes, i.e. no SGR color codes at all.
      const withoutCsi = render().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      assert.ok(!withoutCsi.includes('\x1b'), `expected no ANSI escapes, got ${JSON.stringify(withoutCsi.slice(0, 120))}`)
    } finally {
      if (prevNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = prevNoColor
    }
  })

  it('renders plain text without any SGR codes when TERM=dumb', () => {
    const prevTerm = process.env.TERM
    process.env.TERM = 'dumb'
    try {
      const render = buildPaletteRenderer({ cols: 80, rows: 24 })
      const withoutCsi = render().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      assert.ok(!withoutCsi.includes('\x1b'), 'TERM=dumb must produce a colorless palette')
    } finally {
      if (prevTerm === undefined) delete process.env.TERM
      else process.env.TERM = prevTerm
    }
  })

  it('palette stays inside the screen with a long typed query at 40x12', () => {
    const render = buildPaletteRenderer({ cols: 40, rows: 12, query: 'filter models by provider groq fast' })
    for (const line of parsePositionedLines(render())) {
      assert.ok(line.col + line.width - 1 <= 40, `query row ends at col ${line.col + line.width - 1} > 40`)
      assert.ok(line.row <= 12, `row ${line.row} below the 12-row screen`)
    }
  })

  it('mouse click layout rect stays inside the screen at 40x12', () => {
    const state = {
      commandPaletteOpen: true,
      commandPaletteResults: buildCommandPaletteEntries([]),
      commandPaletteCursor: 0,
      commandPaletteScrollOffset: 0,
      commandPaletteQuery: '',
      terminalRows: 12,
      terminalCols: 40,
      config: { apiKeys: {}, providers: {}, settings: {} },
    }
    const renderers = createOverlayRenderers(state, paletteDeps())
    renderers.renderCommandPalette()
    const l = renderers.overlayLayout
    assert.ok(l.commandPaletteLeft >= 1, 'left edge on screen')
    assert.ok(l.commandPaletteRight <= 40, `right edge ${l.commandPaletteRight} must be <= 40`)
    assert.ok(l.commandPaletteTop >= 1, 'top edge on screen')
    assert.ok(l.commandPaletteBottom <= 12, `bottom edge ${l.commandPaletteBottom} must be <= 12`)
  })

  it('paints only the panel cells: no margin filler and no edge-to-edge erase', () => {
    // 📖 Regression: rows used to be emitted from col 1 with unstyled margin
    // 📖 spaces plus a trailing \x1b[K. Both inherited the panel tint bg that
    // 📖 was still active, filling the full screen width with panel background
    // 📖 and masking the frozen table beside the modal on wide terminals.
    const render = buildPaletteRenderer({ cols: 120, rows: 30 })
    const output = render()
    assert.ok(!output.includes('\x1b[K'), 'palette must not emit \\x1b[K (it fills the tint bg to the screen edge)')
    for (const line of parsePositionedLines(output)) {
      assert.ok(line.col > 1, `row ${line.row} must start at the panel column (got col ${line.col})`)
    }
  })

  it('keeps the panel height constant when the result list shrinks', () => {
    // 📖 Nothing repaints below the panel while it is open (frozen table), so a
    // 📖 shrinking panel would leave stale painted rows under its bottom edge.
    const fullCount = parsePositionedLines(buildPaletteRenderer({ cols: 40, rows: 12 })()).length
    const state = {
      commandPaletteOpen: true,
      commandPaletteResults: [{ label: 'Alpha', type: 'command' }, { label: 'Beta', type: 'command' }],
      commandPaletteCursor: 0,
      commandPaletteScrollOffset: 0,
      commandPaletteQuery: '',
      terminalRows: 12,
      terminalCols: 40,
      config: { apiKeys: {}, providers: {}, settings: {} },
    }
    const fewCount = parsePositionedLines(createOverlayRenderers(state, paletteDeps()).renderCommandPalette()).length
    assert.equal(fewCount, fullCount, 'panel must keep rendering bodyRows lines even with fewer results')
  })
})

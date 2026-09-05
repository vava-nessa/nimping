/**
 * @file provider-key-tester.js
 * @description Shared provider API key verification logic used by both TUI and Web surfaces.
 *
 * @details
 *   This module extracts the key-testing pipeline that was previously embedded in
 *   `src/tui/key-handler.js` so the Web Dashboard's `/api/key/:provider/test` endpoint
 *   can use the exact same strategy without duplicating code.
 *
 *   Pipeline overview:
 *   1. Fast path — parallel auth-only probes (3×8 s) to `/v1/account` or `/v1/models`.
 *      Decisive: 200 → key valid, 401/403 → key rejected. Timeouts fall through.
 *   2. Slow path — optional live `/models` discovery, then parallel chat-completion
 *      pings against candidate model IDs (up to 10 attempts, 5 parallel).
 *
 *   → Functions:
 *   - `testProviderKeyDirect`  — fast auth-only check
 *   - `buildProviderModelsUrl`  — derive `/models` from `/chat/completions`
 *   - `parseProviderModelIds`   — extract ids from OpenAI `/models` response
 *   - `listProviderTestModels`  — build ordered candidate list
 *   - `classifyProviderTestOutcome` — map HTTP codes to outcome label
 *   - `buildProviderTestDetail` — human-readable failure explanation
 *   - `runProviderKeyTest`     — full async pipeline, returns result object
 *
 * @exports testProviderKeyDirect, buildProviderModelsUrl, parseProviderModelIds,
 *          listProviderTestModels, classifyProviderTestOutcome, buildProviderTestDetail,
 *          runProviderKeyTest, PROVIDER_AUTH_ENDPOINTS
 */

import { ping } from './ping.js'
import { sleep } from './shared-helpers.js'

// ─── Constants ────────────────────────────────────────────────────────────────

// 📖 Some providers need an explicit probe model because the first catalog entry
// 📖 is not guaranteed to be accepted by their chat endpoint.
export const PROVIDER_TEST_MODEL_OVERRIDES = {
  sambanova: ['MiniMax-M2.5', 'DeepSeek-V3.1', 'DeepSeek-V3.2'],
  nvidia: ['deepseek-ai/deepseek-v4-flash-0731', 'openai/gpt-oss-120b'],
  'github-models': ['openai/gpt-4.1-mini'],
  mistral: ['mistral-small-latest', 'devstral-small-latest'],
}

// 📖 Settings key tests retry retryable failures across several models so a
// 📖 single stale catalog entry or transient timeout does not mark a valid key as dead.
const SETTINGS_TEST_MAX_ATTEMPTS = 10
const SETTINGS_TEST_RETRY_DELAY_MS = 4000
const SETTINGS_TEST_PARALLEL_PROBES = 5

// 📖 PROVIDER_AUTH_ENDPOINTS maps provider keys to their auth-check URL + method.
// 📖 For most providers this is the /models endpoint (returns 200=valid, 401=invalid).
// 📖 Providers without an auth-check endpoint use null (falls back to chat completion ping).
// 📖 Special cases:
// 📖   - replicate: uses /v1/predictions (not /models) but needs a different payload
// 📖   - cloudflare: no auth endpoint — only has chat completions, always uses ping fallback
export const PROVIDER_AUTH_ENDPOINTS = {
  nvidia:       { url: 'https://api.nvidia.com/v1/account',           method: 'GET' },
  groq:         { url: 'https://api.groq.com/v1/models',             method: 'GET' },
  cerebras:     { url: 'https://api.cerebras.ai/v1/models',          method: 'GET' },
  sambanova:    { url: 'https://api.sambanova.ai/v1/models',         method: 'GET' },
  openrouter:   { url: 'https://openrouter.ai/api/v1/key',           method: 'GET' },
  mistral:      { url: 'https://api.mistral.ai/v1/models',           method: 'GET' },
  huggingface:  { url: 'https://router.huggingface.co/v1/models',    method: 'GET' },
  deepinfra:    { url: 'https://api.deepinfra.com/v1/models',        method: 'GET' },
  fireworks:    { url: 'https://api.fireworks.ai/v1/models',         method: 'GET' },
  hyperbolic:   { url: 'https://api.hyperbolic.xyz/v1/models',       method: 'GET' },
  scaleway:     { url: 'https://api.scaleway.ai/v1/models',          method: 'GET' },
  siliconflow:  { url: 'https://api.siliconflow.cn/v1/models',     method: 'GET' },
  pollinations: null,
  requesty:     null,
  orcarouter:   { url: 'https://api.orcarouter.ai/v1/models',   method: 'GET' },
  'vercel-gateway': { url: 'https://ai-gateway.vercel.sh/v1/models', method: 'GET' },
  together:     { url: 'https://api.together.xyz/v1/models',        method: 'GET' },
  perplexity:   { url: 'https://api.perplexity.ai/v1/models',       method: 'GET' },
  chutes:       { url: 'https://chutes.ai/v1/models',               method: 'GET' },
  ovhcloud:     { url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models', method: 'GET' },
  qwen:         { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models', method: 'GET' },
  iflow:        { url: 'https://apis.iflow.cn/v1/models',            method: 'GET' },
  'github-models': null,
  replicate:    null,
  cloudflare:   null,
  zai:          null,
  googleai:     null,
  'opencode-zen': null,
  kilo:         { url: 'https://api.kilo.ai/api/gateway/models', method: 'GET' },
  llm7:         { url: 'https://api.llm7.io/v1/models', method: 'GET' },
  routeway:     { url: 'https://api.routeway.ai/v1/models', method: 'GET' },
  novita:       { url: 'https://api.novita.ai/openai/v1/models', method: 'GET' },
  'ollama-cloud': { url: 'https://ollama.com/v1/models', method: 'GET' },
}

// ─── Auth-only fast probe ────────────────────────────────────────────────────

/**
 * 📖 testProviderKeyDirect: Fast auth-only check using /v1/account or /v1/models.
 * 📖 Fires 3 parallel probes to get a fast decisive result (auth error vs timeout vs 200).
 * 📖 Returns { code, ms } from the first non-timeout response, or the best available.
 * @param {string} apiKey
 * @param {string} providerKey
 * @returns {Promise<{ code: number|string, ms: number|string } | null>}
 */
export async function testProviderKeyDirect(apiKey, providerKey) {
  const authConfig = PROVIDER_AUTH_ENDPOINTS[providerKey]
  if (!authConfig) return null

  const { url, method } = authConfig
  const headers = { Authorization: `Bearer ${apiKey}` }
  if (providerKey === 'openrouter' || providerKey === 'orcarouter') {
    headers['HTTP-Referer'] = 'https://github.com/vava-nessa/free-coding-models'
    headers['X-Title'] = 'free-coding-models'
  }

  const parallel = 3
  const promises = Array.from({ length: parallel }, async () => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const t0 = performance.now()
    try {
      const resp = await fetch(url, { method, headers, signal: ctrl.signal })
      return { code: resp.status, ms: Math.round(performance.now() - t0) }
    } catch (err) {
      const isTimeout = err.name === 'AbortError'
      return { code: isTimeout ? '000' : 'ERR', ms: isTimeout ? 'TIMEOUT' : Math.round(performance.now() - t0) }
    } finally {
      clearTimeout(timer)
    }
  })

  const results = await Promise.all(promises)
  const success = results.find(r => r.code === 200)
  if (success) return success
  const authFailure = results.find(r => r.code === 401 || r.code === 403)
  if (authFailure) return authFailure
  return results[0]
}

// ─── Model discovery helpers ─────────────────────────────────────────────────

/**
 * 📖 buildProviderModelsUrl derives the matching `/models` endpoint for providers
 * 📖 that expose an OpenAI-compatible model list next to `/chat/completions`.
 * @param {string} url
 * @returns {string|null}
 */
export function buildProviderModelsUrl(url) {
  if (typeof url !== 'string' || !url.includes('/chat/completions')) return null
  return url.replace(/\/chat\/completions$/, '/models')
}

/**
 * 📖 parseProviderModelIds extracts ids from a standard OpenAI-style `/models` response.
 * 📖 Invalid payloads return an empty list so the key-test flow can safely fall back.
 * @param {unknown} data
 * @returns {string[]}
 */
export function parseProviderModelIds(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.data)) return []
  return data.data
    .map(entry => (entry && typeof entry.id === 'string') ? entry.id.trim() : '')
    .filter(Boolean)
}

/**
 * 📖 listProviderTestModels builds the ordered probe list used by the Settings `T` key.
 * 📖 Order matters:
 * 📖 1. provider-specific known-good overrides
 * 📖 2. discovered `/models` ids that also exist in this repo
 * 📖 3. all discovered `/models` ids
 * 📖 4. repo static model ids as final fallback
 * @param {string} providerKey
 * @param {{ models?: Array<[string, string, string, string, string]> } | undefined} src
 * @param {string[]} [discoveredModelIds=[]]
 * @returns {string[]}
 */
export function listProviderTestModels(providerKey, src, discoveredModelIds = []) {
  const staticModelIds = Array.isArray(src?.models) ? src.models.map(model => model[0]).filter(Boolean) : []
  const staticModelSet = new Set(staticModelIds)
  const preferredDiscoveredIds = discoveredModelIds.filter(modelId => staticModelSet.has(modelId))
  const orderedCandidates = [
    ...(PROVIDER_TEST_MODEL_OVERRIDES[providerKey] ?? []),
    ...preferredDiscoveredIds,
    ...discoveredModelIds,
    ...staticModelIds,
  ]
  return [...new Set(orderedCandidates)]
}

// ─── Outcome classification ──────────────────────────────────────────────────

/**
 * 📖 classifyProviderTestOutcome maps attempted probe codes to a user-facing test result.
 * @param {string[]} codes
 * @returns {'ok'|'auth_error'|'rate_limited'|'no_callable_model'|'fail'}
 */
export function classifyProviderTestOutcome(codes) {
  if (codes.includes('200')) return 'ok'
  if (codes.includes('401') || codes.includes('403')) return 'auth_error'
  if (codes.length > 0 && codes.every(code => code === '429')) return 'rate_limited'
  if (codes.length > 0 && codes.every(code => code === '404' || code === '410')) return 'no_callable_model'
  return 'fail'
}

/**
 * 📖 buildProviderTestDetail explains why the probe failed, with enough context
 * 📖 for the user to know whether the key, model list, or provider quota is the problem.
 * @param {string} providerLabel
 * @param {string} outcome
 * @param {Array<{attempt: number, model: string, code: string}>} [attempts=[]]
 * @param {string} [discoveryNote='']
 * @returns {string}
 */
export function buildProviderTestDetail(providerLabel, outcome, attempts = [], discoveryNote = '') {
  const introByOutcome = {
    missing_key: `${providerLabel} has no saved API key right now, so no authenticated test could be sent.`,
    ok: `${providerLabel} accepted the key.`,
    auth_error: `${providerLabel} rejected the configured key with an authentication error.`,
    rate_limited: `${providerLabel} throttled every probe, so the key may still be valid but is currently rate-limited.`,
    no_callable_model: `${providerLabel} answered the requests, but none of the probed models were callable on its chat endpoint.`,
    fail: `${providerLabel} never returned a successful probe during the retry window.`,
  }

  const hintsByOutcome = {
    missing_key: 'Save the key with Enter in Settings, then rerun T.',
    ok: attempts.length > 0 ? `Validated on ${attempts[attempts.length - 1].model}.` : 'The provider returned a success response.',
    auth_error: 'This usually means the saved key is invalid, expired, revoked, or truncated before it reached disk.',
    rate_limited: 'Wait for the provider quota window to reset, then rerun T.',
    no_callable_model: 'The provider catalog or repo defaults likely drifted; try another model family or refresh the catalog.',
    fail: 'This can be caused by timeouts, 5xx responses, or a provider-side outage.',
  }

  const attemptSummary = attempts.length > 0
    ? `Attempts: ${attempts.map(({ attempt, model, code }) => `#${attempt} ${model} -> ${code}`).join(' | ')}`
    : 'Attempts: none'

  const segments = [
    introByOutcome[outcome] || introByOutcome.fail,
    hintsByOutcome[outcome] || hintsByOutcome.fail,
    discoveryNote,
    attemptSummary,
  ].filter(Boolean)

  return segments.join(' ')
}

// ─── Full pipeline ───────────────────────────────────────────────────────────

/**
 * 📖 runProviderKeyTest: Pure async function that verifies an API key for a provider.
 *
 * 📖 Used by both the TUI Settings `T` key and the Web Dashboard's
 * 📖 `/api/key/:provider/test` endpoint. Returns a result object instead of
 * 📖 mutating TUI state so each surface can decide how to display it.
 *
 * @param {string} apiKey — the API key to test
 * @param {string} providerKey — e.g. 'openrouter', 'groq'
 * @param {{ name?: string, url?: string, models?: Array<[string, string, string, string, string]> }} source — provider entry from sources.js
 * @param {object} [options]
 * @param {number} [options.maxAttempts=10]
 * @param {number} [options.parallelProbes=5]
 * @param {number} [options.retryDelayMs=4000]
 * @param {Function} [options.onProgress] — optional callback({ attempts, maxAttempts }) for live updates
 * @returns {Promise<{ outcome: string, detail: string, attempts: Array, discoveryNote: string }>}
 */
export async function runProviderKeyTest(apiKey, providerKey, source, options = {}) {
  const {
    maxAttempts = SETTINGS_TEST_MAX_ATTEMPTS,
    parallelProbes = SETTINGS_TEST_PARALLEL_PROBES,
    retryDelayMs = SETTINGS_TEST_RETRY_DELAY_MS,
    onProgress,
  } = options

  const providerLabel = source?.name || providerKey

  // 📖 Fast path: parallel auth-only probes (3×8s) to /v1/account or /v1/models.
  const authResult = await testProviderKeyDirect(apiKey, providerKey)
  if (authResult) {
    if (authResult.code === 200) {
      return {
        outcome: 'ok',
        detail: buildProviderTestDetail(providerLabel, 'ok', [], 'Auth-only probe returned HTTP 200.'),
        attempts: [],
        discoveryNote: 'Auth-only probe returned HTTP 200.',
      }
    }
    if (authResult.code === 401 || authResult.code === 403) {
      return {
        outcome: 'auth_error',
        detail: buildProviderTestDetail(providerLabel, 'auth_error', [], `Auth probe returned HTTP ${authResult.code}.`),
        attempts: [],
        discoveryNote: `Auth probe returned HTTP ${authResult.code}.`,
      }
    }
    // 📖 Timeout or ERR — fall through to ping-based approach below.
  }

  // 📖 Slow path: ping-based verification (providers without auth endpoint or timeouts).
  const discoveredModelIds = []
  const modelsUrl = buildProviderModelsUrl(source?.url)
  let discoveryNote = ''

  if (modelsUrl) {
    try {
      const headers = { Authorization: `Bearer ${apiKey}` }
      if (providerKey === 'openrouter') {
        headers['HTTP-Referer'] = 'https://github.com/vava-nessa/free-coding-models'
        headers['X-Title'] = 'free-coding-models'
      }
      const modelsResp = await fetch(modelsUrl, {
        headers,
        // 📖 Same 8s ceiling as the fast-path probes so discovery can never hang.
        signal: AbortSignal.timeout(8000),
      })
      if (modelsResp.ok) {
        const data = await modelsResp.json()
        discoveredModelIds.push(...parseProviderModelIds(data))
        discoveryNote = discoveredModelIds.length > 0
          ? `Live model discovery returned ${discoveredModelIds.length} ids.`
          : 'Live model discovery succeeded but returned no callable ids.'
      } else {
        discoveryNote = `Live model discovery returned HTTP ${modelsResp.status}; falling back to the repo catalog.`
      }
    } catch (err) {
      // 📖 AbortSignal.timeout rejects with TimeoutError; treat it like the fast-path timeout.
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      discoveryNote = timedOut
        ? 'Live model discovery timed out; falling back to the repo catalog.'
        : `Live model discovery failed (${err?.name || 'error'}); falling back to the repo catalog.`
    }
  }

  const candidateModels = listProviderTestModels(providerKey, source, discoveredModelIds)
  if (candidateModels.length === 0) {
    return {
      outcome: 'fail',
      detail: buildProviderTestDetail(providerLabel, 'fail', [], discoveryNote || 'No candidate model was available for probing.'),
      attempts: [],
      discoveryNote: discoveryNote || 'No candidate model was available for probing.',
    }
  }

  // 📖 Parallel ping burst: fire probes simultaneously to get fast feedback.
  const attempts = []
  let settled = false

  while (!settled) {
    const batch = []
    for (let i = 0; i < parallelProbes && attempts.length + batch.length < maxAttempts; i++) {
      const testModel = candidateModels[(attempts.length + batch.length) % candidateModels.length]
      batch.push(
        ping(apiKey, testModel, providerKey, source.url)
          .then(({ code }) => ({ attempt: attempts.length + batch.length + 1, model: testModel, code }))
      )
    }
    const batchResults = await Promise.all(batch)
    attempts.push(...batchResults)

    if (onProgress) onProgress({ attempts: attempts.length, maxAttempts })

    // 📖 Check outcome after each parallel batch.
    const outcome = classifyProviderTestOutcome(attempts.map(({ code }) => code))
    if (outcome === 'ok' || outcome === 'auth_error') {
      settled = true
      continue
    }
    if (attempts.length >= maxAttempts) {
      settled = true
      continue
    }

    // 📖 Pause before next round.
    await sleep(retryDelayMs)
  }

  const finalOutcome = classifyProviderTestOutcome(attempts.map(({ code }) => code))
  return {
    outcome: finalOutcome,
    detail: buildProviderTestDetail(providerLabel, finalOutcome, attempts, discoveryNote),
    attempts,
    discoveryNote,
  }
}

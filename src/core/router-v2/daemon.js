/**
 * @file router-v2/daemon.js
 * @description Smart Model Router v2 (BETA) - hardened local failover daemon.
 *
 * @details
 *   📖 v2 is a parallel router that runs NEXT TO v1 (own port, own state
 *   files, shared config/sets/keys) so the v1 behavior ships users already
 *   rely on is never touched while v2 matures. Point a coding tool at
 *   `http://localhost:19380/v1` with `model: "fcm"` and v2 routes every
 *   request through the hardened failover engine.
 *
 *   📖 What v2 fixes over v1 (the short list):
 *   1. Content-level failure detection: a 200 with empty choices, an embedded
 *      error object, or no real content fails over instead of "succeeding".
 *      Streaming gets a readiness gate: an SSE error frame before any content
 *      fails over BEFORE bytes reach the client, and a content-less stream
 *      close is a real failure.
 *   2. Non-streaming body reads are timeout-protected (a trickle-feeding
 *      upstream can no longer hang a request forever).
 *   3. Quota-aware routing: rate-limited models are paused (Retry-After
 *      aware) and skipped until the pause expires.
 *   4. Blame attribution: client-caused 4xx (400/413/422 ...) fail over but
 *      never damage healthy models' circuits; client disconnects never
 *      mark failures at all.
 *   5. Circuit breakers persist across daemon restarts, have a DEGRADED
 *      warning state (60% of threshold) and escalating backoff per re-trip.
 *   6. Every request carries a decision trace (skips + attempts + outcome),
 *      exposed via `x-fcm-v2-*` response headers and a persisted request
 *      history the TUI + web dashboards render.
 *   7. Listens BEFORE the first probe pass: no more first-boot black hole.
 *   8. `x-api-key` client headers are stripped before proxying upstream.
 *   9. Cumulative retry budget per request (attempts + wall-clock cap).
 *  10. Global last-resort model: optional config escape hatch when the whole
 *      set fails (`router.failover.lastResortModel: "provider/model"`).
 *  11. Anthropic `/v1/messages` protocol support (stream + non-stream).
 *  12. `model: "fcm:@provider/modelId"` pins one model through the FULL
 *      chain: this is what "test via router" uses, so tests exercise the
 *      same path production traffic does.
 *
 * @functions
 *   → runRouterV2Daemon() - Start the foreground v2 daemon
 *   → startRouterV2DaemonBackground() - Spawn v2 detached and wait for /health
 *   → stopRouterV2Daemon() - SIGTERM the recorded v2 daemon
 *   → getRouterV2DaemonStatus() - Discover + read /health from v2
 *   → createRouterV2RuntimeForTest() - Isolated runtime for mock-upstream tests
 *
 * @exports runRouterV2Daemon, startRouterV2DaemonBackground, stopRouterV2Daemon
 * @exports getRouterV2DaemonStatus, createRouterV2RuntimeForTest
 *
 * @see ../router-daemon.js - v1 daemon (untouched) and shared pure helpers
 * @see ./failure-classifier.js - typed failure verdicts
 * @see ./response-gate.js - 200-body + SSE content validation
 * @see ./breaker-store.js - persisted breakers with DEGRADED state
 * @see ./request-history.js - persisted request history
 * @see ./anthropic-compat.js - /v1/messages translation layer
 */

import { createServer } from 'node:http'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fork, execFileSync } from 'node:child_process'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { MODELS, sources } from '../../../sources.js'
import {
  CONFIG_PATH,
  DEFAULT_ROUTER_SETTINGS,
  loadConfig,
  normalizeRouterConfig,
  saveConfig,
} from '../config.js'
import { buildChatCompletionPingBody, resolveCloudflareUrl, shouldUseDisabledThinkingForProvider } from '../ping.js'
import { sendUsageTelemetry } from '../telemetry.js'
import { TIER_ORDER } from '../utils.js'
import {
  atomicWriteJson,
  safeJsonParse,
  sleep,
  isRouteableProvider,
} from '../shared-helpers.js'
import { normalizeRequestBody } from '../schema-normalizer.js'
import { pickNextCandidate } from '../model-family.js'
import {
  loadCache as loadProbeCache,
  flushCache as flushProbeCache,
  recordProbeResults as recordProbeCacheResults,
  getCacheStats as getProbeCacheStats,
  isCacheFresh as isProbeCacheFresh,
} from '../probe-cache.js'
import {
  processResponseHeaders as processPassiveQuotaHeaders,
  getAllQuotas as getAllPassiveQuotas,
} from '../provider-quota-fetchers.js'
import {
  recordModelCall as recordRuntimeModelCall,
  getAllModelTelemetry as getAllRuntimeTelemetry,
  getCacheStats as getRuntimeCacheStats,
  loadRuntimeTelemetry,
  flushRuntimeTelemetry as flushRuntimeTelemetryStore,
  pruneStaleEntries as pruneRuntimeTelemetry,
} from '../runtime-telemetry.js'
// 📖 v1 shares its pure helpers with v2 (exports only, zero behavior change).
import {
  buildDefaultRouterSet,
  buildDefaultRouterSetSync,
  buildRouterSetFromFavorites,
  getProcessCommand,
  listenWithFallback,
  applyPrePromptToBody,
  attachClientAbort,
  buildUpstreamMeta,
  extractUsage,
  formatOpenAiError,
  getApiModelId,
  isAllowedHostHeader,
  isAuthorizedForV1,
  isLikelyHtmlResponse,
  isLikelyHtmlText,
  isLoopbackHostname,
  isProcessAlive,
  isSameOriginOrLocal,
  modelKey,
  normalizeToolCallsResponse,
  nowIso,
  parseJsonResult,
  readJsonBody,
  readNumberFile,
  resolveProviderUrl,
  RouterLogger,
  sendError,
  sendJson,
  TokenTracker,
} from '../router-daemon.js'
import { classifyFailure, classifyStatus, clientStatusForKind, FAILURE_KINDS } from './failure-classifier.js'
import { validateChatCompletionPayload, createStreamReadinessTracker, estimateTokens } from './response-gate.js'
import { createDecisionTrace, traceSkip, traceAttempt, finishTrace, decisionHeaderValue, traceSummary } from './decision-trace.js'
import { BreakerStore } from './breaker-store.js'
import { RequestHistory } from './request-history.js'
import {
  anthropicErrorPayload,
  anthropicErrorTypeForStatus,
  createAnthropicStreamTransformer,
  translateAnthropicToOpenAI,
  translateOpenAIToAnthropicResponse,
} from './anthropic-compat.js'
import {
  getRouterV2PidPath,
  getRouterV2PortPath,
  getRouterV2LogPath,
  getRouterV2PortRange,
  getRouterV2BreakersPath,
  getRouterV2HistoryPath,
  getRouterV2TokensPath,
  parseFcmModel,
} from './constants.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY_PATH = join(__dirname, '..', '..', '..', 'bin', 'free-coding-models.js')
const LOCAL_VERSION = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')).version
const MAX_BODY_BYTES = 10 * 1024 * 1024
const MAX_HISTORY_ENTRIES = 500
const MAX_SSE_CLIENTS = 10
const MAX_CONCURRENT_REQUESTS = 50
const MAX_PROBE_WINDOW = 20
const MAX_RECENT_TRACES = 50
const TOKEN_FLUSH_INTERVAL_MS = 60000
const CONFIG_RELOAD_INTERVAL_MS = 10000
const STATS_RETENTION_DAYS = 90
const AUTH_STATUS_CODES = new Set([401, 403])
// 📖 v2 default knobs. These extend (never replace) the shared failover
// settings; users override them in ~/.free-coding-models.json under
// `router.failover` and v2 reads the raw values because the shared
// normalizer only knows the v1 field names.
const DEFAULT_BODY_READ_TIMEOUT_MS = 30000
const DEFAULT_TOTAL_BUDGET_MS = 120000
const DEFAULT_CONTENT_VALIDATION = 'strict'
const DEFAULT_QUOTA_PAUSE_MS = 60000
const MAX_CONCURRENT_QUEUE_RETRY_AFTER_S = 3

function clampInt(value, fallback, { min, max }) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

// 📖 v2 header sanitizer: like v1's cloneHeadersForUpstream but ALSO strips
// `x-api-key` (the local router token can arrive under that name and must
// never be relayed to an upstream provider) and any client-sent `x-fcm-*`.
function cloneHeadersForUpstreamV2(reqHeaders, apiKey, providerKey) {
  const headers = {}
  for (const [key, value] of Object.entries(reqHeaders || {})) {
    const lower = key.toLowerCase()
    if (['host', 'connection', 'content-length', 'authorization', 'cookie', 'x-api-key'].includes(lower)) continue
    if (lower.startsWith('x-fcm-') || lower === 'x-request-id') continue
    if (typeof value !== 'string') continue
    if (lower === 'content-type') {
      headers['Content-Type'] = value
      continue
    }
    headers[key] = value
  }
  headers['Content-Type'] = headers['Content-Type'] || 'application/json'
  headers.Authorization = `Bearer ${apiKey}`
  if (providerKey === 'openrouter' || providerKey === 'orcarouter') {
    headers['HTTP-Referer'] = 'https://github.com/vava-nessa/free-coding-models'
    headers['X-Title'] = 'free-coding-models'
  }
  return headers
}

// 📖 Read the upstream body under a hard deadline. v1 cleared the request
// timeout as soon as headers arrived, so a provider that trickled the body
// could hang an agent forever; the streaming path had a stall guard but the
// JSON path had none. v2 races the body read against `bodyReadTimeoutMs`.
async function readBodyWithTimeout(response, controller, timeoutMs) {
  let timer = null
  try {
    return await Promise.race([
      response.text(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { controller.abort() } catch {}
          reject(Object.assign(new Error('upstream_body_read_timeout'), { name: 'BodyReadTimeoutError' }))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function getAllowedOriginsV2() {
  return (process.env.FCM_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// 📖 v2 adds CORS for loopback (and explicitly allowed) origins so a browser
// dashboard served from another local port (web dashboard 3333, v1 daemon
// 19280) can call this daemon directly without a proxy.
function applyCors(req, res) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
  if (!origin) return
  let hostname = ''
  try {
    hostname = new URL(origin).hostname
  } catch {
    return
  }
  const allowed = isLoopbackHostname(hostname) || getAllowedOriginsV2().includes(origin)
  if (!allowed) return
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-request-id, anthropic-version')
  res.setHeader('Access-Control-Max-Age', '600')
}

function parseLastResortModel(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const slashIdx = trimmed.indexOf('/')
  if (slashIdx <= 0 || slashIdx === trimmed.length - 1) return null
  return { provider: trimmed.slice(0, slashIdx), model: trimmed.slice(slashIdx + 1), key: trimmed }
}

class RouterV2Runtime {
  constructor({ config, port, logger, paths = {}, persistConfig = true }) {
    this.config = config
    this.port = port
    this.logger = logger
    this.persistConfig = persistConfig
    this.startedAt = Date.now()
    this.inFlight = 0
    this.shuttingDown = false
    this.crashRecovered = 0
    this.uncaughtTimestamps = []
    this.server = null
    this.configReloadTimer = null
    this.tokenFlushTimer = null
    this.probeTimer = null
    this.probeWatchdog = null
    this.probeTimeouts = new Set()
    this.modelCatalog = this.buildModelCatalog()
    this.probeWindows = new Map()
    // 📖 Persisted subsystems: breakers survive restarts, request history
    // survives restarts, token counters are v2-scoped so the two daemons
    // never fight over one file.
    this.breakers = new BreakerStore({ path: paths.breakers, logger })
    this.history = new RequestHistory({ path: paths.history, logger, maxEntries: MAX_HISTORY_ENTRIES })
    this.tokenTracker = new TokenTracker(paths.tokens, logger)
    this.activeRequests = new Map()
    this.sseClients = new Set()
    this.lastProbeAt = null
    this.totalRequestsRouted = 0
    this.quotaPauses = new Map()
    this.recentTraces = []
    // 📖 Provider whose models are ALL excluded for the rest of one request
    // after an auth failure (the failed key would 401 on every model anyway).
    this.probeCache = loadProbeCache()
    this.probeCacheDirty = false
    this.probeCacheFlushTimer = null
    loadRuntimeTelemetry()
    pruneRuntimeTelemetry(30 * 24 * 60 * 60 * 1000)
    this.runtimeTelemetryDirty = false
    this.runtimeTelemetryFlushTimer = null
    this.refreshRouteState()
  }

  buildModelCatalog() {
    const catalog = new Map()
    for (const [providerKey, source] of Object.entries(sources)) {
      if (!Array.isArray(source.models)) continue
      for (const [modelId, label, tier, sweScore, ctx] of source.models) {
        catalog.set(modelKey(providerKey, modelId), {
          providerKey,
          modelId,
          label,
          tier,
          sweScore,
          ctx,
          routeable: isRouteableProvider(providerKey, sources),
        })
      }
    }
    return catalog
  }

  refreshRouteState() {
    const router = this.routerConfig()
    this.logger.level = router.logLevel
    for (const set of Object.values(router.sets || {})) {
      for (const model of set.models || []) {
        const key = modelKey(model.provider, model.model)
        if (!this.probeWindows.has(key)) this.probeWindows.set(key, [])
        this.breakers.ensure(key, router.circuitBreaker.initialCooldownMs)
        const catalogEntry = this.modelCatalog.get(key)
        if (!catalogEntry) {
          this.logger.warn(`${key} is no longer in the catalog and will be skipped`)
        }
      }
    }
  }

  // 📖 v2-specific failover knobs read from the RAW config (the shared
  // normalizer only knows the v1 fields and would silently drop these).
  failoverSettings() {
    const normalized = this.routerConfig().failover
    const raw = (this.config?.router?.failover && typeof this.config.router.failover === 'object')
      ? this.config.router.failover
      : {}
    const validation = raw.contentValidation
    return {
      ...normalized,
      bodyReadTimeoutMs: clampInt(raw.bodyReadTimeoutMs, DEFAULT_BODY_READ_TIMEOUT_MS, { min: 5000, max: 300000 }),
      totalBudgetMs: clampInt(raw.totalBudgetMs, DEFAULT_TOTAL_BUDGET_MS, { min: 10000, max: 600000 }),
      contentValidation: ['strict', 'basic', 'off'].includes(validation) ? validation : DEFAULT_CONTENT_VALIDATION,
      lastResortModel: parseLastResortModel(raw.lastResortModel),
    }
  }

  routerConfig() {
    const normalized = normalizeRouterConfig(this.config.router)
    if (normalized) return normalized
    const defaultSet = buildDefaultRouterSetSync(this.config)
    return normalizeRouterConfig({
      ...DEFAULT_ROUTER_SETTINGS,
      enabled: true,
      onboardingSeen: true,
      activeSet: defaultSet.name,
      sets: { [defaultSet.name]: defaultSet },
    })
  }

  setRouterConfigShared(router) {
    // 📖 v2 stores the shared router config in memory only while in beta;
    // v1 remains the owner of set mutations + auto-heal. v2 reloads from
    // disk every CONFIG_RELOAD_INTERVAL_MS so edits stay in sync.
    this.config.router = normalizeRouterConfig(router)
    this.refreshRouteState()
  }

  reloadConfigFromDisk() {
    try {
      const nextConfig = loadConfig()
      // 📖 v1's reload runs ensureRouterConfigForDaemon, which REBUILDS the
      // router section from DEFAULT_ROUTER_SETTINGS and silently discards any
      // user failover tuning on every 10s tick (requestTimeoutMs, stalls,
      // v2-only fields like contentValidation). v2 just reads the file raw:
      // routerConfig() normalizes on read and defaults cover missing fields,
      // so user settings survive reloads.
      this.config = nextConfig
      this.refreshRouteState()
      this.scheduleProbeLoop()
      this.broadcast('config', { activeSet: this.routerConfig().activeSet })
      this.logger.debug('Router v2 config reloaded from disk')
    } catch (error) {
      this.logger.warn('Config reload failed; keeping in-memory config', { error: error.message })
    }
  }

  getApiKeyForProvider(providerKey) {
    const configured = this.config?.apiKeys?.[providerKey]
    if (Array.isArray(configured)) return configured.find(Boolean) || null
    if (typeof configured === 'string' && configured.trim()) return configured.trim()
    return null
  }

  getSet(setName = null) {
    const router = this.routerConfig()
    const name = setName || router.activeSet
    return router.sets?.[name] || null
  }

  listSetModels(set) {
    return [...(set?.models || [])].sort((a, b) => a.priority - b.priority)
  }

  // ─── Health: probe windows + breaker store + quota pauses ─────────────────

  recordProbeResult(key, result) {
    const window = this.probeWindows.get(key) || []
    window.push({ ...result, at: Date.now() })
    while (window.length > MAX_PROBE_WINDOW) window.shift()
    this.probeWindows.set(key, window)
    this.lastProbeAt = Date.now()
    this.broadcast('probe', {
      model: key,
      status: result.ok ? 'ok' : 'fail',
      latency_ms: result.latencyMs ?? null,
      circuit_state: this.breakers.get(key)?.state || 'UNKNOWN',
    })
    const slashIdx = key.indexOf('/')
    if (slashIdx > 0) {
      recordProbeCacheResults(key.slice(0, slashIdx), [{
        modelId: key.slice(slashIdx + 1),
        status: result.ok ? 'ok' : 'broken',
        latencyMs: result.latencyMs ?? null,
        lastError: result.ok ? null : (result.code != null ? String(result.code) : 'error'),
      }])
      this.probeCacheDirty = true
      this.scheduleProbeCacheFlush()
    }
  }

  scheduleProbeCacheFlush() {
    if (this.probeCacheFlushTimer) return
    this.probeCacheFlushTimer = setTimeout(() => {
      this.probeCacheFlushTimer = null
      if (this.probeCacheDirty) {
        flushProbeCache()
        this.probeCacheDirty = false
      }
    }, 2000)
    if (typeof this.probeCacheFlushTimer.unref === 'function') this.probeCacheFlushTimer.unref()
  }

  breakerParams() {
    const cb = this.routerConfig().circuitBreaker
    return {
      failureThreshold: cb.failureThreshold,
      initialCooldownMs: cb.initialCooldownMs,
      maxCooldownMs: cb.maxCooldownMs,
      backoffMultiplier: cb.backoffMultiplier,
    }
  }

  markSuccess(key, latencyMs = null) {
    this.breakers.markSuccess(key, this.routerConfig().circuitBreaker.initialCooldownMs)
    this.quotaPauses.delete(key)
    this.recordProbeResult(key, { ok: true, latencyMs, code: 200 })
    this.broadcast('circuit', { model: key, state: 'CLOSED' })
  }

  // 📖 Single funnel from a failure verdict to health state: circuit damage,
  // quota pause, provider blocking and probe-window recording all derive
  // from the classifier's policy instead of ad-hoc per-path bookkeeping.
  applyFailureVerdict(key, verdict, { detail, statusCode = null, latencyMs = null, meta = {} } = {}) {
    if (verdict.kind === FAILURE_KINDS.AUTH) {
      this.breakers.markFailure(key, { ...this.breakerParams(), detail, statusCode, authError: true })
      this.broadcast('circuit', { model: key, state: 'AUTH_ERROR', reason: detail })
    } else if (verdict.healthDamage) {
      const result = this.breakers.markFailure(key, { ...this.breakerParams(), detail, statusCode })
      this.broadcast('circuit', {
        model: key,
        state: result.state,
        opened: result.opened,
        degraded: result.degraded,
        reason: detail,
      })
      if (result.opened) this.logger.warn(`Circuit opened for ${key}`, { reason: detail })
      else if (result.degraded) this.logger.warn(`Circuit DEGRADED for ${key}`, { reason: detail })
    } else {
      // 📖 No health damage (client-caused 4xx): remember the reason for the
      // dashboards but never push the breaker toward OPEN.
      const breaker = this.breakers.ensure(key, this.routerConfig().circuitBreaker.initialCooldownMs)
      breaker.lastError = detail
    }
    if (verdict.quotaPauseMs != null && verdict.quotaPauseMs > 0) {
      this.quotaPauses.set(key, {
        model: key,
        until: Date.now() + verdict.quotaPauseMs,
        retry_after_ms: verdict.quotaPauseMs,
        status: statusCode,
        rate_limit_headers: meta.rateLimitHeaders || {},
        last_seen: nowIso(),
      })
    } else if (verdict.kind === FAILURE_KINDS.RATE_LIMIT || verdict.kind === FAILURE_KINDS.QUOTA) {
      // 📖 429 without a usable Retry-After still gets a default pause so a
      // burst of 429s cannot keep routing into a wall.
      this.quotaPauses.set(key, {
        model: key,
        until: Date.now() + DEFAULT_QUOTA_PAUSE_MS,
        retry_after_ms: DEFAULT_QUOTA_PAUSE_MS,
        status: statusCode,
        rate_limit_headers: meta.rateLimitHeaders || {},
        last_seen: nowIso(),
      })
    } else if (meta.quotaExhausted) {
      this.quotaPauses.set(key, {
        model: key,
        until: Date.now() + DEFAULT_QUOTA_PAUSE_MS,
        retry_after_ms: null,
        status: statusCode,
        rate_limit_headers: meta.rateLimitHeaders || {},
        last_seen: nowIso(),
      })
    }
    this.recordProbeResult(key, { ok: false, latencyMs, code: statusCode || 'ERR', error: detail })
  }

  quotaPauseActive(key) {
    const pause = this.quotaPauses.get(key)
    if (!pause) return false
    if (Date.now() >= pause.until) {
      this.quotaPauses.delete(key)
      return false
    }
    return true
  }

  quotaPausesForKeys(keys) {
    return keys
      .map((key) => this.quotaPauses.get(key))
      .filter(Boolean)
  }

  recordRuntimeCall({ providerKey, modelId, success, latencyMs, usage, error }) {
    if (!providerKey || !modelId) return
    recordRuntimeModelCall(providerKey, modelId, {
      success: !!success,
      latencyMs: typeof latencyMs === 'number' && Number.isFinite(latencyMs) ? latencyMs : 0,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      stopReason: success ? 'stop' : null,
      error: success ? null : (error || 'unknown'),
    })
    this.runtimeTelemetryDirty = true
    this.scheduleRuntimeTelemetryFlush()
  }

  scheduleRuntimeTelemetryFlush() {
    if (this.runtimeTelemetryFlushTimer) return
    this.runtimeTelemetryFlushTimer = setTimeout(() => {
      this.runtimeTelemetryFlushTimer = null
      if (this.runtimeTelemetryDirty) {
        flushRuntimeTelemetryStore()
        this.runtimeTelemetryDirty = false
      }
    }, 5000)
    if (typeof this.runtimeTelemetryFlushTimer.unref === 'function') this.runtimeTelemetryFlushTimer.unref()
  }

  getWindowStats(key) {
    const window = this.probeWindows.get(key) || []
    const successes = window.filter((entry) => entry.ok && Number.isFinite(entry.latencyMs))
    const sortedLatencies = successes.map((entry) => entry.latencyMs).sort((a, b) => a - b)
    const p95 = sortedLatencies.length > 0
      ? sortedLatencies[Math.max(0, Math.ceil(sortedLatencies.length * 0.95) - 1)]
      : null
    return {
      total: window.length,
      successful: successes.length,
      uptime: window.length > 0 ? successes.length / window.length : null,
      p95,
      last: window[window.length - 1] || null,
    }
  }

  scoreCandidates(set) {
    const models = this.listSetModels(set)
    const maxP95 = Math.max(
      1,
      ...models
        .map((entry) => this.getWindowStats(modelKey(entry.provider, entry.model)).p95)
        .filter((value) => Number.isFinite(value)),
    )
    const weights = this.routerConfig().scoring
    return models.map((entry) => {
      const key = modelKey(entry.provider, entry.model)
      const stats = this.getWindowStats(key)
      const hasData = stats.total > 0
      const latencyScore = stats.p95 === null ? 0.5 : Math.max(0, 1 - (stats.p95 / maxP95))
      const uptimeScore = stats.uptime === null ? 0.5 : stats.uptime
      const score = hasData
        ? (weights.latencyWeight * latencyScore) + (weights.uptimeWeight * uptimeScore)
        : 0.5
      const breaker = this.breakers.evaluate(key) || {}
      return {
        ...entry,
        key,
        score,
        stats,
        circuit: breaker,
        catalog: this.modelCatalog.get(key) || null,
      }
    })
  }

  // 📖 The ordered attempt list for the next request. Every exclusion is
  // recorded as a `skip` on the caller's decision trace so "why did it not
  // try my model?" is always answerable from the dashboard.
  getRoutingCandidates(set, { trace = null, blockedProviders = null } = {}) {
    const scored = this.scoreCandidates(set)
    const usable = []
    for (const candidate of scored) {
      if (blockedProviders?.has(candidate.provider)) {
        traceSkip(trace, candidate.key, 'provider_blocked')
        continue
      }
      if (!candidate.catalog || candidate.circuit?.stale) {
        traceSkip(trace, candidate.key, 'stale')
        continue
      }
      if (!candidate.catalog.routeable || candidate.circuit?.unsupported) {
        traceSkip(trace, candidate.key, 'unsupported')
        continue
      }
      if (candidate.circuit?.authError) {
        traceSkip(trace, candidate.key, 'auth_error')
        continue
      }
      if (!this.getApiKeyForProvider(candidate.provider)) {
        traceSkip(trace, candidate.key, 'missing_key')
        continue
      }
      if (this.quotaPauseActive(candidate.key)) {
        traceSkip(trace, candidate.key, 'quota_paused')
        continue
      }
      const state = candidate.circuit?.state || 'UNKNOWN'
      if (state !== 'CLOSED' && state !== 'HALF_OPEN' && state !== 'DEGRADED') {
        traceSkip(trace, candidate.key, state === 'OPEN' ? 'circuit_open' : 'circuit_state')
        continue
      }
      usable.push(candidate)
    }
    const stateOrder = { CLOSED: 0, DEGRADED: 1, HALF_OPEN: 2 }
    const comparator = (a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      const aState = a.circuit?.state || 'UNKNOWN'
      const bState = b.circuit?.state || 'UNKNOWN'
      if (aState !== bState) {
        const aRank = stateOrder[aState] ?? 3
        const bRank = stateOrder[bState] ?? 3
        return aRank - bRank
      }
      return b.score - a.score
    }
    return usable.sort(comparator)
  }

  getRoutingOrder(set) {
    return this.getRoutingCandidates(set).map((candidate) => ({
      key: candidate.key,
      provider: candidate.provider,
      model: candidate.model,
      priority: candidate.priority,
      state: candidate.circuit?.state || 'UNKNOWN',
      score: Number(candidate.score.toFixed(4)),
    }))
  }

  // 📖 Health projection for /stats and the dashboards. Includes DEGRADED
  // (amber) and quota pauses with their expiry so "why is my model skipped?"
  // has a visible answer.
  getModelHealth(set = this.getSet()) {
    return this.scoreCandidates(set || { models: [] }).map((candidate) => {
      const breaker = candidate.circuit || {}
      const paused = this.quotaPauses.get(candidate.key)
      const state = breaker.authError
        ? 'AUTH_ERROR'
        : !candidate.catalog
          ? 'STALE'
          : (candidate.catalog && !candidate.catalog.routeable)
            ? 'UNSUPPORTED'
            : this.quotaPauseActive(candidate.key)
              ? 'QUOTA_PAUSED'
              : breaker.state || 'UNKNOWN'
      return {
        provider: candidate.provider,
        model: candidate.model,
        key: candidate.key,
        priority: candidate.priority,
        state,
        score: Number(candidate.score.toFixed(4)),
        last_latency_ms: candidate.stats.last?.latencyMs ?? null,
        uptime: candidate.stats.uptime,
        last_error: breaker.lastError || null,
        quota_paused_until: paused ? new Date(paused.until).toISOString() : null,
      }
    })
  }

  // ─── Probes ────────────────────────────────────────────────────────────────

  // 📖 v2 dropped v1's eco shortcut (GET /models): it verified the API key,
  // never the model, so a 404ing model probed "ok" in eco mode. Eco now just
  // means a longer interval between real 1-token chat pings.
  async probeCandidate(candidate) {
    const key = modelKey(candidate.provider, candidate.model)
    const apiKey = this.getApiKeyForProvider(candidate.provider)
    if (!apiKey) {
      this.breakers.markFailure(key, { ...this.breakerParams(), detail: 'missing API key', authError: true })
      this.recordProbeResult(key, { ok: false, latencyMs: null, code: 'NOKEY' })
      return
    }
    const providerUrl = resolveProviderUrl(candidate.provider)
    if (!providerUrl) {
      this.breakers.markFailure(key, { ...this.breakerParams(), detail: 'provider URL unresolvable' })
      this.recordProbeResult(key, { ok: false, latencyMs: null, code: 'NOURL' })
      return
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    const started = performance.now()
    try {
      const response = await fetch(providerUrl, {
        method: 'POST',
        headers: cloneHeadersForUpstreamV2({}, apiKey, candidate.provider),
        body: JSON.stringify(buildChatCompletionPingBody(
          getApiModelId(candidate.provider, candidate.model),
          { stream: false },
          { disableThinking: shouldUseDisabledThinkingForProvider(candidate.provider) }
        )),
        signal: controller.signal,
      })
      const latencyMs = Math.round(performance.now() - started)
      if (response.ok) {
        const meta = buildUpstreamMeta(response, '', candidate.provider)
        if (isLikelyHtmlResponse(response.headers, '')) {
          this.applyFailureVerdict(key, classifyFailure({ kind: FAILURE_KINDS.HTML }), { detail: 'probe: html maintenance', statusCode: 503, meta })
          return
        }
        // 📖 Probe the body too: a 200 with an error object must not probe ok.
        const text = await readBodyWithTimeout(response, controller, DEFAULT_BODY_READ_TIMEOUT_MS)
        const parsed = parseJsonResult(text)
        const gate = parsed.ok ? validateChatCompletionPayload(parsed.value, { mode: 'basic' }) : { ok: false, reason: 'invalid_json' }
        if (!gate.ok) {
          this.applyFailureVerdict(key, classifyFailure({ kind: FAILURE_KINDS[gateReasonToKind(gate.reason)] || FAILURE_KINDS.INVALID_JSON }), {
            detail: `probe: ${gate.reason}`,
            statusCode: 200,
          })
          return
        }
        this.markSuccess(key)
        this.recordProbeResult(key, { ok: true, latencyMs, code: response.status })
        this.logger.info(`Probe ok ${key} - ${latencyMs}ms`)
      } else {
        const meta = buildUpstreamMeta(response, '', candidate.provider)
        const verdict = classifyFailure({ status: response.status, retryAfterMs: meta.retryAfterMs })
        this.applyFailureVerdict(key, verdict, { detail: `probe: HTTP ${response.status}`, statusCode: response.status, meta })
        this.recordProbeResult(key, { ok: false, latencyMs, code: response.status })
      }
    } catch (error) {
      const detail = error.name === 'AbortError' ? 'probe timeout' : error.message
      this.applyFailureVerdict(key, classifyFailure({ kind: FAILURE_KINDS.TIMEOUT }), { detail })
    } finally {
      clearTimeout(timeout)
    }
  }

  async runProbeBurst() {
    const set = this.getSet()
    if (!set) return
    const candidates = this.scoreCandidates(set)
      .filter((candidate) => candidate.catalog?.routeable && !candidate.circuit?.stale)
      .filter((c) => {
        if (!c.catalog) return true
        return !isProbeCacheFresh(c.catalog.providerKey, c.catalog.modelId)
      })
    await Promise.allSettled(candidates.map((candidate) => this.probeCandidate(candidate)))
  }

  scheduleProbeLoop() {
    if (this.probeTimer) clearInterval(this.probeTimer)
    if (this.probeWatchdog) clearInterval(this.probeWatchdog)
    for (const timeout of this.probeTimeouts) clearTimeout(timeout)
    this.probeTimeouts.clear()

    const router = this.routerConfig()
    const interval = router.probeIntervals[router.probeMode] || DEFAULT_ROUTER_SETTINGS.probeIntervals.balanced
    this.lastProbeAt = Date.now()

    this.probeTimer = setInterval(() => {
      try {
        const set = this.getSet()
        if (!set || this.shuttingDown) return
        const candidates = this.scoreCandidates(set)
          .filter((candidate) => candidate.catalog?.routeable && !candidate.circuit?.stale)
        const stagger = candidates.length > 0 ? Math.max(250, Math.floor(interval / candidates.length)) : interval
        candidates.forEach((candidate, index) => {
          const timeout = setTimeout(() => {
            this.probeTimeouts.delete(timeout)
            void this.probeCandidate(candidate)
          }, index * stagger)
          timeout.unref?.()
          this.probeTimeouts.add(timeout)
        })
        this.lastProbeAt = Date.now()
      } catch (err) {
        this.logger.error('[ProbeLoop] error', { error: err })
      }
    }, interval)
    this.probeTimer.unref?.()

    this.probeWatchdog = setInterval(() => {
      if (this.lastProbeAt && Date.now() - this.lastProbeAt > interval * 3) {
        this.logger.warn('[ProbeLoop] stall detected, restarting probe loop')
        this.scheduleProbeLoop()
      }
    }, interval)
    this.probeWatchdog.unref?.()
  }

  // ─── Observability ────────────────────────────────────────────────────────

  rememberTrace(trace) {
    this.recentTraces.push(trace)
    while (this.recentTraces.length > MAX_RECENT_TRACES) this.recentTraces.shift()
  }

  historyEntryFromTrace(trace, { stream = false, set = null } = {}) {
    return {
      request_id: trace.request_id,
      at: trace.at,
      set: set || trace.set,
      protocol: trace.protocol,
      model_requested: trace.model_requested,
      pinned_model: trace.pinned_model,
      served_model: trace.served_model,
      outcome: trace.outcome,
      attempts: trace.attempts,
      skipped: trace.skipped,
      wall_ms: trace.wall_ms,
      tokens: trace.tokens,
      stream,
      last_resort_used: trace.last_resort_used,
      summary: traceSummary(trace),
    }
  }

  decisionHeaders(trace) {
    const lastModel = trace.attempts.length > 0 ? trace.attempts[trace.attempts.length - 1].model : 'none'
    return {
      'x-fcm-v2-model': trace.served_model || lastModel,
      'x-fcm-v2-attempts': String(trace.attempts.length),
      'x-fcm-v2-decision': decisionHeaderValue(trace),
      'x-request-id': trace.request_id,
    }
  }

  sendProtocolError(res, protocol, statusCode, message, requestId, extra = {}) {
    if (protocol === 'anthropic') {
      sendJson(res, statusCode, anthropicErrorPayload(anthropicErrorTypeForStatus(statusCode), message), {
        'x-request-id': requestId,
        ...extra.headers,
      })
      return
    }
    sendError(res, statusCode, message, 'service_unavailable', extra.code || 'router_error', requestId, extra.payload)
  }

  broadcast(event, payload) {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const client of [...this.sseClients]) {
      try {
        client.write(message)
      } catch {
        this.sseClients.delete(client)
      }
    }
  }

  tryOpenSseConnection(req, res, requestId) {
    if (!isSameOriginOrLocal(req)) {
      sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
      return false
    }
    if (this.sseClients.size >= MAX_SSE_CLIENTS) {
      sendError(res, 503, 'Too many dashboard clients', 'service_unavailable', 'too_many_sse_clients', requestId)
      return false
    }
    return true
  }

  // ─── Status payloads ──────────────────────────────────────────────────────

  statusPayload() {
    const router = this.routerConfig()
    const activeSet = this.getSet(router.activeSet)
    const stateCounts = { CLOSED: 0, DEGRADED: 0, OPEN: 0, HALF_OPEN: 0, AUTH_ERROR: 0, QUOTA_PAUSED: 0 }
    for (const model of this.getModelHealth(activeSet)) {
      if (stateCounts[model.state] !== undefined) stateCounts[model.state] += 1
    }
    return {
      ok: true,
      running: true,
      router: 'v2',
      beta: true,
      version: LOCAL_VERSION,
      pid: process.pid,
      port: this.port,
      enabled: router.enabled,
      activeSet: router.activeSet,
      activeModelCount: activeSet?.models?.length || 0,
      setCount: Object.keys(router.sets || {}).length,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      requestsRouted: this.totalRequestsRouted,
      inFlight: this.inFlight,
      shuttingDown: this.shuttingDown,
      probeMode: router.probeMode,
      lastProbeAt: this.lastProbeAt ? new Date(this.lastProbeAt).toISOString() : null,
      failover: {
        maxRetries: this.routerConfig().failover.maxRetries,
        requestTimeoutMs: this.routerConfig().failover.requestTimeoutMs,
        bodyReadTimeoutMs: this.failoverSettings().bodyReadTimeoutMs,
        totalBudgetMs: this.failoverSettings().totalBudgetMs,
        contentValidation: this.failoverSettings().contentValidation,
        lastResortModel: this.failoverSettings().lastResortModel?.key || null,
      },
      modelStates: stateCounts,
      quotaPauses: this.quotaPausesForKeys([...this.quotaPauses.keys()]).map((p) => ({
        model: p.model,
        until: new Date(p.until).toISOString(),
        retry_after_ms: p.retry_after_ms,
      })),
      probeCache: getProbeCacheStats(),
      quota: Object.fromEntries(getAllPassiveQuotas()),
      history: this.history.stats(),
      runtimeTelemetry: {
        stats: getRuntimeCacheStats(),
        models: getAllRuntimeTelemetry(),
      },
      configPath: CONFIG_PATH,
    }
  }

  statsPayload() {
    const router = this.routerConfig()
    const activeSet = this.getSet(router.activeSet)
    return {
      ...this.statusPayload(),
      tokens: this.tokenTracker.summary(),
      models: this.getModelHealth(activeSet),
      routingOrder: this.getRoutingOrder(activeSet),
      breakers: this.breakers.snapshot(),
      traces: this.recentTraces.slice(-20).map((trace) => this.historyEntryFromTrace(trace)),
      requestLog: this.history.recent(20),
    }
  }

  // ─── Routing core ─────────────────────────────────────────────────────────

  resolvePinnedCandidate(pinned) {
    const key = modelKey(pinned.provider, pinned.model)
    const catalog = this.modelCatalog.get(key)
    if (!catalog) return { error: `Unknown model: ${key}` }
    if (!isRouteableProvider(pinned.provider, sources)) return { error: `Provider is not routeable: ${pinned.provider}` }
    if (!this.getApiKeyForProvider(pinned.provider)) return { error: `No API key configured for ${pinned.provider}` }
    const breaker = this.breakers.get(key) || {}
    return {
      candidate: {
        provider: pinned.provider,
        model: pinned.model,
        priority: 1,
        key,
        score: 0,
        stats: this.getWindowStats(key),
        circuit: breaker,
        catalog,
      },
    }
  }

  async routeRequest({ req, res, body, setName, requestId, protocol = 'openai', anthropicModelName = null }) {
    const trace = createDecisionTrace({
      requestId,
      set: setName || this.routerConfig().activeSet,
      protocol,
      modelRequested: body?.model || 'fcm',
    })
    const started = Date.now()

    // 📖 v2 lifecycle fix: all rejection guards run BEFORE the active-request
    // entry is created, and the entry is only alive inside the try/finally.
    // v1 created the entry first, so every validation early-return leaked a
    // ghost "active request" into /stats until the daemon restarted.
    if (this.shuttingDown) {
      this.sendProtocolError(res, protocol, 503, 'Daemon is shutting down', requestId)
      finishTrace(trace, { outcome: 'rejected', wallMs: Date.now() - started })
      this.rememberTrace(trace)
      return
    }
    if (this.inFlight >= MAX_CONCURRENT_REQUESTS) {
      this.sendProtocolError(res, protocol, 503, 'Router overloaded, too many concurrent requests', requestId, {
        code: 'router_overloaded',
        headers: { 'Retry-After': String(MAX_CONCURRENT_QUEUE_RETRY_AFTER_S) },
      })
      finishTrace(trace, { outcome: 'overloaded', wallMs: Date.now() - started })
      this.rememberTrace(trace)
      return
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendError(res, 400, 'Request body must be a JSON object', 'invalid_request_error', 'invalid_json_object', requestId)
      finishTrace(trace, { outcome: 'rejected', wallMs: Date.now() - started })
      this.rememberTrace(trace)
      return
    }
    if (typeof body.model !== 'string' || !body.model.trim()) {
      sendError(res, 400, 'Missing required field: model', 'invalid_request_error', 'missing_model', requestId)
      finishTrace(trace, { outcome: 'rejected', wallMs: Date.now() - started })
      this.rememberTrace(trace)
      return
    }

    // 📖 Model spec resolution: `fcm` (active set), `fcm:<setName>`,
    // `fcm:@provider/model` (pinned single-model test, failover disabled).
    const spec = parseFcmModel(body.model)
    let set = null
    let pinned = null
    if (spec.kind === 'pinned') {
      pinned = spec.pinned
      set = this.getSet(null)
      if (!set) {
        this.sendProtocolError(res, protocol, 503, 'No active router set', requestId, { code: 'set_not_found' })
        finishTrace(trace, { outcome: 'rejected', wallMs: Date.now() - started })
        this.rememberTrace(trace)
        return
      }
      trace.pinned_model = `${pinned.provider}/${pinned.model}`
    } else {
      const requestedSetName = spec.kind === 'set' ? spec.set : setName
      set = this.getSet(requestedSetName)
      if (!set) {
        sendError(res, 404, `Router set not found: ${requestedSetName || this.routerConfig().activeSet}`, 'invalid_request_error', 'set_not_found', requestId)
        finishTrace(trace, { outcome: 'rejected', wallMs: Date.now() - started })
        this.rememberTrace(trace)
        return
      }
    }

    const settings = this.failoverSettings()
    const maxAttempts = pinned ? 1 : Math.min(1 + this.routerConfig().failover.maxRetries, 6)
    const deadline = Date.now() + settings.totalBudgetMs
    const stream = body.stream === true

    this.inFlight += 1
    const activeReq = {
      requestId,
      at: Date.now(),
      model: body.model,
      current_model: null,
      attempts: 0,
      tokens: 0,
      stalled: false,
      last_activity_at: Date.now(),
    }
    this.activeRequests.set(requestId, activeReq)
    try {
      let candidates
      if (pinned) {
        // 📖 Pinned tests deliberately bypass availability pre-skips (circuit
        // OPEN, quota pause): the whole point is a genuine attempt that feeds
        // real health data back into the breakers.
        const resolved = this.resolvePinnedCandidate(pinned)
        if (resolved.error) {
          this.sendProtocolError(res, protocol, 400, resolved.error, requestId, { code: 'invalid_model' })
          finishTrace(trace, { outcome: 'rejected', wallMs: Date.now() - started })
          return
        }
        candidates = [resolved.candidate]
      } else {
        candidates = this.getRoutingCandidates(set, { trace })
      }

      if (candidates.length === 0) {
        this.sendAllModelsUnavailable(res, trace, set, requestId, protocol)
        return
      }

      const tried = []
      const failedKinds = []
      const blockedProviders = new Set()
      let attemptIndex = 0
      const attemptChain = candidates.slice()

      for (let index = 0; index < attemptChain.length && attemptIndex < maxAttempts; index += 1) {
        if (Date.now() > deadline) {
          this.logger.warn('Request retry budget exhausted; failing over to error', { request_id: requestId })
          break
        }
        const candidate = attemptChain[index]
        if (blockedProviders.has(candidate.provider)) continue

        activeReq.current_model = candidate.key
        activeReq.attempts = attemptIndex + 1
        tried.push(candidate.key)
        traceAttempt(trace, candidate.key, { status: null })

        const result = stream
          ? await this.proxyStreamingRequest({ req, res, body, candidate, requestId, attemptIndex, protocol, trace, anthropicModelName })
          : await this.proxyJsonRequest({ req, res, body, candidate, requestId, attemptIndex, protocol, trace })

        trace.attempts[trace.attempts.length - 1] = {
          ...trace.attempts[trace.attempts.length - 1],
          model: candidate.key,
          status: result.status ?? null,
          latency_ms: result.latencyMs ?? null,
          error: result.reason || null,
          at: new Date().toISOString(),
        }
        if (result.verdict) failedKinds.push(result.verdict.kind)
        if (result.done) return
        attemptIndex += 1
        if (result.verdict?.blockProvider) blockedProviders.add(candidate.provider)

        if (result.failoverToNext && attemptIndex < maxAttempts) {
          const pick = pickNextCandidate({
            candidates: attemptChain,
            failedCandidate: candidate,
            triedKeys: new Set(tried),
            blockedProviders,
            familyFailover: set.familyFailover !== false,
          })
          const next = pick?.candidate || null
          if (next && attemptChain[index + 1] !== next) {
            const nextIndex = attemptChain.indexOf(next)
            if (nextIndex > index) {
              attemptChain.splice(nextIndex, 1)
              attemptChain.splice(index + 1, 0, next)
            }
          }
          this.logger.warn(
            `Failover ${candidate.key}${next ? ` -> ${next.key}` : ''}${pick?.reason === 'family_failover' ? ' [family]' : ''}`,
            { request_id: requestId, reason: result.reason },
          )
          void sendUsageTelemetry(this.config, {}, {
            event: 'app_router_v2_failover',
            mode: 'daemon',
            properties: {
              from_model: candidate.key,
              to_model: next?.key || null,
              reason: result.reason,
              failover_reason: pick?.reason || null,
              attempt_number: attemptIndex,
            },
          })
          continue
        }
      }

      // 📖 Chain exhausted. Last-resort escape hatch: one final configured
      // model that is not part of the normal rotation gets a single shot
      // before the client sees an error.
      const lastResort = settings.lastResortModel
      if (!pinned && lastResort && !tried.includes(lastResort.key) && !blockedProviders.has(lastResort.provider) && Date.now() <= deadline) {
        const resolved = this.resolvePinnedCandidate({ provider: lastResort.provider, model: lastResort.model })
        if (resolved.candidate) {
          this.logger.warn(`All candidates failed; trying last-resort model ${lastResort.key}`, { request_id: requestId })
          trace.last_resort_used = true
          activeReq.current_model = lastResort.key
          tried.push(lastResort.key)
          traceAttempt(trace, lastResort.key, { status: null })
          const result = stream
            ? await this.proxyStreamingRequest({ req, res, body, candidate: resolved.candidate, requestId, attemptIndex, protocol, trace, isLastResort: true, anthropicModelName })
            : await this.proxyJsonRequest({ req, res, body, candidate: resolved.candidate, requestId, attemptIndex, protocol, trace, isLastResort: true })
          trace.attempts[trace.attempts.length - 1] = {
            ...trace.attempts[trace.attempts.length - 1],
            model: lastResort.key,
            status: result.status ?? null,
            latency_ms: result.latencyMs ?? null,
            error: result.reason || null,
            at: new Date().toISOString(),
          }
          if (result.verdict) failedKinds.push(result.verdict.kind)
          if (result.done) return
        }
      }

      this.sendAllModelsFailed(res, trace, set, requestId, protocol, { tried, failedKinds, stream })
    } finally {
      this.inFlight -= 1
      this.activeRequests.delete(requestId)
      const wallMs = Date.now() - started
      finishTrace(trace, {
        outcome: trace.outcome || (trace.served_model ? 'served' : 'all_failed'),
        wallMs,
        servedModel: trace.served_model,
        lastResort: trace.last_resort_used,
        tokens: activeReq.tokens,
      })
      this.rememberTrace(trace)
      this.history.append(this.historyEntryFromTrace(trace, { stream, set: set?.name || null }))
    }
  }

  sendAllModelsUnavailable(res, trace, set, requestId, protocol) {
    const health = this.getModelHealth(set)
    const allAuthError = health.length > 0 && health.every((h) => h.state === 'AUTH_ERROR')
    const allPaused = health.length > 0 && health.every((h) => h.state === 'QUOTA_PAUSED')
    const allStaleOrUnsupported = health.length > 0 && health.every((h) => h.state === 'STALE' || h.state === 'UNSUPPORTED')
    let statusCode = 503
    if (allAuthError) statusCode = 401
    else if (allPaused) statusCode = 429
    else if (allStaleOrUnsupported) statusCode = 400
    const extraHeaders = statusCode === 429 ? this.retryAfterHeaders() : {}
    this.sendProtocolError(res, protocol, statusCode,
      `All models in set are unavailable: ${set.name}`, requestId,
      {
        code: statusCode === 401 ? 'invalid_api_key' : statusCode === 429 ? 'insufficient_quota' : 'all_models_unavailable',
        headers: extraHeaders,
        payload: { set: set.name, model_health: health },
      })
    finishTrace(trace, { outcome: 'all_failed', wallMs: Date.now() - new Date(trace.at).getTime() })
  }

  sendAllModelsFailed(res, trace, set, requestId, protocol, { tried, failedKinds, stream }) {
    // 📖 Status refinement by dominant failure kind: an all-auth failure is a
    // 401 for the client, an all-quota failure is a 429 (with Retry-After),
    // an all-invalid-request failure means the PAYLOAD is the problem (400),
    // everything else stays a 503.
    const kinds = failedKinds.length > 0 ? failedKinds : ['unknown']
    const allSame = kinds.every((k) => k === kinds[0])
    const statusCode = allSame ? clientStatusForKind(kinds[0]) : 503
    const headers = {}
    if (statusCode === 429) Object.assign(headers, this.retryAfterHeaders())
    this.sendProtocolError(res, protocol, statusCode,
      `All routed models failed for set: ${set.name}`, requestId,
      {
        code: allSame ? kinds[0] : 'all_models_failed',
        headers,
        payload: {
          set: set.name,
          models_tried: tried,
          failure_kinds: kinds,
          stream,
        },
      })
  }

  retryAfterHeaders() {
    const pauses = this.quotaPausesForKeys([...this.quotaPauses.keys()])
    if (pauses.length === 0) return {}
    const maxUntil = Math.max(...pauses.map((p) => p.until))
    const seconds = Math.max(1, Math.ceil((maxUntil - Date.now()) / 1000))
    return { 'Retry-After': String(Math.min(seconds, 900)) }
  }

  // ─── Proxy paths ──────────────────────────────────────────────────────────

  buildUpstreamBody(body, candidate, stream) {
    const bodyWithPrePrompt = applyPrePromptToBody(body, this.routerConfig().prePrompt)
    const bodyNormalized = normalizeRequestBody(bodyWithPrePrompt, candidate.provider)
    const upstreamBody = {
      ...bodyNormalized,
      model: getApiModelId(candidate.provider, candidate.model),
      stream,
    }
    // 📖 Some providers/models fail if we send custom internal params.
    if (upstreamBody.add_generation_prompt !== undefined) delete upstreamBody.add_generation_prompt
    if (upstreamBody.continue_final_message !== undefined) delete upstreamBody.continue_final_message
    if (upstreamBody.tools?.length === 0) delete upstreamBody.tools
    return upstreamBody
  }

  async proxyJsonRequest({ req, res, body, candidate, requestId, attemptIndex, protocol, trace, isLastResort = false }) {
    const key = candidate.key
    const apiKey = this.getApiKeyForProvider(candidate.provider)
    const providerUrl = resolveProviderUrl(candidate.provider)
    if (!providerUrl) {
      const verdict = classifyFailure({ kind: FAILURE_KINDS.PROVIDER_URL })
      this.applyFailureVerdict(key, verdict, { detail: 'provider URL unresolvable' })
      return { done: false, failoverToNext: true, reason: verdict.kind, verdict }
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.routerConfig().failover.requestTimeoutMs)
    const settings = this.failoverSettings()
    const started = performance.now()
    const upstreamBody = this.buildUpstreamBody(body, candidate, false)
    const clientAbort = attachClientAbort(req, res, controller)
    try {
      const response = await fetch(providerUrl, {
        method: 'POST',
        headers: {
          ...cloneHeadersForUpstreamV2(req.headers, apiKey, candidate.provider),
          'X-Request-Id': requestId,
        },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      })
      clearTimeout(timeout)
      const latencyMs = Math.round(performance.now() - started)
      const text = await readBodyWithTimeout(response, controller, settings.bodyReadTimeoutMs)
      const upstreamMeta = buildUpstreamMeta(response, text, candidate.provider)

      if (isLikelyHtmlResponse(response.headers, text)) {
        const verdict = classifyFailure({ kind: FAILURE_KINDS.HTML })
        this.applyFailureVerdict(key, verdict, { detail: 'upstream html maintenance', statusCode: 503, meta: upstreamMeta })
        this.recordRouterError(verdict.kind, requestId, { model: key })
        return { done: false, failoverToNext: true, reason: verdict.kind, verdict, status: 503, latencyMs }
      }

      if (response.ok) {
        const parsed = parseJsonResult(text)
        if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
          const verdict = classifyFailure({ kind: FAILURE_KINDS.INVALID_JSON })
          this.applyFailureVerdict(key, verdict, { detail: 'upstream invalid json', statusCode: 502, meta: upstreamMeta })
          this.recordRouterError(verdict.kind, requestId, { model: key })
          return { done: false, failoverToNext: true, reason: verdict.kind, verdict, status: 502, latencyMs }
        }
        // 📖 THE v2 gate: a 200 only counts as success when the payload holds
        // real content. Empty choices, embedded error objects, empty text with
        // no tool calls: all fail over (v1 served those as "successes").
        if (settings.contentValidation !== 'off') {
          const gate = validateChatCompletionPayload(parsed.value, { mode: settings.contentValidation })
          if (!gate.ok) {
            const verdict = classifyFailure({ kind: FAILURE_KINDS[gateReasonToKind(gate.reason)] || FAILURE_KINDS.INVALID_JSON })
            this.applyFailureVerdict(key, verdict, { detail: `gate: ${gate.reason}${gate.detail ? ` (${gate.detail})` : ''}`, statusCode: 200, meta: upstreamMeta })
            this.recordRouterError(verdict.kind, requestId, { model: key })
            return { done: false, failoverToNext: true, reason: verdict.kind, verdict, status: 200, latencyMs }
          }
        }

        this.markSuccess(key, latencyMs)
        const usage = extractUsage(parsed.value)
        this.tokenTracker.record(candidate.provider, candidate.model, usage)
        this.recordRuntimeCall({ providerKey: candidate.provider, modelId: candidate.model, success: true, latencyMs, usage })
        this.totalRequestsRouted += 1
        trace.served_model = key
        trace.tokens = usage?.total_tokens || 0
        trace.is_last_resort = isLastResort
        // 📖 Record the winning attempt BEFORE the response head is written so
        // the x-fcm-v2-decision header shows the final status of this model.
        const winningAttempt = trace.attempts[trace.attempts.length - 1]
        if (winningAttempt) {
          winningAttempt.status = response.status
          winningAttempt.latency_ms = latencyMs
        }
        this.broadcast('request', { request_id: requestId, model: key, status: response.status, latency_ms: latencyMs, failover: attemptIndex > 0 })

        let responseText = text
        try {
          if (protocol === 'anthropic') {
            const translated = translateOpenAIToAnthropicResponse(parsed.value, { model: key })
            responseText = translated.ok ? JSON.stringify(translated.body) : text
          } else if (normalizeToolCallsResponse(parsed.value)) {
            responseText = JSON.stringify(parsed.value)
          }
        } catch {}

        if (!res.writableEnded) {
          res.writeHead(response.status, {
            ...headerEntriesSafe(response.headers),
            ...this.decisionHeaders(trace),
            ...(isLastResort ? { 'x-fcm-v2-last-resort': 'true' } : {}),
          })
          res.end(responseText)
        }
        return { done: true, status: response.status, latencyMs }
      }

      const verdict = classifyFailure({ status: response.status, retryAfterMs: upstreamMeta.retryAfterMs })
      this.applyFailureVerdict(key, verdict, {
        detail: `HTTP ${response.status}`,
        statusCode: response.status,
        meta: upstreamMeta,
      })
      this.recordRuntimeCall({
        providerKey: candidate.provider, modelId: candidate.model,
        success: false, latencyMs, error: verdict.kind,
      })
      this.recordRouterError(verdict.kind, requestId, { model: key, status: response.status })
      return { done: false, failoverToNext: verdict.failover, reason: verdict.kind, verdict, status: response.status, latencyMs }
    } catch (error) {
      // 📖 Blame attribution: a client disconnect is never an upstream failure.
      if (clientAbort.aborted) {
        this.logger.info(`Client disconnected before upstream response from ${key}`, { request_id: requestId })
        trace.outcome = 'client_aborted'
        return { done: true, reason: 'client_aborted' }
      }
      const isBodyReadTimeout = error?.name === 'BodyReadTimeoutError'
      const verdict = isBodyReadTimeout || error.name === 'AbortError'
        ? classifyFailure({ kind: FAILURE_KINDS.TIMEOUT })
        : classifyFailure({ kind: FAILURE_KINDS.NETWORK })
      const detail = isBodyReadTimeout ? 'body read timeout' : (error.name === 'AbortError' ? 'timeout' : (error.message || String(error)))
      this.applyFailureVerdict(key, verdict, { detail })
      this.recordRouterError(verdict.kind, requestId, { model: key })
      return { done: false, failoverToNext: true, reason: verdict.kind, verdict }
    } finally {
      clearTimeout(timeout)
      clientAbort.dispose()
    }
  }

  async proxyStreamingRequest({ req, res, body, candidate, requestId, attemptIndex, protocol, trace, isLastResort = false, anthropicModelName = null }) {
    const key = candidate.key
    const activeReq = this.activeRequests.get(requestId)
    if (activeReq) {
      activeReq.current_model = key
      activeReq.last_activity_at = Date.now()
    }
    const apiKey = this.getApiKeyForProvider(candidate.provider)
    const providerUrl = resolveProviderUrl(candidate.provider)
    if (!providerUrl) {
      const verdict = classifyFailure({ kind: FAILURE_KINDS.PROVIDER_URL })
      this.applyFailureVerdict(key, verdict, { detail: 'provider URL unresolvable' })
      return { done: false, failoverToNext: true, reason: verdict.kind, verdict }
    }
    const controller = new AbortController()
    const started = performance.now()
    const upstreamBody = this.buildUpstreamBody(body, candidate, true)
    // 📖 Anthropic clients receive Anthropic SSE events: every byte written
    // to the client goes through the transformer sink instead of raw.
    const sink = protocol === 'anthropic'
      ? createAnthropicStreamTransformer({ model: anthropicModelName || key })
      : null
    const timeout = setTimeout(() => controller.abort(), this.routerConfig().failover.requestTimeoutMs)
    let sentToClient = false
    const clientAbort = attachClientAbort(req, res, controller)

    const writeToClient = (text) => {
      if (res.writableEnded) return
      if (sink) res.write(sink.write(text))
      else res.write(Buffer.from(text))
    }
    const endClientStream = () => {
      try {
        if (sink && !res.writableEnded) res.write(sink.end())
      } catch {}
      try { if (!res.writableEnded) res.end() } catch {}
    }

    try {
      const response = await fetch(providerUrl, {
        method: 'POST',
        headers: {
          ...cloneHeadersForUpstreamV2(req.headers, apiKey, candidate.provider),
          'X-Request-Id': requestId,
        },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      })
      clearTimeout(timeout)
      const latencyMs = Math.round(performance.now() - started)
      const upstreamMeta = buildUpstreamMeta(response, '', candidate.provider)
      if (isLikelyHtmlResponse(response.headers)) {
        const verdict = classifyFailure({ kind: FAILURE_KINDS.HTML })
        this.applyFailureVerdict(key, verdict, { detail: 'upstream html maintenance', statusCode: 503, meta: upstreamMeta })
        this.recordRouterError(verdict.kind, requestId, { model: key, stream: true })
        return { done: false, failoverToNext: true, reason: verdict.kind, verdict, status: 503, latencyMs }
      }
      if (!response.ok) {
        const verdict = classifyFailure({ status: response.status, retryAfterMs: upstreamMeta.retryAfterMs })
        this.applyFailureVerdict(key, verdict, { detail: `HTTP ${response.status}`, statusCode: response.status, meta: upstreamMeta })
        this.recordRouterError(verdict.kind, requestId, { model: key, status: response.status, stream: true })
        return { done: false, failoverToNext: verdict.failover, reason: verdict.kind, verdict, status: response.status, latencyMs }
      }

      const reader = response.body?.getReader()
      if (!reader) {
        const verdict = classifyFailure({ kind: FAILURE_KINDS.EMPTY_STREAM })
        this.applyFailureVerdict(key, verdict, { detail: 'empty stream' })
        return { done: false, failoverToNext: true, reason: verdict.kind, verdict, status: 200, latencyMs }
      }

      // 📖 Readiness gate: hold early chunks until the tracker sees useful
      // content, an upstream error frame (fail over BEFORE the client gets
      // bytes), or the hold cap overflows (weird provider: pass through).
      const tracker = createStreamReadinessTracker()
      const holdBuffer = []
      let holdBytes = 0
      let forwarded = false
      let forwardedChars = 0
      let upstreamErrorAfterForward = false

      const flushHold = () => {
        // 📖 Record this attempt as the serving one before the head is written
        // so the decision header reflects the model actually streaming.
        const winningAttempt = trace.attempts[trace.attempts.length - 1]
        if (winningAttempt) {
          winningAttempt.status = 200
          winningAttempt.latency_ms = latencyMs
        }
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...this.decisionHeaders(trace),
            ...(isLastResort ? { 'x-fcm-v2-last-resort': 'true' } : {}),
          })
        } else {
          try { res.write(`: fcm-v2-failover-from=${key}\n\n`) } catch {}
        }
        for (const text of holdBuffer) {
          writeToClient(text)
          forwardedChars += text.length
        }
        holdBuffer.length = 0
        sentToClient = true
        forwarded = true
      }

      while (true) {
        const chunk = await this.readStreamChunkWithTimeout(reader)
        const text = chunk.done || !chunk.value
          ? null
          : (Buffer.isBuffer(chunk.value) ? chunk.value.toString('utf8') : Buffer.from(chunk.value).toString('utf8'))
        if (text === null) break
        tracker.observe(text)
        if (activeReq) {
          activeReq.last_activity_at = Date.now()
          activeReq.tokens += 1
        }
        if (!forwarded) {
          if (tracker.errorPayload) {
            try { controller.abort() } catch {}
            const verdict = classifyFailure({ kind: FAILURE_KINDS.ERROR_PAYLOAD })
            this.applyFailureVerdict(key, verdict, { detail: 'stream error payload before content', statusCode: 200, meta: upstreamMeta })
            this.recordRouterError(verdict.kind, requestId, { model: key, stream: true })
            return { done: false, failoverToNext: true, reason: verdict.kind, verdict, status: 200, latencyMs }
          }
          if (tracker.useful) {
            holdBuffer.push(text)
            flushHold()
          } else if (tracker.bytesSeen > tracker.maxHoldBytes) {
            // 📖 Huge non-JSON preamble: pass it through rather than stall.
            holdBuffer.push(text)
            flushHold()
          } else if (isLikelyHtmlText(text)) {
            try { controller.abort() } catch {}
            const verdict = classifyFailure({ kind: FAILURE_KINDS.HTML })
            this.applyFailureVerdict(key, verdict, { detail: 'stream html maintenance', statusCode: 503, meta: upstreamMeta })
            return { done: false, failoverToNext: true, reason: verdict.kind, verdict, status: 503, latencyMs }
          } else {
            holdBuffer.push(text)
            holdBytes += Buffer.byteLength(text)
          }
        } else {
          writeToClient(text)
          forwardedChars += text.length
          if (tracker.errorPayload) {
            // 📖 Upstream errored AFTER real content: keep the partial output,
            // close cleanly, and record a real failure (v1 marked success).
            upstreamErrorAfterForward = true
            break
          }
        }
      }

      if (!forwarded) {
        // 📖 The stream closed without ever producing useful content. v1 only
        // caught the zero-chunk case; v2 also fails over a stream that sent
        // only framing garbage. Nothing reached the client, so failover is safe.
        try { controller.abort() } catch {}
        const verdict = classifyFailure({ kind: FAILURE_KINDS.EMPTY_STREAM })
        this.applyFailureVerdict(key, verdict, { detail: `stream closed without content (${tracker.describe()})`, statusCode: 200, meta: upstreamMeta })
        this.recordRouterError(verdict.kind, requestId, { model: key, stream: true })
        return { done: false, failoverToNext: true, reason: verdict.kind, verdict, status: 200, latencyMs }
      }

      if (upstreamErrorAfterForward) {
        const verdict = classifyFailure({ kind: FAILURE_KINDS.ERROR_PAYLOAD })
        this.applyFailureVerdict(key, verdict, { detail: 'stream error payload after content', statusCode: 200, meta: upstreamMeta })
        endClientStream()
        return { done: true, status: 200, latencyMs }
      }

      this.markSuccess(key, latencyMs)
      const completionTokens = estimateTokens(forwardedChars)
      this.tokenTracker.record(candidate.provider, candidate.model, {
        prompt_tokens: 0,
        completion_tokens: completionTokens,
        total_tokens: completionTokens,
      })
      this.recordRuntimeCall({
        providerKey: candidate.provider, modelId: candidate.model,
        success: true, latencyMs,
        usage: { prompt_tokens: 0, completion_tokens: completionTokens, total_tokens: completionTokens },
      })
      this.totalRequestsRouted += 1
      trace.served_model = key
      trace.tokens = completionTokens
      trace.is_last_resort = isLastResort
      this.broadcast('request', { request_id: requestId, model: key, status: 200, latency_ms: latencyMs, failover: attemptIndex > 0, stream: true, tokens: completionTokens })
      endClientStream()
      return { done: true, status: 200, latencyMs }
    } catch (error) {
      try { controller.abort() } catch {}
      if (clientAbort.aborted) {
        this.logger.info(`Client disconnected during streaming response from ${key}`, { request_id: requestId })
        trace.outcome = 'client_aborted'
        endClientStream()
        return { done: true, reason: 'client_aborted' }
      }
      const reason = error?.message === 'stream_stall_timeout' ? FAILURE_KINDS.STREAM_STALL : (error.name === 'AbortError' ? FAILURE_KINDS.TIMEOUT : FAILURE_KINDS.NETWORK)
      const detail = error?.message === 'stream_stall_timeout' ? 'stream stall timeout' : (error.name === 'AbortError' ? 'timeout' : (error.message || String(error)))
      const isStall = reason === FAILURE_KINDS.STREAM_STALL || reason === FAILURE_KINDS.TIMEOUT
      const verdict = classifyFailure({ kind: reason })
      this.applyFailureVerdict(key, verdict, { detail })
      this.recordRouterError(verdict.kind, requestId, { model: key, partial: sentToClient, stream: true })
      if (sentToClient) {
        if (isStall) {
          // 📖 v1 behavior kept (issue #137): fail over even after partial
          // output. OpenAI clients get a synthetic caution delta; Anthropic
          // clients get an SSE error event before the stream closes.
          this.logger.warn(`Stream stall after partial response from ${key}, attempting failover`, { request_id: requestId, detail })
          if (!res.writableEnded) {
            try {
              if (sink) {
                res.write(sink.write(`data: ${JSON.stringify({ error: { message: `stream truncated by router (${detail}); failing over to next model`, type: 'api_error' } })}\n\n`))
              } else {
                const failoverMsg = `\n\n> [!CAUTION]\n> Stream truncated by router due to upstream ${detail}; failing over to next model.\n\n`
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: failoverMsg }, finish_reason: null }] })}\n\n`)
              }
            } catch {}
          }
          return { done: false, failoverToNext: true, reason: `stream_stall`, verdict }
        }
        this.logger.warn(`Streaming failure after partial response from ${key}`, { request_id: requestId, detail })
        endClientStream()
        return { done: true }
      }
      return { done: false, failoverToNext: true, reason: verdict.kind, verdict }
    } finally {
      clearTimeout(timeout)
      clientAbort.dispose()
    }
  }

  readStreamChunkWithTimeout(reader) {
    const timeoutMs = this.routerConfig().failover.streamStallTimeoutMs
    let timeout = null
    const read = reader.read()
    read.catch(() => {})
    return Promise.race([
      read.finally(() => {
        if (timeout) clearTimeout(timeout)
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('stream_stall_timeout')), timeoutMs)
      }),
    ])
  }

  recordRouterError(kind, requestId, properties = {}) {
    void sendUsageTelemetry(this.config, {}, {
      event: 'app_router_v2_error',
      mode: 'daemon',
      properties: { kind, request_id: requestId, ...properties },
    })
  }

  // ─── Anthropic /v1/messages ───────────────────────────────────────────────

  async handleAnthropicMessages(req, res, requestId) {
    if (!isAuthorizedForV1(req)) {
      sendJson(res, 401, anthropicErrorPayload('authentication_error', 'Missing or invalid router token'), { 'x-request-id': requestId })
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      if (error.code === 'BODY_TOO_LARGE') {
        sendJson(res, 413, anthropicErrorPayload('request_too_large', 'Request body too large'), { 'x-request-id': requestId })
        return
      }
      sendJson(res, 400, anthropicErrorPayload('invalid_request_error', 'Invalid JSON body'), { 'x-request-id': requestId })
      return
    }
    const translated = translateAnthropicToOpenAI(body)
    if (!translated.ok) {
      sendJson(res, 400, anthropicErrorPayload('invalid_request_error', translated.error), { 'x-request-id': requestId })
      return
    }
    const openaiBody = { ...translated.body, stream: body.stream === true }
    await this.routeRequest({
      req,
      res,
      body: openaiBody,
      setName: null,
      requestId,
      protocol: 'anthropic',
      anthropicModelName: typeof body.model === 'string' ? body.model : null,
    })
  }

  // ─── Sets (read + activate only; v1 owns mutations while v2 is beta) ──────

  async handleSetsRequest(req, res, url, requestId) {
    if (!isSameOriginOrLocal(req)) {
      sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
      return
    }
    const router = this.routerConfig()
    const activateMatch = url.pathname.match(/^\/sets\/([^/]+)\/activate$/)
    if (req.method === 'GET' && url.pathname === '/sets') {
      sendJson(res, 200, { activeSet: router.activeSet, sets: router.sets }, { 'x-request-id': requestId })
      return
    }
    if (activateMatch && req.method === 'POST') {
      const name = decodeURIComponent(activateMatch[1])
      if (!router.sets[name]) {
        sendError(res, 404, `Router set not found: ${name}`, 'invalid_request_error', 'set_not_found', requestId)
        return
      }
      this.setRouterConfigShared({ ...router, activeSet: name })
      if (this.persistConfig) saveConfig(this.config)
      this.broadcast('set_change', { old_set: router.activeSet, new_set: name })
      void this.runProbeBurst()
      sendJson(res, 200, { activeSet: name }, { 'x-request-id': requestId })
      return
    }
    sendError(res, 404, 'Not found', 'invalid_request_error', 'not_found', requestId)
  }

  async handleProbeModeRequest(req, res, requestId) {
    const body = await readJsonBody(req)
    const nextProbeMode = typeof body.probeMode === 'string'
      ? body.probeMode.trim().toLowerCase()
      : typeof body.mode === 'string'
        ? body.mode.trim().toLowerCase()
        : ''
    if (!['eco', 'balanced', 'aggressive'].includes(nextProbeMode)) {
      sendError(res, 400, 'probeMode must be one of: eco, balanced, aggressive', 'invalid_request_error', 'invalid_probe_mode', requestId)
      return
    }
    const router = this.routerConfig()
    const previousProbeMode = router.probeMode
    this.setRouterConfigShared({ ...router, probeMode: nextProbeMode })
    if (this.persistConfig) saveConfig(this.config)
    this.scheduleProbeLoop()
    this.broadcast('config', { activeSet: this.routerConfig().activeSet, old_probe_mode: previousProbeMode, probe_mode: nextProbeMode })
    void this.runProbeBurst()
    sendJson(res, 200, { ok: true, previousProbeMode, probeMode: nextProbeMode }, { 'x-request-id': requestId })
  }

  // 📖 POST /api/router-v2/test - test a model through THIS daemon's full
  // chain. Implemented as a real loopback /v1/chat/completions call with the
  // pinned-model syntax, so the HTTP layer, gate and headers are all exercised.
  async handleSelfTest(req, res, requestId) {
    if (!isSameOriginOrLocal(req)) {
      sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
      return
    }
    const body = await readJsonBody(req)
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!provider || !model) {
      sendError(res, 400, 'Both `provider` and `model` are required', 'invalid_request_error', 'missing_model_fields', requestId)
      return
    }
    const { testModelViaRouter } = await import('./bench.js')
    const result = await testModelViaRouter({ port: this.port, provider, model })
    sendJson(res, 200, result, { 'x-request-id': requestId })
  }

  // ─── HTTP surface ─────────────────────────────────────────────────────────

  async handleHttp(req, res) {
    const rawRequestId = req.headers['x-request-id']
    const requestId = typeof rawRequestId === 'string' && rawRequestId.trim()
      ? rawRequestId.trim().slice(0, 64)
      : `req-${randomUUID()}`
    applyCors(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (!isAllowedHostHeader(req.headers.host, this.port, this.boundHost)) {
      sendError(res, 403, 'Forbidden host header', 'invalid_request_error', 'forbidden_host', requestId)
      return
    }
    const url = new URL(req.url, `http://localhost:${this.port}`)
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, this.statusPayload(), { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && url.pathname === '/stats') {
        sendJson(res, 200, this.statsPayload(), { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && url.pathname === '/stats/tokens') {
        sendJson(res, 200, this.tokenTracker.summary(), { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        if (!isAuthorizedForV1(req)) {
          sendError(res, 401, 'Missing or invalid router token', 'invalid_request_error', 'invalid_api_key', requestId)
          return
        }
        const router = this.routerConfig()
        sendJson(res, 200, {
          object: 'list',
          data: [
            { id: 'fcm', object: 'model', owned_by: 'fcm-router-v2' },
            { id: 'fcm:@provider/model', object: 'model', owned_by: 'fcm-router-v2', description: 'pin one model (test via router)' },
            ...Object.keys(router.sets || {}).map((name) => ({ id: `fcm:${name}`, object: 'model', owned_by: 'fcm-router-v2' })),
          ],
        }, { 'x-request-id': requestId })
        return
      }

      // ─── OpenAI-compatible routing surface ───────────────────────────────
      const chatMatch = url.pathname.match(/^\/v1\/sets\/([^/]+)\/chat\/completions$/)
      if (url.pathname === '/v1/chat/completions' || chatMatch) {
        if (req.method !== 'POST') {
          sendError(res, 405, 'Method not allowed', 'invalid_request_error', 'method_not_allowed', requestId, { allowed: ['POST'] })
          return
        }
        if (!isAuthorizedForV1(req)) {
          sendError(res, 401, 'Missing or invalid router token', 'invalid_request_error', 'invalid_api_key', requestId)
          return
        }
        const body = await readJsonBody(req)
        await this.routeRequest({
          req, res, body,
          setName: chatMatch ? decodeURIComponent(chatMatch[1]) : null,
          requestId,
          protocol: 'openai',
        })
        return
      }

      // ─── Anthropic-compatible routing surface ────────────────────────────
      if (url.pathname === '/v1/messages') {
        if (req.method !== 'POST') {
          sendJson(res, 405, anthropicErrorPayload('invalid_request_error', 'Method not allowed, use POST'), { 'x-request-id': requestId })
          return
        }
        await this.handleAnthropicMessages(req, res, requestId)
        return
      }

      if (url.pathname === '/sets' || url.pathname.startsWith('/sets/')) {
        await this.handleSetsRequest(req, res, url, requestId)
        return
      }

      // ─── Dashboard API (v2) ──────────────────────────────────────────────
      if (url.pathname === '/daemon/shutdown' && req.method === 'POST') {
        if (!isSameOriginOrLocal(req)) {
          sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
          return
        }
        sendJson(res, 200, { ok: true, message: 'Router v2 daemon shutting down' }, { 'x-request-id': requestId })
        setTimeout(() => this.shutdown(0), 50)
        return
      }
      if (url.pathname === '/daemon/probe-mode' && req.method === 'POST') {
        if (!isSameOriginOrLocal(req)) {
          sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
          return
        }
        await this.handleProbeModeRequest(req, res, requestId)
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/router-v2/status') {
        sendJson(res, 200, this.statusPayload(), { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/router-v2/stats') {
        sendJson(res, 200, this.statsPayload(), { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/router-v2/history') {
        const limit = clampInt(url.searchParams.get('limit'), 50, { min: 1, max: MAX_HISTORY_ENTRIES })
        sendJson(res, 200, { entries: this.history.recent(limit), stats: this.history.stats() }, { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/router-v2/traces') {
        const limit = clampInt(url.searchParams.get('limit'), 20, { min: 1, max: MAX_RECENT_TRACES })
        sendJson(res, 200, { traces: this.recentTraces.slice(-limit).reverse() }, { 'x-request-id': requestId })
        return
      }
      if (url.pathname === '/api/router-v2/history' && req.method === 'DELETE') {
        if (!isSameOriginOrLocal(req)) {
          sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
          return
        }
        this.history.clear()
        this.recentTraces = []
        sendJson(res, 200, { ok: true }, { 'x-request-id': requestId })
        return
      }
      if (url.pathname === '/api/router-v2/test' && req.method === 'POST') {
        await this.handleSelfTest(req, res, requestId)
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/router-v2/events') {
        if (!this.tryOpenSseConnection(req, res, requestId)) return
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'x-request-id': requestId,
        })
        res.flushHeaders?.()
        res.write(': connected\n\n')
        res.write(`event: hello\ndata: ${JSON.stringify(this.statusPayload())}\n\n`)
        this.sseClients.add(res)
        req.on('close', () => this.sseClients.delete(res))
        return
      }

      sendError(res, 404, 'Not found', 'invalid_request_error', 'not_found', requestId)
    } catch (error) {
      if (error.code === 'BODY_TOO_LARGE') {
        sendError(res, 413, 'Request body too large', 'invalid_request_error', 'request_body_too_large', requestId, { max_bytes: MAX_BODY_BYTES })
        return
      }
      if (error.code === 'INVALID_JSON') {
        sendError(res, 400, 'Invalid JSON', 'invalid_request_error', 'invalid_json', requestId, { detail: error.message })
        return
      }
      if (error.code === 'UNSUPPORTED_MEDIA_TYPE') {
        sendError(res, 415, 'Unsupported Media Type: send application/json', 'invalid_request_error', 'unsupported_media_type', requestId)
        return
      }
      this.logger.error('Internal router v2 error', { request_id: requestId, error: error?.stack || error?.message || String(error) })
      if (!res.writableEnded) {
        sendError(res, 500, 'Internal router error', 'server_error', 'internal_router_error', requestId)
      }
    }
  }

  installProcessSafety() {
    process.on('uncaughtException', (error) => {
      this.crashRecovered += 1
      this.uncaughtTimestamps.push(Date.now())
      this.uncaughtTimestamps = this.uncaughtTimestamps.filter((ts) => Date.now() - ts < 5 * 60 * 1000)
      this.logger.error('Recovered uncaught exception', { error: error.stack || error.message })
      if (this.uncaughtTimestamps.length >= 10) void this.shutdown(1)
    })
    process.on('unhandledRejection', (reason) => {
      this.crashRecovered += 1
      this.uncaughtTimestamps.push(Date.now())
      this.uncaughtTimestamps = this.uncaughtTimestamps.filter((ts) => Date.now() - ts < 5 * 60 * 1000)
      this.logger.error('Recovered unhandled rejection', { error: reason?.stack || String(reason) })
      if (this.uncaughtTimestamps.length >= 10) void this.shutdown(1)
    })
    process.on('SIGTERM', () => void this.shutdown(0))
    process.on('SIGINT', () => void this.shutdown(0))
    process.on('SIGHUP', () => this.reloadConfigFromDisk())
  }

  async shutdown(exitCode = 0) {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.logger.info('Router v2 daemon stopping')
    if (this.probeTimer) clearInterval(this.probeTimer)
    if (this.probeWatchdog) clearInterval(this.probeWatchdog)
    if (this.configReloadTimer) clearInterval(this.configReloadTimer)
    if (this.tokenFlushTimer) clearInterval(this.tokenFlushTimer)
    if (this.probeCacheFlushTimer) clearInterval(this.probeCacheFlushTimer)
    if (this.runtimeTelemetryFlushTimer) clearTimeout(this.runtimeTelemetryFlushTimer)
    for (const timeout of this.probeTimeouts) clearTimeout(timeout)
    const started = Date.now()
    while (this.inFlight > 0 && Date.now() - started < 30000) {
      await sleep(100)
    }
    this.tokenTracker.flush({ force: true })
    flushProbeCache()
    if (this.runtimeTelemetryDirty) flushRuntimeTelemetryStore()
    this.breakers.flush()
    this.history.flush()
    try { this.server?.close() } catch {}
    try { unlinkSync(getRouterV2PidPath()) } catch {}
    try { unlinkSync(getRouterV2PortPath()) } catch {}
    void sendUsageTelemetry(this.config, {}, {
      event: 'app_daemon_v2_stop',
      mode: 'daemon',
      properties: {
        uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
        total_requests_routed: this.totalRequestsRouted,
        total_tokens: this.tokenTracker.stats.all_time.total_tokens,
      },
    })
    setTimeout(() => process.exit(exitCode), 20)
  }
}

// 📖 Map a content-gate rejection reason to its failure kind name. The gate
// reasons are deliberately the same words as the FAILURE_KINDS suffixes.
function gateReasonToKind(reason) {
  switch (reason) {
    case 'error_payload': return 'ERROR_PAYLOAD'
    case 'empty_choices': return 'EMPTY_CHOICES'
    case 'empty_content': return 'EMPTY_CONTENT'
    case 'invalid_json': return 'INVALID_JSON'
    default: return 'INVALID_JSON'
  }
}

// 📖 headerEntries from v1 is not exported; keep a local copy of the small
// sanitizer so response headers stay clean without touching v1 further.
function headerEntriesSafe(headers) {
  const entries = {}
  if (!headers || typeof headers.forEach !== 'function') return entries
  headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (['connection', 'content-encoding', 'content-length', 'transfer-encoding'].includes(lower)) return
    if (lower === 'set-cookie' || lower.startsWith('access-control-')) return
    entries[lower] = value
  })
  return entries
}

function hasUsableActiveSet(config) {
  const router = config?.router
  if (!router || typeof router !== 'object') return false
  const activeSet = router.activeSet || DEFAULT_ROUTER_SETTINGS.activeSet
  const set = router.sets?.[activeSet]
  return Boolean(set && Array.isArray(set.models) && set.models.length > 0)
}

function listenOnPortV2(server, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('error', onError)
      reject(error)
    }
    const onListening = () => {
      server.off('listening', onListening)
      resolve(port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

async function listenWithFallbackV2(server, preferredPort, logger, host = '127.0.0.1') {
  const envPort = Number.parseInt(process.env.FCM_ROUTER_V2_PORT || '', 10)
  const { defaultPort, maxPort } = getRouterV2PortRange()
  const preferred = preferredPort || (Number.isFinite(envPort) ? envPort : defaultPort)
  const candidates = []
  const start = Math.max(1, preferred)
  for (let port = start; port <= maxPort; port += 1) candidates.push(port)
  if (!candidates.includes(defaultPort)) {
    for (let port = defaultPort; port <= maxPort; port += 1) candidates.push(port)
  }
  let lastError = null
  for (const port of candidates) {
    try {
      await listenOnPortV2(server, port, host)
      return port
    } catch (error) {
      lastError = error
      logger.warn(`Router v2 port ${port} unavailable`, { error: error.code || error.message })
    }
  }
  throw lastError || new Error('No router v2 ports available')
}

export async function runRouterV2Daemon() {
  const config = loadConfig()
  // 📖 v2 listens FIRST: v1 awaited a 24-candidate probe sweep before its
  // server socket opened, which left first boots with a ~36s black hole.
  // v2 builds a fast static set synchronously when none exists, serves
  // immediately, and upgrades it to the probe-driven set in the background.
  let needsProbedSetUpgrade = false
  if (!hasUsableActiveSet(config)) {
    const favSet = buildRouterSetFromFavorites(config)
    if (favSet) {
      config.router = normalizeRouterConfig({
        ...DEFAULT_ROUTER_SETTINGS,
        enabled: true,
        onboardingSeen: true,
        activeSet: favSet.name,
        sets: { [favSet.name]: favSet },
      })
      saveConfig(config)
    } else {
      const syncSet = buildDefaultRouterSetSync(config, 5)
      config.router = normalizeRouterConfig({
        ...DEFAULT_ROUTER_SETTINGS,
        enabled: true,
        onboardingSeen: true,
        activeSet: syncSet.name,
        sets: { [syncSet.name]: syncSet },
      })
      saveConfig(config)
      needsProbedSetUpgrade = true
    }
  }
  const logger = new RouterLogger(getRouterV2LogPath(), config.router?.logLevel || 'info')
  const runtime = new RouterV2Runtime({
    config,
    port: Number.parseInt(process.env.FCM_ROUTER_V2_PORT || '', 10) || getRouterV2PortRange().defaultPort,
    logger,
    paths: {
      breakers: getRouterV2BreakersPath(),
      history: getRouterV2HistoryPath(),
      tokens: getRouterV2TokensPath(),
    },
  })
  runtime.installProcessSafety()
  const server = createServer((req, res) => void runtime.handleHttp(req, res))
  runtime.server = server
  const host = process.env.FCM_HOST || '127.0.0.1'
  const port = await listenWithFallbackV2(server, runtime.port, logger, host)
  runtime.port = port
  runtime.boundHost = host
  try { writeFileSync(getRouterV2PidPath(), String(process.pid), { mode: 0o600 }) } catch (error) { logger.warn('PID file write failed', { error: error.message }) }
  try { writeFileSync(getRouterV2PortPath(), String(port), { mode: 0o600 }) } catch (error) { logger.warn('Port file write failed', { error: error.message }) }
  logger.info('Router v2 daemon started (beta)', { pid: process.pid, port, host, activeSet: runtime.routerConfig().activeSet })
  if (!isLoopbackHostname(host) && !(process.env.FCM_ALLOWED_ORIGINS || '').trim()) {
    logger.warn('FCM_HOST is bound to a non-loopback address. Set FCM_ALLOWED_ORIGINS so browser dashboards can reach the v2 daemon.')
  }
  void sendUsageTelemetry(runtime.config, {}, {
    event: 'app_daemon_v2_start',
    mode: 'daemon',
    properties: {
      port,
      set_count: Object.keys(runtime.routerConfig().sets || {}).length,
      models_in_active_set: runtime.getSet()?.models?.length || 0,
    },
  })
  runtime.configReloadTimer = setInterval(() => runtime.reloadConfigFromDisk(), CONFIG_RELOAD_INTERVAL_MS)
  runtime.tokenFlushTimer = setInterval(() => runtime.tokenTracker.flush(), TOKEN_FLUSH_INTERVAL_MS)
  // 📖 Probe-driven default set (when the static one above was just created)
  // + the regular probe burst happen in the background, after listen().
  void (async () => {
    try {
      if (needsProbedSetUpgrade) {
        // 📖 The static tier-ordered pick can contain models the user's key
        // cannot actually call (auth-errored on first request). Replace it
        // once with the probe-driven set (same pipeline as v1's first boot)
        // so the router starts on models that really answer.
        const fresh = loadConfig()
        const { createDefaultProbeFn } = await import('../router-daemon.js')
        const probed = await buildDefaultRouterSet(fresh, 5, {
          probeFn: createDefaultProbeFn(fresh.apiKeys || {}),
          probeTimeoutMs: 1500,
          probeBudget: 24,
        })
        if (probed && Array.isArray(probed.models) && probed.models.length > 0) {
          fresh.router = normalizeRouterConfig({
            ...DEFAULT_ROUTER_SETTINGS,
            enabled: true,
            onboardingSeen: true,
            activeSet: probed.name,
            sets: { [probed.name]: probed },
          })
          saveConfig(fresh)
          runtime.config = fresh
          runtime.refreshRouteState()
        }
      } else {
        // 📖 A usable set already exists (user's favorites or a previous run):
        // just adopt the fresh file as-is. Running ensure here would rebuild
        // the router section from defaults and wipe failover tuning.
        runtime.config = fresh
        runtime.refreshRouteState()
      }
    } catch (error) {
      logger.debug('Background router set upgrade skipped', { error: error?.message })
    }
    void runtime.runProbeBurst()
    runtime.scheduleProbeLoop()
  })()
  return runtime
}

export async function getRouterV2DaemonStatus() {
  const { defaultPort, maxPort } = getRouterV2PortRange()
  const ports = []
  const recordedPort = readNumberFile(getRouterV2PortPath())
  if (recordedPort) ports.push(recordedPort)
  for (let port = defaultPort; port <= maxPort; port += 1) {
    if (!ports.includes(port)) ports.push(port)
  }
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return await response.json()
    } catch {
      // keep scanning
    }
  }
  const pid = readNumberFile(getRouterV2PidPath())
  return {
    ok: false,
    running: false,
    router: 'v2',
    beta: true,
    stalePid: pid && !isProcessAlive(pid) ? pid : null,
    pid: pid || null,
    port: recordedPort || null,
  }
}

export async function startRouterV2DaemonBackground() {
  const existing = await getRouterV2DaemonStatus()
  if (existing.ok) {
    if (existing.version && existing.version !== LOCAL_VERSION) {
      await stopRouterV2Daemon()
    } else {
      return { ...existing, alreadyRunning: true }
    }
  }
  const child = fork(CLI_ENTRY_PATH, ['--router-v2'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  for (let i = 0; i < 40; i += 1) {
    await sleep(250)
    const status = await getRouterV2DaemonStatus()
    if (status.ok) return { ...status, alreadyRunning: false }
  }
  return { ok: false, running: false, router: 'v2', pid: child.pid, error: 'Router v2 daemon did not become healthy before timeout' }
}

export async function stopRouterV2Daemon() {
  const pidPath = getRouterV2PidPath()
  let pid = readNumberFile(pidPath)
  if (!pid) {
    const status = await getRouterV2DaemonStatus()
    if (status.ok && status.pid) pid = status.pid
  }
  if (!pid) return { ok: false, stopped: false, router: 'v2', error: 'No router v2 daemon PID found' }
  if (!isProcessAlive(pid)) {
    try { unlinkSync(pidPath) } catch {}
    return { ok: true, stopped: false, router: 'v2', stalePid: pid }
  }
  const command = getProcessCommand(pid)
  if (command !== null && !command.includes('free-coding-models')) {
    return { ok: false, stopped: false, router: 'v2', pid, error: `PID ${pid} is not a free-coding-models process` }
  }
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 60; i += 1) {
    await sleep(250)
    if (!isProcessAlive(pid)) {
      try { unlinkSync(pidPath) } catch {}
      return { ok: true, stopped: true, router: 'v2', pid }
    }
  }
  return { ok: false, stopped: false, router: 'v2', pid, error: 'Router v2 daemon did not stop before timeout' }
}

export function createRouterV2RuntimeForTest({
  config,
  port = 0,
  logger = null,
  tokenPath = null,
  breakersPath = null,
  historyPath = null,
} = {}) {
  const testLogger = logger || {
    level: 'error',
    error() {},
    warn() {},
    info() {},
    debug() {},
  }
  // 📖 Tests exercise the real HTTP router against local fake providers.
  // Config persistence is disabled so fixture sets never leak into the user's
  // real ~/.free-coding-models.json, and all state files land in /tmp.
  const crypto = randomUUID()
  return new RouterV2Runtime({
    config: config || {},
    port,
    logger: testLogger,
    persistConfig: false,
    paths: {
      breakers: breakersPath || `/tmp/fcm-v2-test-breakers-${crypto}.json`,
      history: historyPath || `/tmp/fcm-v2-test-history-${crypto}.json`,
      tokens: tokenPath || `/tmp/fcm-v2-test-tokens-${crypto}.json`,
    },
  })
}

// 📖 MODELS re-export keeps tree-shakers honest: the catalog size is asserted
// in tests so a broken sources.js cannot ship silently.
void MODELS
void TIER_ORDER
void atomicWriteJson
void safeJsonParse
void resolveCloudflareUrl
void classifyStatus

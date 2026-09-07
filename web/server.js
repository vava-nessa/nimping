/**
 * @file web/server.js
 * @description HTTP + Socket.IO/SSE server for the free-coding-models realtime Web Dashboard.
 *
 * @details
 *   📖 This server intentionally mirrors the TUI health loop instead of exposing a
 *   slow request/response snapshot. The browser gets per-model ping state, frequent
 *   updates while probes complete, and the same startup speed burst → normal → idle
 *   slow cadence used by the terminal UI.
 *
 *   Realtime transport strategy:
 *   - Socket.IO is the primary channel for the local web app.
 *   - `/api/events` keeps an SSE stream alive as a zero-dependency fallback.
 *   - `/api/models` remains a plain JSON endpoint for polling/fallback clients.
 *
 * @functions
 *   → startWebServer(port, options) — Start the dashboard server and realtime loops
 *   → inspectExistingWebServer(port) — Detect if a port already hosts this dashboard
 *   → findAvailablePort(startPort, maxAttempts) — Find a local fallback port
 *
 * @exports startWebServer, inspectExistingWebServer, findAvailablePort
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exec } from 'node:child_process'
import { createRequire } from 'node:module'
import { Server } from 'socket.io'

// 📖 Resolve the local package version for /api/version — same trick the TUI uses.
const require = createRequire(import.meta.url)
const { version: LOCAL_VERSION } = require('../package.json')

import { sources, MODELS } from '../sources.js'
import { loadConfig, getApiKey, saveConfig, isProviderEnabled } from '../src/core/config.js'
import { getProviderBillingNote, getProviderLabelWithBilling, PROVIDER_METADATA } from '../src/core/provider-metadata.js'
import { ensureFavoritesConfig } from '../src/core/favorites.js'
import { ping, getProviderQuotaPercentCached } from '../src/core/ping.js'
import { runProviderKeyTest } from '../src/core/provider-key-tester.js'
import { loadChangelog } from '../src/core/changelog-loader.js'
import { checkForUpdateDetailed, checkForUpdate, runUpdate, fetchLastReleaseDate } from '../src/core/updater.js'
import { syncShellEnv, ensureShellRcSource, removeShellEnv } from '../src/core/shell-env.js'
import { cleanupLegacyProxyArtifacts } from '../src/core/legacy-proxy-cleanup.js'
import {
  getAvg, getVerdict, getUptime, getP95, getJitter,
  getStabilityScore,
} from '../src/core/utils.js'
import { benchmarkModel, BENCHMARK_TIMEOUT_MS, BENCHMARK_PROMPT } from '../src/core/benchmark.js'
import { getInstallTargetModes, installProviderEndpoints, getConfiguredInstallableProviders, getProviderCatalogModels } from '../src/core/endpoint-installer.js'
import { isModelCompatibleWithTool } from '../src/core/tool-metadata.js'
import { sendUsageTelemetry } from '../src/core/telemetry.js'
import { getRouterDaemonStatus, startRouterDaemonBackground, stopRouterDaemon, getRouterTokensPath, getRouterPortPath } from '../src/core/router-daemon.js'
import { scanAllToolConfigs, softDeleteModel } from '../src/core/installed-models-manager.js'
import {
  TASK_TYPES,
  PRIORITY_TYPES,
  CONTEXT_BUDGETS,
  getTopRecommendations,
} from '../src/core/utils.js'
import {
  PING_MODE_INTERVALS,
  PING_MODE_CYCLE,
  SPEED_MODE_DURATION_MS,
  IDLE_SLOW_AFTER_MS,
} from '../src/tui/tui-state.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_SIGNATURE = 'free-coding-models-web'
const BROADCAST_THROTTLE_MS = 80
const MAX_PING_HISTORY = 60
const GLOBAL_BENCHMARK_CONCURRENCY = 5
const DEFAULT_WEB_PORT = 3333
const BODY_LIMIT_BYTES = 1024 * 1024

// ─── Mutable server state ───────────────────────────────────────────────────

let config = loadConfig()
let io = null
let pingLoopTimer = null
let broadcastTimer = null
let heartbeatTimer = null
let startedServer = null

const sseClients = new Set()

const runtime = {
  pingMode: 'speed',
  pingModeSource: 'startup',
  activePingInterval: PING_MODE_INTERVALS.speed,
  speedModeUntil: Date.now() + SPEED_MODE_DURATION_MS,
  lastUserActivityAt: Date.now(),
  resumeSpeedOnActivity: false,
  lastPingTime: Date.now(),
  nextPingAt: Date.now(),
  pendingPings: 0,
  pingRound: 0,
  globalBenchmarkRunning: false,
  globalBenchmarkTotal: 0,
  globalBenchmarkCompleted: 0,
  updateStatus: null,
}

const results = MODELS.map(([modelId, label, tier, sweScore, ctx, providerKey], idx) => ({
  idx: idx + 1,
  modelId,
  label,
  tier,
  sweScore,
  ctx,
  providerKey,
  status: 'pending',
  pings: [],
  httpCode: null,
  origin: sources[providerKey]?.name || providerKey,
  url: sources[providerKey]?.url || null,
  cliOnly: sources[providerKey]?.cliOnly || false,
  zenOnly: sources[providerKey]?.zenOnly || false,
  isPinging: false,
}))

const benchmarkRunning = new Set()
const benchmarkResults = new Map()

// ─── Shared state helpers ───────────────────────────────────────────────────

function benchmarkKey(providerKey, modelId) {
  return `${providerKey}/${modelId}`
}

function getResultKey(result) {
  return benchmarkKey(result.providerKey, result.modelId)
}

function getResult(providerKey, modelId) {
  return results.find((r) => r.providerKey === providerKey && r.modelId === modelId) || null
}

function noteUserActivity() {
  runtime.lastUserActivityAt = Date.now()
  if (runtime.pingMode === 'forced') return
  if (runtime.resumeSpeedOnActivity) setPingMode('speed', 'activity')
}

function setPingMode(nextMode, source = 'manual') {
  const mode = PING_MODE_INTERVALS[nextMode] ? nextMode : 'normal'
  runtime.pingMode = mode
  runtime.pingModeSource = source
  runtime.activePingInterval = PING_MODE_INTERVALS[mode]
  runtime.speedModeUntil = mode === 'speed' ? Date.now() + SPEED_MODE_DURATION_MS : null
  runtime.resumeSpeedOnActivity = source === 'idle'
  scheduleNextPing()
  broadcastUpdate({ immediate: true })
}

function cyclePingMode() {
  const idx = PING_MODE_CYCLE.indexOf(runtime.pingMode)
  setPingMode(PING_MODE_CYCLE[(idx + 1) % PING_MODE_CYCLE.length] || 'normal')
}

function refreshPingMode() {
  const now = Date.now()
  if (runtime.pingMode === 'forced') return

  if (runtime.speedModeUntil && now >= runtime.speedModeUntil) {
    setPingMode('normal', 'auto')
    return
  }

  if (now - runtime.lastUserActivityAt >= IDLE_SLOW_AFTER_MS) {
    if (runtime.pingMode !== 'slow' || runtime.pingModeSource !== 'idle') {
      setPingMode('slow', 'idle')
    } else {
      runtime.resumeSpeedOnActivity = true
    }
  }
}

function scheduleNextPing() {
  if (!startedServer?.listening) return
  clearTimeout(pingLoopTimer)
  refreshPingMode()
  const elapsed = Date.now() - runtime.lastPingTime
  const delay = Math.max(0, runtime.activePingInterval - elapsed)
  runtime.nextPingAt = Date.now() + delay
  pingLoopTimer = setTimeout(startPingCycle, delay)
}

function trimPingHistory(result) {
  if (result.pings.length > MAX_PING_HISTORY) result.pings = result.pings.slice(-MAX_PING_HISTORY)
}

function updateHealthFromPing(result, pingResult, hasApiKey) {
  const code = String(pingResult.code || 'ERR')
  result.httpCode = code

  // 📖 Match the TUI: every probe contributes to availability history. Average,
  // 📖 p95, and jitter still ignore non-measurable codes through src/core/utils.js.
  result.pings.push({ ms: pingResult.ms, code })
  trimPingHistory(result)

  if (code === '200') result.status = 'up'
  else if (code === '000') result.status = 'timeout'
  else if (code === '401' || code === '403') result.status = hasApiKey ? 'auth_error' : 'noauth'
  else result.status = 'down'
}

function updateHealthFromBenchmark(result, benchmarkResult) {
  if (!result || !benchmarkResult) return
  if (benchmarkResult.ok) {
    result.status = 'up'
    result.httpCode = '200'
    return
  }

  const code = String(benchmarkResult.code || 'ERR')
  if (code === 'TIMEOUT') result.status = 'timeout'
  else if (code === '401' || code === '403') result.status = getApiKey(config, result.providerKey) ? 'auth_error' : 'noauth'
  else if (code !== 'ERR' && code !== 'UNSUPPORTED') result.status = 'down'
  result.httpCode = code
}

async function pingModel(result) {
  if (!result || result.isPinging || result.cliOnly || !result.url || !isProviderEnabled(config, result.providerKey)) return

  result.isPinging = true
  runtime.pendingPings += 1
  broadcastUpdate()

  const apiKey = getApiKey(config, result.providerKey) ?? null
  try {
    const pingResult = await ping(apiKey, result.modelId, result.providerKey, result.url)
    let quotaPercent = pingResult.quotaPercent
    if ((quotaPercent === null || quotaPercent === undefined) && apiKey) {
      const providerQuota = await getProviderQuotaPercentCached(result.providerKey, apiKey)
      if (typeof providerQuota === 'number' && Number.isFinite(providerQuota)) quotaPercent = providerQuota
    }
    if (typeof quotaPercent === 'number' && Number.isFinite(quotaPercent)) {
      result.usagePercent = quotaPercent
      for (const sibling of results) {
        if (sibling.providerKey === result.providerKey && (sibling.usagePercent === undefined || sibling.usagePercent === null)) {
          sibling.usagePercent = quotaPercent
        }
      }
    }
    updateHealthFromPing(result, pingResult, !!apiKey)
  } catch (err) {
    updateHealthFromPing(result, { code: '000', ms: null, error: err?.message || 'Ping failed' }, !!apiKey)
  } finally {
    result.isPinging = false
    runtime.pendingPings = Math.max(0, runtime.pendingPings - 1)
    broadcastUpdate()
  }
}

function startPingCycle() {
  if (!startedServer?.listening) return
  refreshPingMode()

  runtime.lastPingTime = Date.now()
  runtime.pingRound += 1
  runtime.nextPingAt = runtime.lastPingTime + runtime.activePingInterval

  const modelsToPing = results.filter((r) => !r.cliOnly && r.url && isProviderEnabled(config, r.providerKey))
  for (const result of modelsToPing) {
    void pingModel(result)
  }

  broadcastUpdate({ immediate: true })
  scheduleNextPing()
}

function serializeModel(result) {
  const key = getResultKey(result)
  const avg = getAvg(result)
  const p95 = getP95(result)
  const jitter = getJitter(result)
  const stability = getStabilityScore(result)
  const latest = result.pings.length > 0 ? result.pings[result.pings.length - 1] : null
  const routerConfig = config.router || {}
  const activeSetName = routerConfig.activeSet || 'fast-coding'
  const activeSetModels = routerConfig.sets?.[activeSetName]?.models || []
  const inRouterSet = activeSetModels.some((m) => m.provider === result.providerKey && m.model === result.modelId)

  return {
    idx: result.idx,
    modelId: result.modelId,
    label: result.label,
    tier: result.tier,
    sweScore: result.sweScore,
    ctx: result.ctx,
    providerKey: result.providerKey,
    origin: result.origin,
    status: result.status,
    httpCode: result.httpCode,
    cliOnly: result.cliOnly,
    zenOnly: result.zenOnly,
    isPinging: result.isPinging,
    avg: Number.isFinite(avg) ? avg : null,
    verdict: getVerdict(result),
    uptime: getUptime(result),
    p95: Number.isFinite(p95) ? p95 : null,
    jitter: Number.isFinite(jitter) ? jitter : null,
    stability,
    latestPing: latest?.ms ?? null,
    latestCode: latest?.code ?? null,
    pingHistory: result.pings.slice(-20).map((p) => ({ ms: p.ms, code: p.code })),
    pingCount: result.pings.length,
    hasApiKey: !!getApiKey(config, result.providerKey),
    usagePercent: typeof result.usagePercent === 'number' && Number.isFinite(result.usagePercent) ? result.usagePercent : null,
    inRouterSet,
    benchmarkKey: key,
    isBenchmarking: benchmarkRunning.has(key),
    benchmark: benchmarkResults.get(key) || null,
    // 📖 Enrichment overlay (t4 + t5): extended benchmark + models.dev metadata
    // 📖 attached to the result. The web dashboard's DetailPanel renders these
    // 📖 as a benchmark block + provenance chip. Looked up via the lazily-built
    // 📖 webEnrichmentCache (one Map per overlay layer, primed at boot).
    extendedBench: webEnrichmentCache.extendedById.get(result.modelId) || null,
    metaSource: webEnrichmentCache.metaSourceByModelId.get(result.modelId) || 'sources.js',
  }
}

// 📖 webEnrichmentCache: pre-built lookup tables for the enrichments that need
// 📖 to be served synchronously from the HTTP layer. The catalog lookup is
// 📖 sync (extended-benchmarks.js), so we just prime the Map at boot. The
// 📖 models.dev metadata is async — we try to prime it but fall back to
// 📖 'sources.js' if the fetch fails.
const webEnrichmentCache = {
  extendedById: new Map(),
  metaSourceByModelId: new Map(),
}
;(async () => {
  // 📖 t4: prime the extended-benchmark cache (sync catalog, sync lookup)
  try {
    const { buildPrefixIndex, loadCatalog } = await import('../src/core/extended-benchmarks.js')
    loadCatalog()  // 📖 ensure the lazy cache is hot
    const index = buildPrefixIndex()
    for (const [key, data] of Object.entries(index.exact)) {
      webEnrichmentCache.extendedById.set(key, data)
    }
  } catch {}
  // 📖 t5: prime the models.dev metadata (async fetch, sync lookup afterwards)
  try {
    const { overlayModelsDevMetadata, buildMergedModels } = await import('../src/core/model-merger.js')
    const { MODELS } = await import('../sources.js')
    const merged = buildMergedModels(MODELS)
    const enriched = await overlayModelsDevMetadata(merged, { mutate: true })
    for (const m of enriched) {
      for (const p of m.providers || []) {
        webEnrichmentCache.metaSourceByModelId.set(p.modelId, m.metaSource || 'sources.js')
      }
    }
  } catch {}
})()

function getModelsPayload() {
  return {
    pingMode: runtime.pingMode,
    pingModeSource: runtime.pingModeSource,
    pingInterval: runtime.activePingInterval,
    nextPingAt: runtime.nextPingAt,
    pendingPings: runtime.pendingPings,
    isPinging: runtime.pendingPings > 0,
    pingRound: runtime.pingRound,
    globalBenchmarkRunning: runtime.globalBenchmarkRunning,
    globalBenchmarkTotal: runtime.globalBenchmarkTotal,
    globalBenchmarkCompleted: runtime.globalBenchmarkCompleted,
    updateStatus: runtime.updateStatus,
    models: results.map(serializeModel),
  }
}

function getConfigPayload() {
  const providers = {}
  for (const [key, src] of Object.entries(sources)) {
    const rawKey = getApiKey(config, key)
    providers[key] = {
      name: src.name,
      displayName: getProviderLabelWithBilling(key, src.name),
      billingNote: getProviderBillingNote(key),
      paidProviderNote: PROVIDER_METADATA[key]?.paidProviderNote || null,
      hasKey: !!rawKey,
      maskedKey: rawKey ? maskApiKey(rawKey) : null,
      enabled: isProviderEnabled(config, key),
      modelCount: src.models?.length || 0,
      cliOnly: src.cliOnly || false,
    }
  }
  return { providers, totalModels: MODELS.length }
}

function maskApiKey(key) {
  if (!key || typeof key !== 'string') return ''
  if (key.length <= 8) return '••••••••'
  return '••••••••' + key.slice(-4)
}

function writeSsePayload(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  } catch {
    sseClients.delete(res)
  }
}

function broadcastNow() {
  const payload = getModelsPayload()
  if (io) io.emit('models:update', payload)
  for (const res of [...sseClients]) writeSsePayload(res, payload)
}

function broadcastUpdate({ immediate = false } = {}) {
  if (immediate) {
    clearTimeout(broadcastTimer)
    broadcastTimer = null
    broadcastNow()
    return
  }

  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    broadcastNow()
  }, BROADCAST_THROTTLE_MS)
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml; charset=utf-8',
}

function serveFile(res, filename, contentType) {
  try {
    const content = readFileSync(join(__dirname, filename), 'utf8')
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' })
    res.end(content)
  } catch {
    res.writeHead(404)
    res.end('Not Found')
  }
}

function serveDistFile(res, pathname) {
  const filePath = join(__dirname, 'dist', pathname === '/' ? 'index.html' : pathname)
  if (!existsSync(filePath)) {
    // 📖 SPA fallback: GETs to non-asset paths return index.html so the React
    // 📖 router can take over. Static assets (favicons, /assets/*, anything
    // 📖 with a known extension) must 404 — never serve HTML for a missing PNG.
    const hasExt = extname(pathname) !== ''
    if (hasExt || pathname.startsWith('/assets/') || pathname.startsWith('/favicons/')) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }
    serveFile(res, 'dist/index.html', 'text/html; charset=utf-8')
    return
  }
  const ext = extname(filePath)
  const ct = MIME_TYPES[ext] || 'application/octet-stream'
  try {
    const content = readFileSync(filePath)
    res.writeHead(200, {
      'Content-Type': ct,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    res.end(content)
  } catch {
    res.writeHead(404)
    res.end('Not Found')
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > BODY_LIMIT_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!body.trim()) {
        resolve({})
        return
      }
      try { resolve(JSON.parse(body)) }
      catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

function parseVisibleBenchmarkModels(body) {
  const rawModels = Array.isArray(body?.models) ? body.models : null
  if (!rawModels) return results.filter((r) => !r.cliOnly && r.url)

  const unique = new Map()
  for (const item of rawModels) {
    if (!item || typeof item !== 'object') continue
    const providerKey = typeof item.providerKey === 'string' ? item.providerKey : ''
    const modelId = typeof item.modelId === 'string' ? item.modelId : ''
    const result = getResult(providerKey, modelId)
    if (result && !result.cliOnly && result.url) unique.set(getResultKey(result), result)
  }
  return [...unique.values()]
}

async function runSingleBenchmark(result) {
  const key = getResultKey(result)
  if (benchmarkRunning.has(key)) return { skipped: true }

  benchmarkRunning.add(key)
  broadcastUpdate({ immediate: true })
  try {
    const benchmarkResult = await benchmarkModel({
      apiKey: getApiKey(config, result.providerKey) ?? null,
      modelId: result.modelId,
      providerKey: result.providerKey,
      url: result.url,
      timeoutMs: BENCHMARK_TIMEOUT_MS,
    })
    benchmarkResults.set(key, benchmarkResult)
    updateHealthFromBenchmark(result, benchmarkResult)
    return benchmarkResult
  } catch (err) {
    const fallback = {
      ok: false,
      code: 'ERR',
      totalMs: 0,
      error: err?.message || 'Benchmark failed',
      retries: 0,
    }
    benchmarkResults.set(key, fallback)
    updateHealthFromBenchmark(result, fallback)
    return fallback
  } finally {
    benchmarkRunning.delete(key)
    broadcastUpdate({ immediate: true })
  }
}

function runWithConcurrency(tasks, concurrency) {
  return new Promise((resolve) => {
    const resultsOut = new Array(tasks.length)
    let nextIndex = 0
    let active = 0
    let completed = 0

    function startNext() {
      while (active < concurrency && nextIndex < tasks.length) {
        const index = nextIndex++
        active += 1
        Promise.resolve(tasks[index]())
          .then((value) => { resultsOut[index] = value })
          .catch((err) => { resultsOut[index] = { error: err } })
          .finally(() => {
            active -= 1
            completed += 1
            if (completed >= tasks.length) resolve(resultsOut)
            else startNext()
          })
      }
      if (tasks.length === 0) resolve(resultsOut)
    }

    startNext()
  })
}

const TOOL_MODE_ORDER = getInstallTargetModes()
const TOOL_MODES = new Set(TOOL_MODE_ORDER)
const DAEMON_PROXY_TIMEOUT_MS = 5000

// ─── Router daemon proxy helper ────────────────────────────────────────────
async function proxyToDaemon(path, options = {}) {
  const port = await readDaemonPort()
  if (!port) return null
  // 📖 Some operations (notably /sets/:name/sync, which probes ~24
  // 📖 candidate models with 1.5s timeouts each) can take 30s+ to finish.
  // 📖 Callers can pass `{ timeoutMs: 60000 }` to override the default
  // 📖 5s proxy timeout; everything else stays snappy.
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DAEMON_PROXY_TIMEOUT_MS
  try {
    const url = `http://127.0.0.1:${port}${path}`
    const resp = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
    return { ok: resp.ok, status: resp.status, data: await resp.json().catch(() => null) }
  } catch { return null }
}

function readTokenFile() {
  try {
    const tokensPath = getRouterTokensPath()
    if (!existsSync(tokensPath)) return null
    return JSON.parse(readFileSync(tokensPath, 'utf8'))
  } catch { return null }
}

// ─── Router v2 (BETA) daemon proxy helpers ─────────────────────────────────
// 📖 v2 runs next to v1 on its own port (19380 prod / 29380 dev). The web
// dashboard talks to it through these proxies; the SPA page itself lives at
// /router-v2 and is marked BETA on every surface.
function readDaemonV2Port() {
  try {
    const raw = readFileSync(getRouterPortPath(), 'utf8').trim()
    if (/^\d+$/.test(raw)) return Number(raw)
  } catch {}
  return null
}

async function proxyToDaemonV2(path, options = {}) {
  const port = readDaemonV2Port()
  if (!port) return null
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DAEMON_PROXY_TIMEOUT_MS
  try {
    const url = `http://127.0.0.1:${port}${path}`
    const resp = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
    return { ok: resp.ok, status: resp.status, data: await resp.json().catch(() => null) }
  } catch { return null }
}

function normalizeToolMode(mode) {
  return typeof mode === 'string' && TOOL_MODES.has(mode) ? mode : 'opencode'
}

function getPreferredToolMode() {
  return normalizeToolMode(config.settings?.preferredToolMode)
}

function persistPreferredToolMode(mode) {
  const normalized = normalizeToolMode(mode)
  if (!config.settings || typeof config.settings !== 'object') config.settings = {}
  config.settings.preferredToolMode = normalized
  const saveResult = saveConfig(config)
  return { mode: normalized, saveResult }
}

function getEndpointModel(providerKey, modelId) {
  const result = getResult(providerKey, modelId)
  if (!result) return null
  return {
    providerKey: result.providerKey,
    modelId: result.modelId,
    label: result.label,
    tier: result.tier,
    sweScore: result.sweScore,
    ctx: result.ctx,
    status: result.status,
  }
}

async function readDaemonPort() {
  try {
    // 📖 Use the dynamic port-path resolver so dev checkouts (FCM_DEV=1) read
    // 📖 the `-dev` port file and find the dev daemon, instead of always
    // 📖 reading the production file and missing it. Mirrors router-dashboard.js.
    const raw = readFileSync(getRouterPortPath(), 'utf8').trim()
    if (/^\d+$/.test(raw)) return Number(raw)
  } catch {}
  return null
}

async function syncFavoritesToRouter(selected) {
  if (config?.router?.enabled !== true) return
  const selKey = `${selected.providerKey}/${selected.modelId}`
  const favorites = Array.isArray(config.favorites) ? config.favorites : []
  const chain = [selKey, ...favorites.filter((entry) => entry !== selKey)]
  const models = chain.map((entry, index) => {
    const slashIdx = entry.indexOf('/')
    const provider = slashIdx >= 0 ? entry.slice(0, slashIdx) : '?'
    const model = slashIdx >= 0 ? entry.slice(slashIdx + 1) : entry
    return { provider, model, priority: index + 1 }
  })
  try {
    const port = await readDaemonPort()
    if (!port) return
    const baseUrl = `http://127.0.0.1:${port}`
    const setPayload = { name: 'fast-coding', models, created: new Date().toISOString() }
    await fetch(`${baseUrl}/sets/fast-coding`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(setPayload),
    })
    await fetch(`${baseUrl}/sets/fast-coding/activate`, { method: 'POST' })
  } catch {}
}

async function installEndpointForMode(mode, model) {
  return installProviderEndpoints(config, model.providerKey, mode, {
    scope: 'selected',
    modelIds: [model.modelId],
  })
}

function buildRecommendReason(result, answers) {
  const bits = []
  if (result.tier) bits.push(`${result.tier} tier`)
  if (result.sweScore && result.sweScore !== '—') bits.push(`${result.sweScore} SWE`)
  if (result.ctx) bits.push(`${result.ctx} context`)
  if (result.status === 'up') bits.push('currently up')
  const priority = PRIORITY_TYPES[answers.priority]?.label || 'balanced'
  return `${bits.join(' · ') || 'Strong catalog fit'} for ${priority.toLowerCase()} priority.`
}

// ─── Same-origin guard (mirrors src/core/router-daemon.js) ──────────────────

// 📖 Loopback hostnames are always trusted: the dashboard is a local tool.
function isLoopbackHostname(hostname) {
  if (!hostname) return false
  const h = hostname.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost')
}

// 📖 FCM_ALLOWED_ORIGINS: comma-separated extra origins allowed to call the
// 📖 dashboard, e.g. "http://mybox:3333,http://10.0.0.5:3333". Used for LAN
// 📖 setups when the server is bound to a non-loopback FCM_HOST.
function getAllowedOrigins() {
  return (process.env.FCM_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// 📖 Origin guard applied to every route: only loopback origins, requests
// 📖 whose Origin matches the Host the browser is already talking to, or
// 📖 explicitly allowed origins may call the dashboard. Non-browser clients
// 📖 (curl, TUI, proxies) send no Origin/Referer and pass. An `Origin: null`
// 📖 (sandboxed iframe) is rejected unless a loopback Referer accompanies it.
function isRequestOriginAllowed(req) {
  const origin = req.headers.origin
  const referer = req.headers.referer || req.headers.referrer
  const hasOrigin = typeof origin === 'string' && origin.length > 0
  const candidates = []
  if (hasOrigin && origin !== 'null') {
    candidates.push(origin)
  } else if (hasOrigin && origin === 'null') {
    if (typeof referer !== 'string' || !referer) return false
    candidates.push(referer)
  } else if (typeof referer === 'string' && referer) {
    candidates.push(referer)
  }
  if (candidates.length === 0) return true

  const hostHeader = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : ''
  for (const c of candidates) {
    try {
      const parsed = new URL(c)
      if (isLoopbackHostname(parsed.hostname)) return true
      if (hostHeader && parsed.host.toLowerCase() === hostHeader) return true
      if (getAllowedOrigins().includes(c)) return true
    } catch {
      return false
    }
  }
  return false
}

async function handleRequest(req, res) {
  // 📖 Same-origin guard first: never let a hostile page read this server.
  if (!isRequestOriginAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Forbidden cross-origin request')
    return
  }
  res.setHeader('X-FCM-Server', SERVER_SIGNATURE)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url, `http://${req.headers.host || `localhost:${DEFAULT_WEB_PORT}`}`)

  // 📖 M2: /api/key/:provider/test — matched here (above the switch) so the
  // 📖 M2 path doesn't conflict with the single-segment key reveal below.
  // 📖 Mirrors the TUI Settings `T` key behavior via the shared runProviderKeyTest()
  // 📖 pipeline in src/core/provider-key-tester.js: fast parallel auth probe to
  // 📖 /v1/account or /v1/models, then ping-based verification against real model
  // 📖 IDs (discovered from the provider's /models endpoint + repo catalog) so we
  // 📖 never send an empty model ID (which the provider rejects with HTTP 400).
  const keyTestMatch = url.pathname.match(/^\/api\/key\/([^/]+)\/test$/)
  if (keyTestMatch) {
    if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
    const providerKey = decodeURIComponent(keyTestMatch[1])
    if (!sources[providerKey]) { sendJson(res, 404, { error: 'Unknown provider' }); return }
    const apiKey = getApiKey(config, providerKey)
    if (!apiKey) { sendJson(res, 200, { outcome: 'missing_key', detail: `${sources[providerKey].name || providerKey} has no saved API key.` }); return }
    try {
      const result = await runProviderKeyTest(apiKey, providerKey, sources[providerKey])
      sendJson(res, 200, {
        outcome: result.outcome,
        detail: result.detail,
        attempts: result.attempts,
        discoveryNote: result.discoveryNote,
      })
    } catch (err) {
      sendJson(res, 200, { outcome: 'fail', detail: err.message || 'Probe failed' })
    }
    return
  }

  // 📖 Single-provider key endpoint. Returns the MASKED key plus a hasKey
  // 📖 flag only: the raw key never leaves the config file over HTTP. The
  // 📖 M2 /api/key/:provider/test route is matched above and uses a stricter
  // 📖 regex (one segment + /test) so the two routes coexist cleanly.
  const keyMatch = url.pathname.match(/^\/api\/key\/([^/]+)$/)
  if (keyMatch) {
    const providerKey = decodeURIComponent(keyMatch[1])
    if (!sources[providerKey]) {
      sendJson(res, 404, { error: 'Unknown provider' })
      return
    }
    const rawKey = getApiKey(config, providerKey)
    sendJson(res, 200, { key: rawKey ? maskApiKey(rawKey) : null, hasKey: Boolean(rawKey) })
    return
  }

  try {
    // 📖 /api/router/sets/:name/models — append / remove a single model.
    // 📖 M5: granular set-management endpoints used by the Web Router
    // 📖 Dashboard's drag-and-drop set manager. Matched here (above the
    // 📖 switch) because JavaScript switch only matches literal cases; the
    // 📖 `:name` syntax from the daemon-side routes is not a real wildcard.
    const setModelsMatch = url.pathname.match(/^\/api\/router\/sets\/([^/]+)\/models$/)
    if (setModelsMatch) {
      const setName = decodeURIComponent(setModelsMatch[1])
      const path = `/sets/${encodeURIComponent(setName)}/models`
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const proxy = await proxyToDaemon(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        if (proxy?.ok || proxy?.status === 201) {
          sendJson(res, proxy.status || 200, proxy.data)
          return
        }
        sendJson(res, proxy?.status || 502, proxy?.data || { error: 'Daemon not reachable' })
        return
      }
      if (req.method === 'DELETE') {
        const body = await readJsonBody(req)
        const proxy = await proxyToDaemon(path, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        if (proxy?.ok) { sendJson(res, 200, proxy.data); return }
        sendJson(res, proxy?.status || 502, proxy?.data || { error: 'Daemon not reachable' })
        return
      }
      res.writeHead(405); res.end('Method Not Allowed')
      return
    }

    // 📖 /api/router/sets/:name/reorder — accept a new priority order.
    const setReorderMatch = url.pathname.match(/^\/api\/router\/sets\/([^/]+)\/reorder$/)
    if (setReorderMatch) {
      if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
      const setName = decodeURIComponent(setReorderMatch[1])
      const body = await readJsonBody(req)
      const proxy = await proxyToDaemon(`/sets/${encodeURIComponent(setName)}/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (proxy?.ok) { sendJson(res, 200, proxy.data); return }
      sendJson(res, proxy?.status || 502, proxy?.data || { error: 'Daemon not reachable' })
      return
    }

    // 📖 /api/router/sets/:name/activate — switch the active set.
    const setActivateMatch = url.pathname.match(/^\/api\/router\/sets\/([^/]+)\/activate$/)
    if (setActivateMatch) {
      if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
      const setName = decodeURIComponent(setActivateMatch[1])
      const proxy = await proxyToDaemon(`/sets/${encodeURIComponent(setName)}/activate`, { method: 'POST' })
      if (proxy?.ok) { sendJson(res, 200, proxy.data); return }
      sendJson(res, proxy?.status || 502, proxy?.data || { error: 'Daemon not reachable' })
      return
    }

    // 📖 /api/router/sets/:name — PUT to edit/rename/replace models in the set.
    const setPutMatch = url.pathname.match(/^\/api\/router\/sets\/([^/]+)$/)
    if (setPutMatch && req.method === 'PUT') {
      const setName = decodeURIComponent(setPutMatch[1])
      const body = await readJsonBody(req)
      const proxy = await proxyToDaemon(`/sets/${encodeURIComponent(setName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (proxy?.ok) { sendJson(res, 200, proxy.data); return }
      // 📖 Fallback: if daemon is offline, edit config directly so the UI still works.
      if (!proxy || !proxy.ok) {
        if (!config.router) config.router = {}
        if (!config.router.sets) config.router.sets = {}
        if (config.router.sets[setName]) {
          const nextName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : setName
          const nextSets = { ...config.router.sets }
          delete nextSets[setName]
          nextSets[nextName] = {
            ...config.router.sets[setName],
            ...body,
            name: nextName,
            models: Array.isArray(body.models) ? body.models : config.router.sets[setName].models,
          }
          config.router.sets = nextSets
          if (config.router.activeSet === setName) {
            config.router.activeSet = nextName
          }
          saveConfig(config)
          broadcastUpdate({ immediate: true })
          sendJson(res, 200, { set: config.router.sets[nextName], router: config.router })
          return
        }
      }
      sendJson(res, proxy?.status || 502, proxy?.data || { error: 'Daemon not reachable' })
      return
    }

    // ── Router v2 (BETA) proxy: everything under /api/router-v2/* is forwarded
    // ── to the v2 daemon. /api/router-v2/status|stats map to the daemon's
    // ── /health|/stats; the rest keeps the /api/router-v2 prefix. start/stop
    // ── run the v2 lifecycle helpers directly in this process.
    if (url.pathname === '/api/router-v2' || url.pathname.startsWith('/api/router-v2/')) {
      const v2SubPath = url.pathname.replace(/^\/api\/router-v2/, '') || '/'
      if (v2SubPath === '/start' && req.method === 'POST') {
        try {
          const result = await startRouterDaemonBackground()
          sendJson(res, 200, result)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err.message })
        }
        return
      }
      if (v2SubPath === '/stop' && req.method === 'POST') {
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        try {
          const result = await stopRouterDaemon()
          sendJson(res, 200, result)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err.message })
        }
        return
      }
      if (v2SubPath === '/' || v2SubPath === '/status') {
        try {
          const status = await getRouterDaemonStatus()
          sendJson(res, 200, status)
        } catch (err) {
          sendJson(res, 200, { ok: false, running: false, router: 'v2', error: err.message })
        }
        return
      }
      if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
        res.writeHead(405); res.end('Method Not Allowed'); return
      }
      let upstreamPath
      if (v2SubPath === '/stats') upstreamPath = '/stats'
      else upstreamPath = `/api/router-v2${v2SubPath}`
      const proxyOptions = { method: req.method, timeoutMs: v2SubPath === '/test' ? 30000 : DAEMON_PROXY_TIMEOUT_MS }
      if (req.method === 'POST' || req.method === 'DELETE') {
        proxyOptions.headers = { 'Content-Type': 'application/json' }
        try {
          const body = await readJsonBody(req)
          proxyOptions.body = JSON.stringify(body)
        } catch {
          proxyOptions.body = '{}'
        }
      }
      const proxy = await proxyToDaemonV2(upstreamPath, proxyOptions)
      if (proxy) {
        sendJson(res, proxy.status || 502, proxy.data || { ok: false, error: proxy.error || 'v2 daemon error' })
        return
      }
      sendJson(res, 200, { ok: false, running: false, router: 'v2', error: 'Router daemon not reachable (start it with: free-coding-models --daemon-bg)' })
      return
    }

    // 📖 /api/router/sets/:name/sync — re-run the probe-based sync pipeline
    // 📖 against the named set. Used by the Web Router Dashboard's "Sync
    // 📖 best models" button so the user can rebuild a set with models
    // 📖 that actually work with their keys, without leaving the UI.
    const setSyncMatch = url.pathname.match(/^\/api\/router\/sets\/([^/]+)\/sync$/)
    if (setSyncMatch) {
      if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
      const setName = decodeURIComponent(setSyncMatch[1])
      // 📖 The daemon bounds the Web sync to 16 probes / ~60s. Give the
      // 📖 proxy 180s of headroom so a slow network doesn't truncate the
      // 📖 response — the daemon still returns when it's done.
      const proxy = await proxyToDaemon(`/sets/${encodeURIComponent(setName)}/sync`, { method: 'POST', timeoutMs: 180000 })
      if (proxy?.ok) { sendJson(res, 200, proxy.data); return }
      sendJson(res, proxy?.status || 502, proxy?.data || { error: 'Daemon not reachable' })
      return
    }

    switch (url.pathname) {
      case '/':
        serveDistFile(res, '/')
        return

      case '/styles.css':
      case '/app.js':
        serveDistFile(res, url.pathname)
        return

      case '/api/activity':
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        noteUserActivity()
        sendJson(res, 200, { ok: true, pingMode: runtime.pingMode })
        return

      case '/api/ping-mode': {
        if (req.method !== 'POST' && req.method !== 'GET') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        noteUserActivity()
        const action = url.searchParams.get('action')
        if (action === 'cycle') cyclePingMode()
        else if (PING_MODE_INTERVALS[action]) setPingMode(action, 'manual')
        sendJson(res, 200, {
          pingMode: runtime.pingMode,
          pingModeSource: runtime.pingModeSource,
          interval: runtime.activePingInterval,
          nextPingAt: runtime.nextPingAt,
        })
        return
      }

      case '/api/ping-timer':
        sendJson(res, 200, {
          nextPingAt: runtime.nextPingAt,
          isPinging: runtime.pendingPings > 0,
          pendingPings: runtime.pendingPings,
        })
        return

      case '/api/models':
        // 📖 Legacy REST contract: keep returning the flat model array.
        sendJson(res, 200, getModelsPayload().models)
        return

      case '/api/state':
        sendJson(res, 200, getModelsPayload())
        return

      case '/api/health':
        sendJson(res, 200, { ok: true, app: SERVER_SIGNATURE })
        return

      case '/api/config':
        sendJson(res, 200, getConfigPayload())
        return

      // ── M3: shared tool mode — same preferredToolMode setting as the TUI Z cycle ──
      case '/api/tool-mode': {
        if (req.method === 'GET') {
          sendJson(res, 200, { mode: getPreferredToolMode(), tools: TOOL_MODE_ORDER })
          return
        }
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const body = await readJsonBody(req)
        if (!TOOL_MODES.has(body?.mode)) { sendJson(res, 422, { error: 'Invalid tool mode' }); return }
        const { mode, saveResult } = persistPreferredToolMode(body.mode)
        if (!saveResult.success) { sendJson(res, 500, { error: saveResult.error || 'Failed to save tool mode' }); return }
        noteUserActivity()
        sendJson(res, 200, { mode })
        return
      }

      // ── M3: install selected model endpoint into a tool config, no process spawn ──
      case '/api/install-endpoint':
      case '/api/launch': {
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const body = await readJsonBody(req)
        const mode = normalizeToolMode(body?.toolMode || body?.mode || getPreferredToolMode())
        const model = getEndpointModel(body?.providerKey, body?.modelId)
        if (!model) { sendJson(res, 404, { error: 'Model not found' }); return }
        if (!isModelCompatibleWithTool(model.providerKey, mode)) {
          sendJson(res, 422, { error: 'Model is incompatible with selected tool', code: 'incompatible_model', mode, model })
          return
        }

        const { saveResult } = persistPreferredToolMode(mode)
        if (!saveResult.success) { sendJson(res, 500, { error: saveResult.error || 'Failed to persist tool mode' }); return }
        noteUserActivity()
        try {
          const installResult = await installEndpointForMode(mode, model)
          void syncFavoritesToRouter(model)
          void sendUsageTelemetry(config, { noTelemetry: false }, {
            event: 'app_action',
            mode,
            properties: {
              source: 'web',
              action_type: 'install_endpoint',
              tool_mode: mode,
              provider: model.providerKey,
              model_id: model.modelId,
              model_label: model.label,
              model_tier: model.tier,
            },
          })
          sendJson(res, 200, { configured: true, mode, model, installResult })
        } catch (err) {
          sendJson(res, 422, {
            error: err?.message || 'Failed to install endpoint',
            code: 'endpoint_install_failed',
            mode,
            model,
          })
        }
        return
      }

      // ── M3: Smart Recommend — wraps the same core scoring engine as the TUI ──
      case '/api/recommend': {
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const body = await readJsonBody(req)
        const answers = body?.answers || {}
        const taskType = answers.taskType
        const priority = answers.priority
        const contextBudget = answers.contextBudget
        if (!TASK_TYPES[taskType] || !PRIORITY_TYPES[priority] || !CONTEXT_BUDGETS[contextBudget]) {
          sendJson(res, 422, { error: 'Invalid recommendation answers' })
          return
        }
        const top3 = getTopRecommendations(results, taskType, priority, contextBudget, 3)
          .map(({ result, score }) => ({
            result: serializeModel(result),
            score,
            reason: buildRecommendReason(result, answers),
          }))
        void sendUsageTelemetry(config, { noTelemetry: false }, {
          event: 'app_action',
          mode: getPreferredToolMode(),
          properties: { source: 'web', action_type: 'smart_recommend', taskType, priority, contextBudget },
        })
        sendJson(res, 200, { top3, answers: { taskType, priority, contextBudget } })
        return
      }

      // ── M3: web telemetry mirror — never blocks UX and never exposes secrets ──
      case '/api/telemetry/event': {
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const body = await readJsonBody(req)
        const event = typeof body?.event === 'string' && body.event.trim() ? body.event.trim() : 'app_action'
        const properties = body?.properties && typeof body.properties === 'object' && !Array.isArray(body.properties)
          ? body.properties
          : {}
        void sendUsageTelemetry(config, { noTelemetry: false }, {
          event,
          mode: getPreferredToolMode(),
          properties: { ...properties, source: 'web' },
        })
        sendJson(res, 200, { ok: true })
        return
      }

      case '/api/events':
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        writeSsePayload(res, getModelsPayload())
        sseClients.add(res)
        req.on('close', () => sseClients.delete(res))
        return

      case '/api/settings': {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        const settings = await readJsonBody(req)
        noteUserActivity()
        if (settings.apiKeys) {
          if (!config.apiKeys) config.apiKeys = {}
          for (const [key, value] of Object.entries(settings.apiKeys)) {
            if (value) config.apiKeys[key] = value
            else delete config.apiKeys[key]
          }
        }
        if (settings.providers) {
          if (!config.providers) config.providers = {}
          for (const [key, value] of Object.entries(settings.providers)) {
            if (!config.providers[key]) config.providers[key] = {}
            config.providers[key].enabled = value?.enabled !== false
          }
        }
        saveConfig(config)
        broadcastUpdate({ immediate: true })
        sendJson(res, 200, { success: true })
        return
      }

      // ── M1: /api/favorites — single source of truth for favorites, shared
      // ── with the TUI through ~/.free-coding-models.json. Read on load,
      // ── write on toggle/reorder/pinnedAndSticky changes.
      case '/api/favorites': {
        ensureFavoritesConfig(config)
        if (req.method === 'GET') {
          sendJson(res, 200, {
            favorites: config.favorites,
            pinnedAndSticky: Boolean(config.settings?.favoritesPinnedAndSticky),
          })
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        const body = await readJsonBody(req)
        noteUserActivity()

        if (Array.isArray(body.favorites)) {
          // 📖 Validate each entry is a non-empty string. Anything else is dropped
          // 📖 silently so a partial / malformed payload never breaks the config.
          const cleaned = body.favorites.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
          config.favorites = Array.from(new Set(cleaned))
        }
        if (typeof body.pinnedAndSticky === 'boolean') {
          if (!config.settings || typeof config.settings !== 'object') config.settings = {}
          config.settings.favoritesPinnedAndSticky = body.pinnedAndSticky
        }

        const saveResult = saveConfig(config, { replaceFavorites: true })
        if (!saveResult.success) {
          sendJson(res, 500, { success: false, error: saveResult.error || 'Failed to persist favorites' })
          return
        }
        sendJson(res, 200, {
          success: true,
          favorites: config.favorites,
          pinnedAndSticky: Boolean(config.settings?.favoritesPinnedAndSticky),
        })
        return
      }

      case '/api/benchmark': {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        const body = await readJsonBody(req)
        const result = getResult(body.providerKey, body.modelId)
        if (!result) {
          sendJson(res, 404, { error: 'Model not found' })
          return
        }
        const key = getResultKey(result)
        if (benchmarkRunning.has(key)) {
          sendJson(res, 409, { error: 'Benchmark already in progress for this model' })
          return
        }
        noteUserActivity()
        const benchmarkResult = await runSingleBenchmark(result)
        sendJson(res, 200, benchmarkResult)
        return
      }

      case '/api/benchmark-stream': {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }

        let body
        try {
          body = await readJsonBody(req)
        } catch {
          res.writeHead(400)
          res.end('Invalid JSON')
          return
        }

        const result = getResult(body.providerKey, body.modelId)
        if (!result) {
          sendJson(res, 404, { error: 'Model not found' })
          return
        }

        const source = sources[result.providerKey]
        const apiKey = getApiKey(config, result.providerKey)
        if (!apiKey) {
          sendJson(res, 401, { error: 'No API key configured' })
          return
        }

        const key = getResultKey(result)
        benchmarkRunning.add(key)
        broadcastUpdate({ immediate: true })

        // 📖 Set SSE headers for streaming response to the browser
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        })

        try {
          // Build the upstream URL — append /v1/chat/completions if needed
          let upstreamUrl = source?.url || result.url
          if (!upstreamUrl.includes('/chat/completions')) {
            upstreamUrl = upstreamUrl.replace(/\/+$/, '') + '/v1/chat/completions'
          }

          // 📖 ZAI provider: strip the "zai/" prefix from modelId for the API
          let apiModelId = result.modelId
          if (result.providerKey === 'zai' && apiModelId.startsWith('zai/')) {
            apiModelId = apiModelId.slice(4)
          }

          const upstreamHeaders = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          }

          // 📖 OpenRouter requires HTTP-Referer and X-Title headers
          if (result.providerKey === 'openrouter') {
            upstreamHeaders['HTTP-Referer'] = 'https://github.com/vava-nessa/free-coding-models'
            upstreamHeaders['X-Title'] = 'free-coding-models'
          }

          const reqBody = {
            model: apiModelId,
            messages: [{ role: 'user', content: BENCHMARK_PROMPT }],
            max_tokens: 140,
            temperature: 0,
            stream: true,
          }

          const resp = await fetch(upstreamUrl, {
            method: 'POST',
            headers: upstreamHeaders,
            body: JSON.stringify(reqBody),
            signal: AbortSignal.timeout(20000),
          })

          if (!resp.ok) {
            let message = `HTTP ${resp.status}`
            try {
              const errJson = await resp.json()
              message = errJson?.error?.message || errJson?.error || errJson?.message || message
            } catch { /* keep default */ }
            res.write('event: error\ndata: ' + JSON.stringify({ error: message }) + '\n\n')
            res.end()
            benchmarkRunning.delete(key)
            broadcastUpdate({ immediate: true })
            return
          }

          // 📖 Parse SSE stream from the provider — extract tokens and measure TPS
          const reader = resp.body.getReader()
          const decoder = new TextDecoder()
          const t0 = performance.now()
          let tokenCount = 0
          let fullText = ''
          let buffer = ''

          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || '' // keep incomplete line in buffer

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed.startsWith('data: ')) continue
              const payload = trimmed.slice(6)
              if (payload === '[DONE]') continue

              let parsed
              try { parsed = JSON.parse(payload) } catch { continue }

              const delta = parsed?.choices?.[0]?.delta?.content
              if (!delta) continue

              fullText += delta
              tokenCount++
              res.write('event: token\ndata: ' + JSON.stringify({
                token: delta,
                totalMs: Math.round(performance.now() - t0),
                tokens: tokenCount,
                tps: Math.round(tokenCount / ((performance.now() - t0) / 1000) * 10) / 10,
                text: fullText,
              }) + '\n\n')
            }
          }

          const totalMs = Math.round(performance.now() - t0)
          const tps = tokenCount / (totalMs / 1000)

          res.write('event: done\ndata: ' + JSON.stringify({
            totalMs,
            outputTokens: tokenCount,
            tokensPerSecond: Math.round(tps * 10) / 10,
            answerPreview: fullText.slice(0, 100),
          }) + '\n\n')
          res.end()

          // 📖 Update shared benchmark state so the dashboard reflects the result
          const benchmarkResult = {
            ok: true,
            totalMs,
            outputTokens: tokenCount,
            tokensPerSecond: tps,
            answerPreview: fullText.slice(0, 60),
          }
          benchmarkResults.set(key, benchmarkResult)
          benchmarkRunning.delete(key)
          updateHealthFromBenchmark(result, benchmarkResult)
          broadcastUpdate({ immediate: true })
        } catch (err) {
          res.write('event: error\ndata: ' + JSON.stringify({ error: err?.message || 'Stream failed' }) + '\n\n')
          res.end()
          benchmarkRunning.delete(key)
          broadcastUpdate({ immediate: true })
        }
        return
      }

      case '/api/global-benchmark': {
        if (req.method === 'GET') {
          sendJson(res, 200, {
            running: runtime.globalBenchmarkRunning,
            total: runtime.globalBenchmarkTotal,
            completed: runtime.globalBenchmarkCompleted,
          })
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        if (runtime.globalBenchmarkRunning) {
          sendJson(res, 409, { error: 'Global benchmark already running' })
          return
        }

        const body = await readJsonBody(req)
        noteUserActivity()
        const healthPriority = { up: 0, pending: 1, timeout: 2, noauth: 3, auth_error: 4, down: 5 }
        const modelsToBenchmark = parseVisibleBenchmarkModels(body)
          .sort((a, b) => {
            const hpA = healthPriority[a.status] ?? 6
            const hpB = healthPriority[b.status] ?? 6
            if (hpA !== hpB) return hpA - hpB
            const pingA = typeof a.pings?.[a.pings.length - 1]?.ms === 'number' ? a.pings[a.pings.length - 1].ms : 99999
            const pingB = typeof b.pings?.[b.pings.length - 1]?.ms === 'number' ? b.pings[b.pings.length - 1].ms : 99999
            return pingA - pingB
          })

        runtime.globalBenchmarkRunning = true
        runtime.globalBenchmarkTotal = modelsToBenchmark.length
        runtime.globalBenchmarkCompleted = 0
        broadcastUpdate({ immediate: true })

        const tasks = modelsToBenchmark.map((model) => async () => {
          try {
            return await runSingleBenchmark(model)
          } finally {
            runtime.globalBenchmarkCompleted += 1
            broadcastUpdate({ immediate: true })
          }
        })

        void runWithConcurrency(tasks, GLOBAL_BENCHMARK_CONCURRENCY).finally(() => {
          runtime.globalBenchmarkRunning = false
          runtime.globalBenchmarkTotal = 0
          runtime.globalBenchmarkCompleted = 0
          broadcastUpdate({ immediate: true })
        })

        sendJson(res, 202, { started: true, total: modelsToBenchmark.length })
        return
      }

      // ── M2: /api/version — local vs latest + lastRelease date ─────────────
      case '/api/version': {
        try {
          const { latestVersion, error } = await checkForUpdateDetailed()
          const lastReleaseDate = await fetchLastReleaseDate()
          sendJson(res, 200, {
            local: LOCAL_VERSION,
            latest: latestVersion,
            lastReleaseDate,
            error: error || null,
          })
        } catch (err) {
          sendJson(res, 200, { local: LOCAL_VERSION, latest: null, lastReleaseDate: null, error: err.message || 'update check failed' })
        }
        return
      }

      // ── M2: /api/update/check — force a fresh registry check ──────────────
      case '/api/update/check': {
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const { latestVersion, error } = await checkForUpdateDetailed()
        sendJson(res, 200, { latest: latestVersion, error: error || null })
        return
      }

      // ── M2: /api/update/run — spawn the package manager upgrade ──────────
      case '/api/update/run': {
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const body = await readJsonBody(req)
        const target = typeof body?.version === 'string' && body.version ? body.version : null
        // 📖 Mirrors the TUI's `Shift+U` behavior: install + tell the user to
        // 📖 restart the server. We don't kill the in-process server from
        // 📖 here because that would interrupt every connected client.
        if (target) {
          runUpdate(target)
          sendJson(res, 200, { started: true, version: target, message: 'Update initiated — restart the dashboard to apply.' })
        } else {
          const { latestVersion } = await checkForUpdateDetailed()
          if (!latestVersion) { sendJson(res, 404, { error: 'No update available' }); return }
          runUpdate(latestVersion)
          sendJson(res, 200, { started: true, version: latestVersion, message: 'Update initiated — restart the dashboard to apply.' })
        }
        return
      }

      // ── M2: /api/changelog — parsed changelog directory ─────────────────
      case '/api/changelog': {
        sendJson(res, 200, loadChangelog())
        return
      }

      // ── M2: /api/settings/feature — single-feature toggle endpoint ───────
      case '/api/settings/feature': {
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object' || !body.feature) {
          sendJson(res, 400, { error: 'Missing "feature" key' }); return
        }
        if (!config.settings || typeof config.settings !== 'object') config.settings = {}
        const before = config.settings[body.feature]
        // 📖 Boolean features are toggled unless the caller passes an explicit value.
        if (body.value !== undefined) {
          // 📖 Explicit value (string / boolean / number) always wins. Used for
          // 📖 things like theme='auto'|'dark'|'light' where a string payload
          // 📖 is the right shape.
          config.settings[body.feature] = body.value
        } else if (typeof before === 'boolean') {
          // 📖 No explicit value → toggle for boolean features
          // 📖 (e.g. favoritesPinnedAndSticky).
          config.settings[body.feature] = !before
        } else {
          config.settings[body.feature] = true
        }
        const result = saveConfig(config)
        if (!result.success) { sendJson(res, 500, { error: result.error || 'Save failed' }); return }
        sendJson(res, 200, { success: true, feature: body.feature, value: config.settings[body.feature] })
        return
      }

      // ── M2: /api/shell-env/toggle — flip shell env export for the user ──
      case '/api/shell-env/toggle': {
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const body = await readJsonBody(req)
        const enable = typeof body?.enabled === 'boolean' ? body.enabled : undefined
        if (!config.settings || typeof config.settings !== 'object') config.settings = {}
        if (enable === undefined) {
          config.settings.shellEnvEnabled = !config.settings.shellEnvEnabled
        } else {
          config.settings.shellEnvEnabled = enable
        }
        if (config.settings.shellEnvEnabled) {
          syncShellEnv(config)
          ensureShellRcSource()
        } else {
          removeShellEnv()
        }
        saveConfig(config)
        sendJson(res, 200, { success: true, enabled: config.settings.shellEnvEnabled })
        return
      }

      // ── M2: /api/legacy-cleanup — run the discontinued-proxy cleanup ─────
      case '/api/legacy-cleanup': {
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const summary = cleanupLegacyProxyArtifacts()
        sendJson(res, 200, summary)
        return
      }

      // ── M4: Router dashboard endpoints ────────────────────────────────────
      case '/api/router/status': {
        try {
          const status = await getRouterDaemonStatus()
          sendJson(res, 200, status)
        } catch (err) {
          sendJson(res, 200, { ok: false, running: false, error: err.message })
        }
        return
      }

      case '/api/router/stats': {
        const proxy = await proxyToDaemon('/stats')
        if (proxy?.ok) { sendJson(res, 200, proxy.data); return }
        sendJson(res, 200, { ok: false, running: false, error: 'Daemon not reachable' })
        return
      }

      case '/api/router/tokens': {
        // 📖 Try daemon first (live data), fall back to reading the token file
        const proxy = await proxyToDaemon('/stats/tokens')
        if (proxy?.ok) { sendJson(res, 200, proxy.data); return }
        const fileData = readTokenFile()
        if (fileData) { sendJson(res, 200, fileData); return }
        sendJson(res, 200, { daily: {}, all_time: { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, requests: 0 } })
        return
      }

      case '/api/router/start': {
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        try {
          const result = await startRouterDaemonBackground()
          noteUserActivity()
          sendJson(res, 200, result)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err.message })
        }
        return
      }

      case '/api/router/stop': {
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        try {
          const result = await stopRouterDaemon()
          sendJson(res, 200, result)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err.message })
        }
        return
      }

      case '/api/router/sets': {
        // 📖 Proxy set operations to the daemon
        if (req.method === 'GET') {
          const proxy = await proxyToDaemon('/sets')
          if (proxy?.ok) { sendJson(res, 200, proxy.data); return }
          // 📖 Fallback: read sets from config directly
          const routerConfig = config.router || {}
          sendJson(res, 200, { activeSet: routerConfig.activeSet || 'fast-coding', sets: routerConfig.sets || {} })
          return
        }
        if (req.method === 'POST') {
          const proxy = await proxyToDaemon('/sets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await readJsonBody(req)) })
          if (proxy?.ok) { sendJson(res, 200, proxy.data); return }
          if (proxy?.status === 201) { sendJson(res, 201, proxy.data); return }
          sendJson(res, proxy?.status || 502, proxy?.data || { error: 'Daemon not reachable' })
          return
        }
        res.writeHead(405); res.end('Method Not Allowed')
        return
      }

      // 📖 /api/router/sets/:name/models — append / remove a model.
      // 📖 Backed by the daemon's POST/DELETE /sets/:name/models endpoints
      // 📖 and used by the Web Router Dashboard's set manager UI.
      // 📖 Granular set-management routes (with `:name` parameters) are
      // 📖 matched above the switch — see the `setModelsMatch`,
      // 📖 `setReorderMatch`, and `setActivateMatch` blocks. Putting them
      // 📖 inside the switch would silently never match because JS switch
      // 📖 cases are exact-string equality, not patterns.

      case '/api/router/probe-mode': {
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const body = await readJsonBody(req)
        const proxy = await proxyToDaemon('/daemon/probe-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        if (proxy?.ok) { sendJson(res, 200, proxy.data); return }
        sendJson(res, proxy?.status || 502, proxy?.data || { error: 'Daemon not reachable' })
        return
      }

      // 📖 /api/router/probe-all — launch AI Latency benchmarks on the active
      // 📖 set's models (or an explicit list) inside the DAEMON process. Results
      // 📖 flow back through /api/router/stats (per-model `benchmark` field +
      // 📖 `globalBenchmark` progress), so the Router Dashboard's set list shows
      // 📖 live AI latency after a probe. Proxied to the daemon's
      // 📖 /api/global-benchmark (longer timeout — probing ~10 models takes time).
      case '/api/router/probe-all': {
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const body = await readJsonBody(req)
        const proxy = await proxyToDaemon('/api/global-benchmark', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
          timeoutMs: 60000,
        })
        if (proxy?.ok || proxy?.status === 202) { sendJson(res, proxy?.status || 200, proxy.data); return }
        sendJson(res, proxy?.status || 502, proxy?.data || { error: 'Daemon not reachable' })
        return
      }

      case '/api/router/catalog': {
        // 📖 Catalog of routeable models for the Web Router Dashboard's
        // 📖 "Add model" picker. Proxies the daemon when running, falls
        // 📖 back to a synthesized list from the local config + sources.
        if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const proxy = await proxyToDaemon('/api/router/catalog')
        if (proxy?.ok) { sendJson(res, 200, proxy.data); return }
        // 📖 Fallback: build a minimal catalog from the local sources.
        const { sources } = await import('../sources.js')
        const rows = []
        for (const [providerKey, source] of Object.entries(sources || {})) {
          if (!source?.url || source?.cliOnly) continue
          if (!source.url.includes('/chat/completions')) continue
          for (const [modelId, label] of source.models || []) {
            rows.push({
              key: `${providerKey}/${modelId}`,
              provider: providerKey,
              model: modelId,
              label: label || modelId,
              hasKey: !!getApiKey(config, providerKey),
            })
          }
        }
        sendJson(res, 200, { models: rows, count: rows.length })
        return
      }

      case '/api/router/quick-setup': {
        // 📖 Return router connection info for quick clipboard copy
        const port = await readDaemonPort()
        const routerConfig = config.router || {}
        const activeSetName = routerConfig.activeSet || 'fast-coding'
        const baseUrl = port ? `http://127.0.0.1:${port}/v1` : null
        sendJson(res, 200, {
          running: !!port,
          port: port || null,
          baseUrl,
          model: 'fcm',
          activeSet: activeSetName,
          apiKey: 'not-needed',
        })
        return
      }

      case '/api/router/preprompt': {
        // 📖 Read or update the router pre-prompt. GET reads from the
        // 📖 in-process config (so we don't need a live daemon); PUT writes
        // 📖 back to `~/.free-coding-models.json` and the daemon picks up the
        // 📖 new value on its 10s config-reload tick without needing a restart.
        if (req.method === 'GET') {
          const routerConfig = config.router || {}
          const pre = routerConfig.prePrompt || { enabled: false, text: '' }
          sendJson(res, 200, {
            enabled: pre.enabled === true,
            text: pre.text || '',
          })
          return
        }
        if (req.method === 'PUT') {
          const body = await readJsonBody(req)
          const nextEnabled = body?.enabled === true
          const nextText = typeof body?.text === 'string' ? body.text.slice(0, 4000) : ''
          if (!config.router || typeof config.router !== 'object') config.router = {}
          config.router.prePrompt = { enabled: nextEnabled, text: nextText }
          saveConfig(config)
          noteUserActivity()
          sendJson(res, 200, { ok: true, enabled: nextEnabled, text: nextText })
          return
        }
        res.writeHead(405); res.end('Method Not Allowed')
        return
      }

      case '/api/playground/chat': {
        // 📖 Playground proxy: routes chat-completions requests either to
        // 📖 the local router daemon (for "fcm" auto-router) or directly
        // 📖 to the provider (for specific models). This way the playground
        // 📖 works immediately with any "up" model, even without the daemon.
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const body = await readJsonBody(req)
        const wantsStream = body?.stream === true
        const requestedModel = body?.model || 'fcm'
        const isFcm = requestedModel === 'fcm'

        // 📖 Resolve direct provider routing for non-fcm models.
        // 📖 Format: "providerKey/modelId" → look up source URL + API key.
        let directUrl = null
        let directApiKey = null
        let directModelId = null
        if (!isFcm) {
          const slashIdx = requestedModel.indexOf('/')
          if (slashIdx > 0) {
            const providerKey = requestedModel.slice(0, slashIdx)
            const modelId = requestedModel.slice(slashIdx + 1)
            const source = sources[providerKey]
            if (source?.url) {
              directApiKey = getApiKey(config, providerKey)
              // 📖 Always resolve the URL so we can differentiate "no key"
              // 📖 from "unknown model" in the error handler below.
              let baseUrl = source.url
              if (!baseUrl.includes('/chat/completions')) {
                baseUrl = baseUrl.replace(/\/+$/, '') + '/v1/chat/completions'
              }
              directUrl = baseUrl
              directModelId = modelId
            }
          }
        }

        // 📖 Decide routing: direct to provider (non-fcm, has key) or via daemon.
        const useDirectRoute = !isFcm && directUrl && directApiKey

        // 📖 If user picked a specific model but has no API key for it,
        // 📖 tell them instead of falling through to the daemon 503.
        if (!isFcm && directUrl && !directApiKey) {
          const providerKey = requestedModel.slice(0, requestedModel.indexOf('/'))
          sendJson(res, 401, { ok: false, error: `No API key configured for ${sources[providerKey]?.name || providerKey}. Add one in Settings to chat directly with this model.` })
          return
        }

        // 📖 If user picked a specific model but we couldn't resolve it,
        // 📖 tell them instead of falling through to the daemon 503.
        if (!isFcm && !directUrl) {
          sendJson(res, 404, { ok: false, error: `Could not resolve provider for model "${requestedModel}". Try selecting a different model or use the auto-router (fcm).` })
          return
        }
        const upstreamUrl = useDirectRoute
          ? directUrl
          : `http://127.0.0.1:${await readDaemonPort()}/v1/chat/completions`

        if (!useDirectRoute && !await readDaemonPort()) {
          sendJson(res, 503, { ok: false, error: 'Router daemon is not running. Start it from the Router card or with `free-coding-models --daemon-bg`.' })
          return
        }

        // 📖 Build the upstream payload. For direct routing, extract the
        // 📖 actual model ID from the providerKey/modelId format.
        const upstreamPayload = {
          ...body,
          stream: wantsStream,
          model: useDirectRoute ? directModelId : requestedModel,
        }

        // 📖 Build headers: direct routing needs auth + any provider-specific
        // 📖 headers. Daemon routing is just JSON content-type.
        const upstreamHeaders = { 'Content-Type': 'application/json' }
        if (useDirectRoute) {
          // 📖 Most providers use standard Bearer auth. A few need extra
          // 📖 headers (OpenRouter wants Referer + X-Title for ex).
          upstreamHeaders['Authorization'] = `Bearer ${directApiKey}`
          const providerKey = requestedModel.slice(0, requestedModel.indexOf('/'))
          if (providerKey === 'openrouter') {
            upstreamHeaders['HTTP-Referer'] = 'https://github.com/vava-nessa/free-coding-models'
            upstreamHeaders['X-Title'] = 'free-coding-models'
          }
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 120000)
        req.on('close', () => controller.abort())
        try {
          const upstreamResp = await fetch(upstreamUrl, {
            method: 'POST',
            headers: upstreamHeaders,
            body: JSON.stringify(upstreamPayload),
            signal: controller.signal,
          })
          if (wantsStream) {
            // 📖 Pipe SSE events straight from the upstream to the browser.
            // 📖 Forward the daemon's x-fcm-router-model header so the browser
            // 📖 knows WHICH model the priority-first router actually served
            // 📖 (the chunks only carry the bare model id, not provider/model).
            // 📖 See issue #120 — this makes the served-model badge work.
            const streamHeaders = {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-Accel-Buffering': 'no',
            }
            const servedModel = upstreamResp.headers.get('x-fcm-router-model')
            if (servedModel) streamHeaders['x-fcm-router-model'] = servedModel
            res.writeHead(upstreamResp.status, streamHeaders)
            const reader = upstreamResp.body?.getReader()
            if (!reader) { res.end(); clearTimeout(timeout); return }
            try {
              while (true) {
                const { value, done } = await reader.read()
                if (done) break
                if (value) res.write(Buffer.from(value))
              }
            } finally {
              clearTimeout(timeout)
              res.end()
            }
            return
          }
          const json = await upstreamResp.json().catch(() => null)
          sendJson(res, upstreamResp.status, json || { ok: false, error: 'Empty response from upstream' })
          return
        } catch (err) {
          sendJson(res, 502, { ok: false, error: `Playground proxy failed: ${err.message || String(err)}` })
          return
        } finally {
          clearTimeout(timeout)
        }
      }

      // ── M4: Installed Models — scan tool configs + soft-delete ────────────
      case '/api/installed-models': {
        if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const results = scanAllToolConfigs()
        sendJson(res, 200, { results })
        return
      }

      // ── M4: Install Endpoints wizard — full provider install into tool ────
      case '/api/install-endpoints/providers': {
        if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const providers = getConfiguredInstallableProviders(config)
        sendJson(res, 200, { providers })
        return
      }

      case '/api/install-endpoints/catalog': {
        const catProvider = url.searchParams.get('provider')
        if (!catProvider) { sendJson(res, 400, { error: 'Missing ?provider= parameter' }); return }
        const models = getProviderCatalogModels(catProvider)
        sendJson(res, 200, { provider: catProvider, models })
        return
      }

      case '/api/install-endpoints/wizard': {
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
        const body = await readJsonBody(req)
        const wizProvider = body?.providerKey
        const wizTool = body?.toolMode
        const wizScope = body?.scope || 'all'
        const wizModelIds = body?.modelIds || []
        if (!wizProvider || !wizTool) {
          sendJson(res, 400, { error: 'Missing providerKey or toolMode' }); return
        }
        noteUserActivity()
        try {
          const installResult = installProviderEndpoints(config, wizProvider, wizTool, {
            scope: wizScope,
            modelIds: wizModelIds,
          })
          void sendUsageTelemetry(config, { noTelemetry: false }, {
            event: 'app_action',
            mode: wizTool,
            properties: {
              source: 'web',
              action_type: 'install_endpoints_wizard',
              provider: wizProvider,
              tool_mode: wizTool,
              scope: wizScope,
              model_count: installResult.modelCount || 0,
            },
          })
          sendJson(res, 200, { success: true, ...installResult })
        } catch (err) {
          sendJson(res, 422, { error: err.message, code: 'install_failed' })
        }
        return
      }

      // 📖 M4: soft-delete an installed model (pattern match — must be before default:)
      // 📖 Path: /api/installed-models/:tool/:model/disable
      default: {
        const disableMatch = url.pathname.match(/^\/api\/installed-models\/([^/]+)\/([^/]+)\/disable$/)
        if (disableMatch && req.method === 'POST') {
          const toolMode = decodeURIComponent(disableMatch[1])
          const modelId = decodeURIComponent(disableMatch[2])
          const result = softDeleteModel(toolMode, modelId)
          sendJson(res, result.success ? 200 : 422, result)
          return
        }
      }
        // 📖 Serve Vite's /assets/* bundle, and our static favicon set that
        // 📖 Vite copies verbatim from web/public/ into web/dist/. The legacy
        // 📖 /favicon.ico lives at web/public/favicon.ico (root of public/).
        if (
          url.pathname.startsWith('/assets/')
          || url.pathname.startsWith('/favicons/')
          || url.pathname === '/favicon.ico'
          || url.pathname.endsWith('.js')
          || url.pathname.endsWith('.css')
          || url.pathname.endsWith('.png')
          || url.pathname.endsWith('.svg')
          || url.pathname.endsWith('.webmanifest')
          || url.pathname.endsWith('.xml')
          || url.pathname.endsWith('.ico')
        ) {
          serveDistFile(res, url.pathname)
          return
        }
        res.writeHead(404)
        res.end('Not Found')
    }
  } catch (err) {
    if (!res.writableEnded) sendJson(res, 500, { error: err?.message || 'Internal server error' })
  }
}

function checkPortInUse(port) {
  // 📖 Probe both the wildcard and the loopback address: macOS SO_REUSEADDR
  // 📖 lets a wildcard probe succeed even when 127.0.0.1:port is taken (the
  // 📖 dashboard binds loopback by default), and a loopback probe succeed
  // 📖 when another app owns the wildcard bind. Either hit means "in use".
  const probe = (host) => new Promise((resolve) => {
    const s = createServer()
    s.once('error', (err) => { if (err.code === 'EADDRINUSE') resolve(true); else resolve(false) })
    s.once('listening', () => { s.close(); resolve(false) })
    s.listen(port, host)
  })
  return Promise.all([probe(undefined), probe('127.0.0.1')]).then(([wildcard, loopback]) => wildcard || loopback)
}

export async function inspectExistingWebServer(port) {
  const inUse = await checkPortInUse(port)
  if (!inUse) return { inUse: false, isFcm: false }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 750)

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    const payload = await response.json().catch(() => null)
    const signature = response.headers.get('x-fcm-server')
    return {
      inUse: true,
      isFcm: signature === SERVER_SIGNATURE || payload?.app === SERVER_SIGNATURE,
    }
  } catch {
    return { inUse: true, isFcm: false }
  } finally {
    clearTimeout(timeout)
  }
}

export async function findAvailablePort(startPort, maxAttempts = 20) {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    if (!(await checkPortInUse(port))) return port
  }
  throw new Error(`No free local port found between ${startPort} and ${startPort + maxAttempts - 1}`)
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open'
  exec(`${cmd} "${url}"`, (err) => {
    if (err) console.log(`  💡 Open manually: ${url}`)
  })
}

export async function startWebServer(port = DEFAULT_WEB_PORT, { open = true, startPingLoop = true, updateStatus = null } = {}) {
  runtime.updateStatus = updateStatus && updateStatus.allowedOutdated
    ? {
      latestVersion: updateStatus.latestVersion || null,
      allowedOutdated: true,
      warningMessage: updateStatus.warningMessage || null,
      failures: updateStatus.failures || 0,
    }
    : null

  const portStatus = await inspectExistingWebServer(port)

  if (portStatus.inUse && portStatus.isFcm) {
    const url = `http://localhost:${port}`
    console.log()
    console.log('  ⚡ free-coding-models Web Dashboard already running')
    console.log(`  🌐 ${url}`)
    console.log()
    if (open) openBrowser(url)
    return null
  }

  let resolvedPort = port
  if (portStatus.inUse && !portStatus.isFcm) {
    resolvedPort = await findAvailablePort(port + 1)
    console.log()
    console.log(`  ⚠️ Port ${port} is already in use by another local app`)
    console.log(`  ↪ Starting free-coding-models Web Dashboard on port ${resolvedPort} instead`)
    console.log()
  }

  const url = `http://localhost:${resolvedPort}`
  const server = createServer((req, res) => void handleRequest(req, res))
  startedServer = server

  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
  })

  io.on('connection', (socket) => {
    noteUserActivity()
    socket.emit('models:update', getModelsPayload())
    socket.on('client:activity', () => noteUserActivity())
    socket.on('models:refresh', () => socket.emit('models:update', getModelsPayload()))
  })

  // 📖 Bind loopback by default so the dashboard is never reachable from the
  // 📖 LAN by accident; set FCM_HOST (e.g. "0.0.0.0" for Docker) to override.
  // 📖 Await the actual bind so callers can hit the port as soon as this
  // 📖 resolves (tests read server.address() right after startup).
  const bindHost = process.env.FCM_HOST || '127.0.0.1'
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err)
    server.once('error', onError)
    server.listen(resolvedPort, bindHost, () => {
      server.off('error', onError)
      console.log()
      console.log('  ⚡ free-coding-models Web Dashboard')
      console.log(`  🌐 ${url}`)
      console.log(`  📊 Monitoring ${results.filter((r) => !r.cliOnly).length} models across ${Object.keys(sources).length} providers`)
      console.log()
      console.log('  Press Ctrl+C to stop')
      console.log()
      if (startPingLoop && !pingLoopTimer) {
        runtime.lastPingTime = Date.now()
        runtime.nextPingAt = runtime.lastPingTime + runtime.activePingInterval
        startPingCycle()
      }
      if (open) openBrowser(url)
      resolve()
    })
  })

  server.on('close', () => {
    clearTimeout(pingLoopTimer)
    clearTimeout(broadcastTimer)
    clearInterval(heartbeatTimer)
    for (const res of [...sseClients]) {
      try { res.end() } catch {}
    }
    sseClients.clear()
    io?.close()
    io = null
    if (startedServer === server) startedServer = null
  })

  heartbeatTimer = setInterval(() => {
    refreshPingMode()
    for (const res of [...sseClients]) {
      try { res.write(': heartbeat\n\n') } catch { sseClients.delete(res) }
    }
  }, 15_000)

  return server
}

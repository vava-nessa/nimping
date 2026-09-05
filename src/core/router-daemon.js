/**
 * @file router-daemon.js
 * @description Smart Model Router daemon for local OpenAI-compatible failover routing.
 *
 * @details
 *   📖 The router daemon is the persistent part of FCM: coding tools point at
 *   `http://localhost:19280/v1`, send `model: "fcm"`, and this server forwards
 *   the request to the healthiest configured provider/model in the active set.
 *
 *   📖 It deliberately uses only Node built-ins and the existing provider catalog
 *   so the npm package keeps its tiny dependency surface. The daemon stores only
 *   metadata (latency, status, token counts); request and response bodies are
 *   never written to logs or telemetry.
 *
 * @functions
 *   → runRouterDaemon() - Start the foreground daemon HTTP server
 *   → startRouterDaemonBackground() - Spawn the daemon detached from the TUI
 *   → stopRouterDaemon() - Send SIGTERM to the recorded daemon process
 *   → getRouterDaemonStatus() - Discover and read `/health` from a running daemon
 *   → buildDefaultRouterSet() - Create the first priority-ordered model set
 *   → formatOpenAiError() - Build OpenAI-compatible error response payloads
 *   → createRouterRuntimeForTest() - Build an isolated runtime for mock-upstream tests
 *
 * @exports runRouterDaemon, startRouterDaemonBackground, stopRouterDaemon
 * @exports getRouterDaemonStatus, buildDefaultRouterSet, formatOpenAiError
 * @exports createRouterRuntimeForTest
 *
 * @see ./config.js - router config is persisted under `router`
 * @see ../sources.js - provider URLs and model IDs are resolved from the catalog
 */

import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath, sep as pathSep } from 'node:path'
import { fork, execFileSync } from 'node:child_process'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { MODELS, sources } from '../../sources.js'
import {
  CONFIG_PATH,
  DEFAULT_ROUTER_SETTINGS,
  getApiKey,
  isProviderEnabled,
  loadConfig,
  normalizeRouterConfig,
  saveConfig,
} from './config.js'
import { buildChatCompletionPingBody, ping, resolveCloudflareUrl, shouldUseDisabledThinkingForProvider } from './ping.js'
import { benchmarkModel, BENCHMARK_TIMEOUT_MS } from './benchmark.js'
import { loadChangelog } from './changelog-loader.js'
import { sendUsageTelemetry } from './telemetry.js'
import { TIER_ORDER } from './utils.js'
import { atomicWriteJson, safeJsonParse, sleep, maskApiKey, isRouteableProvider } from './shared-helpers.js'
import { normalizeRequestBody } from './schema-normalizer.js'
import { pickNextCandidate } from './model-family.js'
import {
  loadCache as loadProbeCache,
  flushCache as flushProbeCache,
  recordProbeResults as recordProbeCacheResults,
  getCacheStats as getProbeCacheStats,
  getModelsDueForProbe,
  isCacheFresh as isProbeCacheFresh,
  pruneStaleEntries as pruneProbeCacheStaleEntries,
} from './probe-cache.js'
import {
  processResponseHeaders as processPassiveQuotaHeaders,
  getAllQuotas as getAllPassiveQuotas,
  STALENESS_MS as PASSIVE_QUOTA_STALENESS_MS,
} from './provider-quota-fetchers.js'
import {
  recordModelCall as recordRuntimeModelCall,
  getAllModelTelemetry as getAllRuntimeTelemetry,
  getRealWorldScore as getRuntimeRealWorldScore,
  getCacheStats as getRuntimeCacheStats,
  loadRuntimeTelemetry,
  flushRuntimeTelemetry as flushRuntimeTelemetryStore,
  clearRuntimeTelemetry as clearRuntimeTelemetryStore,
  pruneStaleEntries as pruneRuntimeTelemetry,
  DEFAULT_MIN_CALLS_FOR_SCORE as RUNTIME_MIN_CALLS,
} from './runtime-telemetry.js'

export const ROUTER_DEFAULT_PORT = 19280
export const ROUTER_MAX_PORT = 19289
export const ROUTER_DEFAULT_PORT_DEV = 29280
export const ROUTER_MAX_PORT_DEV = 29289

// 📖 Dev mode uses -dev suffixed files so the local dev daemon never clashes
// 📖 with a production install running on the same machine.
// 📖 IMPORTANT: _isDev() is a function, not a constant, so it picks up FCM_DEV
// 📖 changes that happen after module load (e.g. the bin entry point setting
// 📖 FCM_DEV=1 on git checkouts). Constant exports for PID/PORT/LOG paths
// 📖 are still computed eagerly - they are only used by the daemon child process
// 📖 which always has FCM_DEV set before import. The TUI and dashboard use
// 📖 getRouterPortRange() and getRouterPidPath() for dynamic resolution.
function _isDev() { return typeof process.env.FCM_DEV !== 'undefined' ? !!process.env.FCM_DEV : false }
const _dev = _isDev()
export const ROUTER_PID_PATH = join(homedir(), `.free-coding-models-daemon${_dev ? '-dev' : ''}.pid`)
export const ROUTER_PORT_PATH = join(homedir(), `.free-coding-models-daemon${_dev ? '-dev' : ''}.port`)
export const ROUTER_LOG_PATH = join(homedir(), `.free-coding-models-daemon${_dev ? '-dev' : ''}.log`)
export const ROUTER_TOKENS_PATH = join(homedir(), `.free-coding-models-tokens${_dev ? '-dev' : ''}.json`)

// 📖 Dynamic path resolvers - used by the TUI dashboard which may have FCM_DEV
// 📖 set after module load time (git checkout auto-detection in bin/ entry).
export function getRouterPidPath() { return join(homedir(), `.free-coding-models-daemon${_isDev() ? '-dev' : ''}.pid`) }
export function getRouterPortPath() { return join(homedir(), `.free-coding-models-daemon${_isDev() ? '-dev' : ''}.port`) }
export function getRouterLogPath() { return join(homedir(), `.free-coding-models-daemon${_isDev() ? '-dev' : ''}.log`) }
export function getRouterTokensPath() { return join(homedir(), `.free-coding-models-tokens${_isDev() ? '-dev' : ''}.json`) }

// 📖 Returns effective port range for current mode (dev vs production)
export function getRouterPortRange() {
  return _isDev()
    ? { defaultPort: ROUTER_DEFAULT_PORT_DEV, maxPort: ROUTER_MAX_PORT_DEV }
    : { defaultPort: ROUTER_DEFAULT_PORT, maxPort: ROUTER_MAX_PORT }
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY_PATH = join(__dirname, '..', '..', 'bin', 'free-coding-models.js')
const LOCAL_VERSION = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')).version
const MAX_BODY_BYTES = 10 * 1024 * 1024
/**
 * 📖 normalizeToolCallsResponse — fix malformed tool_calls from upstream.
 * Some providers return finish_reason: "tool_calls" but message has no tool_calls array,
 * which hangs OpenAI-compatible clients (pi agent waits for tool_calls that never arrives).
 * Normalize to finish_reason: "stop" when tool_calls is missing/empty per OpenAI spec.
 * This is defensive: it makes the router spec-compliant regardless of upstream quirks.
 * @param {object} data - parsed JSON response object
 * @returns {boolean} true if mutated
 */
function normalizeToolCallsResponse(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.choices)) return false
  let mutated = false
  for (const choice of data.choices) {
    if (!choice || typeof choice !== 'object') continue
    if (choice.finish_reason !== 'tool_calls') continue
    const msg = choice.message
    if (!msg || typeof msg !== 'object') continue
    const tc = msg.tool_calls
    if (!Array.isArray(tc) || tc.length === 0) {
      choice.finish_reason = 'stop'
      mutated = true
    }
  }
  return mutated
}

const MAX_REQUEST_LOG = 200
const MAX_SSE_CLIENTS = 10
const MAX_SSE_CLIENTS_PER_ORIGIN = 5
const MAX_CONCURRENT_REQUESTS = 50
const MAX_PROBE_WINDOW = 20
const TOKEN_FLUSH_INTERVAL_MS = 60000
const CONFIG_RELOAD_INTERVAL_MS = 10000
const STATS_RETENTION_DAYS = 90
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 529])
const AUTH_STATUS_CODES = new Set([401, 403])
const RATE_LIMIT_HEADER_NAMES = [
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
]

function nowIso() {
  return new Date().toISOString()
}

function modelKey(provider, model) {
  return `${provider}/${model}`
}

// 📖 parseJsonResult is still local - it returns {ok, value/error} which is different from safeJsonParse
function parseJsonResult(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (error) {
    return { ok: false, error }
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readNumberFile(path) {
  try {
    const value = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function headerEntries(headers) {
  const entries = {}
  if (!headers || typeof headers.forEach !== 'function') return entries
  headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (['connection', 'content-encoding', 'content-length', 'transfer-encoding'].includes(lower)) return
    // 📖 Never relay upstream Set-Cookie / CORS headers to browser clients:
    // 📖 the router owns its own CORS posture and must not leak upstream
    // 📖 cookie state into the dashboard.
    if (lower === 'set-cookie' || lower.startsWith('access-control-')) return
    entries[lower] = value
  })
  return entries
}

function getHeaderValue(headers, name) {
  if (!headers || typeof headers.get !== 'function') return ''
  return headers.get(name) || ''
}

function extractRateLimitHeaders(headers) {
  const values = {}
  for (const name of RATE_LIMIT_HEADER_NAMES) {
    const value = getHeaderValue(headers, name)
    if (value) values[name] = value
  }
  return values
}

function parseRetryAfterMs(value) {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const dateMs = Date.parse(value)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now())
  return null
}

function hasZeroRemainingQuota(rateLimitHeaders) {
  return Object.entries(rateLimitHeaders).some(([name, value]) => {
    if (!name.includes('remaining')) return false
    const numeric = Number(value)
    return Number.isFinite(numeric) && numeric <= 0
  })
}

function isLikelyHtmlText(text) {
  return /^\s*(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(text || '')
}

function isLikelyHtmlResponse(headers, text = '') {
  const contentType = getHeaderValue(headers, 'content-type').toLowerCase()
  return contentType.includes('text/html') || isLikelyHtmlText(text)
}

// ─── Web Dashboard Helpers ─────────────────────────────────────────────────────

// 📖 Same-origin / loopback check for state-changing or secret-revealing
// 📖 endpoints. Blocks CSRF from malicious tabs and key exfiltration from
// 📖 cross-origin scripts. Plain CLI calls (curl/fetch without Origin) are
// 📖 allowed because they cannot be triggered by a browser context.
function isLoopbackHostname(hostname) {
  if (!hostname) return false
  const h = hostname.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost')
}

// 📖 Private-network hostname check for Host-header validation. Matches
// 📖 RFC 1918 IPs (10.x, 172.16-31.x, 192.168.x) and hostnames that end in
// 📖 `.local` or `.internal`. Used when the daemon is explicitly bound to a
// 📖 wildcard address (FCM_HOST=0.0.0.0) so LAN clients keep working; it
// 📖 never grants origin trust on its own.
function isPrivateNetworkHostname(hostname) {
  if (!hostname) return false
  const h = hostname.toLowerCase()
  // 📖 mDNS / zero-conf hostnames
  if (h.endsWith('.local') || h.endsWith('.internal')) return true
  // 📖 IPv4 private ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true
  return false
}

// 📖 Cache the FCM_ALLOWED_ORIGINS env var split into a Set on first access.
// 📖 Format: comma-separated origin URLs, e.g. "http://mybox:19280,http://10.0.0.5:19280"
let _allowedOriginsCache = null
function getAllowedOrigins() {
  if (_allowedOriginsCache === null) {
    const raw = process.env.FCM_ALLOWED_ORIGINS || ''
    _allowedOriginsCache = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return _allowedOriginsCache
}

function isSameOriginOrLocal(req) {
  const origin = req.headers.origin
  const referer = req.headers.referer || req.headers.referrer
  const hasOrigin = typeof origin === 'string' && origin.length > 0
  const candidates = []
  if (hasOrigin && origin !== 'null') {
    candidates.push(origin)
  } else if (hasOrigin && origin === 'null') {
    // 📖 Origin: null (sandboxed iframe / opaque origin) is attacker-friendly:
    // 📖 never trust it on its own - only a loopback Referer alongside it counts.
    if (typeof referer !== 'string' || !referer) return false
    candidates.push(referer)
  } else if (typeof referer === 'string' && referer) {
    candidates.push(referer)
  }

  // 📖 No Origin/Referer → non-browser caller (curl, native app). Allow.
  if (candidates.length === 0) return true

  let hostHeader = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : ''
  for (const c of candidates) {
    try {
      const parsed = new URL(c)
      if (isLoopbackHostname(parsed.hostname)) return true
      // 📖 Genuine same-origin request: the browser's Origin matches the Host
      // 📖 it is already talking to (LAN/Docker setups hitting FCM_HOST).
      if (hostHeader && parsed.host.toLowerCase() === hostHeader) return true
      // 📖 Allow user-specified origins via env var (e.g. "http://mybox:19280")
      if (getAllowedOrigins().includes(c)) return true
    } catch {
      return false
    }
  }
  return false
}

// 📖 Host-header allowlist applied to every request before routing. Blocks
// 📖 DNS-rebinding, where a public attacker domain resolves to 127.0.0.1 and
// 📖 the browser sends Host: evil.com, bypassing the Origin/Referer guard.
// 📖 Loopback Host values are always accepted; when the daemon is bound to a
// 📖 non-loopback FCM_HOST (LAN / Docker), that hostname plus private-network
// 📖 hosts are accepted too. Public domains stay rejected.
function isAllowedHostHeader(hostHeader, port, boundHost) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false
  const value = hostHeader.toLowerCase()
  const loopback = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, '127.0.0.1', 'localhost', '[::1]']
  if (loopback.includes(value)) return true
  if (!boundHost || isLoopbackHostname(boundHost)) return false
  const host = boundHost.toLowerCase()
  if (value === host || value === `${host}:${port}`) return true
  // 📖 Wildcard binds (0.0.0.0 / ::) listen on every interface, so
  // 📖 private-network Host values are legitimate; public domains are not.
  if (host === '0.0.0.0' || host === '::') {
    return isPrivateNetworkHostname(value.replace(/:\d+$/, ''))
  }
  return false
}

// 📖 Optional shared-token auth for the OpenAI-compatible /v1 proxy.
// 📖 Set FCM_ROUTER_TOKEN to require `Authorization: Bearer <token>` (or
// 📖 `x-api-key: <token>`) on every /v1/* request; leave it unset for the
// 📖 default no-auth local behavior.
function getRouterToken() {
  return (process.env.FCM_ROUTER_TOKEN || '').trim()
}

function safeTokenCompare(candidate, token) {
  const bufA = Buffer.from(String(candidate || ''))
  const bufB = Buffer.from(token)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function isAuthorizedForV1(req) {
  const token = getRouterToken()
  if (!token) return true
  const auth = req.headers.authorization || ''
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && safeTokenCompare(auth.slice(7).trim(), token)) return true
  const apiKeyHeader = req.headers['x-api-key']
  return typeof apiKeyHeader === 'string' && safeTokenCompare(apiKeyHeader.trim(), token)
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function getWebModelsPayload(runtime) {
  // 📖 Hoist router + active set lookups out of the per-model loop so we
  // 📖 don't re-resolve them ~200 times per request.
  const router = runtime.routerConfig()
  const activeSet = runtime.getSet(router.activeSet)
  const inSetIndex = new Set(
    (activeSet?.models || []).map((m) => `${m.provider}::${m.model}`),
  )

  const payload = []
  for (const [providerKey, source] of Object.entries(sources)) {
    if (!Array.isArray(source.models)) continue
    const hasApiKey = !!runtime.getApiKeyForProvider(providerKey)
    for (const [modelId, label, tier, sweScore, ctx] of source.models) {
      const key = modelKey(providerKey, modelId)
      const probeWindow = runtime.probeWindows.get(key) || []
      const pings = probeWindow.map((entry) => ({
        ms: entry.latencyMs ?? null,
        code: entry.code ?? (entry.ok ? '200' : 'ERR'),
      }))
      const msList = pings.map((p) => p.ms).filter((ms) => typeof ms === 'number' && ms > 0)
      const avg = msList.length > 0
        ? msList.reduce((sum, ms) => sum + ms, 0) / msList.length
        : null
      const sorted = [...msList].sort((a, b) => a - b)
      const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : null
      const jitter = sorted.length > 1
        ? sorted.slice(1).reduce((sum, v, i) => sum + Math.abs(v - sorted[i]), 0) / (sorted.length - 1)
        : null
      const recentOk = pings.filter((p) => typeof p.ms === 'number' && String(p.code) === '200').length
      const stability = pings.length > 0 ? recentOk / pings.length : null
      const verdict = avg === null ? '-' : avg < 1000 ? 'Excellent' : avg < 2000 ? 'Good' : avg < 4000 ? 'Fair' : 'Poor'
      const uptime = pings.length > 0 ? recentOk / pings.length : null
      payload.push({
        idx: payload.length + 1,
        modelId,
        label,
        tier,
        sweScore,
        ctx,
        providerKey,
        origin: source.name || providerKey,
        status: pings.length === 0 ? 'pending' : recentOk > 0 ? 'up' : 'down',
        httpCode: pings.length > 0 ? pings[pings.length - 1].code : null,
        cliOnly: source.cliOnly || false,
        zenOnly: source.zenOnly || false,
        avg: avg === null ? null : Math.round(avg),
        verdict,
        uptime,
        p95,
        jitter: jitter === null ? null : Math.round(jitter),
        stability: stability === null ? null : Math.round(stability * 100) / 100,
        latestPing: pings.length > 0 ? pings[pings.length - 1].ms : null,
        latestCode: pings.length > 0 ? pings[pings.length - 1].code : null,
        pingHistory: pings.slice(-20),
        pingCount: pings.length,
        hasApiKey,
        inRouterSet: inSetIndex.has(`${providerKey}::${modelId}`),
        benchmarkKey: key,
        isBenchmarking: runtime.webBenchmarkRunning?.has(key) || false,
        benchmark: runtime.webBenchmarkResults?.get(key) || null,
      })
    }
  }
  return payload
}

function getWebUpdateStatusPayload() {
  if (process.env.FCM_UPDATE_ALLOWED_OUTDATED !== '1') return null
  return {
    latestVersion: process.env.FCM_UPDATE_LATEST_VERSION || null,
    allowedOutdated: true,
    warningMessage: process.env.FCM_UPDATE_WARNING_MESSAGE || null,
    failures: Number.parseInt(process.env.FCM_UPDATE_FAILURES || '0', 10) || 0,
  }
}

function getWebStatePayload(runtime) {
  const router = runtime.routerConfig()
  const probeInterval = router.probeIntervals?.[router.probeMode] || DEFAULT_ROUTER_SETTINGS.probeIntervals.balanced
  return {
    pingMode: router.probeMode === 'aggressive' ? 'speed' : router.probeMode === 'eco' ? 'slow' : 'normal',
    pingModeSource: 'daemon-probe-mode',
    pingInterval: probeInterval,
    nextPingAt: runtime.lastProbeAt ? runtime.lastProbeAt + probeInterval : null,
    pendingPings: runtime.probeTimeouts?.size || 0,
    isPinging: (runtime.probeTimeouts?.size || 0) > 0,
    globalBenchmarkRunning: runtime.webGlobalBenchmarkRunning || false,
    globalBenchmarkTotal: runtime.webGlobalBenchmarkTotal || 0,
    globalBenchmarkCompleted: runtime.webGlobalBenchmarkCompleted || 0,
    updateStatus: getWebUpdateStatusPayload(),
    models: getWebModelsPayload(runtime),
  }
}

function getWebConfigPayload(runtime) {
  const providers = {}
  for (const [key, src] of Object.entries(sources)) {
    const rawKey = runtime.getApiKeyForProvider(key)
    providers[key] = {
      name: src.name,
      hasKey: !!rawKey,
      maskedKey: rawKey ? maskApiKey(rawKey) : null,
      enabled: isProviderEnabled(runtime.config, key),
      modelCount: src.models?.length || 0,
      cliOnly: src.cliOnly || false,
    }
  }
  const router = runtime.routerConfig()
  return {
    providers,
    totalModels: MODELS.length,
    prePrompt: {
      enabled: router.prePrompt?.enabled === true,
      text: router.prePrompt?.text || '',
      isDefault: router.prePrompt?.text === DEFAULT_ROUTER_SETTINGS.prePrompt.text
        && router.prePrompt?.enabled === DEFAULT_ROUTER_SETTINGS.prePrompt.enabled,
    },
  }
}

const WEB_DIST_DIR = resolvePath(__dirname, '..', '..', 'web', 'dist')

function serveStaticFromDist(res, absPath) {
  const ext = absPath.slice(absPath.lastIndexOf('.'))
  const ct = MIME_TYPES[ext] || 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': ct,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(readFileSync(absPath))
}

function serveSpaIndex(res) {
  const indexPath = resolvePath(WEB_DIST_DIR, 'index.html')
  if (!existsSync(indexPath)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' })
    res.end('Web dashboard not built. Run: pnpm build')
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(readFileSync(indexPath))
}

function serveWebStaticFile(res, pathname, requestId) {
  // 📖 Resolve to an absolute path and verify it stays inside WEB_DIST_DIR.
  // 📖 Without this, `pathname` like `/../../etc/passwd` escapes the dist root.
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const candidate = resolvePath(WEB_DIST_DIR, requested)
  if (candidate !== WEB_DIST_DIR && !candidate.startsWith(WEB_DIST_DIR + pathSep)) {
    sendError(res, 403, 'Forbidden', 'invalid_request_error', 'path_traversal_blocked', requestId)
    return
  }

  let stats
  try {
    stats = statSync(candidate)
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 📖 SPA fallback: unknown route → serve index.html so client-side routing wins.
      serveSpaIndex(res)
      return
    }
    sendError(res, 500, 'Failed to read static file', 'server_error', 'static_file_read_failed', requestId)
    return
  }

  if (stats.isDirectory()) {
    const dirIndex = resolvePath(candidate, 'index.html')
    if (dirIndex.startsWith(WEB_DIST_DIR + pathSep) && existsSync(dirIndex)) {
      serveStaticFromDist(res, dirIndex)
      return
    }
    // 📖 Directory without index.html → fall back to SPA root.
    serveSpaIndex(res)
    return
  }

  serveStaticFromDist(res, candidate)
}

function buildUpstreamMeta(response, text = '', providerKey = '') {
  // 📖 Keep quota diagnostics structural only: headers and retry timing are safe,
  // 📖 while upstream response bodies stay out of logs and telemetry.
  const rateLimitHeaders = extractRateLimitHeaders(response.headers)
  const retryAfterMs = parseRetryAfterMs(rateLimitHeaders['retry-after'])
  // 📖 Passive quota tracker (t2): every upstream response carries rate-limit
  // 📖 headers — we parse them once here and write to the in-memory snapshot
  // 📖 map. Zero extra network requests; works on providers with no quota
  // 📖 endpoint. See src/core/provider-quota-fetchers.js for the 8 header pairs.
  if (providerKey) processPassiveQuotaHeaders(providerKey, response.headers)
  const quotaExhausted = response.status === 429
    || hasZeroRemainingQuota(rateLimitHeaders)
    || /\b(quota|rate[_ -]?limit|too many requests)\b/i.test(text || '')
  return {
    retryAfterMs,
    rateLimitHeaders,
    quotaExhausted,
  }
}

function attachClientAbort(req, res, controller) {
  let clientAborted = false
  const abort = () => {
    if (res.writableEnded) return
    // 📖 If the coding tool disconnects, stop spending provider quota
    // 📖 immediately and do not mark the upstream model unhealthy.
    clientAborted = true
    try {
      controller.abort(new Error('client_disconnected'))
    } catch {
      controller.abort()
    }
  }
  req.on('aborted', abort)
  res.on('close', abort)
  return {
    get aborted() {
      return clientAborted
    },
    dispose() {
      req.off('aborted', abort)
      res.off('close', abort)
    },
  }
}

export function cloneHeadersForUpstream(reqHeaders, apiKey, providerKey) {
  const headers = {}
  for (const [key, value] of Object.entries(reqHeaders || {})) {
    const lower = key.toLowerCase()
    // 📖 Drop the client's cookies: they belong to the local browser session
    // 📖 and must never be forwarded to the upstream provider.
    if (['host', 'connection', 'content-length', 'authorization', 'cookie'].includes(lower)) continue
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

function getApiModelId(providerKey, modelId) {
  return providerKey === 'zai' ? modelId.replace(/^zai\//, '') : modelId
}

function resolveProviderUrl(providerKey) {
  const url = sources[providerKey]?.url
  if (!url) return null
  return providerKey === 'cloudflare' ? resolveCloudflareUrl(url) : url
}

function buildProviderModelsUrl(providerKey) {
  const url = resolveProviderUrl(providerKey)
  if (typeof url !== 'string' || !url.includes('/chat/completions')) return null
  return url.replace(/\/chat\/completions$/, '/models')
}

function extractUsage(payload) {
  const usage = payload?.usage
  if (!usage || typeof usage !== 'object') return null
  const promptTokens = Number(usage.prompt_tokens ?? 0)
  const completionTokens = Number(usage.completion_tokens ?? 0)
  const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens)
  if (![promptTokens, completionTokens, totalTokens].every(Number.isFinite)) return null
  if (promptTokens <= 0 && completionTokens <= 0 && totalTokens <= 0) return null
  return {
    prompt_tokens: Math.max(0, Math.round(promptTokens)),
    completion_tokens: Math.max(0, Math.round(completionTokens)),
    total_tokens: Math.max(0, Math.round(totalTokens)),
  }
}

export function formatOpenAiError(message, type, code, requestId, extra = {}) {
  return {
    error: {
      message,
      type,
      code,
      request_id: requestId,
      ...extra,
    },
  }
}

function sendJson(res, statusCode, payload, headers = {}) {
  if (res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

function sendError(res, statusCode, message, type, code, requestId, extra = {}) {
  sendJson(res, statusCode, formatOpenAiError(message, type, code, requestId, extra))
}

function readRequestBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function readJsonBody(req) {
  return readRequestBody(req).then((raw) => {
    // 📖 Refuse explicit non-JSON bodies (e.g. text/plain form posts) so a
    // 📖 cross-site form cannot smuggle data into JSON endpoints. Missing or
    // 📖 empty content-type stays allowed for CLI clients that send bare
    // 📖 bodies, and anything with an empty body is fine regardless.
    const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].toLowerCase() : ''
    if (raw.trim() && contentType && !contentType.includes('json')) {
      throw Object.assign(new Error(`Unsupported Content-Type: ${contentType}`), { code: 'UNSUPPORTED_MEDIA_TYPE' })
    }
    if (!raw.trim()) return {}
    const parsed = safeJsonParse(raw)
    if (parsed === null) {
      throw Object.assign(new Error('Invalid JSON'), { code: 'INVALID_JSON' })
    }
    return parsed
  })
}

/**
 * 📖 Inject the configured router pre-prompt as the first `system` message
 * 📖 of the request, ahead of any user-provided messages. The pre-prompt is
 * 📖 always prepended (not appended) so it takes precedence over the
 * 📖 per-conversation tone; user `system` messages after the pre-prompt can
 * 📖 still override specific instructions.
 *
 * 📖 If the pre-prompt is disabled or empty, the messages array is returned
 * 📖 as-is. The function is pure: it never mutates the input.
 *
 * @param {unknown} messages
 * @param {{ enabled?: boolean, text?: string }|null|undefined} prePrompt
 * @returns {Array}
 */
export function injectPrePrompt(messages, prePrompt) {
  if (!Array.isArray(messages)) return messages
  if (!prePrompt || prePrompt.enabled !== true) return messages
  const text = typeof prePrompt.text === 'string' ? prePrompt.text.trim() : ''
  if (!text) return messages
  // 📖 Skip injection if the very first message is already an exact match -
  // 📖 prevents duplicate system messages when the client retries a request
  // 📖 or the Playground already sent the pre-prompt itself.
  const first = messages[0]
  if (first && first.role === 'system' && typeof first.content === 'string' && first.content.trim() === text) {
    return messages
  }
  return [{ role: 'system', content: text }, ...messages]
}

/**
 * 📖 Apply the pre-prompt to a chat-completion body. Returns a new body so
 * 📖 we never mutate the client's payload. Used by both the streaming and
 * 📖 non-streaming proxy paths.
 *
 * @param {Record<string, unknown>|null|undefined} body
 * @param {{ enabled?: boolean, text?: string }|null|undefined} prePrompt
 * @returns {Record<string, unknown>}
 */
export function applyPrePromptToBody(body, prePrompt) {
  const safeBody = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {}
  // 📖 If the body is missing `messages`, start with an empty array so
  // 📖 downstream code that always expects `messages` does not have to
  // 📖 special-case the pre-prompt path.
  const baseMessages = Array.isArray(safeBody.messages) ? safeBody.messages : []
  const messages = injectPrePrompt(baseMessages, prePrompt)
  return { ...safeBody, messages }
}

class RouterLogger {
  constructor(logPath, level = 'info') {
    this.logPath = logPath
    this.level = level
    this.levelRank = { error: 0, warn: 1, info: 2, debug: 3 }
  }

  shouldLog(level) {
    return this.levelRank[level] <= this.levelRank[this.level]
  }

  rotateIfNeeded() {
    try {
      if (!existsSync(this.logPath)) return
      const stat = statSync(this.logPath)
      if (stat.size < 5 * 1024 * 1024) return
      const rotatedPath = `${this.logPath}.1`
      try { unlinkSync(rotatedPath) } catch {}
      renameSync(this.logPath, rotatedPath)
    } catch {
      // 📖 Logging should never be capable of taking the daemon down.
    }
  }

  write(level, message, meta = null) {
    if (!this.shouldLog(level)) return
    const suffix = meta ? ` ${this.safeStringify(meta)}` : ''
    const line = `[${nowIso()}] [${level.toUpperCase()}] ${message}${suffix}\n`
    try {
      this.rotateIfNeeded()
      appendFileSync(this.logPath, line, { mode: 0o600 })
    } catch {
      try { process.stderr.write(line) } catch {}
    }
  }

  safeStringify(meta) {
    try {
      return JSON.stringify(meta)
    } catch {
      return '[unserializable-meta]'
    }
  }

  error(message, meta = null) { this.write('error', message, meta) }
  warn(message, meta = null) { this.write('warn', message, meta) }
  info(message, meta = null) { this.write('info', message, meta) }
  debug(message, meta = null) { this.write('debug', message, meta) }
}

class TokenTracker {
  constructor(path, logger) {
    this.path = path
    this.logger = logger
    this.stats = this.load()
    this.dirty = false
    this.flushFailures = 0
  }

  load() {
    try {
      if (!existsSync(this.path)) {
        return {
          daily: {},
          all_time: {
            total_tokens: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            requests: 0,
            first_tracked: nowIso(),
          },
        }
      }
      const parsed = safeJsonParse(readFileSync(this.path, 'utf8'), null)
      if (!parsed || typeof parsed !== 'object') throw new Error('Token stats JSON is invalid')
      return {
        daily: parsed.daily && typeof parsed.daily === 'object' ? parsed.daily : {},
        all_time: {
          total_tokens: Number(parsed.all_time?.total_tokens ?? 0),
          prompt_tokens: Number(parsed.all_time?.prompt_tokens ?? 0),
          completion_tokens: Number(parsed.all_time?.completion_tokens ?? 0),
          requests: Number(parsed.all_time?.requests ?? 0),
          first_tracked: parsed.all_time?.first_tracked || nowIso(),
        },
      }
    } catch (error) {
      this.logger.warn('Token stats read failed; starting fresh counters', { error: error.message })
      return {
        daily: {},
        all_time: {
          total_tokens: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          requests: 0,
          first_tracked: nowIso(),
        },
      }
    }
  }

  todayKey() {
    return new Date().toISOString().slice(0, 10)
  }

  ensureDaily(dateKey) {
    if (!this.stats.daily[dateKey]) {
      this.stats.daily[dateKey] = {
        total_tokens: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        requests: 0,
        by_model: {},
      }
    }
    if (!this.stats.daily[dateKey].by_model || typeof this.stats.daily[dateKey].by_model !== 'object') {
      this.stats.daily[dateKey].by_model = {}
    }
    return this.stats.daily[dateKey]
  }

  record(provider, model, usage) {
    if (!usage) return
    const dateKey = this.todayKey()
    const daily = this.ensureDaily(dateKey)
    const key = modelKey(provider, model)
    if (!daily.by_model[key]) daily.by_model[key] = { total: 0, requests: 0 }

    daily.total_tokens += usage.total_tokens
    daily.prompt_tokens += usage.prompt_tokens
    daily.completion_tokens += usage.completion_tokens
    daily.requests += 1
    daily.by_model[key].total += usage.total_tokens
    daily.by_model[key].requests += 1

    this.stats.all_time.total_tokens += usage.total_tokens
    this.stats.all_time.prompt_tokens += usage.prompt_tokens
    this.stats.all_time.completion_tokens += usage.completion_tokens
    this.stats.all_time.requests += 1
    this.dirty = true
  }

  prune() {
    const cutoff = Date.now() - STATS_RETENTION_DAYS * 24 * 60 * 60 * 1000
    for (const dateKey of Object.keys(this.stats.daily)) {
      const time = Date.parse(`${dateKey}T00:00:00.000Z`)
      if (Number.isFinite(time) && time < cutoff) delete this.stats.daily[dateKey]
    }
  }

  flush({ force = false } = {}) {
    if (!this.dirty && !force) return
    try {
      this.prune()
      atomicWriteJson(this.path, this.stats, 0o600)
      this.dirty = false
      this.flushFailures = 0
    } catch (error) {
      this.flushFailures += 1
      this.logger.warn('Token stats write failed; keeping counters in memory', {
        error: error.message,
        failures: this.flushFailures,
      })
    }
  }

  summary() {
    const today = this.ensureDaily(this.todayKey())
    return {
      today,
      all_time: this.stats.all_time,
      daily: this.stats.daily,
    }
  }
}

class RouterRuntime {
  constructor({ config, port, logger, tokenPath = ROUTER_TOKENS_PATH, persistConfig = true }) {
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
    this.probeTimeouts = new Set()
    this.tokenTracker = new TokenTracker(tokenPath, logger)
    this.modelCatalog = this.buildModelCatalog()
    this.probeWindows = new Map()
    this.circuit = new Map()
    this.requestLog = []
    this.activeRequests = new Map()
    this.sseClients = new Set()
    this.lastProbeAt = null
    this.totalRequestsRouted = 0
    this.quotaExhausted = new Set()
    this.quotaDetails = new Map()
    this.staleNotifications = new Set()
    this.webBenchmarkRunning = new Set()
    this.webBenchmarkResults = new Map()
    this.webGlobalBenchmarkRunning = false
    this.webGlobalBenchmarkTotal = 0
    this.webGlobalBenchmarkCompleted = 0
    // 📖 Probe-cache (t1): load the persistent probe-cache on boot so the daemon
    // 📖 can skip fresh healthy models during its health-probe loop and write
    // 📖 results back to the same file the CLI TUI uses. See src/core/probe-cache.js.
    this.probeCache = loadProbeCache()
    this.probeCacheDirty = false
    this.probeCacheFlushTimer = null
    // 📖 Runtime telemetry (t3): load the persistent per-model metrics file on boot.
    // 📖 Prune models that haven't been seen in 30 days to keep file size bounded.
    loadRuntimeTelemetry()
    pruneRuntimeTelemetry(30 * 24 * 60 * 60 * 1000)
    this.runtimeTelemetryDirty = false
    this.runtimeTelemetryFlushTimer = null
    this.refreshRouteState()
  }

  /**
   * 📖 scheduleRuntimeTelemetryFlush — debounced write so we don't thrash the
   * 📖 filesystem when many requests succeed in quick succession.
   */
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

  /**
   * 📖 recordRuntimeCall — central helper invoked from both success and failure
   * 📖 paths in the reverse proxy. Wraps recordModelCall with the call-shape
   * 📖 translation so every routed outcome (success or fail) feeds the telemetry.
   */
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
        if (!this.circuit.has(key)) {
          this.circuit.set(key, {
            state: 'CLOSED',
            consecutiveFailures: 0,
            cooldownMs: router.circuitBreaker.initialCooldownMs,
            openedAt: null,
            lastError: null,
            authError: false,
            stale: false,
          })
        }
        const entry = this.circuit.get(key)
        entry.stale = !this.modelCatalog.has(key)
        const catalogEntry = this.modelCatalog.get(key)
        entry.unsupported = Boolean(catalogEntry && !catalogEntry.routeable)
        if (entry.stale && !this.staleNotifications.has(key)) {
          this.staleNotifications.add(key)
          this.logger.warn(`${key} is no longer available and will be skipped`)
        }
      }
    }
  }

  routerConfig() {
    const normalized = normalizeRouterConfig(this.config.router)
    if (normalized) return normalized
    // 📖 Fallback for the very first read before ensureRouterConfigForDaemon
    // 📖 has had a chance to probe candidates. We use a tiny sync helper
    // 📖 here so the routerConfig() getter stays sync. The async probed
    // 📖 version is wired up by runRouterDaemon() on first start.
    const defaultSet = buildDefaultRouterSetSync(this.config)
    return normalizeRouterConfig({
      ...DEFAULT_ROUTER_SETTINGS,
      enabled: true,
      onboardingSeen: true,
      activeSet: defaultSet.name,
      sets: { [defaultSet.name]: defaultSet },
    })
  }

  setRouterConfig(router) {
    this.config.router = normalizeRouterConfig(router)
    this.refreshRouteState()
  }

  /**
   * 📖 markSetCustomized - flip `router.userCustomized = true` and
   * 📖 `router.autoHeal = false` so the user's manual edits are
   * 📖 preserved on the next daemon start. Called from the HTTP
   * 📖 endpoints that mutate the active set (add / remove / reorder /
   * 📖 sync / activate / rename). Auto-heal itself does NOT call this.
   */
  markSetCustomized() {
    if (!this.config.router) return
    this.config.router = normalizeRouterConfig({
      ...this.config.router,
      userCustomized: true,
      autoHeal: false,
    })
  }

  saveRouterConfig() {
    if (this.persistConfig === false) return { success: true, backupCreated: false }
    const result = saveConfig(this.config)
    if (!result.success) this.logger.warn('Router config write failed', { error: result.error })
    return result
  }

  reloadConfigFromDisk() {
    try {
      const nextConfig = loadConfig()
      // 📖 Always rebuild the router set from favorites so UI toggles apply dynamically
      void ensureRouterConfigForDaemon(nextConfig, true)
      this.config = nextConfig
      this.refreshRouteState()
      this.scheduleProbeLoop()
      this.broadcast('config', { activeSet: this.routerConfig().activeSet })
      this.logger.debug('Router config reloaded from disk')
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

  updateCircuitForCooldown(key) {
    const state = this.circuit.get(key)
    if (!state || state.state !== 'OPEN') return state
    const elapsed = Date.now() - (state.openedAt || 0)
    if (elapsed >= state.cooldownMs) {
      const oldState = state.state
      state.state = 'HALF_OPEN'
      this.broadcast('circuit', { model: key, old_state: oldState, new_state: state.state, cooldown_ms: state.cooldownMs })
    }
    return state
  }

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
      circuit_state: this.circuit.get(key)?.state || 'UNKNOWN',
    })

    // 📖 Issue #147: the web dashboard (web/src/hooks/useSocket.js) only listens
    // 📖 for `models` events — it never consumes the lightweight `probe` event.
    // 📖 Broadcast the full models payload (debounced) so live stats actually
    // 📖 update in the Docker/daemon-served dashboard.
    this.scheduleWebStateBroadcast()

    // 📖 Probe-cache (t1): mirror the result into the persistent cross-session
    // 📖 cache so the CLI TUI can skip fresh healthy models and auto-hide broken
    // 📖 ones. key is `provider/modelId` — split on the first slash.
    const slashIdx = key.indexOf('/')
    if (slashIdx > 0) {
      const providerKey = key.slice(0, slashIdx)
      const modelId = key.slice(slashIdx + 1)
      recordProbeCacheResults(providerKey, [{
        modelId,
        status: result.ok ? 'ok' : 'broken',
        latencyMs: result.latencyMs ?? null,
        lastError: result.ok ? null : (result.code != null ? String(result.code) : 'error'),
      }])
      this.probeCacheDirty = true
      this.scheduleProbeCacheFlush()
    }
  }

  /**
   * 📖 scheduleProbeCacheFlush — debounced write to disk so we don't thrash the
   * 📖 filesystem when a probe burst records dozens of results at once.
   */
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

  markAuthError(key, detail = 'authentication failed') {
    const state = this.circuit.get(key)
    if (!state) return
    state.authError = true
    state.lastError = detail
    this.broadcast('circuit', { model: key, old_state: state.state, new_state: 'AUTH_ERROR', cooldown_ms: 0 })
  }

  markSuccess(key, latencyMs = null) {
    const state = this.circuit.get(key)
    if (!state) return
    const oldState = state.state
    state.state = 'CLOSED'
    state.consecutiveFailures = 0
    state.cooldownMs = this.routerConfig().circuitBreaker.initialCooldownMs
    state.openedAt = null
    state.lastError = null
    state.authError = false
    this.quotaExhausted.delete(key)
    this.quotaDetails.delete(key)
    if (oldState !== state.state) {
      this.broadcast('circuit', { model: key, old_state: oldState, new_state: state.state, cooldown_ms: state.cooldownMs })
    }
    if (latencyMs !== null) this.recordProbeResult(key, { ok: true, latencyMs, code: 200 })
  }

  markFailure(key, detail, statusCode = null, meta = {}) {
    const state = this.circuit.get(key)
    if (!state) return
    state.authError = false
    state.consecutiveFailures += 1
    state.lastError = detail
    if (statusCode === 429 || meta.quotaExhausted) {
      this.quotaExhausted.add(key)
      this.quotaDetails.set(key, {
        model: key,
        status: statusCode,
        retry_after_ms: meta.retryAfterMs ?? null,
        rate_limit_headers: meta.rateLimitHeaders || {},
        last_seen: nowIso(),
      })
    }
    const router = this.routerConfig()
    if (state.state === 'HALF_OPEN' || state.consecutiveFailures >= router.circuitBreaker.failureThreshold) {
      const oldState = state.state
      state.state = 'OPEN'
      state.openedAt = Date.now()
      state.cooldownMs = Math.min(
        router.circuitBreaker.maxCooldownMs,
        Math.max(router.circuitBreaker.initialCooldownMs, state.cooldownMs * router.circuitBreaker.backoffMultiplier),
      )
      this.broadcast('circuit', { model: key, old_state: oldState, new_state: state.state, cooldown_ms: state.cooldownMs })
      this.logger.warn(`Circuit opened for ${key}`, { reason: detail, cooldown_ms: state.cooldownMs })
      void sendUsageTelemetry(this.config, {}, {
        event: 'app_router_circuit_open',
        mode: 'daemon',
        properties: {
          model: key,
          consecutive_failures: state.consecutiveFailures,
          cooldown_ms: state.cooldownMs,
        },
      })
    }
    this.recordProbeResult(key, { ok: false, latencyMs: null, code: statusCode || 'ERR', error: detail })
  }

  quotaDetailsForKeys(keys) {
    return keys
      .filter((key) => this.quotaExhausted.has(key))
      .map((key) => this.quotaDetails.get(key) || {
        model: key,
        status: 429,
        retry_after_ms: null,
        rate_limit_headers: {},
        last_seen: null,
      })
  }

  recordRouterError(kind, requestId, properties = {}) {
    void sendUsageTelemetry(this.config, {}, {
      event: 'app_router_error',
      mode: 'daemon',
      properties: {
        kind,
        request_id: requestId,
        ...properties,
      },
    })
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
    const router = this.routerConfig()
    const setSize = Math.max(1, models.length)
    const weights = router.scoring

    return models.map((entry) => {
      const key = modelKey(entry.provider, entry.model)
      const stats = this.getWindowStats(key)
      const hasData = stats.total > 0
      const latencyScore = stats.p95 === null ? 0.5 : Math.max(0, 1 - (stats.p95 / maxP95))
      const uptimeScore = stats.uptime === null ? 0.5 : stats.uptime
      // 📖 priorityBonus - kept as a separate field for dashboards/legacy UIs
      // 📖 that previously rendered a single composite "score". Priority is
      // 📖 NOT folded into `score` anymore (issue #120): the routing comparator
      // 📖 in getRoutingCandidates sorts by explicit priority authoritatively,
      // 📖 so mixing priority into the score only confused tiebreakers.
      const priorityBonus = 1 - ((entry.priority - 1) / setSize)
      // 📖 score - pure latency+uptime composite. Used only as the FINAL
      // 📖 tiebreaker between candidates that share the same priority AND
      // 📖 same circuit state (see getRoutingCandidates). A model with no
      // 📖 probe data yet scores neutral (0.5) - we deliberately do NOT use
      // 📖 priorityBonus as a cold-start fallback, because that would re-
      // 📖 introduce the priority-in-score confusion this refactor removes.
      const score = hasData
        ? (weights.latencyWeight * latencyScore) + (weights.uptimeWeight * uptimeScore)
        : 0.5
      const state = this.updateCircuitForCooldown(key) || {}
      return {
        ...entry,
        key,
        score,
        priorityBonus,
        stats,
        circuit: state,
        catalog: this.modelCatalog.get(key) || null,
      }
    })
  }

  // 📖 getRoutingCandidates - the ordered list of models the router will try,
  // 📖 in EXACT attempt order. This is the heart of routing.
  // 📖
  // 📖 Strategy (priority-first): the user's priority order is authoritative.
  // 📖 A model ranked #1 is always tried first while it is healthy, even if a
  // 📖 lower-priority model has a better health score. The health score is only
  // 📖 used to break ties between models that share the same priority - which
  // 📖 happens in practice when multiple models tie because they have no probe
  // 📖 data yet (cold start) or identical stats.
  // 📖
  // 📖 Why: before this, priority was only 20% of the score and a fast
  // 📖 low-priority model could steal traffic from a deliberately higher-ranked
  // 📖 one (see issue #120 - GPT-OSS 120B served despite higher-priority models
  // 📖 being healthy). Users set the fallback chain on purpose; routing must
  // 📖 respect it.
  // 📖
  // 📖 Circuit-breaker safety is preserved: CLOSED (healthy) models always come
  // 📖 before HALF_OPEN (probing after cooldown) models, so a recovering model
  // 📖 never pre-empts a known-good one.
  getRoutingCandidates(set) {
    const scored = this.scoreCandidates(set)
    const usable = scored.filter((candidate) => {
      if (!candidate.catalog || candidate.circuit?.stale) return false
      if (!candidate.catalog.routeable || candidate.circuit?.unsupported) return false
      if (candidate.circuit?.authError) return false
      if (!this.getApiKeyForProvider(candidate.provider)) return false
      return candidate.circuit?.state === 'CLOSED' || candidate.circuit?.state === 'HALF_OPEN'
    })
    // 📖 New ordering: prioritize by explicit priority first, then by circuit state
    // 📖 (CLOSED before HALF_OPEN), and finally by health score (higher is better).
    // 📖 This ensures a higher‑priority model is never skipped just because it is
    // 📖 in HALF_OPEN while a lower‑priority CLOSED model is available.
    const stateOrder = { CLOSED: 0, HALF_OPEN: 1 }
    const comparator = (a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      const aState = a.circuit?.state || 'UNKNOWN'
      const bState = b.circuit?.state || 'UNKNOWN'
      if (aState !== bState) {
        const aRank = stateOrder[aState] ?? 2
        const bRank = stateOrder[bState] ?? 2
        return aRank - bRank
      }
      // higher score first
      return b.score - a.score
    }
    return usable.sort(comparator)
  }

  // 📖 getRoutingOrder - slim projection of getRoutingCandidates for the /stats
  // 📖 payload and dashboards. Exposes the EXACT order the router will attempt
  // 📖 on the next request, so the UI can mark the model that will serve it
  // 📖 (routingOrder[0]) and label every entry as Primary vs Fallback.
  // 📖 Cheap to compute: reuses getRoutingCandidates + already-recorded health.
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

  getModelHealth(set = this.getSet()) {
    return this.scoreCandidates(set || { models: [] }).map((candidate) => ({
      provider: candidate.provider,
      model: candidate.model,
      key: candidate.key,
      priority: candidate.priority,
      state: candidate.circuit?.authError
        ? 'AUTH_ERROR'
        : candidate.circuit?.stale
          ? 'STALE'
          : candidate.circuit?.unsupported
            ? 'UNSUPPORTED'
            : candidate.circuit?.state || 'UNKNOWN',
      score: Number(candidate.score.toFixed(4)),
      last_latency_ms: candidate.stats.last?.latencyMs ?? null,
      uptime: candidate.stats.uptime,
      last_error: candidate.circuit?.lastError || null,
      // 📖 AI Latency benchmark results for the Router Dashboard's "Probe all"
      // 📖 button. Mirrors the per-model fields already exposed on /api/models
      // 📖 so the set list can show live AI latency + TPS after a probe.
      isBenchmarking: this.webBenchmarkRunning?.has(candidate.key) || false,
      benchmark: this.webBenchmarkResults?.get(candidate.key) || null,
    }))
  }

  findBestModelForProviderInSources(providerKey) {
    const source = sources[providerKey]
    if (!source || !Array.isArray(source.models)) return null
    let best = null
    let bestTier = Infinity
    for (const modelEntry of source.models) {
      const [modelId, , tier] = modelEntry
      if (!modelId || !tier) continue
      const tierIdx = TIER_ORDER.indexOf(tier)
      if (tierIdx < 0) continue
      if (tierIdx < bestTier) {
        bestTier = tierIdx
        best = modelId
      }
    }
    return best
  }

  addRequestLog(entry) {
    // 📖 failover_reason (t8) - WHY this attempt was picked ('family_failover'
    // or 'set_order'). The failover loop stores it on the active request right
    // after choosing the next candidate; every log entry of that attempt
    // (requestLog, /stats, SSE 'request' event) carries it from here on.
    if (entry.failover === true && entry.request_id && entry.failover_reason === undefined) {
      const active = this.activeRequests.get(entry.request_id)
      if (active?.failoverReason) entry.failover_reason = active.failoverReason
    }
    this.requestLog.unshift({ ...entry, at: nowIso() })
    while (this.requestLog.length > MAX_REQUEST_LOG) this.requestLog.pop()
    this.broadcast('request', entry)
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

  broadcastWebState() {
    this.broadcast('models', getWebStatePayload(this))
  }

  /**
   * 📖 scheduleWebStateBroadcast — debounced full-state broadcast so a probe
   * 📖 burst doesn't serialize the whole ~200-model payload once per result.
   * 📖 Fires at most once per 250ms window; unref'd so it never blocks exit.
   */
  scheduleWebStateBroadcast() {
    if (this.webStateBroadcastTimer) return
    this.webStateBroadcastTimer = setTimeout(() => {
      this.webStateBroadcastTimer = null
      this.broadcastWebState()
    }, 250)
    if (typeof this.webStateBroadcastTimer.unref === 'function') this.webStateBroadcastTimer.unref()
  }

  async runWebBenchmark(providerKey, modelId) {
    const key = modelKey(providerKey, modelId)
    if (this.webBenchmarkRunning.has(key)) return { skipped: true }
    const source = sources[providerKey]
    if (!source?.url) {
      return { ok: false, code: 'UNSUPPORTED', totalMs: 0, error: 'Provider has no benchmark URL', retries: 0 }
    }

    this.webBenchmarkRunning.add(key)
    this.broadcastWebState()
    try {
      const result = await benchmarkModel({
        apiKey: this.getApiKeyForProvider(providerKey) ?? null,
        modelId,
        providerKey,
        url: source.url,
        timeoutMs: BENCHMARK_TIMEOUT_MS,
      })
      this.webBenchmarkResults.set(key, result)
      return result
    } catch (err) {
      const fallback = { ok: false, code: 'ERR', totalMs: 0, error: err?.message || 'Benchmark failed', retries: 0 }
      this.webBenchmarkResults.set(key, fallback)
      return fallback
    } finally {
      this.webBenchmarkRunning.delete(key)
      this.broadcastWebState()
    }
  }

  async runWebGlobalBenchmark(models) {
    if (this.webGlobalBenchmarkRunning) return { started: false, error: 'Global benchmark already running' }
    const knownModels = []
    const seen = new Set()
    for (const item of Array.isArray(models) ? models : []) {
      const providerKey = typeof item?.providerKey === 'string' ? item.providerKey : ''
      const modelId = typeof item?.modelId === 'string' ? item.modelId : ''
      const key = modelKey(providerKey, modelId)
      if (!this.modelCatalog.has(key) || seen.has(key)) continue
      seen.add(key)
      knownModels.push({ providerKey, modelId, key })
    }

    const fallbackModels = knownModels.length > 0
      ? knownModels
      : [...this.modelCatalog.values()].filter((m) => sources[m.providerKey]?.url && !sources[m.providerKey]?.cliOnly)

    this.webGlobalBenchmarkRunning = true
    this.webGlobalBenchmarkTotal = fallbackModels.length
    this.webGlobalBenchmarkCompleted = 0
    this.broadcastWebState()

    const healthPriority = { up: 0, pending: 1, timeout: 2, noauth: 3, auth_error: 4, down: 5 }
    const sorted = [...fallbackModels].sort((a, b) => {
      const aw = this.probeWindows.get(modelKey(a.providerKey, a.modelId)) || []
      const bw = this.probeWindows.get(modelKey(b.providerKey, b.modelId)) || []
      const aLast = aw.at(-1)
      const bLast = bw.at(-1)
      const aState = aLast?.ok ? 'up' : aw.length ? 'down' : 'pending'
      const bState = bLast?.ok ? 'up' : bw.length ? 'down' : 'pending'
      const hpA = healthPriority[aState] ?? 6
      const hpB = healthPriority[bState] ?? 6
      if (hpA !== hpB) return hpA - hpB
      return (aLast?.latencyMs ?? 99999) - (bLast?.latencyMs ?? 99999)
    })

    const workers = new Array(Math.min(5, sorted.length)).fill(null).map(async () => {
      while (sorted.length > 0) {
        const next = sorted.shift()
        if (!next) break
        try {
          await this.runWebBenchmark(next.providerKey, next.modelId)
        } finally {
          this.webGlobalBenchmarkCompleted += 1
          this.broadcastWebState()
        }
      }
    })

    void Promise.all(workers).finally(() => {
      this.webGlobalBenchmarkRunning = false
      this.webGlobalBenchmarkTotal = 0
      this.webGlobalBenchmarkCompleted = 0
      this.broadcastWebState()
    })

    return { started: true, total: fallbackModels.length }
  }

  statusPayload() {
    const router = this.routerConfig()
    const activeSet = this.getSet(router.activeSet)
    return {
      ok: true,
      // 📖 `running` mirrors `ok` so every consumer (Router view reads `ok`,
      // 📖 Playground reads `running`) agrees on daemon state. Without this,
      // 📖 the Playground showed "router offline" even when the Router card
      // 📖 said "Running" - both hit /api/router/status but read different fields.
      running: true,
      version: LOCAL_VERSION,
      pid: process.pid,
      port: this.port,
      enabled: router.enabled,
      activeSet: router.activeSet,
      activeModelCount: activeSet?.models?.length || 0,
      setCount: Object.keys(router.sets || {}).length,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      requestsRouted: this.totalRequestsRouted,
      // 📖 M6: surface the auto-heal flags so the UI can show "auto-heal
      // 📖 is on" / "user has customized this set" and the broken-model
      // 📖 count so the dashboard can prompt for a fix.
      autoHeal: router.autoHeal !== false,
      userCustomized: router.userCustomized === true,
      brokenModelCount: (activeSet?.models || []).filter((m) => {
        const key = `${m.provider}/${m.model}`
        // 📖 this.circuit stores the raw flags (authError / stale / unsupported)
        // 📖 alongside the translated `state`. We read the raw flags so a
        // 📖 model that just auth-errored (state: CLOSED + authError: true)
        // 📖 is still flagged as broken, not just one whose state is OPEN.
        const cb = this.circuit?.get?.(key)
        return Boolean(cb?.authError || cb?.stale)
      }).length,
      inFlight: this.inFlight,
      shuttingDown: this.shuttingDown,
      probeMode: router.probeMode,
      lastProbeAt: this.lastProbeAt ? new Date(this.lastProbeAt).toISOString() : null,
      crashRecovered: this.crashRecovered,
      configPath: CONFIG_PATH,
      tokenStatsPath: ROUTER_TOKENS_PATH,
      logPath: ROUTER_LOG_PATH,
      // 📖 Probe-cache (t1): live aggregates from the persistent probe-cache.
      // 📖 Surfaced so the Web Dashboard + CLI can show cache hit rate + how many
      // 📖 broken models are currently hidden. Refreshed every /stats call.
      probeCache: getProbeCacheStats(),
      // 📖 Passive quota (t2): latest known rate-limit headers per provider, keyed
      // 📖 by providerKey. Each entry is { remaining, limit, percent, source,
      // 📖 lastUpdated } — source can be 'header' (live) or 'endpoint' (active
      // 📖 fetcher fallback). Stale entries (older than PASSIVE_QUOTA_STALENESS_MS)
      // 📖 are excluded so the consumer only sees fresh data.
      quota: Object.fromEntries(getAllPassiveQuotas()),
      // 📖 Runtime telemetry (t3): aggregate counters + every model's derived
      // 📖 snapshot (successRate, avgLatencyMs, avgTokensPerSecond, recentCalls).
      // 📖 Surfaced via /stats/runtime (separate endpoint) and here as a digest
      // 📖 so dashboards can show '1,420 calls tracked across 12 models' without
      // 📖 an extra round-trip.
      runtimeTelemetry: {
        stats: getRuntimeCacheStats(),
        models: getAllRuntimeTelemetry(),
      },
    }
  }

  statsPayload() {
    const router = this.routerConfig()
    const activeSet = this.getSet(router.activeSet)
    return {
      ...this.statusPayload(),
      tokens: this.tokenTracker.summary(),
      models: this.getModelHealth(activeSet),
      // 📖 routingOrder - the exact attempt order for the next request
      // 📖 (priority-first among healthy models). routingOrder[0] is what will
      // 📖 serve the next chat completion. Surfaced so dashboards can mark the
      // 📖 "next" model and label Primary vs Fallback semantics. See issue #120.
      routingOrder: this.getRoutingOrder(activeSet),
      // 📖 Global AI Latency probe progress - powers the Router Dashboard's
      // 📖 "Probe all" button progress bar. Per-model results live on each
      // 📖 entry of `models` above (isBenchmarking / benchmark).
      globalBenchmark: {
        running: this.webGlobalBenchmarkRunning || false,
        total: this.webGlobalBenchmarkTotal || 0,
        completed: this.webGlobalBenchmarkCompleted || 0,
      },
      requestLog: this.requestLog.slice(0, 20),
      activeRequests: Array.from(this.activeRequests.values()).map(r => ({
        requestId: r.requestId,
        at: r.at,
        model: r.model,
        current_model: r.current_model,
        attempts: r.attempts,
        tokens: r.tokens,
        stalled: r.stalled
      })),
      circuitBreakers: Object.fromEntries([...this.circuit.entries()].map(([key, value]) => [key, {
        state: value.authError ? 'AUTH_ERROR' : value.stale ? 'STALE' : value.unsupported ? 'UNSUPPORTED' : value.state,
        consecutiveFailures: value.consecutiveFailures,
        cooldownMs: value.cooldownMs,
        openedAt: value.openedAt ? new Date(value.openedAt).toISOString() : null,
        lastError: value.lastError,
      }])),
    }
  }

  async probeCandidate(candidate, { eco = false } = {}) {
    const key = modelKey(candidate.provider, candidate.model)
    const apiKey = this.getApiKeyForProvider(candidate.provider)
    if (!apiKey) {
      this.markAuthError(key, 'missing API key')
      return
    }
    // 📖 Guard: skip probe if the provider URL cannot be resolved (e.g. missing account ID)
    const providerUrl = resolveProviderUrl(candidate.provider)
    if (!providerUrl) {
      this.markAuthError(key, 'provider URL unresolvable')
      return
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    const started = performance.now()
    try {
      const modelsUrl = eco ? buildProviderModelsUrl(candidate.provider) : null
      const response = modelsUrl
        ? await fetch(modelsUrl, {
            method: 'GET',
            headers: cloneHeadersForUpstream({}, apiKey, candidate.provider),
            signal: controller.signal,
          })
        : await fetch(providerUrl, {
            method: 'POST',
            headers: cloneHeadersForUpstream({}, apiKey, candidate.provider),
            body: JSON.stringify(buildChatCompletionPingBody(
              getApiModelId(candidate.provider, candidate.model),
              { stream: false },
              { disableThinking: shouldUseDisabledThinkingForProvider(candidate.provider) }
            )),
            signal: controller.signal,
          })
      const latencyMs = Math.round(performance.now() - started)
      if (response.ok) {
        this.markSuccess(key)
        this.recordProbeResult(key, { ok: true, latencyMs, code: response.status })
        this.logger.info(`Probe ok ${key} - ${latencyMs}ms`)
      } else if (AUTH_STATUS_CODES.has(response.status)) {
        this.markAuthError(key, `HTTP ${response.status}`)
        this.recordProbeResult(key, { ok: false, latencyMs, code: response.status })
      } else if (RETRYABLE_STATUS_CODES.has(response.status)) {
        this.markFailure(key, `HTTP ${response.status}`, response.status)
      } else {
        this.recordProbeResult(key, { ok: false, latencyMs, code: response.status })
      }
    } catch (error) {
      const detail = error.name === 'AbortError' ? 'probe timeout' : error.message
      this.markFailure(key, detail)
    } finally {
      clearTimeout(timeout)
    }
  }

  async runProbeBurst() {
    const set = this.getSet()
    if (!set) return
    const candidates = this.scoreCandidates(set)
      .filter((candidate) => candidate.catalog?.routeable && !candidate.circuit?.stale)
    // 📖 Probe-cache (t1): skip models that are still fresh + ok in the persistent
    // 📖 cache. Broken models naturally pass through (isProbeCacheFresh returns false
    // 📖 for them), so recovery detection keeps working unchanged.
    const filtered = candidates.filter((c) => {
      if (!c.catalog) return true
      return !isProbeCacheFresh(c.catalog.providerKey, c.catalog.modelId)
    })
    await Promise.allSettled(filtered.map((candidate) => this.probeCandidate(candidate, {
      eco: this.routerConfig().probeMode === 'eco',
    })))
  }

  /**
   * 📖 autoHealActiveSet - replaces broken models in the active set with
   * 📖 working alternatives, so the Playground and Router Dashboard both
   * 📖 start with a usable set by default. The user's manual edits are
   * 📖 always respected: once `router.userCustomized` is true (set by
   * 📖 reorder/add/remove/sync), auto-heal is a no-op.
   *
   * 📖 Healing strategy:
   * 📖 1. Identify broken models in the active set
   * 📖    (state === AUTH_ERROR or persistent TIMEOUT).
   * 📖 2. For each broken model, pick a working alternative:
   * 📖    a. Prefer a same-provider model that's currently CLOSED.
   * 📖    b. Fall back to any keyed-provider model that's CLOSED.
   * 📖 3. Replace in place, preserving priority order.
   * 📖 4. Broadcast a `set_change` so the UI refreshes.
   *
   * 📖 Should be called once at startup, AFTER the first `runProbeBurst`
   * 📖 so the circuit-breaker data is fresh.
   */
  async autoHealActiveSet() {
    const router = this.routerConfig()
    if (router.autoHeal === false) return { ok: false, reason: 'autoHeal_disabled' }
    if (router.userCustomized === true) return { ok: false, reason: 'user_customized' }
    const set = this.getSet(router.activeSet)
    if (!set || !Array.isArray(set.models) || set.models.length === 0) {
      return { ok: false, reason: 'empty_set' }
    }

    // 📖 Build a candidate pool from EVERY routeable model in the
    // 📖 catalog, not just the ones in the active set - we need healthy
    // 📖 alternatives to swap in, and the active set's only models are
    // 📖 the broken ones we're trying to replace.
    const healthByKey = new Map()
    const aliveByProvider = new Map()
    // 📖 Per-provider probe stats - we use these to detect "the user's
    // 📖 whole <provider> is dead" (every probe has auth-errored) and
    // 📖 skip that provider as a candidate for replacements.
    const providerProbeStats = new Map() // provider -> { probed: n, authError: n, stale: n, alive: n }
    for (const [providerKey, source] of Object.entries(sources)) {
      if (!isRouteableProvider(providerKey, sources)) continue
      if (!providerProbeStats.has(providerKey)) providerProbeStats.set(providerKey, { probed: 0, authError: 0, stale: 0, alive: 0 })
      for (const [modelId, , tier, sweScore, ctx] of source.models || []) {
        const key = `${providerKey}/${modelId}`
        const cb = this.circuit?.get?.(key) || {}
        const state = cb.state || 'UNKNOWN'
        const authError = !!cb.authError
        const stale = !!cb.stale
        const isAlive = !cb.lastErrorAt ? true : (state === 'CLOSED' && !authError && !stale)
        const tierRank = ['S+', 'S', 'A+', 'A', 'A-', 'B+', 'B', 'C'].indexOf(tier)
        const score = Number.isFinite(tierRank) && tierRank >= 0
          ? (10 - tierRank) * 100 + (Number.parseFloat(sweScore) || 0)
          : 0
        healthByKey.set(key, { state, authError, stale, isAlive, score, existsInCatalog: true })
        // 📖 Only count "alive" picks if we have actual evidence (i.e.
        // 📖 at least one probe has CLOSED). Otherwise the provider is
        // 📖 unproven and we treat it as a fallback, not a preferred pick.
        if (cb.lastErrorAt) {
          const stats = providerProbeStats.get(providerKey)
          stats.probed += 1
          if (authError) stats.authError += 1
          else if (stale) stats.stale += 1
          else if (state === 'CLOSED') stats.alive += 1
        }
        if (isAlive) {
          if (!aliveByProvider.has(providerKey)) aliveByProvider.set(providerKey, [])
          aliveByProvider.get(providerKey).push({ key, score })
        }
      }
    }

    // 📖 Build the "proven-alive" provider set: providers where at
    // 📖 least one probe has come back CLOSED (not auth-errored or
    // 📖 stale). Providers with zero proven-alive models are filtered
    // 📖 out of `aliveByProvider` so the auto-heal doesn't pick unproven
    // 📖 candidates and end up with another broken replacement.
    for (const [providerKey, stats] of providerProbeStats.entries()) {
      if (stats.probed > 0 && stats.alive === 0) {
        // 📖 Probed but no model ever returned CLOSED → the user's key
        // 📖 for this provider is dead. Drop all candidates from this
        // 📖 provider so the picker falls through to a working one.
        aliveByProvider.delete(providerKey)
        // 📖 Also flip every model in this provider to "broken" so the
        // 📖 cross-provider fallback also skips them.
        for (const entry of healthByKey.entries()) {
          if (entry[0].startsWith(`${providerKey}/`)) {
            entry[1].authError = true
            entry[1].stale = false
            entry[1].isAlive = false
          }
        }
      }
    }

    // 📖 Also pick up models that are in the active set but NOT in the
    // 📖 current catalog (e.g. removed from sources.js, deprecated by the
    // 📖 provider). They should be marked as broken and replaced too -
    // 📖 otherwise they'd stay in the set forever as silent dead weight.
    for (const entry of set.models) {
      const key = `${entry.provider}/${entry.model}`
      if (!healthByKey.has(key)) {
        const cb = this.circuit?.get?.(key) || {}
        healthByKey.set(key, {
          state: cb.state || 'UNKNOWN',
          authError: !!cb.authError,
          stale: true,  // 📖 if it's in the set but not in the catalog, it's stale by definition
          isAlive: false,
          score: 0,
          existsInCatalog: false,
        })
      }
    }

    // 📖 Decide what's broken. We heal AUTH_ERROR (key is wrong for that
    // 📖 model) and STALE/TIMEOUT (upstream isn't responding). We do
    // 📖 NOT heal HALF_OPEN (recovering) or OPEN (circuit breaker tripped
    // 📖 on a transient blip) - those should resolve on their own.
    const isBroken = (key) => {
      const health = healthByKey.get(key)
      if (!health) return false
      return health.authError === true || health.stale === true || health.state === 'STALE' || health.state === 'UNSUPPORTED'
    }

    const broken = set.models.filter((m) => isBroken(`${m.provider}/${m.model}`))
    if (broken.length === 0) return { ok: true, replaced: 0, reason: 'no_broken_models' }

    // 📖 Build the replacement list. Same provider first, then any.
    // 📖 We skip candidates that the circuit breaker already knows are
    // 📖 broken (authError / stale) so we don't swap a broken model for
    // 📖 another broken model of the same provider.
    const usedKeys = new Set(set.models.map((m) => `${m.provider}/${m.model}`))
    // 📖 Aggregate PROVEN-alive counts per provider so we can detect
    // 📖 "the user's whole <provider> is dead" and fall through to
    // 📖 cross-provider candidates instead of stacking broken picks.
    // 📖 We deliberately ignore unprobed models here so a provider with
    // 📖 23 unprobed models doesn't look "alive" just because none of
    // 📖 them have been probed yet. The real signal is the set of models
    // 📖 we have actual evidence for (i.e. stats.alive > 0).
    const aliveByProviderKey = (provider) => {
      const stats = providerProbeStats.get(provider)
      if (!stats || stats.alive === 0) return 0
      return stats.alive
    }
    const replacements = []
    for (const dead of broken) {
      const isPickedBroken = (key) => {
        const h = healthByKey.get(key)
        return !h || h.authError === true || h.stale === true
      }
      // 📖 If the user's whole <provider> is dead, skip same-provider
      // 📖 entirely and let anyProvider find a working alternative.
      const providerIsDead = aliveByProviderKey(dead.provider) === 0
      const sameProvider = providerIsDead ? null : (aliveByProvider.get(dead.provider) || []).find((c) =>
        !usedKeys.has(c.key)
        && !broken.some((b) => `${b.provider}/${b.model}` === c.key)
        && !isPickedBroken(c.key)
      )
      const anyProvider = []
      for (const [, list] of aliveByProvider) {
        for (const entry of list) anyProvider.push(entry)
      }
      anyProvider.sort((a, b) => b.score - a.score)
      const pick = sameProvider || anyProvider.find((c) => !usedKeys.has(c.key) && !isPickedBroken(c.key))
      if (pick) {
        usedKeys.add(pick.key)
        const slashIdx = pick.key.indexOf('/')
        const provider = slashIdx >= 0 ? pick.key.slice(0, slashIdx) : pick.key
        const model = slashIdx >= 0 ? pick.key.slice(slashIdx + 1) : ''
        replacements.push({ from: `${dead.provider}/${dead.model}`, to: pick.key, provider, model, score: pick.score })
        this.logger.info('autoHeal: picked replacement', {
          from: `${dead.provider}/${dead.model}`,
          to: pick.key,
          score: pick.score,
          sameProvider: pick === sameProvider,
          crossProvider: !providerIsDead && pick !== sameProvider,
          providerWasDead: providerIsDead,
        })
      } else {
        const aliveList = Array.from(aliveByProvider.entries()).map(([p, list]) => `${p}:${list.length}`).slice(0, 5)
        this.logger.warn('autoHeal: no working alternative found', {
          broken: `${dead.provider}/${dead.model}`,
          set: set.name,
          usedKeys: Array.from(usedKeys).slice(0, 10),
          aliveSample: aliveList,
        })
      }
    }

    if (replacements.length === 0) {
      return { ok: true, replaced: 0, reason: 'no_working_alternatives' }
    }

    // 📖 Apply replacements in place, preserving priority order. We
    // 📖 rewrite the entire `models` array (rather than mutating each
    // 📖 entry) so priorities stay 1..N and contiguous.
    const nextModels = []
    for (const m of set.models) {
      const key = `${m.provider}/${m.model}`
      const replacement = replacements.find((r) => r.from === key)
      if (replacement) {
        nextModels.push({ provider: replacement.provider, model: replacement.model, priority: nextModels.length + 1 })
      } else {
        nextModels.push({ ...m, priority: nextModels.length + 1 })
      }
    }
    const nextRouter = normalizeRouterConfig({
      ...router,
      sets: { ...router.sets, [set.name]: { ...set, models: nextModels } },
    })
    this.setRouterConfig(nextRouter)
    this.saveRouterConfig()
    for (const r of replacements) {
      this.logger.info('autoHeal: replaced broken model', {
        from: r.from,
        to: r.to,
        score: r.score,
        set: set.name,
      })
    }
    this.broadcast('set_change', {
      activeSet: this.routerConfig().activeSet,
      set: set.name,
      action: 'auto_heal',
      replaced: replacements,
    })
    return { ok: true, replaced: replacements.length, replacements }
  }

  scheduleProbeLoop() {
    // Clear any existing timers
    if (this.probeTimer) clearInterval(this.probeTimer)
    if (this.probeWatchdog) clearInterval(this.probeWatchdog)
    for (const timeout of this.probeTimeouts) clearTimeout(timeout)
    this.probeTimeouts.clear()

    const router = this.routerConfig()
    const interval = router.probeIntervals[router.probeMode] || DEFAULT_ROUTER_SETTINGS.probeIntervals.balanced
    // Track last successful probe cycle timestamp
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
            void this.probeCandidate(candidate, { eco: router.probeMode === 'eco' })
          }, index * stagger)
          timeout.unref?.()
          this.probeTimeouts.add(timeout)
        })
        // Update timestamp after scheduling probes
        this.lastProbeAt = Date.now()
      } catch (err) {
        this.logger.error('[ProbeLoop] error', { error: err })
      }
    }, interval)
    this.probeTimer.unref?.()

    // Watchdog: if no successful cycle for 3x interval, restart loop
    this.probeWatchdog = setInterval(() => {
      if (this.lastProbeAt && Date.now() - this.lastProbeAt > interval * 3) {
        this.logger.warn('[ProbeLoop] stall detected, restarting probe loop')
        this.scheduleProbeLoop()
      }
    }, interval)
    this.probeWatchdog.unref?.()
  }

  async routeRequest({ req, res, body, setName, requestId }) {
    this.activeRequests.set(requestId, {
      requestId,
      at: Date.now(),
      model: body?.model || 'fcm',
      current_model: null,
      attempts: 0,
      tokens: 0,
      stalled: false
    })
    if (this.shuttingDown) {
      sendError(res, 503, 'Daemon is shutting down', 'service_unavailable', 'daemon_shutting_down', requestId)
      return
    }
    if (this.inFlight >= MAX_CONCURRENT_REQUESTS) {
      sendError(res, 503, 'Router overloaded, too many concurrent requests', 'service_unavailable', 'router_overloaded', requestId)
      return
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendError(res, 400, 'Request body must be a JSON object', 'invalid_request_error', 'invalid_json_object', requestId)
      return
    }
    if (typeof body.model !== 'string' || !body.model.trim()) {
      sendError(res, 400, 'Missing required field: model', 'invalid_request_error', 'missing_model', requestId)
      return
    }

    const set = this.getSet(setName)
    if (!set) {
      sendError(res, 404, `Router set not found: ${setName || this.routerConfig().activeSet}`, 'invalid_request_error', 'set_not_found', requestId)
      return
    }

    const candidates = this.getRoutingCandidates(set)
    const maxRetries = this.routerConfig().failover.maxRetries
    const maxAttempts = 1 + maxRetries
    if (candidates.length === 0) {
      const health = this.getModelHealth(set)
      const quotaExhausted = [...this.quotaExhausted].filter((key) => set.models.some((model) => modelKey(model.provider, model.model) === key))

      let statusCode = 503
      let errorCode = 'all_models_unavailable'
      let errorType = 'service_unavailable'
      if (health.length > 0) {
        const allAuthError = health.length > 0 && health.every((h) => h.state === 'AUTH_ERROR')
        const allAuthOrQuota = health.length > 0 && health.every((h) => h.state === 'AUTH_ERROR' || quotaExhausted.includes(h.key))
        const allStaleOrUnsupported = health.every((h) => h.state === 'STALE' || h.state === 'UNSUPPORTED')
        if (allAuthError) {
          statusCode = 401
          errorCode = 'invalid_api_key'
          errorType = 'invalid_request_error'
        } else if (allAuthOrQuota) {
          statusCode = 429
          errorCode = 'insufficient_quota'
          errorType = 'insufficient_quota'
        } else if (allStaleOrUnsupported) {
          statusCode = 400
          errorCode = 'invalid_model'
          errorType = 'invalid_request_error'
        }
      }

      sendError(res, statusCode, `All models in set are unavailable: ${set.name}`, errorType, errorCode, requestId, {
        set: set.name,
        models_tried: [],
        quota_exhausted: quotaExhausted,
        quota_exhausted_details: this.quotaDetailsForKeys(quotaExhausted),
        model_health: health,
      })
      void sendUsageTelemetry(this.config, {}, {
        event: 'app_router_all_down',
        mode: 'daemon',
        properties: {
          set_name: set.name,
          models_tried: [],
          quota_exhausted_count: quotaExhausted.length,
        },
      })
      return
    }

    this.inFlight += 1
    try {
      const tried = []
      const blockedProviders = new Set()
      let attemptIndex = 0
      // 📖 attemptChain is a private copy of the routing order: on a family
      // failover (t8) the same-family candidate is swapped in as the NEXT
      // attempt, so the iteration order itself follows the two-stage policy.
      const attemptChain = candidates.slice()
      for (let index = 0; index < attemptChain.length && attemptIndex < maxAttempts; index += 1) {
        const candidate = attemptChain[index]
        if (blockedProviders.has(candidate.provider)) continue

        const activeReq = this.activeRequests.get(requestId)
        if (activeReq) {
          activeReq.current_model = candidate.key
          activeReq.attempts = attemptIndex + 1
        }

        tried.push(candidate.key)
        const result = body.stream === true
          ? await this.proxyStreamingRequest({ req, res, body, candidate, requestId, attemptIndex })
          : await this.proxyJsonRequest({ req, res, body, candidate, requestId, attemptIndex })
        if (result.done) return
        attemptIndex += 1
        if (result.authFailure) blockedProviders.add(candidate.provider)
        if (result.failoverToNext && attemptIndex < maxAttempts) {
          // 📖 Two-stage failover (t8): prefer a healthy model of the SAME
          // family on another provider (DeepSeek down on NIM -> DeepSeek on
          // Together) so the user's output style doesn't change mid-request.
          // Falls back to the historical set-order pick, and is disabled
          // per-set via familyFailover: false.
          const pick = pickNextCandidate({
            candidates: attemptChain,
            failedCandidate: candidate,
            triedKeys: new Set(tried),
            blockedProviders,
            familyFailover: set.familyFailover !== false,
          })
          const next = pick?.candidate || null
          // 📖 Reorder the remaining chain so `next` is genuinely the following
          // attempt. With set-order picks this is already the case (or the
          // skipped entries are blocked anyway), so behaviour is unchanged.
          if (next && attemptChain[index + 1] !== next) {
            const nextIndex = attemptChain.indexOf(next)
            if (nextIndex > index) {
              attemptChain.splice(nextIndex, 1)
              attemptChain.splice(index + 1, 0, next)
            }
          }
          const activeReqForReason = this.activeRequests.get(requestId)
          if (next && activeReqForReason) activeReqForReason.failoverReason = pick.reason
          this.logger.warn(
            `Failover ${candidate.key}${next ? ` -> ${next.key}` : ''}${pick?.reason === 'family_failover' ? ' [family]' : ''}`,
            { request_id: requestId, reason: result.reason },
          )
          void sendUsageTelemetry(this.config, {}, {
            event: 'app_router_failover',
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

      const quotaExhausted = [...this.quotaExhausted].filter((key) => tried.includes(key))
      const allAuthError = tried.every((key) => {
        const [provider] = key.split('/')
        return blockedProviders.has(provider)
      })
      const allQuotaError = tried.length > 0 && quotaExhausted.length === tried.length
      const allAuthOrQuota = tried.every((key) => {
        const [provider] = key.split('/')
        return blockedProviders.has(provider) || quotaExhausted.includes(key)
      })

      let statusCode = 503
      let errorCode = 'all_models_failed'
      let errorType = 'service_unavailable'

      if (tried.length > 0) {
        if (allAuthError) {
          statusCode = 401
          errorCode = 'invalid_api_key'
          errorType = 'invalid_request_error'
        } else if (allQuotaError || allAuthOrQuota) {
          statusCode = 429
          errorCode = 'insufficient_quota'
          errorType = 'insufficient_quota'
        }
      }

      sendError(res, statusCode, `All routed models failed for set: ${set.name}`, errorType, errorCode, requestId, {
        set: set.name,
        models_tried: tried,
        quota_exhausted: quotaExhausted,
        quota_exhausted_details: this.quotaDetailsForKeys(quotaExhausted),
      })
    } finally {
      this.inFlight -= 1
      this.activeRequests.delete(requestId)
    }
  }

  async proxyJsonRequest({ req, res, body, candidate, requestId, attemptIndex }) {
    const key = candidate.key
    const apiKey = this.getApiKeyForProvider(candidate.provider)
    // 📖 Guard: bail early if provider URL cannot be resolved
    const providerUrl = resolveProviderUrl(candidate.provider)
    if (!providerUrl) {
      this.markFailure(key, 'provider URL unresolvable')
      this.addRequestLog({ request_id: requestId, model: key, status: 'ERR', latency_ms: null, tokens: 0, failover: attemptIndex > 0, error: 'provider_url_unresolvable' })
      return { done: false, failoverToNext: true, reason: 'provider_url_unresolvable' }
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.routerConfig().failover.requestTimeoutMs)
    const started = performance.now()
    // 📖 Pre-prompt is injected server-side so every client (OpenAI SDK,
    // 📖 curl, custom Playground) gets the FCM persona without any client
    // 📖 change. Non-streaming path.
    const bodyWithPrePrompt = applyPrePromptToBody(body, this.routerConfig().prePrompt)
    // 📖 Apply per-provider schema normalization (GLM, Mistral, Codestral).
    // 📖 Returns the body unchanged for providers without a registered normalizer.
    const bodyNormalized = normalizeRequestBody(bodyWithPrePrompt, candidate.provider)
    const upstreamBody = {
      ...bodyNormalized,
      model: getApiModelId(candidate.provider, candidate.model),
      stream: false,
    }
    // 📖 Some providers/models fail if we send custom internal params, so strip them
    if (upstreamBody.add_generation_prompt !== undefined) delete upstreamBody.add_generation_prompt
    if (upstreamBody.continue_final_message !== undefined) delete upstreamBody.continue_final_message
    if (upstreamBody.tools?.length === 0) delete upstreamBody.tools

    const clientAbort = attachClientAbort(req, res, controller)
    try {
      const response = await fetch(providerUrl, {
        method: 'POST',
        headers: {
          ...cloneHeadersForUpstream(req.headers, apiKey, candidate.provider),
          'X-Request-Id': requestId,
        },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      })
      clearTimeout(timeout)
      const latencyMs = Math.round(performance.now() - started)
      const text = await response.text()
      const upstreamMeta = buildUpstreamMeta(response, text, candidate.provider)

      if (isLikelyHtmlResponse(response.headers, text)) {
        this.markFailure(key, 'upstream_html_maintenance', 503, upstreamMeta)
        this.recordRouterError('upstream_html_maintenance', requestId, { model: key, status: response.status })
        this.addRequestLog({ request_id: requestId, model: key, status: 503, latency_ms: latencyMs, tokens: 0, failover: attemptIndex > 0, error: 'upstream_html_maintenance' })
        return { done: false, failoverToNext: true, reason: 'upstream_html_maintenance' }
      }

      if (response.ok) {
        const parsed = parseJsonResult(text)
        if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
          this.markFailure(key, 'upstream_invalid_json', 502, upstreamMeta)
          this.recordRouterError('upstream_invalid_json', requestId, { model: key, status: response.status })
          this.addRequestLog({ request_id: requestId, model: key, status: 502, latency_ms: latencyMs, tokens: 0, failover: attemptIndex > 0, error: 'upstream_invalid_json' })
          return { done: false, failoverToNext: true, reason: 'upstream_invalid_json' }
        }
        this.markSuccess(key, latencyMs)
        const usage = extractUsage(parsed.value)
        this.tokenTracker.record(candidate.provider, candidate.model, usage)
        // 📖 Runtime telemetry (t3): track every successful routed request so the
        // 📖 real-world score can rank models by what *actually* works.
        this.recordRuntimeCall({
          providerKey: candidate.provider,
          modelId: candidate.model,
          success: true,
          latencyMs,
          usage,
        })
        this.totalRequestsRouted += 1
        // 📖 Fire app_router_use telemetry once per 10 routed requests
        if (this.totalRequestsRouted % 10 === 0) {
          void sendUsageTelemetry(this.config, {}, {
            event: 'app_router_use',
            mode: 'daemon',
            properties: {
              total_requests: this.totalRequestsRouted,
              active_set: this.routerConfig().activeSet,
            },
          })
        }
        this.addRequestLog({
          request_id: requestId,
          model: key,
          status: response.status,
          latency_ms: latencyMs,
          tokens: usage?.total_tokens || 0,
          failover: attemptIndex > 0,
        })
        this.logger.info(`Routed to ${key} - ${latencyMs}ms`, { request_id: requestId, status: response.status })
        // 📖 Fix #124: normalize malformed tool_calls (finish_reason tool_calls without tool_calls array)
        let responseText = text
        try {
          if (normalizeToolCallsResponse(parsed.value)) {
            responseText = JSON.stringify(parsed.value)
          }
        } catch {}
        if (!res.writableEnded) {
          res.writeHead(response.status, {
            ...headerEntries(response.headers),
            'x-fcm-router-model': key,
            'x-request-id': requestId,
          })
          res.end(responseText)
        }
        return { done: true }
      }

      if (AUTH_STATUS_CODES.has(response.status)) {
        this.markAuthError(key, `HTTP ${response.status}`)
        this.addRequestLog({ request_id: requestId, model: key, status: response.status, latency_ms: latencyMs, tokens: 0, failover: attemptIndex > 0, error: 'auth_error' })
        this.recordRuntimeCall({
          providerKey: candidate.provider, modelId: candidate.model,
          success: false, latencyMs, error: `auth_${response.status}`,
        })
        return { done: false, failoverToNext: true, reason: `auth_${response.status}`, authFailure: true }
      }

      if (RETRYABLE_STATUS_CODES.has(response.status)) {
        this.markFailure(key, `HTTP ${response.status}`, response.status, upstreamMeta)
        this.addRequestLog({ request_id: requestId, model: key, status: response.status, latency_ms: latencyMs, tokens: 0, failover: attemptIndex > 0, error: `http_${response.status}` })
        this.recordRuntimeCall({
          providerKey: candidate.provider, modelId: candidate.model,
          success: false, latencyMs, error: `http_${response.status}`,
        })
        return { done: false, failoverToNext: true, reason: `http_${response.status}` }
      }

      // 📖 Provide failover fallback for non-retryable errors from the provider (like 400 Bad Request)
      // when they are caused by format idiosyncrasies (e.g. empty tools array that another model might accept)
      if (response.status >= 400 && response.status < 500) {
        // 📖 Telemetry keeps structural fields only: upstream response bodies
        // 📖 must never leave the machine (they can embed user code/prompts).
        this.recordRouterError(`http_${response.status}`, requestId, { provider: candidate.provider, model: key, status: response.status })
        this.markFailure(key, `HTTP ${response.status}`)
        this.addRequestLog({ request_id: requestId, model: key, status: response.status, latency_ms: latencyMs, tokens: 0, failover: attemptIndex > 0, error: `http_${response.status}` })
        this.recordRuntimeCall({
          providerKey: candidate.provider, modelId: candidate.model,
          success: false, latencyMs, error: `http_${response.status}`,
        })
        return { done: false, failoverToNext: true, reason: `http_${response.status}` }
      }

      if (!res.writableEnded) {
        res.writeHead(response.status, {
          ...headerEntries(response.headers),
          'x-fcm-router-model': key,
          'x-request-id': requestId,
        })
        res.end(text)
      }
      return { done: true }
    } catch (error) {
      if (clientAbort.aborted) {
        this.logger.info(`Client disconnected before upstream response from ${key}`, { request_id: requestId })
        return { done: true }
      }
      const reason = error.name === 'AbortError' ? 'timeout' : (error.message || String(error))
      this.markFailure(key, reason)
      this.recordRouterError('upstream_transport_error', requestId, { model: key, reason })
      this.addRequestLog({ request_id: requestId, model: key, status: 'ERR', latency_ms: null, tokens: 0, failover: attemptIndex > 0, error: reason })
      return { done: false, failoverToNext: true, reason }
    } finally {
      clearTimeout(timeout)
      clientAbort.dispose()
    }
  }

  async proxyStreamingRequest({ req, res, body, candidate, requestId, attemptIndex }) {
    const key = candidate.key
    const activeReq = this.activeRequests.get(requestId)
    if (activeReq) {
      activeReq.current_model = key
      if (activeReq.last_activity_at) activeReq.last_activity_at = Date.now()
    }
    const apiKey = this.getApiKeyForProvider(candidate.provider)
    // 📖 Guard: bail early if provider URL cannot be resolved
    const providerUrl = resolveProviderUrl(candidate.provider)
    if (!providerUrl) {
      this.markFailure(key, 'provider URL unresolvable')
      this.addRequestLog({ request_id: requestId, model: key, status: 'ERR', latency_ms: null, tokens: 0, failover: attemptIndex > 0, error: 'provider_url_unresolvable', stream: true })
      return { done: false, failoverToNext: true, reason: 'provider_url_unresolvable' }
    }
    const controller = new AbortController()
    const started = performance.now()
    // 📖 Pre-prompt is injected server-side so every client (OpenAI SDK,
    // 📖 curl, custom Playground) gets the FCM persona without any client
    // 📖 change. Streaming path.
    const bodyWithPrePrompt = applyPrePromptToBody(body, this.routerConfig().prePrompt)
    // 📖 Apply per-provider schema normalization (GLM, Mistral, Codestral).
    // 📖 Returns the body unchanged for providers without a registered normalizer.
    const bodyNormalized = normalizeRequestBody(bodyWithPrePrompt, candidate.provider)
    const upstreamBody = {
      ...bodyNormalized,
      model: getApiModelId(candidate.provider, candidate.model),
      stream: true,
    }
    // 📖 Some providers/models fail if we send custom internal params, so strip them
    if (upstreamBody.add_generation_prompt !== undefined) delete upstreamBody.add_generation_prompt
    if (upstreamBody.continue_final_message !== undefined) delete upstreamBody.continue_final_message
    if (upstreamBody.tools?.length === 0) delete upstreamBody.tools

    const timeout = setTimeout(() => controller.abort(), this.routerConfig().failover.requestTimeoutMs)
    let sentToClient = false
    const clientAbort = attachClientAbort(req, res, controller)
    try {
      const response = await fetch(providerUrl, {
        method: 'POST',
        headers: {
          ...cloneHeadersForUpstream(req.headers, apiKey, candidate.provider),
          'X-Request-Id': requestId,
        },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      })
      clearTimeout(timeout)
      const latencyMs = Math.round(performance.now() - started)
      const upstreamMeta = buildUpstreamMeta(response, '', candidate.provider)
      if (isLikelyHtmlResponse(response.headers)) {
        this.markFailure(key, 'upstream_html_maintenance', 503, upstreamMeta)
        this.recordRouterError('upstream_html_maintenance', requestId, { model: key, status: response.status, stream: true })
        this.addRequestLog({ request_id: requestId, model: key, status: 503, latency_ms: latencyMs, tokens: 0, failover: attemptIndex > 0, error: 'upstream_html_maintenance', stream: true })
        return { done: false, failoverToNext: true, reason: 'upstream_html_maintenance' }
      }
      if (!response.ok) {
        if (AUTH_STATUS_CODES.has(response.status)) {
          this.markAuthError(key, `HTTP ${response.status}`)
          this.addRequestLog({ request_id: requestId, model: key, status: response.status, latency_ms: latencyMs, tokens: 0, failover: attemptIndex > 0, error: 'auth_error', stream: true })
          return { done: false, failoverToNext: true, reason: `auth_${response.status}`, authFailure: true }
        }
        if (RETRYABLE_STATUS_CODES.has(response.status)) {
          this.markFailure(key, `HTTP ${response.status}`, response.status, upstreamMeta)
          this.addRequestLog({ request_id: requestId, model: key, status: response.status, latency_ms: latencyMs, tokens: 0, failover: attemptIndex > 0, error: `http_${response.status}`, stream: true })
          return { done: false, failoverToNext: true, reason: `http_${response.status}` }
        }

        // 📖 Provide failover fallback for non-retryable errors from the provider (like 400 Bad Request)
        // when they are caused by format idiosyncrasies (e.g. empty tools array that another model might accept)
        if (response.status >= 400 && response.status < 500) {
          // 📖 Telemetry keeps structural fields only: upstream response bodies
          // 📖 must never leave the machine (they can embed user code/prompts).
          this.recordRouterError(`http_${response.status}`, requestId, { provider: candidate.provider, model: key, status: response.status, stream: true })
          this.markFailure(key, `HTTP ${response.status}`)
          this.addRequestLog({ request_id: requestId, model: key, status: response.status, latency_ms: latencyMs, tokens: 0, failover: attemptIndex > 0, error: `http_${response.status}`, stream: true })
          return { done: false, failoverToNext: true, reason: `http_${response.status}` }
        }

        if (!res.writableEnded) {
          res.writeHead(response.status, {
            ...headerEntries(response.headers),
            'x-fcm-router-model': key,
            'x-request-id': requestId,
          })
          try { res.end(await response.text()) } catch {}
        }
        return { done: true }
      }

      const reader = response.body?.getReader()
      if (!reader) {
        this.markFailure(key, 'empty stream')
        return { done: false, failoverToNext: true, reason: 'empty_stream' }
      }

      const firstChunk = await this.readStreamChunkWithTimeout(reader)
      if (firstChunk.done || !firstChunk.value) {
        this.markFailure(key, 'stream ended before first chunk')
        return { done: false, failoverToNext: true, reason: 'empty_stream' }
      }
      // 📖 Guard: ensure value is a valid buffer source before conversion
      const firstChunkBuffer = Buffer.isBuffer(firstChunk.value) ? firstChunk.value : Buffer.from(firstChunk.value)
      if (isLikelyHtmlText(firstChunkBuffer.toString('utf8'))) {
        this.markFailure(key, 'upstream_html_maintenance', 503, upstreamMeta)
        this.recordRouterError('upstream_html_maintenance', requestId, { model: key, status: response.status, stream: true })
        return { done: false, failoverToNext: true, reason: 'upstream_html_maintenance' }
      }

      if (res.writableEnded) return { done: true }
      // 📖 Issue #137: when the previous model sent partial data, headers are
      // 📖 already on the wire — re-calling writeHead throws ERR_HTTP_HEADERS_SENT.
      // 📖 On a mid-stream failover we just append chunks to the existing response.
      if (!res.headersSent) {
        res.writeHead(response.status, {
          ...headerEntries(response.headers),
          'x-fcm-router-model': key,
          'x-request-id': requestId,
        })
      } else {
        // 📖 Reflect the new model in trailer-ish debug headers. Node won't let
        // 📖 us add new headers after send, but we still update x-fcm-router-model
        // 📖 semantics via a leading SSE comment so clients can see the switch.
        try {
          res.write(`: fcm-router-failover-from=${key}\n\n`)
        } catch { /* best-effort */ }
      }
      sentToClient = true
      res.write(firstChunkBuffer)

      while (!res.writableEnded) {
        const chunk = await this.readStreamChunkWithTimeout(reader)
        if (chunk.done || !chunk.value) break
        // 📖 Guard: ensure chunk value is safe for Buffer conversion
        const buf = Buffer.isBuffer(chunk.value) ? chunk.value : Buffer.from(chunk.value)
        res.write(buf)
        if (activeReq) {
          if (activeReq.last_activity_at) activeReq.last_activity_at = Date.now()
          activeReq.tokens += 1 // Increment a counter to show progress
        }
      }

      this.markSuccess(key, latencyMs)
      this.totalRequestsRouted += 1
      this.addRequestLog({
        request_id: requestId,
        model: key,
        status: response.status,
        latency_ms: latencyMs,
        tokens: 0,
        failover: attemptIndex > 0,
        stream: true,
      })
      if (!res.writableEnded) res.end()
      return { done: true }
    } catch (error) {
      try { controller.abort() } catch {}
      if (clientAbort.aborted) {
        this.logger.info(`Client disconnected during streaming response from ${key}`, { request_id: requestId })
        return { done: true }
      }
      const reason = error.name === 'AbortError' ? 'timeout' : (error.message || String(error))
      // 📖 Issue #137: stream-stall timeouts get a special tag so we can
      // 📖 distinguish them from generic upstream errors below. Only stalls
      // 📖 should trigger failover after a partial response — generic errors
      // 📖 (malformed JSON, network reset, etc.) usually mean the partial
      // 📖 data is invalid anyway, so closing cleanly is safer.
      const isStall = reason === 'stream_stall_timeout' || reason === 'timeout'
      this.markFailure(key, reason)
      if (reason !== 'timeout') {
        this.recordRouterError('upstream_stream_error', requestId, { model: key, reason, partial: sentToClient })
      } else {
        this.recordRouterError('timeout', requestId, { model: key, reason, partial: sentToClient })
      }
      this.addRequestLog({ request_id: requestId, model: key, status: 'ERR', latency_ms: null, tokens: 0, failover: attemptIndex > 0, error: reason, stream: true })
      if (sentToClient) {
        if (isStall) {
          // 📖 Issue #137: failover even after a partial response. Emit a
          // 📖 synthetic SSE error event in OpenAI format so clients know the
          // 📖 stream was truncated and that the router is failing over. The
          // 📖 outer retry loop will then try the next model on a fresh
          // 📖 upstream connection; its chunks are appended to the same
          // 📖 response object so the client sees one continuous stream.
          this.logger.warn(`Stream stall after partial response from ${key}, attempting failover`, { request_id: requestId, reason })
          if (!res.writableEnded) {
            try {
              // 📖 Issue #137: failover even after a partial response.
              // 📖 We use a regular chat delta instead of an error payload so
              // 📖 that clients (which often abort on "error") stay connected.
              const failoverMsg = `\n\n> [!CAUTION]\n> Stream truncated by router due to upstream ${reason}; failing over to next model.\n\n`
              const deltaPayload = JSON.stringify({
                choices: [{
                  index: 0,
                  delta: { content: failoverMsg },
                  finish_reason: null,
                }],
              })
              res.write(`data: ${deltaPayload}\n\n`)
            } catch { /* best-effort */ }
          }
          return { done: false, failoverToNext: true, reason: `stream_stall_${reason}` }
        }
        // 📖 Non-stall errors after partial output: keep existing behaviour
        // 📖 (close cleanly, no failover) to avoid sending malformed data.
        this.logger.warn(`Streaming failure after partial response from ${key}`, { request_id: requestId, reason })
        try { if (!res.writableEnded) res.end() } catch {}
        return { done: true }
      }
      return { done: false, failoverToNext: true, reason }
    } finally {
      clearTimeout(timeout)
      clientAbort.dispose()
    }
  }

  readStreamChunkWithTimeout(reader) {
    const timeoutMs = this.routerConfig().failover.streamStallTimeoutMs
    let timeout = null
    const read = reader.read()
    // 📖 When the stall timer below wins the race, this read promise is
    // 📖 abandoned; without a catch its eventual rejection would surface as
    // 📖 an unhandledRejection and feed the daemon crash counter.
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

  async handleSetsRequest(req, res, url, requestId) {
    // 📖 Hoisted same-origin guard: covers both the canonical /sets routes and
    // 📖 the /api/router/sets alias so no set-mutating path skips the check.
    if (!isSameOriginOrLocal(req)) {
      sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
      return
    }
    const router = this.routerConfig()
    const setNameMatch = url.pathname.match(/^\/sets\/([^/]+)$/)
    const activateMatch = url.pathname.match(/^\/sets\/([^/]+)\/activate$/)
    const setModelsMatch = url.pathname.match(/^\/sets\/([^/]+)\/models$/)
    const setReorderMatch = url.pathname.match(/^\/sets\/([^/]+)\/reorder$/)
    const setSyncMatch = url.pathname.match(/^\/sets\/([^/]+)\/sync$/)

    if (req.method === 'GET' && url.pathname === '/sets') {
      sendJson(res, 200, { activeSet: router.activeSet, sets: router.sets })
      return
    }

    if (req.method === 'POST' && url.pathname === '/sets') {
      const body = await readJsonBody(req)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) {
        sendError(res, 400, 'Set name is required', 'invalid_request_error', 'missing_set_name', requestId)
        return
      }
      const normalized = normalizeRouterConfig({
        ...router,
        sets: {
          ...router.sets,
          [name]: {
            name,
            models: Array.isArray(body.models) ? body.models : [],
            created: nowIso(),
          },
        },
      })
      this.setRouterConfig(normalized)
      this.saveRouterConfig()
      this.markSetCustomized()
      this.broadcast('set_change', { old_set: router.activeSet, new_set: normalized.activeSet })
      sendJson(res, 201, { set: normalized.sets[normalized.activeSet] || normalized.sets[name], router: normalized })
      return
    }

    if (activateMatch && req.method === 'POST') {
      const name = decodeURIComponent(activateMatch[1])
      if (!router.sets[name]) {
        sendError(res, 404, `Router set not found: ${name}`, 'invalid_request_error', 'set_not_found', requestId)
        return
      }
      this.setRouterConfig({ ...router, activeSet: name })
      this.saveRouterConfig()
      this.markSetCustomized()
      this.broadcast('set_change', { old_set: router.activeSet, new_set: name })
      void this.runProbeBurst()
      sendJson(res, 200, { activeSet: name })
      return
    }

    if (setNameMatch && req.method === 'PUT') {
      const name = decodeURIComponent(setNameMatch[1])
      if (!router.sets[name]) {
        sendError(res, 404, `Router set not found: ${name}`, 'invalid_request_error', 'set_not_found', requestId)
        return
      }
      const body = await readJsonBody(req)
      const nextName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : name
      const nextSets = { ...router.sets }
      delete nextSets[name]
      nextSets[nextName] = {
        ...router.sets[name],
        ...body,
        name: nextName,
        models: Array.isArray(body.models) ? body.models : router.sets[name].models,
      }
      const nextActiveSet = router.activeSet === name ? nextName : router.activeSet
      const normalized = normalizeRouterConfig({ ...router, activeSet: nextActiveSet, sets: nextSets })
      this.setRouterConfig(normalized)
      this.saveRouterConfig()
      this.markSetCustomized()
      sendJson(res, 200, { set: normalized.sets[nextName], router: normalized })
      return
    }

    if (setNameMatch && req.method === 'DELETE') {
      const name = decodeURIComponent(setNameMatch[1])
      if (!router.sets[name]) {
        sendError(res, 404, `Router set not found: ${name}`, 'invalid_request_error', 'set_not_found', requestId)
        return
      }
      const nextSets = { ...router.sets }
      delete nextSets[name]
      const nextActiveSet = router.activeSet === name ? (Object.keys(nextSets)[0] || DEFAULT_ROUTER_SETTINGS.activeSet) : router.activeSet
      this.setRouterConfig({ ...router, activeSet: nextActiveSet, sets: nextSets })
      this.saveRouterConfig()
      this.markSetCustomized()
      sendJson(res, 200, { deleted: name, activeSet: this.routerConfig().activeSet })
      return
    }

    // 📖 POST /sets/:name/models - append a single model to a set. The model
    // 📖 is auto-prioritized to the end of the list (priority = count+1).
    // 📖 This is the granular alternative to PUT /sets/:name for clients
    // 📖 that just want to add one entry without resending the full array.
    if (setModelsMatch && req.method === 'POST') {
      const name = decodeURIComponent(setModelsMatch[1])
      const set = router.sets[name]
      if (!set) {
        sendError(res, 404, `Router set not found: ${name}`, 'invalid_request_error', 'set_not_found', requestId)
        return
      }
      const body = await readJsonBody(req)
      const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (!provider || !model) {
        sendError(res, 400, 'Both `provider` and `model` are required', 'invalid_request_error', 'missing_model_fields', requestId)
        return
      }
      // 📖 Reject duplicate entries by provider+model so the set never
      // 📖 contains the same key twice (would just waste a priority slot).
      const currentModels = Array.isArray(set.models) ? set.models : []
      const duplicate = currentModels.find((m) => m.provider === provider && m.model === model)
      if (duplicate) {
        sendError(res, 409, `Model already in set: ${provider}/${model}`, 'invalid_request_error', 'duplicate_model', requestId)
        return
      }
      const newEntry = {
        provider,
        model,
        priority: typeof body.priority === 'number' && Number.isFinite(body.priority)
          ? body.priority
          : currentModels.length + 1,
      }
      const nextModels = [...currentModels, newEntry]
      // 📖 Re-number priorities so they're always 1..N and contiguous.
      for (let i = 0; i < nextModels.length; i += 1) {
        nextModels[i] = { ...nextModels[i], priority: i + 1 }
      }
      const nextSets = { ...router.sets, [name]: { ...set, models: nextModels } }
      const normalized = normalizeRouterConfig({ ...router, sets: nextSets })
      this.setRouterConfig(normalized)
      this.saveRouterConfig()
      this.markSetCustomized()
      this.broadcast('set_change', { activeSet: this.routerConfig().activeSet, set: name, action: 'add', model: newEntry })
      sendJson(res, 201, { set: normalized.sets[name], router: normalized }, { 'x-request-id': requestId })
      void this.runProbeBurst()
      return
    }

    // 📖 DELETE /sets/:name/models - remove a single model from a set.
    // 📖 The body is `{ provider, model }` (using the body keeps the URL
    // 📖 short and matches the POST shape).
    if (setModelsMatch && req.method === 'DELETE') {
      const name = decodeURIComponent(setModelsMatch[1])
      const set = router.sets[name]
      if (!set) {
        sendError(res, 404, `Router set not found: ${name}`, 'invalid_request_error', 'set_not_found', requestId)
        return
      }
      const body = await readJsonBody(req)
      const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (!provider || !model) {
        sendError(res, 400, 'Both `provider` and `model` are required', 'invalid_request_error', 'missing_model_fields', requestId)
        return
      }
      const currentModels = Array.isArray(set.models) ? set.models : []
      const nextModels = currentModels.filter((m) => !(m.provider === provider && m.model === model))
      if (nextModels.length === currentModels.length) {
        sendError(res, 404, `Model not in set: ${provider}/${model}`, 'invalid_request_error', 'model_not_in_set', requestId)
        return
      }
      // 📖 Re-number priorities so they stay 1..N and contiguous.
      for (let i = 0; i < nextModels.length; i += 1) {
        nextModels[i] = { ...nextModels[i], priority: i + 1 }
      }
      const nextSets = { ...router.sets, [name]: { ...set, models: nextModels } }
      const normalized = normalizeRouterConfig({ ...router, sets: nextSets })
      this.setRouterConfig(normalized)
      this.saveRouterConfig()
      this.markSetCustomized()
      this.broadcast('set_change', { activeSet: this.routerConfig().activeSet, set: name, action: 'remove', key: `${provider}/${model}` })
      sendJson(res, 200, { set: normalized.sets[name], router: normalized }, { 'x-request-id': requestId })
      return
    }

    // 📖 POST /sets/:name/reorder - accept a full priority order from the
    // 📖 client. Body shape: `{ order: ["provider/model", "provider/model"] }`.
    // 📖 The daemon re-derives the canonical `{ provider, model, priority }`
    // 📖 objects from the order, so the client never has to know the
    // 📖 internal `priority` numbering.
    if (setReorderMatch && req.method === 'POST') {
      const name = decodeURIComponent(setReorderMatch[1])
      const set = router.sets[name]
      if (!set) {
        sendError(res, 404, `Router set not found: ${name}`, 'invalid_request_error', 'set_not_found', requestId)
        return
      }
      const body = await readJsonBody(req)
      const order = Array.isArray(body.order) ? body.order : null
      if (!order) {
        sendError(res, 400, 'Body must include `order` array', 'invalid_request_error', 'missing_order', requestId)
        return
      }
      const currentModels = Array.isArray(set.models) ? set.models : []
      const modelByKey = new Map(currentModels.map((m) => [`${m.provider}/${m.model}`, m]))
      // 📖 Validate that every key in the new order is already in the set.
      // 📖 Reject unknown keys (would be a silent bug if we just appended).
      for (const key of order) {
        if (typeof key !== 'string' || !modelByKey.has(key)) {
          sendError(res, 400, `Unknown model in order: ${key}`, 'invalid_request_error', 'unknown_model_in_order', requestId)
          return
        }
      }
      // 📖 Reject the request if the client omitted some keys - reordering
      // 📖 must be a permutation of the current set, not a partial edit.
      if (order.length !== currentModels.length) {
        sendError(res, 400, 'Order must include every model in the set', 'invalid_request_error', 'order_size_mismatch', requestId)
        return
      }
      const nextModels = order.map((key, idx) => ({ ...modelByKey.get(key), priority: idx + 1 }))
      const nextSets = { ...router.sets, [name]: { ...set, models: nextModels } }
      const normalized = normalizeRouterConfig({ ...router, sets: nextSets })
      this.setRouterConfig(normalized)
      this.saveRouterConfig()
      this.markSetCustomized()
      this.broadcast('set_change', { activeSet: this.routerConfig().activeSet, set: name, action: 'reorder', order: order.slice() })
      sendJson(res, 200, { set: normalized.sets[name], router: normalized }, { 'x-request-id': requestId })
      return
    }

    sendError(res, 404, 'Not found', 'invalid_request_error', 'not_found', requestId)
  }

  /**
   * 📖 POST /sets/:name/sync - re-run the probe-based sync-set pipeline
   * 📖 against the named set. The pipeline probes up to `maxProbes` model
   * 📖 candidates with the user's actual API keys and rebuilds the set
   * 📖 with only the ones that come back 2xx. Returns the new set + a
   * 📖 sample of probe results so the UI can show "what changed".
   */
  async handleSyncSetRequest(req, res, requestId, routeUrl = null) {
    // 📖 Same-origin guard hoisted here so the canonical /sets/:name/sync and
    // 📖 the /api/router/sets alias are both covered.
    if (!isSameOriginOrLocal(req)) {
      sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
      return
    }
    const url = routeUrl || (req.url ? new URL(req.url, 'http://localhost') : null)
    const pathname = url ? url.pathname : ''
    const setSyncMatch = pathname.match(/^\/sets\/([^/]+)\/sync$/)
    if (!setSyncMatch) {
      sendError(res, 404, 'Not found', 'invalid_request_error', 'not_found', requestId)
      return
    }
    const setName = decodeURIComponent(setSyncMatch[1])
    try {
      const { syncSet } = await import('./sync-set.js')
      // 📖 Bound the probe budget to 16 so a sync from the Web UI never
      // 📖 takes more than ~60s. The CLI's `free-coding-models --sync-set`
      // 📖 still uses the larger default for the headless sync pipeline.
      const result = await syncSet({ name: setName, activate: true, maxProbes: 16, targetCount: 5 })
      // 📖 sync-set writes to the config file; reload so the daemon's
      // 📖 in-memory router state picks up the new models immediately
      // 📖 instead of waiting for the 10s config-reload tick.
      this.reloadConfigFromDisk()
      this.markSetCustomized()
      this.broadcast('set_change', { activeSet: this.routerConfig().activeSet, set: setName, action: 'sync', count: result.selected?.length || 0 })
      // 📖 Kick a probe burst so the freshly-added models are pinged and
      // 📖 their circuit-breaker state is up to date by the time the UI
      // 📖 re-fetches /api/router/stats.
      void this.runProbeBurst()
      sendJson(res, 200, {
        ok: result.ok !== false,
        name: setName,
        selected: result.selected || [],
        reusedExisting: result.reusedExisting || false,
        probeCount: result.probeResults?.length || 0,
        probeResults: (result.probeResults || []).slice(0, 24),
      }, { 'x-request-id': requestId })
    } catch (err) {
      sendError(res, 500, `Sync failed: ${err?.message || String(err)}`, 'server_error', 'sync_failed', requestId)
    }
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
    this.setRouterConfig({ ...router, probeMode: nextProbeMode })
    this.saveRouterConfig()
    this.scheduleProbeLoop()
    this.broadcast('config', {
      activeSet: this.routerConfig().activeSet,
      old_probe_mode: previousProbeMode,
      probe_mode: nextProbeMode,
    })
    void this.runProbeBurst()
    sendJson(res, 200, {
      ok: true,
      previousProbeMode,
      probeMode: nextProbeMode,
    }, { 'x-request-id': requestId })
  }

  // 📖 Shared admission control for the SSE dashboard streams: same-origin
  // 📖 browsers only, max 10 concurrent streams overall (MAX_SSE_CLIENTS)
  // 📖 and max 5 per single Origin so one tab or origin cannot hog every slot.
  tryOpenSseConnection(req, res, requestId) {
    if (!isSameOriginOrLocal(req)) {
      sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
      return false
    }
    if (this.sseClients.size >= MAX_SSE_CLIENTS) {
      sendError(res, 503, 'Too many dashboard clients', 'service_unavailable', 'too_many_sse_clients', requestId)
      return false
    }
    const originKey = (typeof req.headers.origin === 'string' && req.headers.origin) || 'no-origin'
    const perOrigin = [...this.sseClients].filter((client) => (client.fcmSseOrigin || 'no-origin') === originKey).length
    if (perOrigin >= MAX_SSE_CLIENTS_PER_ORIGIN) {
      sendError(res, 503, 'Too many streams for this origin', 'service_unavailable', 'too_many_sse_clients', requestId)
      return false
    }
    res.fcmSseOrigin = originKey
    return true
  }

  async handleHttp(req, res) {
    // 📖 Clamp client-supplied request ids so a giant header can't bloat
    // 📖 logs, telemetry, and response headers.
    const rawRequestId = req.headers['x-request-id']
    const requestId = typeof rawRequestId === 'string' && rawRequestId.trim()
      ? rawRequestId.trim().slice(0, 64)
      : `req-${randomUUID()}`
    // 📖 DNS-rebinding guard: reject requests whose Host header is not the
    // 📖 loopback (or the configured FCM_HOST) before any routing happens.
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
      // 📖 Runtime telemetry (t3): /stats/runtime returns every model's derived
      // 📖 snapshot (successRate, avgLatencyMs, avgTokensPerSecond, recentCalls).
      // 📖 Useful for the Web Dashboard's runtime cards + the upcoming Shift+W
      // 📖 'Runtime Report' screen in the TUI.
      if (req.method === 'GET' && url.pathname === '/stats/runtime') {
        sendJson(res, 200, {
          ok: true,
          stats: getRuntimeCacheStats(),
          models: getAllRuntimeTelemetry(),
        }, { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && url.pathname === '/stats/tokens') {
        sendJson(res, 200, this.tokenTracker.summary(), { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && url.pathname.startsWith('/stats/tokens/daily/')) {
        const date = decodeURIComponent(url.pathname.replace('/stats/tokens/daily/', ''))
        sendJson(res, 200, { date, usage: this.tokenTracker.stats.daily[date] || null }, { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        // 📖 Optional shared-token auth (FCM_ROUTER_TOKEN) protects every
        // 📖 /v1/* route; with no token configured this is a no-op.
        if (!isAuthorizedForV1(req)) {
          sendError(res, 401, 'Missing or invalid router token', 'invalid_request_error', 'invalid_api_key', requestId)
          return
        }
        const router = this.routerConfig()
        sendJson(res, 200, {
          object: 'list',
          data: [
            { id: 'fcm', object: 'model', owned_by: 'fcm-router' },
            ...Object.keys(router.sets || {}).map((name) => ({ id: `fcm:${name}`, object: 'model', owned_by: 'fcm-router' })),
          ],
        }, { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && url.pathname === '/stream/events') {
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
      if (url.pathname === '/daemon/shutdown' && req.method === 'POST') {
        if (!isSameOriginOrLocal(req)) {
          sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
          return
        }
        sendJson(res, 200, { ok: true, message: 'Daemon shutting down' }, { 'x-request-id': requestId })
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

      // 📖 Docker mode serves the built Web Dashboard directly from the daemon
      // 📖 on :19280. The React app uses the same `/api/router/*` routes as
      // 📖 local dev (`web/server.js`), so the daemon must expose aliases for
      // 📖 its canonical `/health`, `/stats`, and `/sets` APIs instead of
      // 📖 forcing the frontend to special-case Docker.
      if (req.method === 'GET' && url.pathname === '/api/router/status') {
        sendJson(res, 200, this.statusPayload(), { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/router/stats') {
        sendJson(res, 200, this.statsPayload(), { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/router/tokens') {
        sendJson(res, 200, this.tokenTracker.summary(), { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/router/quick-setup') {
        const router = this.routerConfig()
        sendJson(res, 200, {
          running: true,
          port: this.port,
          baseUrl: `http://127.0.0.1:${this.port}/v1`,
          model: 'fcm',
          activeSet: router.activeSet || DEFAULT_ROUTER_SETTINGS.activeSet,
          apiKey: 'not-needed',
        }, { 'x-request-id': requestId })
        return
      }
      if (url.pathname === '/api/router/start') {
        if (req.method !== 'POST') {
          sendError(res, 405, 'Method not allowed', 'invalid_request_error', 'method_not_allowed', requestId, { allowed: ['POST'] })
          return
        }
        if (!isSameOriginOrLocal(req)) {
          sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
          return
        }
        sendJson(res, 200, { ...this.statusPayload(), alreadyRunning: true }, { 'x-request-id': requestId })
        return
      }
      if (url.pathname === '/api/router/stop') {
        if (req.method !== 'POST') {
          sendError(res, 405, 'Method not allowed', 'invalid_request_error', 'method_not_allowed', requestId, { allowed: ['POST'] })
          return
        }
        if (!isSameOriginOrLocal(req)) {
          sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
          return
        }
        sendJson(res, 200, { ok: true, stopped: true, message: 'Daemon shutting down' }, { 'x-request-id': requestId })
        setTimeout(() => this.shutdown(0), 50)
        return
      }
      if (url.pathname === '/api/router/probe-mode' && req.method === 'POST') {
        if (!isSameOriginOrLocal(req)) {
          sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
          return
        }
        await this.handleProbeModeRequest(req, res, requestId)
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/changelog') {
        sendJson(res, 200, loadChangelog(), { 'x-request-id': requestId })
        return
      }
      if (url.pathname === '/api/router/sets' || url.pathname.startsWith('/api/router/sets/')) {
        if (req.method !== 'GET' && !isSameOriginOrLocal(req)) {
          sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
          return
        }
        const aliasedUrl = new URL(req.url, `http://localhost:${this.port}`)
        aliasedUrl.pathname = aliasedUrl.pathname.replace(/^\/api\/router/, '')
        if (/^\/sets\/[^/]+\/sync$/.test(aliasedUrl.pathname) && req.method === 'POST') {
          await this.handleSyncSetRequest(req, res, requestId, aliasedUrl)
          return
        }
        await this.handleSetsRequest(req, res, aliasedUrl, requestId)
        return
      }
      if (url.pathname === '/sets' || url.pathname.startsWith('/sets/')) {
        // 📖 /sets/:name/sync has a different return type (rebuilds the
        // 📖 set from probes) so it gets its own handler.
        if (/^\/sets\/[^/]+\/sync$/.test(url.pathname) && req.method === 'POST') {
          await this.handleSyncSetRequest(req, res, requestId)
          return
        }
        await this.handleSetsRequest(req, res, url, requestId)
        return
      }

      // ─── Web Dashboard API endpoints ───────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/models') {
        sendJson(res, 200, getWebModelsPayload(this), { 'x-request-id': requestId })
        return
      }
      // 📖 Stub endpoints for the web dashboard's hooks (useToolMode, useFavorites,
      // 📖 useUpdateChecker). These were 404 before - minimal shapes that match
      // 📖 what the dashboard hooks expect. See PR #108 for context.
      if (req.method === 'GET' && (url.pathname === '/api/tool-mode')) {
        sendJson(res, 200, { mode: 'opencode', tools: ['opencode', 'openclaw', 'opencode-desktop', 'opencode-web'] }, { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && (url.pathname === '/api/favorites')) {
        const cfg = this.config || {}
        sendJson(res, 200, { favorites: cfg.favorites || [], pinnedAndSticky: Boolean(cfg.settings?.favoritesPinnedAndSticky) }, { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && (url.pathname === '/api/version')) {
        sendJson(res, 200, { local: LOCAL_VERSION, latest: null, lastReleaseDate: null, error: null }, { 'x-request-id': requestId })
        return
      }
      // 📖 /api/router/catalog - lightweight catalog of routeable models for
      // 📖 the Web Router Dashboard's "Add model" picker. Returns one row
      // 📖 per (provider, model) with `key`, label, tier, ctx. We filter to
      // 📖 routeable providers only so the picker never offers a model the
      // 📖 daemon cannot actually proxy.
      if (req.method === 'GET' && url.pathname === '/api/router/catalog') {
        const rows = []
        for (const [providerKey, source] of Object.entries(sources)) {
          if (!isRouteableProvider(providerKey, sources)) continue
          if (!Array.isArray(source.models)) continue
          for (const [modelId, label, tier, sweScore, ctx] of source.models) {
            rows.push({
              key: `${providerKey}/${modelId}`,
              provider: providerKey,
              model: modelId,
              label: label || modelId,
              tier: tier || null,
              sweScore: typeof sweScore === 'number' ? sweScore : null,
              ctx: ctx || null,
              hasKey: !!this.getApiKeyForProvider(providerKey),
            })
          }
        }
        sendJson(res, 200, { models: rows, count: rows.length }, { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        sendJson(res, 200, getWebStatePayload(this), { 'x-request-id': requestId })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        sendJson(res, 200, getWebConfigPayload(this), { 'x-request-id': requestId })
        return
      }
      if (url.pathname === '/api/router/preprompt') {
        // 📖 Pre-prompt lives in `~/.free-coding-models.json` under
        // 📖 `router.prePrompt`. The GET returns the effective value so the
        // 📖 Playground can render it next to the input box, and the PUT
        // 📖 updates the persisted config and triggers a hot reload so the
        // 📖 next proxied request uses the new pre-prompt without restart.
        if (req.method === 'GET') {
          const router = this.routerConfig()
          const fallback = DEFAULT_ROUTER_SETTINGS.prePrompt
          const isDefault = router.prePrompt?.text === fallback.text && router.prePrompt?.enabled === fallback.enabled
          sendJson(res, 200, {
            enabled: router.prePrompt?.enabled === true,
            text: router.prePrompt?.text || '',
            isDefault,
            defaultText: fallback.text,
          }, { 'x-request-id': requestId })
          return
        }
        if (req.method === 'PUT') {
          if (!isSameOriginOrLocal(req)) {
            sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
            return
          }
          const body = await readJsonBody(req)
          const nextEnabled = body?.enabled === true
          const nextText = typeof body?.text === 'string' ? body.text.slice(0, 4000) : ''
          const nextRouter = {
            ...this.routerConfig(),
            prePrompt: { enabled: nextEnabled, text: nextText },
          }
          this.setRouterConfig(nextRouter)
          this.saveRouterConfig()
          this.broadcast('config', { activeSet: this.routerConfig().activeSet, prePrompt: this.routerConfig().prePrompt })
          sendJson(res, 200, {
            ok: true,
            enabled: nextEnabled,
            text: nextText,
            isDefault: nextText === DEFAULT_ROUTER_SETTINGS.prePrompt.text && nextEnabled === DEFAULT_ROUTER_SETTINGS.prePrompt.enabled,
          }, { 'x-request-id': requestId })
          return
        }
        sendError(res, 405, 'Method not allowed', 'invalid_request_error', 'method_not_allowed', requestId, { allowed: ['GET', 'PUT'] })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (!this.tryOpenSseConnection(req, res, requestId)) return
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'x-request-id': requestId,
        })
        res.flushHeaders?.()
        res.write(': connected\n\n')
        res.write(`data: ${JSON.stringify(getWebStatePayload(this))}\n\n`)
        this.sseClients.add(res)
        req.on('close', () => this.sseClients.delete(res))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/activity') {
        sendJson(res, 200, { ok: true }, { 'x-request-id': requestId })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/benchmark') {
        if (!isSameOriginOrLocal(req)) {
          sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
          return
        }
        const body = await readJsonBody(req)
        const providerKey = typeof body.providerKey === 'string' ? body.providerKey : ''
        const modelId = typeof body.modelId === 'string' ? body.modelId : ''
        if (!this.modelCatalog.has(modelKey(providerKey, modelId))) {
          sendJson(res, 404, { error: 'Model not found' }, { 'x-request-id': requestId })
          return
        }
        if (this.webBenchmarkRunning.has(modelKey(providerKey, modelId))) {
          sendJson(res, 409, { error: 'Benchmark already in progress for this model' }, { 'x-request-id': requestId })
          return
        }
        const result = await this.runWebBenchmark(providerKey, modelId)
        sendJson(res, 200, result, { 'x-request-id': requestId })
        return
      }
      if (url.pathname === '/api/global-benchmark') {
        if (!isSameOriginOrLocal(req)) {
          sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
          return
        }
        if (req.method === 'GET') {
          sendJson(res, 200, {
            running: this.webGlobalBenchmarkRunning,
            total: this.webGlobalBenchmarkTotal,
            completed: this.webGlobalBenchmarkCompleted,
          }, { 'x-request-id': requestId })
          return
        }
        if (req.method !== 'POST') {
          sendError(res, 405, 'Method not allowed', 'invalid_request_error', 'method_not_allowed', requestId)
          return
        }
        if (this.webGlobalBenchmarkRunning) {
          sendJson(res, 409, { error: 'Global benchmark already running' }, { 'x-request-id': requestId })
          return
        }
        const body = await readJsonBody(req)
        const result = await this.runWebGlobalBenchmark(body.models)
        sendJson(res, result.started ? 202 : 409, result, { 'x-request-id': requestId })
        return
      }
      if (url.pathname.startsWith('/api/key/')) {
        if (!isSameOriginOrLocal(req)) {
          sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
          return
        }
        const testMatch = url.pathname.match(/^\/api\/key\/([^/]+)\/test$/)
        if (testMatch && req.method === 'POST') {
          const providerKey = decodeURIComponent(testMatch[1])
          if (!sources[providerKey]) {
            sendError(res, 404, 'Unknown provider', 'invalid_request_error', 'unknown_provider', requestId)
            return
          }
          const apiKey = this.getApiKeyForProvider(providerKey)
          if (!apiKey) {
            sendJson(res, 200, { outcome: 'missing_key', detail: `${providerKey} has no saved API key.` }, { 'x-request-id': requestId })
            return
          }
          const providerModels = sources[providerKey]?.models || []
          const modelId = providerModels[0]?.[0] || ''
          try {
            const result = await ping(apiKey, modelId, providerKey, sources[providerKey].url)
            const code = result?.code
            if (code === '200') {
              sendJson(res, 200, { outcome: 'ok', code: 200 }, { 'x-request-id': requestId })
            } else if (code === '401' || code === '403') {
              sendJson(res, 200, { outcome: 'auth_error', code: Number(code) || code }, { 'x-request-id': requestId })
            } else {
              sendJson(res, 200, { outcome: 'fail', code: code ?? 'ERR', detail: 'Probe did not return a 2xx' }, { 'x-request-id': requestId })
            }
          } catch (err) {
            sendJson(res, 200, { outcome: 'fail', detail: err.message || 'Probe failed' }, { 'x-request-id': requestId })
          }
          return
        }
        if (req.method === 'GET') {
          const providerKey = decodeURIComponent(url.pathname.slice('/api/key/'.length))
          if (!providerKey || !sources[providerKey]) {
            sendError(res, 404, 'Unknown provider', 'invalid_request_error', 'unknown_provider', requestId)
            return
          }
          // 📖 Never return the raw key over HTTP: only the masked form the
          // 📖 dashboard already displays, plus a hasKey flag for UI state.
          const rawKey = this.getApiKeyForProvider(providerKey)
          sendJson(res, 200, { key: rawKey ? maskApiKey(rawKey) : null, hasKey: Boolean(rawKey) }, { 'x-request-id': requestId })
          return
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        // 📖 Writes API keys + provider toggles - same-origin only to block
        // 📖 CSRF-style writes from malicious browser tabs.
        if (!isSameOriginOrLocal(req)) {
          sendError(res, 403, 'Forbidden cross-origin request', 'invalid_request_error', 'forbidden_origin', requestId)
          return
        }
        const body = await readJsonBody(req)
        if (body.apiKeys) {
          for (const [key, value] of Object.entries(body.apiKeys)) {
            if (value) {
              if (!this.config.apiKeys) this.config.apiKeys = {}
              this.config.apiKeys[key] = value
            } else {
              if (this.config.apiKeys) delete this.config.apiKeys[key]
            }
          }
        }
        if (body.providers) {
          for (const [key, value] of Object.entries(body.providers)) {
            if (!this.config.providers) this.config.providers = {}
            if (!this.config.providers[key]) this.config.providers[key] = {}
            this.config.providers[key].enabled = value.enabled !== false
          }
        }
        try {
          saveConfig(this.config)
        } catch (err) {
          sendError(res, 500, 'Failed to save config: ' + err.message, 'server_error', 'config_save_failed', requestId)
          return
        }
        if (body.apiKeys) {
          for (const pk of Object.keys(body.apiKeys)) {
            if (typeof pk !== 'string' || !pk) continue
            const newModel = this.findBestModelForProviderInSources(pk)
            if (!newModel) continue
            const router = this.routerConfig()
            if (!router.activeSet) continue
            const activeSetData = router.sets?.[router.activeSet]
            if (!activeSetData || activeSetData.models?.some((m) => m.provider === pk)) continue
            const nextModels = [
              ...(activeSetData.models || []),
              { provider: pk, model: newModel, priority: (activeSetData.models?.length || 0) + 1 },
            ]
            this.setRouterConfig({
              ...router,
              sets: { ...router.sets, [router.activeSet]: { ...activeSetData, models: nextModels } },
            })
          }
          void this.runProbeBurst()
        }
        sendJson(res, 200, { success: true }, { 'x-request-id': requestId })
        return
      }

      // ─── Static file serving for web dashboard ────────────────────────────────
      if (req.method === 'GET' && (
        url.pathname === '/' || url.pathname === '/index.html' ||
        url.pathname === '/styles.css' || url.pathname === '/app.js' ||
        url.pathname.startsWith('/assets/') ||
        url.pathname.endsWith('.js') || url.pathname.endsWith('.css') ||
        url.pathname.endsWith('.svg') || url.pathname.endsWith('.png') ||
        url.pathname.endsWith('.ico')
      )) {
        serveWebStaticFile(res, url.pathname, requestId)
        return
      }
      if (url.pathname === '/v1/chat/completions' || url.pathname.match(/^\/v1\/sets\/[^/]+\/chat\/completions$/)) {
        if (req.method !== 'POST') {
          sendError(res, 405, 'Method not allowed', 'invalid_request_error', 'method_not_allowed', requestId, { allowed: ['POST'] })
          return
        }
        // 📖 Optional shared-token auth (FCM_ROUTER_TOKEN) protects every
        // 📖 /v1/* route; with no token configured this is a no-op.
        if (!isAuthorizedForV1(req)) {
          sendError(res, 401, 'Missing or invalid router token', 'invalid_request_error', 'invalid_api_key', requestId)
          return
        }
        const setMatch = url.pathname.match(/^\/v1\/sets\/([^/]+)\/chat\/completions$/)
        const body = await readJsonBody(req)
        await this.routeRequest({ req, res, body, setName: setMatch ? decodeURIComponent(setMatch[1]) : null, requestId })
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
      this.logger.error('Internal router error', { request_id: requestId, error: error?.stack || error?.message || String(error) })
      this.recordRouterError('internal_router_error', requestId, { message: error?.message || String(error) })
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
      if (this.uncaughtTimestamps.length >= 10) {
        this.logger.error('Too many uncaught exceptions; shutting down for external restart')
        void sendUsageTelemetry(this.config, {}, {
          event: 'app_router_self_restart',
          mode: 'daemon',
          properties: {
            uncaught_count: this.uncaughtTimestamps.length,
            uptime_before_restart: Math.floor((Date.now() - this.startedAt) / 1000),
            strategy: 'exit_for_service_restart',
          },
        })
        void this.shutdown(1)
      }
    })
    process.on('unhandledRejection', (reason) => {
      this.crashRecovered += 1
      this.uncaughtTimestamps.push(Date.now())
      this.uncaughtTimestamps = this.uncaughtTimestamps.filter((ts) => Date.now() - ts < 5 * 60 * 1000)
      this.logger.error('Recovered unhandled rejection', { error: reason?.stack || String(reason) })
      if (this.uncaughtTimestamps.length >= 10) {
        this.logger.error('Too many uncaught exceptions/rejections; shutting down for external restart')
        void this.shutdown(1)
      }
    })
    process.on('SIGTERM', () => void this.shutdown(0))
    process.on('SIGINT', () => void this.shutdown(0))
    process.on('SIGHUP', () => this.reloadConfigFromDisk())
  }

  async shutdown(exitCode = 0) {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.logger.info('Router daemon stopping')
    if (this.probeTimer) clearInterval(this.probeTimer)
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
    flushProbeCache()  // 📖 t1: persist any pending probe-cache deltas before exit
    if (this.runtimeTelemetryDirty) flushRuntimeTelemetryStore()  // 📖 t3
    try { this.server?.close() } catch {}
    try { unlinkSync(getRouterPidPath()) } catch {}
    try { unlinkSync(getRouterPortPath()) } catch {}
    void sendUsageTelemetry(this.config, {}, {
      event: 'app_daemon_stop',
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

// 📖 Pinned picks: only used as a *tie-breaker* when multiple models have
// 📖 identical (tier, sweScore, latency) - never a hard requirement, so
// 📖 a user whose NVIDIA key is dead still gets a working set.
const PREFERRED_DEFAULT_MODELS = [
  { provider: 'groq',     model: 'openai/gpt-oss-120b' },
  { provider: 'groq',     model: 'qwen/qwen3.6-27b' },
  { provider: 'cerebras', model: 'llama3.1-70b' },
  { provider: 'nvidia',   model: 'deepseek-ai/deepseek-v4-flash-0731' },
  { provider: 'cerebras', model: 'qwen-3-235b-a7b' },
  { provider: 'nvidia',   model: 'openai/gpt-oss-120b' },
  { provider: 'groq',     model: 'openai/gpt-oss-20b' },
  { provider: 'nvidia',   model: 'minimaxai/minimax-m2.7' },
]

/**
 * 📖 buildDefaultRouterSet picks the first-time set the daemon creates when
 * 📖 the user has no router config yet. The new behavior is *probe-driven*:
 * 📖 every candidate model is sent a real chat-completion ping (1 token)
 * 📖 against the user's actual API key. Models that come back 2xx with a
 * 📖 reasonable latency go to the top of the list. Models that auth-fail,
 * 📖 timeout, or 5xx are de-prioritized so a new user with a half-broken
 * 📖 key set still gets a working default.
 *
 * 📖 The probe runs sequentially with a short timeout (1.5s per model) and
 * 📖 is bounded to ~24 candidates so first-time start stays snappy. If no
 * 📖 probe fn is provided (e.g. in unit tests) we fall back to the static
 * 📖 tier-based ordering from the old logic.
 *
 * @param {object} config
 * @param {number} maxModels
 * @param {object} [options] { probeFn: async (entry) => ({ ok, latencyMs, code }) }
 * @returns {{ name: string, models: Array, created: string }}
 */
export async function buildDefaultRouterSet(config = {}, maxModels, options = {}) {
  const probeFn = typeof options.probeFn === 'function' ? options.probeFn : null
  const probeTimeoutMs = typeof options.probeTimeoutMs === 'number' ? options.probeTimeoutMs : 1500
  const probeBudget = typeof options.probeBudget === 'number' ? options.probeBudget : 24

  const keyedProviders = new Set(Object.entries(config.apiKeys || {})
    .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim()))
    .map(([provider]) => provider))

  // 📖 Scale default set size with configured providers so users with many
  // 📖 keys get a richer default router set (PR #108 idea, kept from the
  // 📖 previous sync version).
  if (maxModels === undefined) maxModels = Math.max(5, keyedProviders.size * 2)
  const entries = []
  for (const [providerKey, source] of Object.entries(sources)) {
    if (!isRouteableProvider(providerKey, sources)) continue
    for (const [model, label, tier, sweScore, ctx] of source.models || []) {
      entries.push({
        provider: providerKey,
        model,
        label,
        tier,
        sweScore,
        ctx,
        hasKey: keyedProviders.has(providerKey),
      })
    }
  }

  // 📖 Tier rank for sorting (lower index = better).
  const tierRank = (tier) => {
    const idx = TIER_ORDER.indexOf(tier)
    return idx === -1 ? TIER_ORDER.length : idx
  }

  // 📖 Static fallback ordering (the pre-probe behavior). Used when no probe
  // 📖 fn is supplied OR when the probe returns no successful candidates.
  const staticOrder = (a, b) => {
    if (a.hasKey !== b.hasKey) return a.hasKey ? -1 : 1
    const tierCmp = tierRank(a.tier) - tierRank(b.tier)
    if (tierCmp !== 0) return tierCmp
    const sweA = Number.parseFloat(a.sweScore) || 0
    const sweB = Number.parseFloat(b.sweScore) || 0
    return sweB - sweA
  }

  // 📖 Probe each candidate when a probe fn is available. Successful +
  // 📖 fast probes are pinned to the top; failed probes fall back to the
  // 📖 static ordering so the user is never left with an empty set.
  let probeResults = new Map()
  if (probeFn) {
    const candidates = entries
      .filter((e) => e.hasKey)
      .sort(staticOrder)
      .slice(0, probeBudget)
    const results = await Promise.all(candidates.map(async (entry) => {
      try {
        const result = await Promise.race([
          probeFn(entry),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: 'TIMEOUT', latencyMs: probeTimeoutMs }), probeTimeoutMs)),
        ])
        return { entry, result: result || { ok: false, code: 'NO_RESULT' } }
      } catch (err) {
        return { entry, result: { ok: false, code: 'ERR', error: err?.message || String(err) } }
      }
    }))
    for (const { entry, result } of results) {
      probeResults.set(`${entry.provider}/${entry.model}`, result)
    }
  }

  const probeScore = (entry) => {
    const result = probeResults.get(`${entry.provider}/${entry.model}`)
    if (!result) return null
    if (result.ok !== true) return null
    const latency = Number.isFinite(result.latencyMs) ? result.latencyMs : 9999
    // 📖 Higher is better: tier weight + speed bonus. We use tier rank to
    // 📖 make sure S+ and S still outrank A even when A is faster.
    const tierWeight = (TIER_ORDER.length - tierRank(entry.tier)) * 1000
    const speedBonus = Math.max(0, 5000 - latency)
    return tierWeight + speedBonus
  }

  const working = entries
    .map((entry) => ({ entry, score: probeScore(entry) }))
    .filter((x) => x.score != null)
    .sort((a, b) => b.score - a.score)

  const failing = entries
    .filter((e) => !probeResults.has(`${e.provider}/${e.model}`) || probeScore(e) == null)
    .sort(staticOrder)

  // 📖 Build the final order: proven-working models first, then the static
  // 📖 fallback, then pinned popular models as a safety net so the user
  // 📖 always sees a populated set on first start.
  // 📖 When no probeFn is available AND the user has keys, fall back to the
  // 📖 sync behaviour (keyed providers only) so we don't leak models the
  // 📖 user can't actually call.
  const fallbackPool = (probeFn == null && keyedProviders.size > 0)
    ? entries.filter((e) => e.hasKey)
    : entries
  const used = new Set()
  const ordered = []
  for (const { entry } of working) {
    const key = `${entry.provider}/${entry.model}`
    if (used.has(key)) continue
    used.add(key)
    ordered.push(entry)
  }
  for (const entry of failing) {
    if (!fallbackPool.includes(entry)) continue
    const key = `${entry.provider}/${entry.model}`
    if (used.has(key)) continue
    used.add(key)
    ordered.push(entry)
  }
  for (const pref of PREFERRED_DEFAULT_MODELS) {
    const key = `${pref.provider}/${pref.model}`
    if (used.has(key)) continue
    const idx = ordered.findIndex((e) => e.provider === pref.provider && e.model === pref.model)
    if (idx >= 0) {
      const [picked] = ordered.splice(idx, 1)
      used.add(key)
      ordered.push(picked)
    }
  }

  return {
    name: DEFAULT_ROUTER_SETTINGS.activeSet,
    models: ordered.slice(0, Math.max(1, maxModels)).map((entry, index) => ({
      provider: entry.provider,
      model: entry.model,
      priority: index + 1,
    })),
    created: nowIso(),
  }
}

export function createRouterRuntimeForTest({ config, port = 0, logger = null, tokenPath = ROUTER_TOKENS_PATH } = {}) {
  const testLogger = logger || {
    level: 'error',
    error() {},
    warn() {},
    info() {},
    debug() {},
  }
  // 📖 Tests use this factory to exercise the real HTTP router against local
  // 📖 fake providers without spawning a daemon or touching user token files.
  // 📖 Router config persistence is disabled here so set/probe-mode endpoint
  // 📖 tests cannot write fixture router sets into ~/.free-coding-models.json.
  return new RouterRuntime({
    config: config || {},
    port,
    logger: testLogger,
    tokenPath,
    persistConfig: false,
  })
}

/**
 * 📖 createDefaultProbeFn - used by buildDefaultRouterSet to find models
 * 📖 that actually work with the user's API keys. Returns an async probe
 * 📖 `(entry) => { ok, latencyMs, code }` that posts a 1-token chat-
 * 📖 completion to the provider's URL and treats 2xx as "working".
 *
 * 📖 This is what powers the M5 "default to working models" promise: a new
 * 📖 user with a half-broken key set still gets a default router set made
 * 📖 of models that come back 200, instead of a list of pinned NVIDIA
 * 📖 models that all 401.
 *
 * 📖 The probe is best-effort: it never throws, it just times out after
 * 📖 `probeTimeoutMs` and the caller treats timeouts as a failed probe.
 *
 * @returns {(entry: { provider: string, model: string }) => Promise<{ ok: boolean, code: string|number, latencyMs: number }>}
 */
function createDefaultProbeFn(apiKeys) {
  return async (entry) => {
    const { provider, model } = entry
    if (!isRouteableProvider(provider, sources)) return { ok: false, code: 'NOT_ROUTEABLE', latencyMs: 0 }
    const url = resolveProviderUrl(provider)
    if (!url) return { ok: false, code: 'NO_URL', latencyMs: 0 }
    const apiKey = getApiKey({ apiKeys: apiKeys || {} }, provider) || ''
    if (!apiKey) return { ok: false, code: 'NO_KEY', latencyMs: 0 }
    const apiModelId = provider === 'zai' ? model.replace(/^zai\//, '') : model
    const probeBody = buildChatCompletionPingBody(apiModelId, {}, {
      disableThinking: !disabledThinkingUnsupportedProviders.has(provider),
    })
    const headers = { 'Content-Type': 'application/json' }
    if (provider === 'cloudflare') {
      // 📖 Cloudflare uses account_id in the URL - resolveCloudflareUrl is
      // 📖 already imported. We just need the standard Bearer header.
      headers.Authorization = `Bearer ${apiKey}`
    } else if (provider === 'replicate') {
      headers.Authorization = `Token ${apiKey}`
      headers.Prefer = 'wait=4'
    } else {
      headers.Authorization = `Bearer ${apiKey}`
      if (provider === 'openrouter' || provider === 'orcarouter') {
        headers['HTTP-Referer'] = 'https://github.com/vava-nessa/free-coding-models'
        headers['X-Title'] = 'free-coding-models'
      }
    }
    const started = Date.now()
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1500)
      const resp = await fetch(resolveProviderUrl(provider) || url, {
        method: 'POST',
        headers,
        body: JSON.stringify(probeBody),
        signal: controller.signal,
      })
      clearTimeout(timer)
      const latencyMs = Date.now() - started
      const code = resp.status
      return { ok: resp.ok, code, latencyMs }
    } catch (err) {
      return { ok: false, code: err?.name === 'AbortError' ? 'TIMEOUT' : 'ERR', latencyMs: Date.now() - started, error: err?.message }
    }
  }
}

function buildDefaultRouterSetSync(config = {}, maxModels = 5) {
  // 📖 Synchronous fallback used when async probing isn't available (e.g.
  // 📖 routerConfig() getter, which is on the hot path). Falls back to the
  // 📖 static tier-based ordering. The async probed version is the one
  // 📖 used at first daemon start; this sync version exists so the router
  // 📖 still works even before the probe completes.
  const keyedProviders = new Set(Object.entries(config.apiKeys || {})
    .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim()))
    .map(([provider]) => provider))
  const entries = []
  for (const [providerKey, source] of Object.entries(sources)) {
    if (!isRouteableProvider(providerKey, sources)) continue
    for (const [model, label, tier, sweScore, ctx] of source.models || []) {
      entries.push({ provider: providerKey, model, label, tier, sweScore, ctx, hasKey: keyedProviders.has(providerKey) })
    }
  }
  const preferred = entries.some((e) => e.hasKey) ? entries.filter((e) => e.hasKey) : entries
  const pinned = []
  const allRemaining = [...entries]
  for (const pref of PREFERRED_DEFAULT_MODELS) {
    const idx = allRemaining.findIndex((e) => e.provider === pref.provider && e.model === pref.model)
    if (idx >= 0) pinned.push(allRemaining.splice(idx, 1)[0])
  }
  const remaining = preferred.filter((e) => !pinned.some((p) => p.provider === e.provider && p.model === e.model))
  remaining.sort((a, b) => {
    const tierCmp = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
    if (tierCmp !== 0) return tierCmp
    const sweA = Number.parseFloat(a.sweScore) || 0
    const sweB = Number.parseFloat(b.sweScore) || 0
    return sweB - sweA
  })
  const ordered = [...pinned, ...remaining]
  return {
    name: DEFAULT_ROUTER_SETTINGS.activeSet,
    models: ordered.slice(0, maxModels).map((entry, index) => ({
      provider: entry.provider,
      model: entry.model,
      priority: index + 1,
    })),
    created: nowIso(),
  }
}

async function ensureRouterConfigForDaemon(config, skipSave = false) {
  // 📖 Preserve existing named sets (e.g., created by sync-set) to avoid overwriting
  // 📖 user-created configurations. Only rebuild from favorites/defaults when no
  // 📖 sets exist at all (fresh install).
  const existingSets = config.router?.sets || {}
  const existingActiveSet = config.router?.activeSet || DEFAULT_ROUTER_SETTINGS.activeSet
  const existingSetData = existingSets[existingActiveSet]
  const hasExistingNamedSet = existingSetData && Array.isArray(existingSetData.models) && existingSetData.models.length > 0

  let activeSet
  if (hasExistingNamedSet) {
    activeSet = { name: existingActiveSet, models: existingSetData.models, created: existingSetData.created }
  } else {
    const favSet = buildRouterSetFromFavorites(config)
    // 📖 The async probed version of buildDefaultRouterSet is preferred;
    // 📖 on failure it falls back to the sync static ordering.
    try {
      activeSet = favSet || await buildDefaultRouterSet(config, 5, {
        probeFn: createDefaultProbeFn(config.apiKeys || {}),
        probeTimeoutMs: 1500,
        probeBudget: 24,
      })
    } catch {
      activeSet = favSet || buildDefaultRouterSetSync(config)
    }
  }
  config.router = normalizeRouterConfig({
    ...DEFAULT_ROUTER_SETTINGS,
    enabled: true,
    onboardingSeen: true,
    activeSet: activeSet.name,
    sets: { [activeSet.name]: activeSet },
  })
  if (!skipSave) saveConfig(config)
  return config.router
}

/**
 * 📖 Build a router set from the user's favorites list.
 * 📖 Each favorite "providerKey/modelId" is resolved to its source model entry.
 * 📖 Falls back to buildDefaultRouterSet if no favorites exist.
 */
function buildRouterSetFromFavorites(config) {
  const favorites = config.favorites
  if (!Array.isArray(favorites) || favorites.length === 0) return null
  const models = []
  for (let i = 0; i < favorites.length; i++) {
    const fav = favorites[i]
    const slashIdx = fav.indexOf('/')
    if (slashIdx < 0) continue
    const providerKey = fav.slice(0, slashIdx)
    const modelId = fav.slice(slashIdx + 1)
    if (!isRouteableProvider(providerKey, sources)) continue
    const source = sources[providerKey]
    if (!source) continue
    const found = (source.models || []).find((m) => m[0] === modelId)
    if (!found) {
      models.push({ provider: providerKey, model: modelId, priority: i + 1 })
      continue
    }
    models.push({ provider: providerKey, model: found[0], priority: i + 1 })
  }
  if (models.length === 0) return null
  return {
    name: DEFAULT_ROUTER_SETTINGS.activeSet,
    models,
    created: nowIso(),
  }
}

function listenOnPort(server, port, host = '127.0.0.1') {
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

async function listenWithFallback(server, preferredPort, logger, host = '127.0.0.1') {
  const { defaultPort, maxPort } = getRouterPortRange()
  const start = Math.max(1, preferredPort || defaultPort)
  const candidates = []
  for (let port = start; port <= maxPort; port += 1) candidates.push(port)
  if (!candidates.includes(defaultPort)) {
    for (let port = defaultPort; port <= maxPort; port += 1) candidates.push(port)
  }
  let lastError = null
  for (const port of candidates) {
    try {
      await listenOnPort(server, port, host)
      return port
    } catch (error) {
      lastError = error
      logger.warn(`Port ${port} unavailable`, { error: error.code || error.message })
    }
  }
  throw lastError || new Error('No router ports available')
}

export async function runRouterDaemon() {
  const config = loadConfig()
  const router = await ensureRouterConfigForDaemon(config)
  // 📖 In dev mode, override the saved port with the dev default so a local
  // 📖 checkout doesn't clash with a production install on the same machine.
  // 📖 The saved config has port: 19280 (production); dev should use 29280.
  const { defaultPort: devDefault } = getRouterPortRange()
  if (_dev && router.port !== devDefault && router.port === DEFAULT_ROUTER_SETTINGS.port) {
    router.port = devDefault
  }
  const logger = new RouterLogger(ROUTER_LOG_PATH, router.logLevel)
  const runtime = new RouterRuntime({ config, port: router.port, logger })
  runtime.installProcessSafety()
  const server = createServer((req, res) => void runtime.handleHttp(req, res))
  runtime.server = server
  const host = process.env.FCM_HOST || '127.0.0.1'
  const port = await listenWithFallback(server, router.port, logger, host)
  runtime.port = port
  // 📖 Remember the bind host so the Host-header guard knows which non-loopback
  // 📖 hostname (if any) is legitimately allowed to talk to the daemon.
  runtime.boundHost = host
  runtime.config.router.port = port
  saveConfig(runtime.config)
  try { writeFileSync(ROUTER_PID_PATH, String(process.pid), { mode: 0o600 }) } catch (error) { logger.warn('PID file write failed', { error: error.message }) }
  try { writeFileSync(ROUTER_PORT_PATH, String(port), { mode: 0o600 }) } catch (error) { logger.warn('Port file write failed', { error: error.message }) }
  logger.info('Router daemon started', { pid: process.pid, port, host, activeSet: runtime.routerConfig().activeSet })
  // 📖 One-time LAN warning: non-loopback binds are only useful when the
  // 📖 origin guard knows which origins to trust, so point the user at
  // 📖 FCM_ALLOWED_ORIGINS (comma-separated, e.g. "http://mybox:19280").
  if (!isLoopbackHostname(host) && !(process.env.FCM_ALLOWED_ORIGINS || '').trim()) {
    logger.warn('FCM_HOST is bound to a non-loopback address. Cross-machine browsers will be blocked unless you set FCM_ALLOWED_ORIGINS to your dashboard origin (e.g. "http://192.168.1.10:19280"). Loopback and same-origin clients keep working.')
  }
  void sendUsageTelemetry(runtime.config, {}, {
    event: 'app_daemon_start',
    mode: 'daemon',
    properties: {
      port,
      set_count: Object.keys(runtime.routerConfig().sets || {}).length,
      models_in_active_set: runtime.getSet()?.models?.length || 0,
      auto_start: false,
      probe_mode: runtime.routerConfig().probeMode,
    },
  })
  runtime.configReloadTimer = setInterval(() => runtime.reloadConfigFromDisk(), CONFIG_RELOAD_INTERVAL_MS)
  runtime.tokenFlushTimer = setInterval(() => runtime.tokenTracker.flush(), TOKEN_FLUSH_INTERVAL_MS)
  void runtime.runProbeBurst()
  runtime.scheduleProbeLoop()
  // 📖 Auto-heal: wait for the first probe burst to populate health data,
  // 📖 then swap any broken models (AUTH_ERROR / STALE) for working
  // 📖 alternatives. This is the M6 promise: the Playground and Router
  // 📖 Dashboard both start with a usable set by default. The user can
  // 📖 disable auto-heal by editing the active set (the first manual edit
  // 📖 sets `router.userCustomized = true` and auto-heal becomes a no-op).
  // 📖 We run two passes: one after the initial probe (8s) and another
  // 📖 after the replacement models have been probed too (24s). This
  // 📖 handles the case where the first replacement is itself broken
  // 📖 (e.g. a different model of a provider whose key is dead).
  void (async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 8000))
      const first = await runtime.autoHealActiveSet()
      if (first?.ok && first.replaced > 0) {
        // 📖 Re-probe the new set, wait for the probes to land, then
        // 📖 check again in case the first replacement was also broken.
        void runtime.runProbeBurst()
        await new Promise((resolve) => setTimeout(resolve, 16000))
        const second = await runtime.autoHealActiveSet()
        if (second?.ok && second.replaced > 0) {
          void runtime.runProbeBurst()
        }
      }
    } catch (err) {
      runtime.logger.warn('autoHeal failed', { error: err?.message || String(err) })
    }
  })()
  return runtime
}

export async function getRouterDaemonStatus() {
  const { defaultPort, maxPort } = getRouterPortRange()
  const ports = []
  // 📖 Use the dynamic path resolvers so dev checkouts (FCM_DEV=1) read the
  // 📖 `-dev` port/pid files and discover the dev daemon. The static constants
  // 📖 are frozen at module load and would always point at the production files.
  const portPath = getRouterPortPath()
  const pidPath = getRouterPidPath()
  const recordedPort = readNumberFile(portPath)
  if (recordedPort) ports.push(recordedPort)
  for (let port = defaultPort; port <= maxPort; port += 1) {
    if (!ports.includes(port)) ports.push(port)
  }
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return await response.json()
    } catch {
      // 📖 Keep scanning the small discovery range.
    }
  }
  const pid = readNumberFile(pidPath)
  return {
    ok: false,
    running: false,
    stalePid: pid && !isProcessAlive(pid) ? pid : null,
    pid: pid || null,
    port: recordedPort || null,
  }
}

export async function startRouterDaemonBackground() {
  const existing = await getRouterDaemonStatus()
  if (existing.ok) {
    if (existing.version && existing.version !== LOCAL_VERSION) {
      await stopRouterDaemon()
    } else {
      return { ...existing, alreadyRunning: true }
    }
  }

  const child = fork(CLI_ENTRY_PATH, ['--daemon'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  for (let i = 0; i < 40; i += 1) {
    await sleep(250)
    const status = await getRouterDaemonStatus()
    if (status.ok) return { ...status, alreadyRunning: false }
  }
  return { ok: false, running: false, pid: child.pid, error: 'Daemon did not become healthy before timeout' }
}

// 📖 Best-effort process command lookup used to verify a PID file before
// 📖 signalling. Returns null when `ps` is unavailable (e.g. Windows) so the
// 📖 caller can keep the previous behavior instead of failing hard.
function getProcessCommand(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

export async function stopRouterDaemon() {
  const pidPath = getRouterPidPath()
  let pid = readNumberFile(pidPath)

  // 📖 Fallback: if the PID file is missing or invalid, try to discover the
  // 📖 running daemon via its health port and get the PID from there.
  if (!pid) {
    const status = await getRouterDaemonStatus()
    if (status.ok && status.pid) pid = status.pid
  }

  if (!pid) return { ok: false, stopped: false, error: 'No daemon PID found' }
  if (!isProcessAlive(pid)) {
    try { unlinkSync(pidPath) } catch {}
    return { ok: true, stopped: false, stalePid: pid }
  }
  // 📖 Safety: only SIGTERM processes whose command line names this CLI. A
  // 📖 stale or corrupted PID file could otherwise kill an unrelated process.
  // 📖 When the platform has no `ps`, skip verification rather than breaking.
  const command = getProcessCommand(pid)
  if (command !== null && !command.includes('free-coding-models')) {
    console.warn(`⚠️  PID ${pid} does not look like a free-coding-models process (${command || 'unknown command'}); not signalling`)
    return { ok: false, stopped: false, pid, error: `PID ${pid} is not a free-coding-models process` }
  }
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 60; i += 1) {
    await sleep(250)
    if (!isProcessAlive(pid)) {
      try { unlinkSync(pidPath) } catch {}
      return { ok: true, stopped: true, pid }
    }
  }
  return { ok: false, stopped: false, pid, error: 'Daemon did not stop before timeout' }
}

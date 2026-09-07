/**
 * @file router-v2/tui-dashboard.js
 * @description TUI client + renderer for the Router v2 (BETA) dashboard overlay.
 *
 * @details
 *   📖 Open with Shift+V. This overlay talks to the v2 daemon (own port
 *   range, own state files) and renders what v1's dashboard could not:
 *   - model states including DEGRADED (amber: failing, not yet tripped) and
 *     QUOTA_PAUSED (with expiry),
 *   - the per-request fallback chain (which model was tried, what it returned
 *     with, what was skipped and why) straight from the persisted history,
 *   - a live "test via router" action that sends ONE real chat completion
 *     through the daemon with a pinned model (`fcm:@provider/model`), so the
 *     test exercises normalization + pre-prompt + content gate + failover,
 *     unlike the direct-to-provider benchmarks.
 *
 *   📖 Same defensive posture as the v1 dashboard: the daemon may be stopped,
 *   stale or mid-restart; every fetch failure degrades to a status label,
 *   never a thrown exception into the render loop.
 *
 * @functions
 *   → openRouterV2DashboardOverlay(state) - Open + start polling/SSE
 *   → closeRouterV2DashboardOverlay(state) - Close + stop I/O
 *   → refreshRouterV2Snapshot(state, opts) - Fetch /health + /stats + /history
 *   → startRouterV2Polling / startRouterV2EventStream / stopRouterV2DashboardClient
 *   → testModelViaRouterV2(state, modelKeyStr) - One pinned-model test
 *   → testAllVisibleViaRouterV2(state) - Test every visible model (pooled)
 *   → renderRouterV2Dashboard(state) - Full-screen overlay renderer
 *
 * @exports ROUTER_V2_DASHBOARD_POLL_INTERVAL_MS, openRouterV2DashboardOverlay
 * @exports closeRouterV2DashboardOverlay, refreshRouterV2Snapshot
 * @exports startRouterV2Polling, startRouterV2EventStream, stopRouterV2DashboardClient
 * @exports testModelViaRouterV2, testAllVisibleViaRouterV2, renderRouterV2Dashboard
 * @exports setRouterV2Notice, cycleRouterV2ProbeMode
 *
 * @see ../tui/key-handler.js - Shift+V / Ctrl+T / Ctrl+Shift+T bindings
 * @see ./daemon.js - v2 daemon endpoints consumed by this screen
 */

import chalk from 'chalk'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { displayWidth, padEndDisplay, sliceOverlayLines, tintOverlayLines } from '../../tui/render-helpers.js'
import { themeColors } from '../../tui/theme.js'
import { formatTokenTotalCompact } from '../token-usage-reader.js'
import { parseFcmModel } from './constants.js'
import { discoverRouterV2Port, testModelViaRouter, testSetViaRouter } from './bench.js'
// 📖 After the merge, the v2 engine lives in the MAIN router daemon: all
// discovery and lifecycle calls target the historical daemon paths/ports.
import { getRouterPidPath, getRouterPortPath, getRouterPortRange } from '../router-daemon.js'

export const ROUTER_V2_DASHBOARD_POLL_INTERVAL_MS = 2000
export const ROUTER_V2_DASHBOARD_FETCH_TIMEOUT_MS = 1500
export const ROUTER_V2_PROBE_MODE_CYCLE = ['eco', 'balanced', 'aggressive']
export const ROUTER_V2_TEST_CONCURRENCY = 3

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toFiniteNumber(value, fallback = null) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function makeTimeoutController(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  if (typeof timer.unref === 'function') timer.unref()
  return { controller, cleanup: () => clearTimeout(timer) }
}

async function fetchJsonV2(url, options = {}) {
  const { controller, cleanup } = makeTimeoutController(options.timeoutMs || ROUTER_V2_DASHBOARD_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const text = await response.text()
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      return { ok: false, status: response.status, data: null, error: 'Malformed JSON from daemon' }
    }
    if (!response.ok) return { ok: false, status: response.status, data, error: `HTTP ${response.status}` }
    return { ok: true, status: response.status, data, error: null }
  } catch (error) {
    return { ok: false, status: 0, data: null, error: error?.name === 'AbortError' ? 'timeout' : (error?.message || String(error)) }
  } finally {
    cleanup()
  }
}

function readV2DaemonFiles() {
  const pidPath = getRouterPidPath()
  const portPath = getRouterPortPath()
  return {
    hasPidFile: existsSync(pidPath),
    hasPortFile: existsSync(portPath),
    pid: readNumberFileSafe(pidPath),
    recordedPort: readNumberFileSafe(portPath),
  }
}

function readNumberFileSafe(path) {
  try {
    const value = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

async function discoverRouterV2Dashboard(state, fetchFn = globalThis.fetch) {
  const recordedPort = readNumberFileSafe(getRouterPortPath())
  const candidates = []
  if (recordedPort) candidates.push(recordedPort)
  const { defaultPort, maxPort } = getRouterPortRange()
  for (let port = defaultPort; port <= maxPort; port += 1) {
    if (!candidates.includes(port)) candidates.push(port)
  }
  for (const port of candidates) {
    try {
      const { controller, cleanup } = makeTimeoutController(ROUTER_V2_DASHBOARD_FETCH_TIMEOUT_MS)
      try {
        const response = await fetchFn(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
        if (response.ok) {
          const health = await response.json()
          return { baseUrl: `http://127.0.0.1:${port}`, port, health, error: null }
        }
      } finally {
        cleanup()
      }
    } catch (error) {
      if (state.terminalCols === -1) return { baseUrl: null, port, health: null, error: error?.message }
    }
  }
  const files = readV2DaemonFiles()
  const stalePid = files.pid && !isAlive(files.pid) ? files.pid : null
  void homedir
  return { baseUrl: null, port: files.recordedPort || defaultPort, health: null, error: null, stalePid, files }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function setRouterV2Notice(state, type, message, ttlMs = 3500) {
  state.routerV2Notice = { type, message, at: Date.now() }
  if (state.routerV2NoticeTimer) clearTimeout(state.routerV2NoticeTimer)
  state.routerV2NoticeTimer = setTimeout(() => {
    state.routerV2Notice = null
  }, ttlMs)
  if (typeof state.routerV2NoticeTimer.unref === 'function') state.routerV2NoticeTimer.unref()
}

export async function refreshRouterV2Snapshot(state, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  if (!state.routerV2DashboardOpen && !options.force) return null
  if (!state.routerV2Status || state.routerV2Status === 'idle') {
    state.routerV2Status = 'loading'
  }

  let discovery
  try {
    discovery = await discoverRouterV2Dashboard(state, fetchFn)
  } catch (err) {
    state.routerV2Status = 'unreachable'
    state.routerV2Error = err?.message || 'Discovery failed unexpectedly'
    return null
  }
  if (!discovery.baseUrl) {
    state.routerV2BaseUrl = null
    state.routerV2Port = discovery.port
    state.routerV2Health = discovery.health || null
    state.routerV2Stats = null
    state.routerV2History = null
    const files = discovery.files || readV2DaemonFiles()
    state.routerV2Status = discovery.stalePid
      ? 'stale'
      : files.hasPidFile || files.hasPortFile
        ? 'unreachable'
        : 'stopped'
    state.routerV2Error = discovery.error
    stopRouterV2EventStream(state)
    return null
  }

  state.routerV2BaseUrl = discovery.baseUrl
  state.routerV2Port = discovery.port
  state.routerV2Health = discovery.health
  const [stats, history] = await Promise.all([
    fetchJsonV2(`${discovery.baseUrl}/stats`, { fetchFn }),
    fetchJsonV2(`${discovery.baseUrl}/api/router-v2/history?limit=15`, { fetchFn }),
  ])
  state.routerV2Stats = stats.ok ? stats.data : null
  state.routerV2History = history.ok ? history.data : null
  state.routerV2Status = stats.ok ? 'ready' : 'partial'
  state.routerV2Error = stats.ok ? null : stats.error
  startRouterV2EventStream(state, { fetchFn })
  return state.routerV2Stats
}

export function startRouterV2Polling(state, options = {}) {
  if (state.routerV2PollTimer) return
  const fetchFn = options.fetchFn || globalThis.fetch
  void refreshRouterV2Snapshot(state, { fetchFn, force: true })
  state.routerV2PollTimer = setInterval(() => {
    void refreshRouterV2Snapshot(state, { fetchFn, force: true })
  }, ROUTER_V2_DASHBOARD_POLL_INTERVAL_MS)
  state.routerV2PollTimer.unref?.()
}

export function stopRouterV2EventStream(state) {
  if (state.routerV2EventAbort) {
    try { state.routerV2EventAbort.abort() } catch {}
  }
  state.routerV2EventAbort = null
}

export function stopRouterV2DashboardClient(state) {
  if (state.routerV2PollTimer) clearInterval(state.routerV2PollTimer)
  state.routerV2PollTimer = null
  stopRouterV2EventStream(state)
  if (state.routerV2NoticeTimer) clearTimeout(state.routerV2NoticeTimer)
  state.routerV2NoticeTimer = null
}

export function startRouterV2EventStream(state, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  if (!state.routerV2DashboardOpen) return
  if (!state.routerV2BaseUrl || typeof fetchFn !== 'function') return
  if (state.routerV2EventAbort) return

  const controller = new AbortController()
  state.routerV2EventAbort = controller
  void (async () => {
    try {
      const response = await fetchFn(`${state.routerV2BaseUrl}/api/router-v2/events`, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      })
      if (!response.ok) return
      if (!response.body || typeof response.body.getReader !== 'function') return
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!controller.signal.aborted) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let frameEnd = buffer.indexOf('\n\n')
        while (frameEnd >= 0) {
          const frame = buffer.slice(0, frameEnd)
          buffer = buffer.slice(frameEnd + 2)
          applyRouterV2SseEvent(state, frame)
          frameEnd = buffer.indexOf('\n\n')
        }
      }
    } catch {
      // 📖 Polling keeps the overlay functional when SSE is unavailable.
    } finally {
      if (state.routerV2EventAbort === controller) state.routerV2EventAbort = null
    }
  })()
}

function applyRouterV2SseEvent(state, frame) {
  let event = 'message'
  let data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (!data) return
  let payload
  try {
    payload = JSON.parse(data)
  } catch {
    return
  }
  // 📖 Lightweight touch: SSE events just nudge the snapshot refresh clock so
  // the next poll tick lands sooner and the overlay feels live.
  state.routerV2LastEventAt = Date.now()
  if (event === 'request' && isRecord(payload) && state.routerV2Stats) {
    state.routerV2Stats.requestsRouted = toFiniteNumber(payload.requestsRouted, state.routerV2Stats.requestsRouted)
  }
}

export function openRouterV2DashboardOverlay(state) {
  state.routerV2DashboardOpen = true
  state.routerV2ScrollOffset = 0
  state.routerV2CursorIndex = 0
  state.routerV2Status = state.routerV2Status || 'loading'
  startRouterV2Polling(state)
}

export function closeRouterV2DashboardOverlay(state) {
  state.routerV2DashboardOpen = false
  state.routerV2ScrollOffset = 0
  state.routerV2CursorIndex = 0
  stopRouterV2DashboardClient(state)
}

export async function cycleRouterV2ProbeMode(state, options = {}) {
  const baseUrl = state.routerV2BaseUrl
  if (!baseUrl) {
    setRouterV2Notice(state, 'error', 'Router v2 daemon is not reachable.')
    return
  }
  const current = state.routerV2Stats?.probeMode || state.routerV2Health?.probeMode || 'balanced'
  const idx = ROUTER_V2_PROBE_MODE_CYCLE.indexOf(current)
  const next = ROUTER_V2_PROBE_MODE_CYCLE[(idx + 1) % ROUTER_V2_PROBE_MODE_CYCLE.length]
  const response = await fetchJsonV2(`${baseUrl}/daemon/probe-mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ probeMode: next }),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  })
  if (!response.ok) {
    setRouterV2Notice(state, 'error', `Probe mode change failed: ${response.error || 'unknown error'}`)
    return
  }
  setRouterV2Notice(state, 'success', `Health check speed: ${next}`)
  void refreshRouterV2Snapshot(state, { force: true })
}

/**
 * 📖 Test ONE model through the running v2 daemon (pinned model, full chain).
 * `modelKeyStr` is `provider/modelId` as shown in the main table.
 */
export async function testModelViaRouterV2(state, modelKeyStr, options = {}) {
  const parsed = parseFcmModel(`fcm:@${modelKeyStr}`)
  if (parsed.kind !== 'pinned') {
    setRouterV2Notice(state, 'error', `Cannot parse model: ${modelKeyStr}`)
    return { ok: false, error: 'parse_failed' }
  }
  if (!state.routerV2TestRunning) state.routerV2TestRunning = new Set()
  if (!state.routerV2TestResults) state.routerV2TestResults = new Map()
  if (state.routerV2TestRunning.has(modelKeyStr)) return { ok: false, error: 'already_running' }
  state.routerV2TestRunning.add(modelKeyStr)
  try {
    const fetchFn = options.fetchFn || globalThis.fetch
    let port = state.routerV2Port
    if (!port || !state.routerV2BaseUrl) {
      port = await discoverRouterV2Port()
      if (!port) {
        setRouterV2Notice(state, 'error', 'Router v2 daemon is not running. Open Shift+V and start it first.')
        return { ok: false, error: 'daemon_not_running' }
      }
      state.routerV2Port = port
      state.routerV2BaseUrl = `http://127.0.0.1:${port}`
    }
    const result = await testModelViaRouter({ port, provider: parsed.pinned.provider, model: parsed.pinned.model })
    state.routerV2TestResults.set(modelKeyStr, { ...result, at: Date.now() })
    if (result.ok) {
      setRouterV2Notice(state, 'success', `${modelKeyStr} OK via router - ${result.latencyMs}ms`)
    } else {
      setRouterV2Notice(state, 'error', `${modelKeyStr} FAILED via router: ${result.error}`)
    }
    void refreshRouterV2Snapshot(state, { fetchFn, force: true })
    return result
  } finally {
    state.routerV2TestRunning.delete(modelKeyStr)
  }
}

/**
 * 📖 Test every VISIBLE model through the router with a small worker pool.
 * Long-running by design: results stream into the overlay as they land.
 */
export async function testAllVisibleViaRouterV2(state) {
  const visible = Array.isArray(state.visibleSorted) ? state.visibleSorted : []
  const models = visible
    .filter((row) => row && row.providerKey && row.modelId && row.hasApiKey !== false)
    .map((row) => ({ provider: row.providerKey, model: row.modelId }))
  if (models.length === 0) {
    setRouterV2Notice(state, 'error', 'No configured models visible to test.')
    return []
  }
  let port = state.routerV2Port
  if (!port) {
    port = await discoverRouterV2Port()
    if (!port) {
      setRouterV2Notice(state, 'error', 'Router v2 daemon is not running. Open Shift+V and start it first.')
      return []
    }
    state.routerV2Port = port
    state.routerV2BaseUrl = `http://127.0.0.1:${port}`
  }
  if (!state.routerV2TestRunning) state.routerV2TestRunning = new Set()
  if (!state.routerV2TestResults) state.routerV2TestResults = new Map()
  state.routerV2BatchTest = { running: true, total: models.length, completed: 0 }
  try {
    const results = await testSetViaRouter({
      port,
      models,
      concurrency: ROUTER_V2_TEST_CONCURRENCY,
      onResult: (record) => {
        state.routerV2TestResults.set(record.key, { ...record, at: Date.now() })
        if (state.routerV2BatchTest) state.routerV2BatchTest.completed += 1
      },
    })
    const passed = results.filter((r) => r.ok).length
    setRouterV2Notice(state, passed === results.length ? 'success' : 'warning', `Router test done: ${passed}/${results.length} models serve real content through v2.`)
    void refreshRouterV2Snapshot(state, { force: true })
    return results
  } finally {
    state.routerV2BatchTest = null
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function formatDurationV2(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '-'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function stateBadgeV2(modelState) {
  switch (modelState) {
    case 'CLOSED': return { text: '✅ UP', color: themeColors.success }
    case 'DEGRADED': return { text: '🟠 DEGRADED', color: themeColors.warningBold }
    case 'HALF_OPEN': return { text: '🔁 PROBING', color: themeColors.warning }
    case 'OPEN': return { text: '⛔ OPEN', color: themeColors.error }
    case 'AUTH_ERROR': return { text: '🔐 AUTH FAIL', color: themeColors.errorBold }
    case 'QUOTA_PAUSED': return { text: '🔥 QUOTA', color: themeColors.warningBold }
    case 'STALE': return { text: '👻 STALE', color: themeColors.dim }
    case 'UNSUPPORTED': return { text: '🚫 UNSUPPORTED', color: themeColors.dim }
    default: return { text: '⏳ PENDING', color: themeColors.dim }
  }
}

function attemptChainLabel(entry) {
  const attempts = Array.isArray(entry.attempts) ? entry.attempts : []
  if (attempts.length === 0) return entry.served_model || '-'
  return attempts
    .map((a) => {
      const name = typeof a.model === 'string' ? a.model.split('/').slice(1).join('/') || a.model : '?'
      if (a.error) return `${name}:${a.error}`
      return `${name}:${a.status ?? '?'}`
    })
    .join(' -> ')
}

export function renderRouterV2Dashboard(state, deps = {}) {
  const EL = '\x1b[K'
  const lines = []
  const status = state.routerV2Status || 'idle'
  const width = Math.max(80, state.terminalCols || 80)
  const separator = themeColors.dim('-'.repeat(Math.max(20, width - 6)))
  const stats = isRecord(state.routerV2Stats) ? state.routerV2Stats : null

  const LOADING_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  const loadingGlyph = LOADING_FRAMES[(state.frame || 0) % LOADING_FRAMES.length]
  const isRunning = status === 'ready' || status === 'partial'
  const isLoading = status === 'loading'

  const bannerWidth = Math.max(40, width - 6)
  let bannerText, bannerBgRgb
  if (isRunning) {
    bannerText = '  ROUTER V2 RUNNING (BUILT-IN)  '
    bannerBgRgb = [22, 120, 60]
  } else if (isLoading) {
    bannerText = `  ROUTER V2 STARTING (BUILT-IN) ${loadingGlyph}  `
    bannerBgRgb = [180, 100, 0]
  } else {
    bannerText = '  ROUTER V2 STOPPED (BUILT-IN)  '
    bannerBgRgb = [160, 30, 30]
  }
  const padTotal = Math.max(0, bannerWidth - displayWidth(bannerText))
  const padLeft = Math.floor(padTotal / 2)
  const bannerLine = ' '.repeat(padLeft) + bannerText + ' '.repeat(padTotal - padLeft)
  const paintBanner = chalk.bgRgb(...bannerBgRgb).rgb(255, 255, 255).bold

  lines.push('')
  lines.push(`  ${paintBanner(bannerLine)}`)

  // ── Quick Setup ─────────────────────────────────────────────────────────────
  const { defaultPort } = getRouterPortRange()
  const port = state.routerV2Port || defaultPort
  lines.push(`  ${themeColors.textBold('Quick Setup')} ${themeColors.dim('(beta)')} ${themeColors.dim('- point your coding tool at v2')}`)
  lines.push(`  ${themeColors.dim('URL')}     ${themeColors.infoBold(`http://localhost:${port}/v1`)}   ${themeColors.dim('Anthropic:')} ${themeColors.infoBold(`http://localhost:${port}`)}  ${themeColors.dim('(POST /v1/messages)')}`)
  lines.push(`  ${themeColors.dim('Model')}   ${themeColors.infoBold('fcm')}  ${themeColors.dim('or pin one:')} ${themeColors.infoBold('fcm:@provider/model')}`)
  lines.push(`  ${themeColors.dim('API Key')} ${themeColors.infoBold('fcm-local')}`)
  if (isRunning) {
    lines.push(`  ${themeColors.dim('Uptime')}  ${themeColors.success(formatDurationV2(toFiniteNumber(stats?.uptimeSeconds, 0)))}  ${themeColors.dim('Routed:')} ${themeColors.info(String(toFiniteNumber(stats?.requestsRouted, 0)))}  ${themeColors.dim('Failover rate:')} ${themeColors.info(`${Math.round(toFiniteNumber(stats?.history?.failover_rate, 0) * 100)}%`)}`)
  }
  lines.push(`  ${separator}`)

  // ── Fallback chain with live breaker states ─────────────────────────────────
  lines.push(`  ${themeColors.textBold('Fallback Chain')} ${themeColors.dim('- routing order for the next request')}`)
  const routingOrder = Array.isArray(stats?.routingOrder) ? stats.routingOrder : []
  const models = Array.isArray(stats?.models) ? stats.models : []
  const healthByKey = new Map(models.map((m) => [m.key, m]))
  const testResults = state.routerV2TestResults instanceof Map ? state.routerV2TestResults : new Map()
  const cursor = state.routerV2CursorIndex ?? 0

  if (!isRunning) {
    lines.push(`  ${themeColors.dim('Start the daemon to see the live chain.')}`)
  } else if (routingOrder.length === 0) {
    lines.push(`  ${themeColors.warning('No routeable candidates right now (keys missing or all models failing).')}`)
  } else {
    lines.push(`   ${themeColors.dim(padEndDisplay('PRI', 4))} ${themeColors.dim(padEndDisplay('MODEL', 44))} ${themeColors.dim(padEndDisplay('STATE', 15))} ${themeColors.dim(padEndDisplay('UPTIME', 7))} ${themeColors.dim(padEndDisplay('V2 TEST', 12))} ${themeColors.dim('LAST ERROR')}`)
    const maxRows = Math.max(1, routingOrder.length)
    routingOrder.forEach((entry, i) => {
      const health = healthByKey.get(entry.key)
      const badge = stateBadgeV2(health?.state || entry.state || 'UNKNOWN')
      const uptime = health?.uptime != null ? `${Math.round(health.uptime * 100)}%` : '-'
      const test = testResults.get(entry.key)
      let testLabel = themeColors.dim(padEndDisplay('- space t', 12))
      if (state.routerV2TestRunning?.has(entry.key)) testLabel = themeColors.warning(padEndDisplay('⏳ testing', 12))
      else if (test?.ok === true) testLabel = themeColors.success(padEndDisplay(`✅ ${test.latencyMs}ms`, 12))
      else if (test?.ok === false) testLabel = themeColors.error(padEndDisplay(`❌ ${String(test.error || 'fail').slice(0, 6)}`, 12))
      const lastError = health?.last_error ? compactTextV2(health.last_error, 24) : themeColors.dim('-')
      const isCursorRow = i === cursor
      const nextMarker = i === 0 ? themeColors.successBold('▶') : themeColors.dim(' ')
      const rowText = ` ${nextMarker} ${padEndDisplay(String(entry.priority || i + 1), 4)} ${padEndDisplay(entry.key, 44)} ${padEndDisplay(badge.text, 15)} ${themeColors.dim(padEndDisplay(uptime, 7))} ${testLabel} ${lastError}`
      lines.push(isCursorRow
        ? themeColors.bgCursor(rowText + ' '.repeat(Math.max(0, width - displayWidth(rowText) - 3)))
        : rowText)
    })
    void maxRows
  }

  // ── Recent requests WITH fallback chains (the v1 gap) ───────────────────────
  lines.push('')
  lines.push(`  ${themeColors.textBold('Request Chains')} ${themeColors.dim('- every attempt, skips and the winner')}`)
  const historyEntries = Array.isArray(state.routerV2History?.entries) ? state.routerV2History.entries : []
  if (!isRunning) {
    lines.push(`  ${themeColors.dim('No history (daemon stopped).')}`)
  } else if (historyEntries.length === 0) {
    lines.push(`  ${themeColors.dim('No requests routed yet')}`)
  } else {
    for (const entry of historyEntries.slice(0, 6)) {
      const atMs = Date.parse(entry.at)
      const time = Number.isFinite(atMs) ? new Date(atMs).toLocaleTimeString() : '-'
      const outcome = entry.outcome === 'served'
        ? themeColors.success('served')
        : entry.outcome === 'client_aborted'
          ? themeColors.dim('aborted')
          : themeColors.error(entry.outcome || 'failed')
      const chain = attemptChainLabel(entry)
      const skips = Array.isArray(entry.skipped) && entry.skipped.length > 0
        ? ` ${themeColors.dim(`[skips: ${entry.skipped.map((s) => s.reason).join(', ')}]`)}`
        : ''
      const lastResort = entry.last_resort_used ? ` ${themeColors.warningBold('[last-resort]')}` : ''
      const shortId = typeof entry.request_id === 'string' ? entry.request_id.slice(-4) : '----'
      lines.push(`  ${themeColors.dim(`[${shortId}]`)} ${themeColors.dim(time)} ${outcome}`)
      lines.push(`    ${themeColors.dim(chain)}${skips}${lastResort}`)
    }
  }

  // ── Quota pauses + counts ───────────────────────────────────────────────────
  const stateCounts = stats?.modelStates
  if (isRecord(stateCounts)) {
    lines.push('')
    const chips = [
      `✅ ${stateCounts.CLOSED ?? 0}`,
      `🟠 degraded ${stateCounts.DEGRADED ?? 0}`,
      `⛔ open ${stateCounts.OPEN ?? 0}`,
      `🔐 auth ${stateCounts.AUTH_ERROR ?? 0}`,
      `🔥 quota ${stateCounts.QUOTA_PAUSED ?? 0}`,
    ]
    lines.push(`  ${themeColors.textBold('Models:')} ${chips.map((c) => themeColors.dim(c)).join('  ')}`)
    const pauses = Array.isArray(stats?.quotaPauses) ? stats.quotaPauses : []
    if (pauses.length > 0) {
      for (const pause of pauses.slice(0, 3)) {
        lines.push(`  ${themeColors.warning(`🔥 ${pause.model} paused until ${String(pause.until || '').slice(11, 19)}`)}`)
      }
    }
  }

  // ── Batch test progress ─────────────────────────────────────────────────────
  if (state.routerV2BatchTest?.running) {
    lines.push('')
    lines.push(`  ${themeColors.warning(`⏳ Testing ${state.routerV2BatchTest.completed}/${state.routerV2BatchTest.total} visible models through the router...`)}`)
  }

  // ── Buttons ─────────────────────────────────────────────────────────────────
  lines.push('')
  const isStopped = !isRunning && !isLoading
  const cursorBase = Math.max(1, routingOrder.length)
  const startBtnCursor = cursorBase
  const startBtnText = isStopped ? '▶ Start Router Daemon (v2 engine)' : '⏹ Stop Router Daemon (v2 engine)'
  const startBtnRow = `  [ ${startBtnText} ]`
  lines.push(cursor === startBtnCursor
    ? themeColors.bgCursor(startBtnRow + ' '.repeat(Math.max(0, width - displayWidth(startBtnRow) - 3)))
    : startBtnRow)

  // ── Notice / errors ─────────────────────────────────────────────────────────
  const notice = state.routerV2Notice
  if (notice?.message) {
    lines.push('')
    const color = notice.type === 'error' ? themeColors.errorBold : notice.type === 'success' ? themeColors.successBold : themeColors.warningBold
    lines.push(`  ${color(notice.message)}`)
  } else if (state.routerV2Error && isStopped) {
    lines.push('')
    lines.push(`  ${themeColors.dim('Press')} ${themeColors.hotkey('S')} ${themeColors.dim('to start it now.')}`)
  } else if (state.routerV2Error) {
    lines.push('')
    lines.push(`  ${themeColors.warning(state.routerV2Error)}`)
  }

  // ── Footer ──────────────────────────────────────────────────────────────────
  lines.push('')
  lines.push(`  ${separator}`)
  const probeMode = stats?.probeMode || 'balanced'
  lines.push(`  ${themeColors.hotkey('↑↓')} ${themeColors.dim('Navigate')}  ${themeColors.dim('•')}  ${themeColors.hotkey('T')} ${themeColors.dim('Test via router')}  ${themeColors.dim('•')}  ${themeColors.hotkey('S')} ${themeColors.dim(isStopped ? 'Start' : 'Stop')}  ${themeColors.dim('•')}  ${themeColors.hotkey('I')} ${themeColors.dim(`Probes: ${probeMode}`)}  ${themeColors.dim('•')}  ${themeColors.hotkey('C')} ${themeColors.dim('Clear history')}  ${themeColors.dim('•')}  ${themeColors.hotkey('Esc')} ${themeColors.dim('Back')}`)
  lines.push(`  ${themeColors.dim('BETA: the v2 engine now powers the main router daemon. Ctrl+T tests the selected table model, Ctrl+Shift+T tests all visible models through the router.')}`)

  const { visible, offset } = sliceOverlayLines(lines, state.routerV2ScrollOffset || 0, state.terminalRows || 24)
  state.routerV2ScrollOffset = offset
  const tinted = tintOverlayLines(visible, themeColors.overlayBgSettings, state.terminalCols || 80)
  return tinted.map((line) => line + EL).join('\n')
}

function compactTextV2(value, width) {
  const text = String(value ?? '')
  if (displayWidth(text) <= width) return themeColors.dim(text)
  return themeColors.dim(`${text.slice(0, Math.max(1, width - 1))}…`)
}

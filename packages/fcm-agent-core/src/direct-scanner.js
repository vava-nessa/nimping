/**
 * @file direct-scanner.js
 * @description Direct model scanner (non-daemon fallback) — shared core.
 *
 * @details
 *   Runs pings and AI benchmarks directly from the host agent process by
 *   importing core FCM modules. Works in two phases:
 *
 *   **Phase 1 — Ping (parallel):** Pings all candidate models concurrently
 *   (up to `maxCandidates`, default 60). After each ping, emits a
 *   `model-result` progress event so adapters can display models incrementally
 *   as they come in — no more waiting for the full scan to finish.
 *
 *   **Phase 2 — AI Benchmark (parallel, top N survivors):** Runs a real AI
 *   latency + TPS test on the top `maxBenchmarkCandidates` (default 8) ping
 *   survivors. Each benchmark completion also fires a `benchmark-result` event
 *   for live updates in the adapter UI.
 *
 *   Rendering is NOT done here. The scanner emits structured progress events
 *   via `onProgress(event)`; each adapter decides how to show them (Pi live
 *   widget, OpenCode toast, logs, …). This keeps the core free of chalk/ANSI
 *   and host-specific UI.
 *
 * @functions
 *   - directScan → Ping + benchmark candidates, emit progressive events, return scanned models
 */

// 📖 Relative imports into the repo root: this package ships only inside a
// 📖 clone of free-coding-models (file: dependency), so a self-name import
// 📖 ('free-coding-models/...') would only resolve where npm happens to have
// 📖 created a self-link in node_modules.
import { MODELS, sources } from '../../../sources.js'
import { ping } from '../../../src/core/ping.js'
import { benchmarkModel } from '../../../src/core/benchmark.js'
import { loadAllApiKeys } from './api-keys.js'
import { parseSweScore } from './ranker.js'

/**
 * @typedef {object} ScannedModel
 * @property {string} modelId
 * @property {string} label
 * @property {string} tier
 * @property {string} sweScore
 * @property {string} ctxWindow
 * @property {string} providerKey
 * @property {string} providerName
 * @property {string} providerUrl
 * @property {string} apiKey
 * @property {string} status - 'up' | 'down' | 'timeout' | 'auth_error' | 'noauth'
 * @property {number|null} latencyMs
 * @property {number|null} tps
 * @property {number|null} totalBenchMs
 * @property {number} stabilityScore
 * @property {boolean} hasKey
 */

/**
 * 📖 Scan model availability and latency directly from the agent process.
 *
 * 📖 Emits several structured progress event shapes via `onProgress(event)`:
 *
 *   **Ping phase** (phase: 'probing'):
 *   ```js
 *   { phase: 'probing', action: 'Probing', percent, completed, total, activeModels }
 *   ```
 *
 *   **Model discovered** (phase: 'model-result') — fired for every ping result:
 *   ```js
 *   { phase: 'model-result', model: ScannedModel, pingIndex: number, totalPings: number }
 *   ```
 *
 *   **Benchmark phase** (phase: 'benchmarking'):
 *   ```js
 *   { phase: 'benchmarking', action: 'Benchmarking', percent, completed, total, activeModels }
 *   ```
 *
 *   **Benchmark result** (phase: 'benchmark-result') — fired for each benchmark:
 *   ```js
 *   { phase: 'benchmark-result', model: ScannedModel }
 *   ```
 *
 *   **Done** (phase: 'done'):
 *   ```js
 *   { phase: 'done', percent: 100, completed, total, activeModels: [] }
 *   ```
 *
 * @param {object} [options={}]
 * @param {function} [options.onProgress] - Structured progress callback `(event) => void`
 * @param {AbortSignal} [options.signal] - Abort signal to cancel the scan early
 * @param {number} [options.maxCandidates=60] - Cap on pinged candidates (increased from 30)
 * @param {number} [options.maxBenchmarkCandidates=8] - Cap on benchmarked survivors (increased from 5)
 * @returns {Promise<Array<ScannedModel>>} Scanned models list (unfiltered)
 */
export async function directScan(options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const signal = options.signal
  const maxCandidates = options.maxCandidates ?? 60
  const maxBenchmarkCandidates = options.maxBenchmarkCandidates ?? 8
  const keys = loadAllApiKeys()
  const scannedList = []

  // 📖 Step 1: Filter models by available keys (skip zen-only / cli-only models).
  // 📖 We deliberately do NOT pre-sort by SWE here before filtering, so models
  // 📖 with unknown SWE scores still get a chance to be pinged.
  const candidateModels = MODELS.filter(tuple => {
    const providerKey = tuple[5]
    const sourceInfo = sources[providerKey]
    if (!sourceInfo) return false
    if (sourceInfo.zenOnly) return false // 📖 Zen models only work in OpenCode
    const key = keys.get(providerKey)
    return !!key || !!sourceInfo.noKeyNeeded
  })

  if (candidateModels.length === 0) {
    onProgress({ phase: 'error', message: 'No configured API keys found' })
    return []
  }

  // 📖 Step 2: Sort by SWE score descending, keep top N.
  // 📖 Unknown SWE ('-') gets score 0 but is NOT pre-filtered out — they still
  // 📖 compete for the ping slots. The higher maxCandidates cap (60) ensures
  // 📖 we catch functional models that lack a SWE benchmark.
  const sortedCandidates = candidateModels
    .map(tuple => ({
      modelId: tuple[0],
      label: tuple[1],
      tier: tuple[2],
      sweScore: tuple[3],
      ctxWindow: tuple[4],
      providerKey: tuple[5],
      sourceInfo: sources[tuple[5]]
    }))
    .sort((a, b) => parseSweScore(b.sweScore) - parseSweScore(a.sweScore))
    .slice(0, maxCandidates)

  const totalPings = sortedCandidates.length
  let completedPings = 0

  let currentAction = 'Probing'
  let activeModels = []
  let pct = 0
  let completed = 0
  let total = totalPings

  const emit = (overrides = {}) => {
    onProgress({
      phase: currentAction === 'Probing' ? 'probing' : 'benchmarking',
      action: currentAction,
      percent: pct,
      completed,
      total,
      activeModels: activeModels.slice(-2),
      ...overrides
    })
  }

  emit()

  // 📖 Step 3: Ping candidate models in parallel (15s timeout inside ping.js).
  // 📖 Each completion fires a `model-result` event immediately so adapters
  // 📖 can render models as they come in — no waiting for all pings to finish.
  const pingPromises = sortedCandidates.map(async (candidate) => {
    if (signal?.aborted) return null
    const { modelId, providerKey, sourceInfo, label } = candidate
    const apiKey = keys.get(providerKey) || null
    const url = sourceInfo.url
    const providerName = sourceInfo.name || providerKey
    const target = { label, providerName }
    activeModels.push(target)
    emit()

    let scanned = null

    try {
      const res = await ping(apiKey, modelId, providerKey, url)

      let status = 'down'
      if (res.code === '200') status = 'up'
      else if (res.code === '000') status = 'timeout'
      else if (res.code === '401' || res.code === '403') {
        status = apiKey ? 'auth_error' : 'noauth'
      }

      scanned = {
        ...candidate,
        apiKey,
        providerName,
        providerUrl: url,
        status,
        latencyMs: typeof res.ms === 'number' ? res.ms : null,
        tps: null,
        totalBenchMs: null,
        stabilityScore: 100,
        hasKey: status !== 'noauth' && status !== 'auth_error'
      }

      // 📖 Emit a live event for every resolved ping (up, down, timeout, etc.)
      // 📖 so adapters can render a progressive list as models are discovered.
      onProgress({
        phase: 'model-result',
        model: { ...scanned },
        pingIndex: completedPings + 1,
        totalPings
      })

      return scanned
    } catch (err) {
      scanned = {
        ...candidate,
        apiKey,
        providerName,
        providerUrl: url,
        status: 'down',
        latencyMs: null,
        tps: null,
        totalBenchMs: null,
        stabilityScore: 100,
        hasKey: true
      }

      onProgress({
        phase: 'model-result',
        model: { ...scanned },
        pingIndex: completedPings + 1,
        totalPings
      })

      return scanned
    } finally {
      completedPings++
      pct = Math.round((completedPings / totalPings) * 100)
      completed = completedPings
      activeModels = activeModels.filter(t => t !== target)
      emit()
    }
  })

  const pingResults = await Promise.allSettled(pingPromises)
  const aliveModels = []

  for (const result of pingResults) {
    if (result.status === 'fulfilled' && result.value) {
      aliveModels.push(result.value)
    }
  }

  // 📖 Remove intermediate sourceInfo so returning plain JSON is safe
  for (const m of aliveModels) {
    delete m.sourceInfo
  }

  const usableAlive = aliveModels.filter(m => m.status === 'up')
  if (usableAlive.length === 0) {
    onProgress({ phase: 'done', percent: 100, completed: totalPings, total: totalPings, activeModels: [] })
    return aliveModels
  }

  // 📖 Step 4: AI Latency + TPS benchmark on the top survivors.
  // 📖 Sort by SWE score first, then take top maxBenchmarkCandidates (default 8).
  const benchmarkCandidates = usableAlive
    .sort((a, b) => parseSweScore(b.sweScore) - parseSweScore(a.sweScore))
    .slice(0, maxBenchmarkCandidates)

  currentAction = 'Benchmarking'
  completed = 0
  pct = 0
  total = benchmarkCandidates.length
  activeModels = []
  emit()

  const totalBenchmarks = benchmarkCandidates.length
  let completedBenchmarks = 0

  const benchmarkPromises = benchmarkCandidates.map(async (model) => {
    if (signal?.aborted) return { modelId: model.modelId, ok: false, code: 'ABORTED', totalMs: null }
    const { modelId, providerKey, providerUrl, apiKey, label, providerName } = model
    const target = { label, providerName }
    activeModels.push(target)
    emit()

    try {
      const res = await benchmarkModel({
        apiKey,
        modelId,
        providerKey,
        url: providerUrl,
        maxRetries: 1,
        retryDelayMs: 3000
      })

      let benchResult
      if (res.ok) {
        benchResult = { modelId, ok: true, tps: res.tokensPerSecond || null, totalMs: res.totalMs || null }
      } else {
        benchResult = { modelId, ok: false, code: res.code || 'ERR', totalMs: res.totalMs || null }
      }

      // 📖 Emit a live benchmark-result event so Pi/OpenCode can update the
      // 📖 progressive list with real AI latency + TPS as each benchmark finishes.
      const updatedModel = benchResult.ok
        ? { ...model, tps: benchResult.tps, totalBenchMs: benchResult.totalMs, benchmarkStatus: 'up' }
        : { ...model, status: 'down', tps: null, totalBenchMs: benchResult.totalMs, benchmarkStatus: benchResult.code || 'ERR' }

      onProgress({
        phase: 'benchmark-result',
        model: { ...updatedModel }
      })

      return benchResult
    } catch (err) {
      const errResult = { modelId, ok: false, code: 'ERR', totalMs: null }
      onProgress({
        phase: 'benchmark-result',
        model: { ...model, status: 'down', benchmarkStatus: 'ERR' }
      })
      return errResult
    } finally {
      completedBenchmarks++
      pct = Math.round((completedBenchmarks / totalBenchmarks) * 100)
      completed = completedBenchmarks
      activeModels = activeModels.filter(t => t !== target)
      emit()
    }
  })

  const benchmarkResults = await Promise.allSettled(benchmarkPromises)
  const benchMap = new Map()
  const benchmarkedIds = new Set(benchmarkCandidates.map((model) => model.modelId))

  for (const res of benchmarkResults) {
    if (res.status === 'fulfilled') {
      benchMap.set(res.value.modelId, res.value)
    }
  }

  onProgress({ phase: 'done', percent: 100, completed: total, total, activeModels: [] })

  // 📖 Step 5: Merge benchmark stats back in. If a survivor failed the real AI
  // 📖 latency test, mark it down: a tiny ping passing is not enough for an agent.
  return aliveModels.map(model => {
    const bench = benchMap.get(model.modelId)
    if (bench?.ok) {
      return { ...model, tps: bench.tps, totalBenchMs: bench.totalMs, benchmarkStatus: 'up' }
    }
    if (benchmarkedIds.has(model.modelId)) {
      return {
        ...model,
        status: 'down',
        tps: null,
        totalBenchMs: bench?.totalMs || null,
        benchmarkStatus: bench?.code || 'ERR'
      }
    }
    return model
  })
}

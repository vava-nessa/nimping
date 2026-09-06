/**
 * @file lib/utils.js
 * @description Pure utility functions extracted from the main CLI for testability.
 *
 * 📖 This file was created to separate the "brain" of the app from the "body" (TUI, I/O, chalk).
 *    Every function here is a pure function — no side effects, no process.exit, no console output.
 *    This makes them trivial to unit test with `node:test` without mocking anything.
 *
 * 📖 The main CLI (bin/free-coding-models.js) imports everything from here.
 *    If you need to add new logic (calculations, data transforms, parsing),
 *    add it here so tests can cover it.
 *
 * 📖 Data flow:
 *    sources.js → MODELS array → main CLI creates result objects → these utils process them
 *
 * 📖 Result object shape (created by the main CLI, consumed by these functions):
 *    {
 *      idx: number,          // 1-based index for display
 *      modelId: string,      // e.g. "deepseek-ai/deepseek-v4-flash"
 *      label: string,        // e.g. "DeepSeek V4 Flash" (human-friendly name)
 *      tier: string,         // e.g. "S+", "A", "B+" — from sources.js
 *      sweScore: string,     // e.g. "49.2%", "73.1%" — SWE-bench Verified score
 *      status: string,       // "pending" | "up" | "down" | "timeout"
 *      pings: Array<{ms: number, code: string}>,  // full ping history since start
 *      httpCode: string|null // last HTTP status code (for detecting 429 rate limits)
 *    }
 *
 * @functions
 *   → getAvg(result) — Calculate average latency from successful pings only
 *   → getVerdict(result) — Determine model health verdict based on avg latency and stability
 *   → getUptime(result) — Calculate uptime percentage (successful / total pings)
 *   → getP95(result) — Calculate 95th percentile latency from successful pings
 *   → getJitter(result) — Calculate latency standard deviation (jitter)
 *   → getStabilityScore(result) — Composite 0–100 stability score (p95 + jitter + spikes + uptime)
 *   → sortResults(results, sortColumn, sortDirection) — Sort model results by any column
 *   → filterByTier(results, tierLetter) — Filter results by tier letter (S/A/B/C)
 *   → findBestModel(results) — Pick the best model by status → avg → stability → uptime priority
 *   → parseArgs(argv) — Parse CLI arguments into structured flags and values
 *
 * @exports getAvg, getVerdict, getUptime, getP95, getJitter, getStabilityScore
 * @exports sortResults, filterByTier, findBestModel, parseArgs
 * @exports scoreModelForTask, getTopRecommendations
 * @exports TIER_ORDER, VERDICT_ORDER, TIER_LETTER_MAP, TASK_TYPES, PRIORITY_TYPES, CONTEXT_BUDGETS
 * @exports parseCtxToK, parseSweToNum, formatCtxWindow, labelFromId, NEW_MODELS, getVersionStatusInfo, formatResultsAsJSON
 *
 * @see bin/free-coding-models.js — main CLI that imports these utils
 * @see sources.js — model definitions consumed by these functions
 * @see test/test.js — unit tests that validate all these functions
 */

// ─── Constants ────────────────────────────────────────────────────────────────

// 📖 Tier sort order — defines the hierarchy from best to worst.
// 📖 Used by sortResults to compare tiers numerically via indexOf.
// 📖 S+ (elite frontier coders) is index 0, C (lightweight edge) is index 7.
// 📖 This must stay in sync with the tiers defined in sources.js.
export const TIER_ORDER = ['S+', 'S', 'A+', 'A', 'A-', 'B+', 'B', 'C']

// 📖 Verdict strings in order from healthiest to unhealthiest.
// 📖 Used by sortResults when sorting by the "verdict" column.
// 📖 "Perfect" means < 400ms avg, "Pending" means no data yet.
// 📖 The order matters — it determines sort rank in the TUI table.
export const VERDICT_ORDER = ['Perfect', 'Normal', 'Slow', 'Spiky', 'Very Slow', 'Overloaded', 'Unstable', 'Not Active', 'Pending']

// 📖 Maps a CLI tier letter (--tier S/A/B/C) to the full tier strings it includes.
// 📖 Example: --tier A matches A+, A, and A- models (all "A-family" tiers).
// 📖 This avoids users needing to know the exact sub-tier names.
// 📖 Used by filterByTier() and the --tier CLI flag.
export const TIER_LETTER_MAP = {
  'S': ['S+', 'S'],      // 📖 Frontier coders — top Aider polyglot scores
  'A': ['A+', 'A', 'A-'], // 📖 Excellent alternatives — strong at most coding tasks
  'B': ['B+', 'B'],       // 📖 Solid performers — good for targeted programming
  'C': ['C'],              // 📖 Lightweight/edge models — code completion on constrained infra
}

// ─── Core Logic Functions ────────────────────────────────────────────────────

// 📖 measureablePingCodes: HTTP codes that still give us a real round-trip latency sample.
// 📖 200 = normal success, 401 = no key / bad key but the provider endpoint is reachable.
const measurablePingCodes = new Set(['200', '401'])

// 📖 getAvg: Calculate average latency from pings that produced a real latency sample.
// 📖 HTTP 200 and 401 both count because a 401 still proves the endpoint responded in X ms.
// 📖 Timeouts and server failures are excluded to avoid mixing availability with raw latency.
// 📖 Returns Infinity when no measurable pings exist — this sorts "unknown" models to the bottom.
// 📖 The rounding to integer avoids displaying fractional milliseconds in the TUI.
//
// 📖 Example:
//   pings = [{ms: 200, code: '200'}, {ms: 320, code: '401'}, {ms: 999, code: '500'}]
//   → getAvg returns 260 (only the measurable pings count: (200+320)/2)
export const getAvg = (r) => {
  const measurablePings = (r.pings || []).filter(p => measurablePingCodes.has(p.code))
  if (measurablePings.length === 0) return Infinity
  return Math.round(measurablePings.reduce((a, b) => a + b.ms, 0) / measurablePings.length)
}

// 📖 getVerdict: Determine a human-readable health verdict for a model.
// 📖 This is the "Status" column label shown in the TUI table.
//
// 📖 Decision priority (first match wins):
//   1. HTTP 429 → "Overloaded" (rate limited by NVIDIA, not a latency issue)
//   2. Timeout/down BUT was previously up → "Unstable" (it worked before, now it doesn't)
//   3. Timeout/down and never worked → "Not Active" (model might be offline)
//   4. No successful pings yet → "Pending" (still waiting for first response)
//   5. Stability-aware speed tiers (avg + p95/jitter penalty):
//      - Avg < 400ms + stable → "Perfect"
//      - Avg < 400ms but spiky p95 → "Spiky" (fast on average, but tail latency hurts)
//      - Avg < 1000ms → "Normal"
//      - Avg < 3000ms → "Slow"
//      - Avg < 5000ms → "Very Slow"
//      - Avg >= 5000ms → "Unstable"
//
// 📖 The "Spiky" verdict catches models that look fast on paper (low avg) but randomly
//    stall your IDE/agent with tail-latency spikes. A model with avg 250ms but p95 6000ms
//    gets downgraded from "Perfect" to "Spiky" — because consistency matters more than speed.
//
// 📖 The "wasUpBefore" check is key — it distinguishes between a model that's
//    temporarily flaky vs one that was never reachable in the first place.
// 📖 NEW_MODEL_DURATION_MS — how long a model shows the 🆕 badge after being added.
// 📖 5 days in milliseconds.
export const NEW_MODEL_DURATION_MS = 5 * 24 * 60 * 60 * 1000

/**
 * 📖 Check if a model should display the 🆕 badge.
 * 📖 A model is "new" if its addedDate is within the last 5 days.
 * 📖 `addedDate` comes from sources.js as the optional 6th element of model tuples.
 * @param {string|null|undefined} addedDate — ISO date string (e.g. '2026-06-10')
 * @returns {boolean}
 */
export function isNewModel(addedDate) {
  if (!addedDate || typeof addedDate !== 'string') return false
  const added = Date.parse(addedDate)
  if (!Number.isFinite(added)) return false
  return (Date.now() - added) < NEW_MODEL_DURATION_MS
}

// 📖 NEW_MODELS kept for backward compat with web/website surfaces that
// 📖 don't have addedDate. Will be removed once all surfaces migrate.
export const NEW_MODELS = new Set([
]);

export const getVerdict = (r) => {
  // 📖 401/403 rows can still carry fast measurable pings, but calling them
  // 📖 "Perfect" let --fiable / findBestModel recommend a model that cannot serve
  // 📖 a single authenticated request. Auth-failing rows always get the
  // 📖 least-trustworthy health label instead.
  if (r.status === 'auth_error' || r.status === 'noauth') return 'Not Active'
  const avg = getAvg(r)
  const wasUpBefore = (r.pings || []).length > 0 && r.pings.some(p => p.code === '200')

  if (r.httpCode === '429') return 'Overloaded'
  if ((r.status === 'timeout' || r.status === 'down') && wasUpBefore) return 'Unstable'
  if (r.status === 'timeout' || r.status === 'down') return 'Not Active'
  if (avg === Infinity) return 'Pending'

  // 📖 Stability-aware verdict: penalize models with good avg but terrible tail latency
  const measurablePings = (r.pings || []).filter(p => measurablePingCodes.has(p.code))
  const p95 = getP95(r)

  // 📖 Incorporate benchmark data (AI Latency and TPS) if available
  if (r.benchmark && r.benchmark.ok) {
    // AI Latency from benchmark (totalMs)
    const aiLatency = r.benchmark.totalMs
    // TPS from benchmark (tokens per second)
    const tps = r.benchmark.tokensPerSecond
    
    // Adjust verdict based on benchmark data
    if (aiLatency < 400) {
      // 📖 Only flag as "Spiky" when we have enough data (≥3 pings) to judge stability
      if (measurablePings.length >= 3 && p95 > 3000) return 'Spiky'
      return 'Perfect'
    }
    if (aiLatency < 1000) {
      if (measurablePings.length >= 3 && p95 > 5000) return 'Spiky'
      return 'Normal'
    }
    if (aiLatency < 3000) return 'Slow'
    if (aiLatency < 5000) return 'Very Slow'
    if (aiLatency < 10000) return 'Unstable'
    
    // 📖 High TPS can improve verdict for models with higher latency
    if (tps > 20 && aiLatency < 15000) return 'Slow'
    if (tps > 40 && aiLatency < 20000) return 'Normal'
    if (tps > 60 && aiLatency < 25000) return 'Perfect'
  }
  
  // 📖 Fall back to ping-based verdict if no benchmark data
  if (avg < 400) {
    // 📖 Only flag as "Spiky" when we have enough data (≥3 pings) to judge stability
    if (measurablePings.length >= 3 && p95 > 3000) return 'Spiky'
    return 'Perfect'
  }
  if (avg < 1000) {
    if (measurablePings.length >= 3 && p95 > 5000) return 'Spiky'
    return 'Normal'
  }
  if (avg < 3000) return 'Slow'
  if (avg < 5000) return 'Very Slow'
  if (avg < 10000) return 'Unstable'
  return 'Unstable'
}

// 📖 getUptime: Calculate the percentage of successful pings (code 200) over total pings.
// 📖 Returns 0 when no pings have been made yet (avoids division by zero).
// 📖 Displayed as "Up%" column in the TUI — e.g., "85%" means 85% of pings got HTTP 200.
// 📖 This metric is useful for identifying models that are technically "up" but flaky.
export const getUptime = (r) => {
  const pings = r.pings || []
  if (pings.length === 0) return 0
  const successful = pings.filter(p => p.code === '200').length
  return Math.round((successful / pings.length) * 100)
}

// 📖 getP95: Calculate the 95th percentile latency from measurable pings (HTTP 200/401).
// 📖 The p95 answers: "95% of requests are faster than this value."
// 📖 A low p95 means consistently fast responses — a high p95 signals tail-latency spikes.
// 📖 Returns Infinity when no measurable pings exist.
//
// 📖 Algorithm: sort latencies ascending, pick the value at ceil(N * 0.95) - 1.
// 📖 Example: [100, 200, 300, 400, 5000] → p95 index = ceil(5 * 0.95) - 1 = 4 → 5000ms
export const getP95 = (r) => {
  const measurablePings = (r.pings || []).filter(p => measurablePingCodes.has(p.code))
  if (measurablePings.length === 0) return Infinity
  const sorted = measurablePings.map(p => p.ms).sort((a, b) => a - b)
  const idx = Math.ceil(sorted.length * 0.95) - 1
  return sorted[Math.max(0, idx)]
}

// 📖 getJitter: Calculate latency standard deviation (σ) from measurable pings.
// 📖 Low jitter = predictable response times. High jitter = erratic, spiky latency.
// 📖 Returns 0 when fewer than 2 measurable pings (can't compute variance from 1 point).
// 📖 Uses population σ (divides by N, not N-1) since we have ALL the data, not a sample.
export const getJitter = (r) => {
  const measurablePings = (r.pings || []).filter(p => measurablePingCodes.has(p.code))
  if (measurablePings.length < 2) return 0
  const mean = measurablePings.reduce((a, b) => a + b.ms, 0) / measurablePings.length
  const variance = measurablePings.reduce((sum, p) => sum + (p.ms - mean) ** 2, 0) / measurablePings.length
  return Math.round(Math.sqrt(variance))
}

// 📖 getStabilityScore: Composite 0–100 score that rewards consistency and reliability.
// 📖 Combines four signals into a single number:
//   - p95 latency (30%) — penalizes tail-latency spikes
//   - Jitter / σ (30%) — penalizes erratic response times
//   - Spike rate (20%) — fraction of pings above 3000ms threshold
//   - Uptime / reliability (20%) — fraction of successful pings
//
// 📖 Each component is normalized to 0–100, then weighted and combined.
// 📖 Returns -1 when no successful pings exist (not enough data yet).
//
// 📖 Example:
//   Model A: avg 250ms, p95 6000ms (tons of spikes) → score ~30
//   Model B: avg 400ms, p95 650ms (boringly consistent) → score ~85
//   In real usage, Model B FEELS faster because it doesn't randomly stall.
export const getStabilityScore = (r) => {
  const measurablePings = (r.pings || []).filter(p => measurablePingCodes.has(p.code))
  if (measurablePings.length === 0) return -1

  const p95 = getP95(r)
  const jitter = getJitter(r)
  const uptime = getUptime(r)
  const spikeCount = measurablePings.filter(p => p.ms > 3000).length
  const spikeRate = spikeCount / measurablePings.length

  // 📖 Normalize each component to 0–100 (higher = better)
  const p95Score = Math.max(0, Math.min(100, 100 * (1 - p95 / 5000)))
  const jitterScore = Math.max(0, Math.min(100, 100 * (1 - jitter / 2000)))
  const spikeScore = Math.max(0, 100 * (1 - spikeRate))
  const reliabilityScore = uptime

  // 📖 Weighted composite: 30% p95, 30% jitter, 20% spikes, 20% reliability
  const score = 0.3 * p95Score + 0.3 * jitterScore + 0.2 * spikeScore + 0.2 * reliabilityScore
  return Math.round(score)
}

// 📖 sortResults: Sort the results array by any column the user can click/press in the TUI.
// 📖 Returns a NEW array — never mutates the original (important for React-style re-renders).
//
// 📖 Supported columns in the sorter.
// 📖 Most map directly to visible TUI sort hotkeys; `tier` remains available internally
// 📖 while `Y` is used by the live UI for favorites display mode.
//   - 'rank'      (R key) — original index from sources.js
//   - 'tier'      (internal) — tier hierarchy (S+ first, C last)
//   - 'origin'    (O key) — provider name (all NIM for now, future-proofed)
//   - 'model'     (M key) — alphabetical by display label
//   - 'ping'      (L key) — last ping latency (only successful ones count)
//   - 'avg'       (A key) — average latency across all successful pings
//   - 'swe'       (S key) — SWE-bench score (higher is better)
//   - 'ctx'       (N key) — context window size (larger is better)
//   - 'condition'  (H key) — health status (alphabetical)
//   - 'verdict'   (V key) — verdict order (Perfect → Pending)
//   - 'uptime'    (U key) — uptime percentage
//   - 'stability' (B key) — stability score (0–100, higher = more stable)
//
// 📖 sortDirection 'asc' = ascending (smallest first), 'desc' = descending (largest first)
export const sortResults = (results, sortColumn, sortDirection, { benchmarkResults = {} } = {}) => {
  return [...results].map(r => ({
    ...r,
    benchmark: benchmarkResults?.[`${r.providerKey}/${r.modelId}`]
  })).sort((a, b) => {
    let cmp = 0

    switch (sortColumn) {
      case 'rank':
        cmp = a.idx - b.idx
        break
      case 'tier':
        // 📖 Compare by position in TIER_ORDER — lower index = better tier
        cmp = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
        break
      case 'origin':
        // 📖 Sort by providerKey (or fallback to modelId prefix) for multi-provider support.
        // 📖 Explicit 'en' locale: the default is ICU-dependent, so row order would
        // 📖 otherwise vary between machines.
        cmp = (a.providerKey ?? 'nvidia').localeCompare(b.providerKey ?? 'nvidia', 'en')
        break
      case 'model':
        cmp = a.label.localeCompare(b.label, 'en')
        break
      case 'ping': {
        // 📖 Sort by LAST ping only — gives a real-time "right now" snapshot
        // 📖 Failed last pings sort to the bottom (Infinity)
        const aLast = a.pings.length > 0 ? a.pings[a.pings.length - 1] : null
        const bLast = b.pings.length > 0 ? b.pings[b.pings.length - 1] : null
        const aPing = aLast?.code === '200' ? aLast.ms : Infinity
        const bPing = bLast?.code === '200' ? bLast.ms : Infinity
        cmp = aPing - bPing
        break
      }
      case 'avg':
        cmp = getAvg(a) - getAvg(b)
        break
      case 'swe': {
        // 📖 Sort by SWE-bench score — higher is better
        cmp = parseSweToNum(a.sweScore) - parseSweToNum(b.sweScore)
        break
      }
      case 'ctx': {
        // 📖 Sort by context window size — larger is better (uses parseCtxToK)
        cmp = parseCtxToK(a.ctx) - parseCtxToK(b.ctx)
        break
      }
      case 'condition':
        cmp = a.status.localeCompare(b.status, 'en')
        break
      case 'verdict': {
        // 📖 Sort by verdict order — "Perfect" first, "Pending" last
        const aVerdict = getVerdict(a)
        const bVerdict = getVerdict(b)
        cmp = VERDICT_ORDER.indexOf(aVerdict) - VERDICT_ORDER.indexOf(bVerdict)
        break
      }
      case 'uptime':
        cmp = getUptime(a) - getUptime(b)
        break
      case 'stability':
        // 📖 Sort by stability score — higher = more stable = better
        // 📖 Models with no data (-1) sort to the bottom
        cmp = getStabilityScore(a) - getStabilityScore(b)
        break
      case 'aiLatency': {
        // 📖 Sort by AI benchmark latency (totalMs). Lower = better.
        // 📖 Models without benchmark data sort to the bottom.
        const aKey = `${a.providerKey}/${a.modelId}`
        const bKey = `${b.providerKey}/${b.modelId}`
        const aBench = benchmarkResults[aKey]
        const bBench = benchmarkResults[bKey]
        const aMs = (aBench?.ok && aBench.totalMs != null) ? aBench.totalMs : Infinity
        const bMs = (bBench?.ok && bBench.totalMs != null) ? bBench.totalMs : Infinity
        cmp = aMs - bMs
        break
      }
      case 'tps': {
        // 📖 Sort by benchmark throughput (tokens/second). Higher = better.
        // 📖 Models without benchmark data sort to the bottom.
        const aKey2 = `${a.providerKey}/${a.modelId}`
        const bKey2 = `${b.providerKey}/${b.modelId}`
        const aBench2 = benchmarkResults[aKey2]
        const bBench2 = benchmarkResults[bKey2]
        const aTps = (aBench2?.ok && aBench2.tokensPerSecond != null) ? aBench2.tokensPerSecond : -1
        const bTps = (bBench2?.ok && bBench2.tokensPerSecond != null) ? bBench2.tokensPerSecond : -1
        cmp = aTps - bTps
        break
      }
      case 'usage':
        // 📖 Sort by quota usage percent (usagePercent numeric field, 0–100)
        // 📖 Models with no usage data (undefined/null) are treated as 0 — stable tie-break
        // 📖 via JS stable sort preserving original order when values are equal
        cmp = (a.usagePercent ?? 0) - (b.usagePercent ?? 0)
        break
      case 'realworld':
        // 📖 Sort by real-world score (t3) — composite of success rate, throughput,
        // 📖 and recency. Models with insufficient data (r.realWorldScore === null)
        // 📖 sort to the bottom in BOTH directions (treat null as -Infinity for asc,
        // 📖 so high-to-low puts the score-havers first regardless of null).
        const aRW = typeof a.realWorldScore === 'number' ? a.realWorldScore : -Infinity
        const bRW = typeof b.realWorldScore === 'number' ? b.realWorldScore : -Infinity
        cmp = aRW - bRW
        break
    }

    // 📖 Non-finite differences (e.g. Infinity - Infinity) collapse to 0: a NaN
    // 📖 comparator result makes sort order machine-dependent and unstable.
    if (!Number.isFinite(cmp)) cmp = 0

    // 📖 Flip comparison for descending order
    return sortDirection === 'asc' ? cmp : -cmp
  })
}

// 📖 filterByTier: Filter model results by a single tier letter.
// 📖 Uses TIER_LETTER_MAP to expand the letter into matching tier strings.
// 📖 Returns null if the tier letter is invalid — the caller decides how to handle
//    (the main CLI exits with an error message, tests can assert null).
//
// 📖 Example: filterByTier(results, 'A') → returns only models with tier A+, A, or A-
export function filterByTier(results, tierLetter) {
  const letter = tierLetter.toUpperCase()
  const allowed = TIER_LETTER_MAP[letter]
  if (!allowed) return null
  return results.filter(r => allowed.includes(r.tier))
}

// 📖 PROBE_FAILED_STATUSES: row health states that count as "failed" for the
// 📖 Shift+P re-probe action (issue #168). Covers the errors a user actually sees
// 📖 in the table: dead endpoints (404/410/5xx/ERR → 'down'), rate limits
// 📖 (429 → 'down'), rejected keys ('auth_error') and network timeouts.
// 📖 'noauth' is deliberately excluded: those rows have no API key, so an
// 📖 authenticated probe cannot even run for them.
export const PROBE_FAILED_STATUSES = new Set(['down', 'timeout', 'auth_error'])

// 📖 isProbeFailedRow: True when a single result row is currently showing an
// 📖 error state worth re-probing. Hidden rows are skipped on purpose: Shift+P
// 📖 re-probes what the user can SEE failing, not rows the probe already hid.
export function isProbeFailedRow(row) {
  return !!row && !row.hidden && PROBE_FAILED_STATUSES.has(row.status)
}

// 📖 selectProbeFailedRows: Filter a results array down to the rows that are
// 📖 currently failing (auth fail / 429 / 404 / timeout). Pure helper used by
// 📖 the TUI Shift+P "re-probe failed rows only" action (issue #168) so users
// 📖 can retry 1-2 flaky providers without burning quota on the whole list.
export function selectProbeFailedRows(results) {
  if (!Array.isArray(results)) return []
  return results.filter(isProbeFailedRow)
}

// 📖 findBestModel: Pick the single best model from a results array.
// 📖 Used by --fiable mode to output the most reliable model after 10s of analysis.
//
// 📖 Selection priority (quad-key sort):
//   1. Status: "up" models always beat non-up models
//   2. Average latency: faster average wins (lower is better)
//   3. Stability score: higher stability wins (more consistent = better)
//   4. Uptime %: higher uptime wins as final tiebreaker
//
// 📖 Returns null if the array is empty.
export function findBestModel(results) {
  const sorted = [...results].sort((a, b) => {
    const avgA = getAvg(a)
    const avgB = getAvg(b)
    const stabilityA = getStabilityScore(a)
    const stabilityB = getStabilityScore(b)
    const uptimeA = getUptime(a)
    const uptimeB = getUptime(b)

    // 📖 Priority 1: Models that are currently responding beat those that aren't
    if (a.status === 'up' && b.status !== 'up') return -1
    if (a.status !== 'up' && b.status === 'up') return 1

    // 📖 Priority 2: Lower average latency = faster = better
    if (avgA !== avgB) return avgA - avgB

    // 📖 Priority 3: Higher stability = more consistent = better
    if (stabilityA !== stabilityB) return stabilityB - stabilityA

    // 📖 Priority 4: Higher uptime = more reliable = better (final tiebreaker)
    return uptimeB - uptimeA
  })

  return sorted.length > 0 ? sorted[0] : null
}

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

// 📖 parseArgs: Parse process.argv into a structured object of flags and values.
// 📖 Expects the full argv array (including 'node' and 'script' at indices 0-1).
// 📖 Slices from index 2 to get user-provided arguments only.
//
// 📖 Argument types:
//   - API key: first positional arg that does not look like a CLI flag (e.g., "nvapi-xxx")
//   - Boolean flags: --best, --fiable, --opencode, --opencode-desktop, --opencode-web, --openclaw,
//     --aider, --crush, --goose, --qwen, --kilo,
//     --openhands, --amp, --pi, --hermes, --continue, --cline,
//     --xcode, --jcode, --copilot, --forgecode, --zcode,
//     --daemon, --daemon-bg, --daemon-stop,
//     --daemon-status, --no-telemetry, --json, --help/-h (case-insensitive)
//     --playground / playground subcommand (open the in-TUI chat playground)
//     --fix-permissions / --yes / -y (auto-fix config permissions without prompting)
//   - Value flag: --tier <letter> (also accepts the --tier=S equals form)
//   - Probe-cache flags (t1):
//     --reprobe / --no-cache (boolean) — force-rebuild the probe cache this run
//     --probe-ttl <ms> (value)          — override the 24h default TTL
//     --show-broken (boolean)           — don't auto-hide broken models (one-shot)
//   - Config location flag:
//     --config-dir <dir> (value)        — override where config.json + backups/ live
//
// Returns:
//   { apiKey, bestMode, fiableMode, openCodeMode, openCodeDesktopMode, openCodeWebMode, openClawMode,
//     aiderMode, crushMode, gooseMode, qwenMode, openHandsMode, ampMode,
//     piMode, jcodeMode, copilotMode, forgecodeMode, zcodeMode, noTelemetry, jsonMode, helpMode, tierFilter,
//     reprobeMode, probeTtlMs, showBrokenMode }
//
// 📖 Note: apiKey may be null here — the main CLI falls back to env vars and saved config.

// 📖 findValueFlag: collect every occurrence of a value flag, in both "--flag value"
// 📖 and "--flag=value" forms. Equals form used to be silently ignored (the lookup
// 📖 only matched the bare flag), and repeated flags used to leak their extra values
// 📖 into the positional API-key slot because only the first index was marked used.
// 📖 Returns { indices, values }: indices point at the VALUE args (for the equals
// 📖 form, at the "--flag=value" arg itself, which is already treated as a flag).
function findValueFlag(args, flag) {
  const indices = []
  const values = []
  for (const [i, arg] of args.entries()) {
    const lower = arg.toLowerCase()
    if (lower.startsWith(`${flag}=`)) {
      indices.push(i)
      values.push(arg.slice(flag.length + 1))
    } else if (lower === flag && args[i + 1] && !args[i + 1].startsWith('--')) {
      indices.push(i + 1)
      values.push(args[i + 1])
    }
  }
  return { indices, values }
}

// 📖 First usable value of a flag, or null when the flag was not passed (or was
// 📖 passed with an empty value like "--tier=").
function firstFlagValue(found) {
  return found.values.length > 0 && found.values[0] !== '' ? found.values[0] : null
}

export function parseArgs(argv) {
  const args = argv.slice(2)
  let apiKey = null
  const flags = []

  // 📖 Resolve all value flags up front so every occurrence (space or equals form)
  // 📖 can be marked consumed before the positional API-key scan runs.
  const tierFlag = findValueFlag(args, '--tier')
  const sortFlag = findValueFlag(args, '--sort')
  const originFlag = findValueFlag(args, '--origin')
  const pingIntervalFlag = findValueFlag(args, '--ping-interval')
  const probeTtlFlag = findValueFlag(args, '--probe-ttl')
  const syncSetFlag = findValueFlag(args, '--sync-set')
  const configDirFlag = findValueFlag(args, '--config-dir')
  const driftThresholdFlag = findValueFlag(args, '--drift-threshold')

  // 📖 Set of arg indices that are values for flags (not API keys)
  const skipIndices = new Set()
  for (const found of [tierFlag, sortFlag, originFlag, pingIntervalFlag, probeTtlFlag, syncSetFlag, configDirFlag, driftThresholdFlag]) {
    for (const idx of found.indices) skipIndices.add(idx)
  }

  for (const [i, arg] of args.entries()) {
    // 📖 -y is a boolean flag (security auto-fix), never an API key
    if (arg.startsWith('--') || arg === '-h' || arg === '-y') {
      flags.push(arg.toLowerCase())
    } else if (skipIndices.has(i)) {
      // 📖 Skip — this is a value for --tier, not an API key
    } else if (i === 0 && arg.toLowerCase() === 'web') {
      // 📖 `free-coding-models web` is a subcommand, not a provider API key.
    } else if (!apiKey) {
      apiKey = arg
    }
  }

  const bestMode = flags.includes('--best')
  const fiableMode = flags.includes('--fiable')
  const openCodeMode = flags.includes('--opencode')
  const openCodeDesktopMode = flags.includes('--opencode-desktop')
  const openCodeWebMode = flags.includes('--opencode-web')
  const openClawMode = flags.includes('--openclaw')
  const aiderMode = flags.includes('--aider')
  const crushMode = flags.includes('--crush')
  const gooseMode = flags.includes('--goose')
  const qwenMode = flags.includes('--qwen')
  const kiloMode = flags.includes('--kilo')
  const openHandsMode = flags.includes('--openhands')
  const ampMode = flags.includes('--amp')
  const piMode = flags.includes('--pi')
  const hermesMode = flags.includes('--hermes')
  const continueMode = flags.includes('--continue')
  const clineMode = flags.includes('--cline')
  const xcodeMode = flags.includes('--xcode')
  const cavemanMode = flags.includes('--caveman')
  const jcodeMode = flags.includes('--jcode')
  const copilotMode = flags.includes('--copilot')
  const forgecodeMode = flags.includes('--forgecode')
  const zcodeMode = flags.includes('--zcode')
  const noTelemetry = flags.includes('--no-telemetry')
  const devMode = flags.includes('--dev')
  const jsonMode = flags.includes('--json')
  const helpMode = flags.includes('--help') || flags.includes('-h')
  const premiumMode = flags.includes('--premium')
  const daemonMode = flags.includes('--daemon')
  const daemonBackgroundMode = flags.includes('--daemon-bg')
  const daemonStopMode = flags.includes('--daemon-stop')
  const daemonStatusMode = flags.includes('--daemon-status')
  // 📖 Router v2 (beta) lifecycle flags - run v2 alongside v1 on its own
  // port (19380) with persisted breakers + decision traces. See
  // src/core/router-v2/daemon.js and docs/router-v2.md.
  const routerV2Mode = flags.includes('--router-v2')
  const routerV2BackgroundMode = flags.includes('--router-v2-bg')
  const routerV2StopMode = flags.includes('--router-v2-stop')
  const routerV2StatusMode = flags.includes('--router-v2-status')

  // 📖 --fix-permissions / --yes / -y - auto-answer "yes" to the config-permission
  // 📖 security prompt (chmod 600, best-effort on Windows) so scripts, CI and
  // 📖 non-interactive terminals never hang on a hidden prompt. Issue #173.
  const fixPermissionsMode = flags.includes('--fix-permissions') || flags.includes('--yes') || flags.includes('-y')

  // 📖 --sync-set [name] — auto-discover and populate a router set with best available models
  const syncSetMode = flags.includes('--sync-set')
  const syncSetName = firstFlagValue(syncSetFlag)

  // 📖 --web / --gui / web subcommand — launch the web dashboard instead of the TUI
  const webMode = flags.includes('--web') || flags.includes('--gui') || args[0] === 'web'

  // 📖 --playground / playground subcommand — boot the TUI directly into the
  // 📖 Playground chat overlay (assumes the router daemon is running or can
  // 📖 be started with `free-coding-models --daemon-bg` first).
  const playgroundMode = flags.includes('--playground') || args[0] === 'playground'

  // New boolean flags
  const sortDesc = flags.includes('--desc')
  const sortAscFlag = flags.includes('--asc')
  const hideUnconfigured = flags.includes('--hide-unconfigured')
  const showUnconfigured = flags.includes('--show-unconfigured')

  let tierFilter = firstFlagValue(tierFlag)?.toUpperCase() ?? null
  let sortColumn = firstFlagValue(sortFlag)?.toLowerCase() ?? null
  let originFilter = firstFlagValue(originFlag)
  let pingIntervalRaw = firstFlagValue(pingIntervalFlag)
  let pingInterval = pingIntervalRaw !== null ? parseInt(pingIntervalRaw, 10) : null
  let sortDirection = sortDesc ? 'desc' : (sortAscFlag ? 'asc' : null)

  // 📖 Profile system removed - API keys now persist permanently across all sessions

  // 📖 --recommend — launch directly into Smart Recommend mode (Q key equivalent)
  const recommendMode = flags.includes('--recommend')

  // 📖 --clear-runtime — wipe ~/.free-coding-models/runtime-telemetry.json (t3).
  // 📖 Useful when the user wants to reset the real-world-score baseline.
  const clearRuntimeMode = flags.includes('--clear-runtime')

  // 📖 Probe-cache flags (t1): --reprobe / --no-cache force a fresh probe pass;
  // 📖 --probe-ttl overrides the 24h default; --show-broken un-hides broken models for this run.
  const reprobeMode = flags.includes('--reprobe') || flags.includes('--no-cache')
  const showBrokenMode = flags.includes('--show-broken')
  const probeTtlRaw = firstFlagValue(probeTtlFlag)
  const probeTtlMs = probeTtlRaw !== null ? parseInt(probeTtlRaw, 10) : null

  // 📖 Drift detection flags (t5):
  // 📖 --check-drift (boolean) — print a drift report vs models.dev, exit non-zero on mismatch.
  // 📖 --drift-threshold <N> (value) — only fail when N+ mismatches are found.
  const checkDriftMode = flags.includes('--check-drift')
  const driftThresholdRaw = firstFlagValue(driftThresholdFlag)
  const driftThreshold = driftThresholdRaw !== null ? parseInt(driftThresholdRaw, 10) : null

  return {
    apiKey,
    bestMode,
    fiableMode,
    openCodeMode,
    openCodeDesktopMode,
    openCodeWebMode,
    openClawMode,
    aiderMode,
    crushMode,
    gooseMode,
    qwenMode,
    kiloMode,
    openHandsMode,
    ampMode,
    piMode,
    hermesMode,
    continueMode,
    clineMode,
    xcodeMode,
    cavemanMode,
    jcodeMode,
    copilotMode,
    forgecodeMode,
    zcodeMode,
    noTelemetry,
    jsonMode,
    helpMode,
    tierFilter,
    sortColumn,
    sortDirection,
    originFilter,
    pingInterval,
    hideUnconfigured,
    showUnconfigured,
    premiumMode,
    webMode,
    playgroundMode,
    daemonMode,
    daemonBackgroundMode,
    daemonStopMode,
    checkDriftMode,
    driftThreshold,
    daemonStatusMode,
    // 📖 Router v2 (beta) lifecycle flags - see src/core/router-v2/daemon.js
    routerV2Mode,
    routerV2BackgroundMode,
    routerV2StopMode,
    routerV2StatusMode,
    // 📖 Profile system removed - API keys now persist permanently across all sessions
    recommendMode,
    devMode,
    syncSetMode,
    syncSetName,
    // 📖 Probe-cache flags (t1) — see src/core/probe-cache.js
    reprobeMode,
    probeTtlMs: Number.isFinite(probeTtlMs) && probeTtlMs > 0 ? probeTtlMs : null,
    showBrokenMode,
    // 📖 Runtime telemetry flag (t3) — see src/core/runtime-telemetry.js
    clearRuntimeMode,
    // 📖 Config location flag — see src/core/config.js getConfigDir()
    configDir: firstFlagValue(configDirFlag),
    // 📖 Security auto-fix flag - see src/core/security.js checkConfigSecurity()
    fixPermissionsMode,
  }
}

// ─── Config Security Gating (issue #173) ─────────────────────────────────────

// 📖 resolveSecurityAction: pure decision helper that tells the startup security
// 📖 check what it should do about insecure config file permissions.
//
// 📖 Why: the security warning + "Fix permissions automatically?" prompt used to
// 📖 run un-awaited while the TUI entered raw mode / the alternate screen, so the
// 📖 prompt was invisible (worst on Windows) and the app looked frozen. This gate
// 📖 guarantees: never prompt without an interactive surface, never prompt a
// 📖 daemon/web/JSON surface, and always auto-fix when a yes-flag is passed.
//
// 📖 Params:
//   configExists     - does the config file exist (no file = nothing to secure)
//   isSecure         - are permissions already 0600
//   autoFixRequested - user passed --fix-permissions / --yes / -y
//   stdinIsTTY       - is stdin an interactive terminal
//   promptAllowed    - is this an interactive surface (TUI)? false for daemon/web/JSON
//
// 📖 Returns one of: 'none' | 'auto-fix' | 'warn-only' | 'prompt'
export function resolveSecurityAction({ configExists, isSecure, autoFixRequested, stdinIsTTY, promptAllowed }) {
  if (!configExists || isSecure) return 'none'
  if (autoFixRequested) return 'auto-fix'
  if (!stdinIsTTY || !promptAllowed) return 'warn-only'
  return 'prompt'
}

// 📖 parseIcaclsOutput: PURE parser for Windows `icacls <file>` output, used by
// 📖 the config security check to get a REAL answer about NTFS access.
// 📖 WHY: on win32 Node reports POSIX-style modes as 0666 (writable) or 0444
// 📖 (read-only) only - 0600 is unreachable - so the old `(mode & 0o777) === 0o600`
// 📖 test was always false and the warning re-fired on every launch (issue #173
// 📖 follow-up from rutexd). Only the ACL tells the truth on NTFS.
// 📖
// 📖 Sample output we must handle (ACEs, one per line, path on the first line):
//   C:\Users\rutex\.free-coding-models.json NT AUTHORITY\SYSTEM:(I)(F)
//                                           BUILTIN\Administrators:(I)(F)
//                                           DESKTOP-XYZ\rutex:(F)
//   Successfully processed 1 files; Failed processing 0 files
// 📖 `(I)` marks an inherited ACE, so "inheritance disabled" = no `(I)` anywhere.
// 📖 Locale-proof whitelists: names are machine-localized, so we whitelist by
// 📖 substring (SYSTEM, Administra* covers Administrators/Administrateurs) and
// 📖 by well-known SID (S-1-5-18 = SYSTEM, S-1-5-32-544 = Administrators), plus
// 📖 the current user (case-insensitive, domain-qualified or bare).
// 📖
// 📖 Params:
//   output   - raw stdout of `icacls <path>` (string)
//   userName - current user name (string), e.g. "rutex"
//   filePath - the exact path passed to icacls (optional but STRONGLY
//              recommended: icacls echoes it on the first line, glued to the
//              first ACE, and paths/account names can both contain spaces)
// 📖 Returns { inheritanceEnabled, othersHaveAccess, ownerHasAccess, grants }
//   grants = [{ name, flags }] for every ACE line; empty when output unparseable.
export function parseIcaclsOutput({ output, userName, filePath = '' }) {
  const text = String(output ?? '')
  const user = String(userName ?? '').trim().toLowerCase()
  const knownPath = String(filePath ?? '')
  const lines = text.split(/\r?\n/)

  // 📖 The rights/flags groups always end the line: "(I)(F)", "(F)", "(R,W)"...
  const aceTail = /((?:\([^)]*\)\s*)+)$/
  const grants = []
  for (const rawLine of lines) {
    const tail = aceTail.exec(rawLine)
    if (!tail) continue

    let before = rawLine.slice(0, tail.index).trim()
    if (before === '') continue
    // 📖 Drop the colon that separates the account name from its flags.
    before = before.replace(/:$/, '').trim()
    // 📖 First ACE shares its line with the echoed path: strip the path we
    // 📖 passed to icacls. Without a known path, keep only the segment after
    // 📖 the last whitespace (exact for simple names; callers should pass
    // 📖 filePath when the path or account name contains spaces).
    if (knownPath && before.startsWith(knownPath)) {
      before = before.slice(knownPath.length).trim()
    } else if (knownPath === '' && /\s/.test(before)) {
      before = before.slice(before.lastIndexOf(' ') + 1).trim()
    }
    if (before === '') continue
    grants.push({ name: before, flags: tail[1].replace(/\s+/g, '') })
  }

  const isTrusted = (name) => {
    const n = name.toLowerCase()
    if (user !== '' && (n === user || n.endsWith('\\' + user))) return true
    if (n.includes('system') || n.includes('s-1-5-18')) return true
    if (n.includes('administra') || n.includes('s-1-5-32-544')) return true
    return false
  }

  const inheritanceEnabled = grants.some((g) => g.flags.includes('I'))
  const others = grants.filter((g) => !isTrusted(g.name)).map((g) => g.name)
  const ownerHasAccess = grants.some((g) => {
    const n = g.name.toLowerCase()
    return user !== '' && (n === user || n.endsWith('\\' + user))
  })

  return {
    inheritanceEnabled,
    othersHaveAccess: others.length > 0,
    ownerHasAccess,
    grants,
    otherNames: others,
  }
}

// 📖 shouldSkipSecurityWarn: PURE anti-nag gate for the config security warning.
// 📖 WHY: when the permission fix cannot be applied or verified (rare: icacls
// 📖 missing on Windows, chmod failing on POSIX), the insecure state persists and
// 📖 the warning used to re-fire on every single launch. Once we warned and the
// 📖 fix did not stick, stay quiet for `intervalDays` (default 30) instead of
// 📖 nagging daily. `--fix-permissions` bypasses the gate in the caller.
// 📖 Params: ackedAt - last warning timestamp (ms epoch or ISO string or null)
//           now - current time in ms epoch; intervalDays - quiet window length
// 📖 Returns true only when ackedAt parses AND is less than intervalDays old.
export function shouldSkipSecurityWarn({ ackedAt, now = Date.now(), intervalDays = 30 }) {
  if (ackedAt === null || ackedAt === undefined || ackedAt === '') return false
  const then = typeof ackedAt === 'number' ? ackedAt : Date.parse(String(ackedAt))
  if (!Number.isFinite(then)) return false
  const intervalMs = Math.max(0, intervalDays) * 24 * 60 * 60 * 1000
  return now - then < intervalMs && now >= then
}

// 📖 detectTerminalCapabilities: PURE terminal capability probe for TUI overlays.
// 📖 WHY: basic server consoles (IPMI/KVM viewers, ASPEED framebuffer, serial
// 📖 terminals) often run 80x24 or smaller with no or limited color support, and
// 📖 the palette/overlays must degrade instead of overflowing or painting garbage.
// 📖 Everything is injected by the caller (env, size, TTY) so tests never touch
// 📖 process.env and the function stays deterministic.
//
// 📖 Rules:
//   - FORCE_COLOR wins over NO_COLOR (same precedence chalk uses).
//   - NO_COLOR (non-empty, per no-color.org spec) disables color.
//   - Not a TTY, TERM missing / "dumb" / "unknown" disables color, unless
//     COLORTERM is set (some terminals export only COLORTERM).
//   - compact = size too tight for the roomy overlay layout (cols < 90 or rows < 24,
//     thresholds chosen so a plain 80x24 console gets the space-saving layout).
//
// 📖 Returns { colorSupported: boolean, compact: boolean }
export function detectTerminalCapabilities({ env = {}, cols = 80, rows = 24, isTTY = true } = {}) {
  const term = String(env.TERM ?? '').trim().toLowerCase()
  const colorterm = String(env.COLORTERM ?? '').trim().toLowerCase()
  const force = env.FORCE_COLOR
  const forceOn = force !== undefined && force !== '' && force !== '0' && force !== 'false'
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== ''
  const termUsable = term !== '' && term !== 'dumb' && term !== 'unknown'
  const colorSupported = forceOn || (!noColor && isTTY !== false && (termUsable || colorterm !== ''))
  const compact = Math.floor(cols) < 90 || Math.floor(rows) < 24
  return { colorSupported, compact }
}

// ─── Smart Recommend — Scoring Engine ─────────────────────────────────────────

// 📖 Task types for the Smart Recommend questionnaire.
// 📖 Each task type has different weight priorities — quick fixes favor speed,
//    deep refactors favor SWE score and context, code review needs balanced quality,
//    test generation needs high SWE score + medium context.
export const TASK_TYPES = {
  quickfix:    { label: 'Quick Fix',       sweWeight: 0.2, speedWeight: 0.5, ctxWeight: 0.1, stabilityWeight: 0.2 },
  refactor:    { label: 'Deep Refactor',   sweWeight: 0.4, speedWeight: 0.1, ctxWeight: 0.3, stabilityWeight: 0.2 },
  review:      { label: 'Code Review',     sweWeight: 0.35, speedWeight: 0.2, ctxWeight: 0.25, stabilityWeight: 0.2 },
  testgen:     { label: 'Test Generation', sweWeight: 0.35, speedWeight: 0.15, ctxWeight: 0.2, stabilityWeight: 0.3 },
}

// 📖 Priority presets — bias the scoring toward speed or quality.
// 📖 'speed' amplifies latency weighting, 'quality' amplifies SWE score weighting.
export const PRIORITY_TYPES = {
  speed:   { label: 'Speed',   speedMultiplier: 1.5, sweMultiplier: 0.7 },
  quality: { label: 'Quality', speedMultiplier: 0.7, sweMultiplier: 1.5 },
  balanced:{ label: 'Balanced', speedMultiplier: 1.0, sweMultiplier: 1.0 },
}

// 📖 Context budget categories — match against model's context window size.
// 📖 'small' (<4K tokens) can use any model. 'large' (>32K) strongly penalizes small-ctx models.
export const CONTEXT_BUDGETS = {
  small:  { label: 'Small file (<4K)',      minCtx: 0,     idealCtx: 32 },
  medium: { label: 'Medium project (<32K)', minCtx: 32,    idealCtx: 128 },
  large:  { label: 'Large codebase (>32K)', minCtx: 128,   idealCtx: 256 },
}

// 📖 parseCtxToK: Convert context window string ("128k", "1m", "200k") into numeric K tokens.
// 📖 Used by the scoring engine to compare against CONTEXT_BUDGETS thresholds.
export function parseCtxToK(ctx) {
  if (!ctx || ctx === '—') return 0
  const str = ctx.toLowerCase()
  if (str.includes('m')) return parseFloat(str.replace('m', '')) * 1000
  if (str.includes('k')) return parseFloat(str.replace('k', ''))
  return 0
}

// 📖 formatCtxWindow: Convert context_length number to compact string (256000 → '256k', 1048576 → '1M')
// 📖 Used by dynamic OpenRouter model discovery to convert API response to our display format.
export function formatCtxWindow(n) {
  if (typeof n !== 'number' || n <= 0) return '128k'
  if (n >= 1_000_000) return Math.round(n / 1_000_000) + 'M'
  return Math.round(n / 1000) + 'k'
}

// 📖 labelFromId: Build a human-readable label from an OpenRouter model ID.
// 📖 'qwen/qwen3-coder:free' → 'Qwen3 Coder'
export function labelFromId(id) {
  const base = id.replace(/:free$/, '')
  const name = base.includes('/') ? base.split('/').pop() : base
  return name
    .split(/[-_]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// 📖 parseSweToNum: Convert SWE-bench score string ("49.2%", "73.1%") into a 0–100 number.
// 📖 Returns 0 for missing or invalid scores.
export function parseSweToNum(sweScore) {
  if (!sweScore || sweScore === '—') return 0
  const num = parseFloat(sweScore.replace('%', ''))
  return isNaN(num) ? 0 : num
}

/**
 * 📖 scoreModelForTask: Score a single model result for a specific task/priority/context combination.
 *
 * 📖 The score is a weighted composite of 4 signals:
 *   - SWE quality score (0–100): how good the model is at coding (from sources.js benchmarks)
 *   - Speed score (0–100): inverse of average latency (faster = higher score)
 *   - Context fit score (0–100): how well the model's context window matches the user's budget
 *   - Stability score (0–100): composite p95/jitter/uptime from getStabilityScore()
 *
 * 📖 Each signal is weighted by the task type, then further adjusted by the priority multiplier.
 * 📖 Models that are down/timeout get a harsh penalty but aren't completely excluded
 *    (they might come back up during the analysis phase).
 *
 * @param {object} result — A model result object (from state.results)
 * @param {string} taskType — Key from TASK_TYPES ('quickfix'|'refactor'|'review'|'testgen')
 * @param {string} priority — Key from PRIORITY_TYPES ('speed'|'quality'|'balanced')
 * @param {string} contextBudget — Key from CONTEXT_BUDGETS ('small'|'medium'|'large')
 * @returns {number} Score between 0 and 100 (higher = better recommendation)
 */
export function scoreModelForTask(result, taskType, priority, contextBudget) {
  const task = TASK_TYPES[taskType]
  const prio = PRIORITY_TYPES[priority]
  const budget = CONTEXT_BUDGETS[contextBudget]
  if (!task || !prio || !budget) return 0

  // 📖 SWE quality signal (0–100) — raw SWE-bench score
  const sweNum = parseSweToNum(result.sweScore)
  const sweScore = Math.min(100, sweNum * (100 / 80)) // 📖 Normalize: 80% SWE → 100 score

  // 📖 Speed signal (0–100) — inverse latency, capped at 5000ms
  const avg = getAvg(result)
  let speedScore
  if (avg === Infinity) {
    speedScore = 0 // 📖 No data yet — can't judge speed
  } else {
    speedScore = Math.max(0, Math.min(100, 100 * (1 - avg / 5000)))
  }

  // 📖 Context fit signal (0–100):
  //   - Full score if model ctx >= idealCtx
  //   - Partial score if model ctx >= minCtx but < idealCtx (linear interpolation)
  //   - Zero if model ctx < minCtx (too small for the job)
  const modelCtx = parseCtxToK(result.ctx)
  let ctxScore
  if (modelCtx >= budget.idealCtx) {
    ctxScore = 100
  } else if (modelCtx >= budget.minCtx) {
    ctxScore = budget.idealCtx === budget.minCtx
      ? 100
      : Math.round(100 * (modelCtx - budget.minCtx) / (budget.idealCtx - budget.minCtx))
  } else {
    ctxScore = 0
  }

  // 📖 Stability signal (0–100) — from getStabilityScore(), or 0 if no data
  const stability = getStabilityScore(result)
  const stabScore = stability === -1 ? 0 : stability

  // 📖 Weighted combination: task weights × priority multipliers
  const rawScore =
    (sweScore   * task.sweWeight       * prio.sweMultiplier) +
    (speedScore * task.speedWeight     * prio.speedMultiplier) +
    (ctxScore   * task.ctxWeight) +
    (stabScore  * task.stabilityWeight)

  // 📖 Normalize by total effective weight to keep result in 0–100 range
  const totalWeight =
    (task.sweWeight   * prio.sweMultiplier) +
    (task.speedWeight * prio.speedMultiplier) +
    task.ctxWeight +
    task.stabilityWeight

  let score = totalWeight > 0 ? rawScore / totalWeight : 0

  // 📖 Penalty for models that are currently down/timeout — still scoreable but penalized
  if (result.status === 'down' || result.status === 'timeout') {
    score *= 0.2
  }

  return Math.round(Math.min(100, Math.max(0, score)))
}

/**
 * 📖 getTopRecommendations: Score all models and return the top N recommendations.
 *
 * 📖 Filters out hidden models, scores each one, sorts descending, returns topN.
 * 📖 Each returned item includes the original result + computed score for display.
 *
 * @param {Array} results — Full state.results array
 * @param {string} taskType — Key from TASK_TYPES
 * @param {string} priority — Key from PRIORITY_TYPES
 * @param {string} contextBudget — Key from CONTEXT_BUDGETS
 * @param {number} [topN=3] — How many recommendations to return
 * @returns {Array<{result: object, score: number}>} Top N scored models, descending by score
 */
export function getTopRecommendations(results, taskType, priority, contextBudget, topN = 3) {
  const scored = results
    .filter(r => !r.hidden)
    .map(r => ({ result: r, score: scoreModelForTask(r, taskType, priority, contextBudget) }))
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, topN)
}

/**
 * 📖 getVersionStatusInfo turns startup + manual update-check state into a compact,
 * 📖 render-friendly footer descriptor for the main table.
 *
 * 📖 Priority:
 * 📖   1. Manual Settings check found an update (`available`)
 * 📖   2. Startup auto-check already found a newer npm version
 * 📖   3. Otherwise stay quiet
 * 📖
 * 📖 `versionAlertsEnabled` lets the CLI suppress npm-specific warnings in dev checkouts,
 * 📖 where telling contributors to run a global npm update would be bogus.
 *
 * @param {'idle'|'checking'|'available'|'up-to-date'|'error'|'installing'} updateState
 * @param {string|null} latestVersion
 * @param {string|null} [startupLatestVersion=null]
 * @param {boolean} [versionAlertsEnabled=true]
 * @returns {{ isOutdated: boolean, latestVersion: string|null }}
 */
export function getVersionStatusInfo(updateState, latestVersion, startupLatestVersion = null, versionAlertsEnabled = true) {
  if (!versionAlertsEnabled) {
    return {
      isOutdated: false,
      latestVersion: null,
    }
  }

  if (updateState === 'available' && typeof latestVersion === 'string' && latestVersion.trim()) {
    return {
      isOutdated: true,
      latestVersion: latestVersion.trim(),
    }
  }

  if (typeof startupLatestVersion === 'string' && startupLatestVersion.trim()) {
    return {
      isOutdated: true,
      latestVersion: startupLatestVersion.trim(),
    }
  }

  return {
    isOutdated: false,
    latestVersion: null,
  }
}

/**
 * 📖 formatResultsAsJSON converts model results to clean JSON output for scripting/automation.
 *
 * 📖 This is used by the --json flag to output results in a machine-readable format.
 * 📖 The output is designed to be:
 *    - Easy to parse with jq, grep, awk, or any JSON library
 *    - Human-readable for debugging
 *    - Stable (field names won't change between versions)
 *
 * 📖 Output format:
 *   [
 *     {
 *       "rank": 1,
 *       "modelId": "nvidia/deepseek-ai/deepseek-v4-flash",
 *       "label": "DeepSeek V4 Flash",
 *       "provider": "nvidia",
 *       "tier": "S+",
 *       "sweScore": "72.0%",
 *       "context": "128k",
 *       "latestPing": 245,
 *       "avgPing": 260,
 *       "p95": 312,
 *       "jitter": 45,
 *       "stability": 87,
 *       "uptime": 95.5,
 *       "verdict": "Perfect",
 *       "status": "up"
 *     },
 *     ...
 *   ]
 *
 * 📖 Note: NaN and Infinity values are converted to null for cleaner JSON.
 *
 * @param {Array} results — Model result objects from the TUI
 * @param {string} sortBy — Current sort column (for rank calculation)
 * @param {number} limit — Maximum number of results to return (0 = all)
 * @returns {string} JSON string of formatted results
 */
export function formatResultsAsJSON(results, sortBy = 'avg', limit = 0) {
  // 📖 Only slice for a usable positive limit: a negative limit used to drop the
  // 📖 last row(s) via slice(0, -1), and 0/undefined means "all results".
  const effectiveLimit = Number.isInteger(limit) && limit > 0 ? limit : undefined
  const formatted = results
    .map((r, idx) => ({
      rank: r.idx || idx + 1,
      modelId: r.modelId || null,
      label: r.label || null,
      provider: r.providerKey || null,
      tier: r.tier || null,
      sweScore: r.sweScore || null,
      context: r.ctx || null,
      latestPing: (r.pings && r.pings.length > 0) ? r.pings[r.pings.length - 1].ms : null,
      avgPing: (Number.isFinite(r.avg)) ? r.avg : null,
      p95: (Number.isFinite(r.p95)) ? r.p95 : null,
      jitter: (Number.isFinite(r.jitter)) ? r.jitter : null,
      stability: (Number.isFinite(r.stability)) ? r.stability : null,
      uptime: (Number.isFinite(r.uptime)) ? r.uptime : null,
      verdict: r.verdict || null,
      status: r.status || null,
      httpCode: r.httpCode || null
    }))
    .slice(0, effectiveLimit)

  return JSON.stringify(formatted, null, 2)
}

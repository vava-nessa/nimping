/**
 * @file models-drift.js
 * @description Drift detection between `sources.js` (our curated catalog) and the live
 *              models.dev community catalog. Compares context window, max output tokens,
 *              and capability flags (reasoning / vision / thinking). Reports mismatches
 *              but never auto-rewrites sources.js — a human approves the edit.
 *
 * @details
 *   📖 Why this exists:
 *   📖 - sources.js is curated but `ctx` drifts constantly (128k → 256k → 1M).
 *   📖 - We don't want to silently overwrite curated values; we want to surface
 *   📖   the drift so a human can review it.
 *   📖 - Used by:
 *   📖     1. `scripts/check-drift.mjs` (CLI: `free-coding-models --check-drift`)
 *   📖     2. `.github/workflows/check-drift.yml` (weekly CI — opens an issue)
 *   📖     3. The TUI footer chip + /health endpoint (read-only)
 *
 *   📖 What "drift" means here:
 *   📖   - ctx: sources.js says "128k", models.dev says 256000 → UPDATE
 *   📖   - maxTokens: sources.js has no value, models.dev says 65536 → ADD
 *   📖   - reasoning/vision flags: sources.js is null, models.dev has the flag → ADD
 *   📖   - exact match: ✓ (no action)
 *
 *   📖 A "field mismatch" entry has:
 *   📖   { modelId, field, sourcesJsValue, modelsDevValue, action: 'update'|'add'|'remove' }
 *
 * @functions
 *   → detectDrift(models, catalog, opts?)              — Returns a list of field mismatches
 *   → summarizeDrift(mismatches)                       — { total, byField, byModel, modelsAffected }
 *   → formatDriftReport(mismatches, opts?)             — Pretty-print a human-readable report
 *   → parseCtxToNum(ctx)                               — "128k" / "1m" → number
 *   → DRIFT_FIELDS                                     — The list of fields we check
 *
 * @exports detectDrift, summarizeDrift, formatDriftReport, parseCtxToNum, DRIFT_FIELDS
 *
 * @see src/core/models-dev-fetcher.js — provides the live catalog
 * @see src/core/models-dev-index.js  — provides the lookup helpers
 * @see scripts/check-drift.mjs       — CLI consumer
 */

import { buildModelIndex, lookupModelDevMeta, normalizeModelDevEntry } from './models-dev-index.js'

/** 📖 Fields we check for drift. Each has a sources.js column + a models.dev mapping. */
export const DRIFT_FIELDS = ['ctx', 'maxTokens', 'reasoning', 'vision', 'thinking']

/**
 * 📖 Convert a sources.js ctx string ("128k", "1m", "262144") to a number.
 * 📖 Mirrors parseCtxToK from utils.js but returns raw tokens (not thousands).
 * 📖 Returns null if the string is empty, "-", or unparseable.
 */
export function parseCtxToNum(ctx) {
  if (ctx == null) return null
  const s = String(ctx).trim()
  if (!s || s === '-' || s === '—') return null
  // Pure number
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  // Suffix
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([km])$/i)
  if (m) {
    const n = parseFloat(m[1])
    const unit = m[2].toLowerCase()
    if (unit === 'k') return Math.round(n * 1000)
    if (unit === 'm') return Math.round(n * 1_000_000)
  }
  return null
}

// ─── Comparison helpers ──────────────────────────────────────────────────────

function contextMatch(sourcesJsCtx, devContextWindow) {
  const a = parseCtxToNum(sourcesJsCtx)
  const b = (typeof devContextWindow === 'number' && Number.isFinite(devContextWindow)) ? devContextWindow : null
  if (a == null && b == null) return { status: 'both-null' }
  if (a == null && b != null) return { status: 'add', sourcesJs: null, dev: b }
  if (a != null && b == null) return { status: 'dev-missing', sourcesJs: a, dev: null }
  // 📖 Allow 5% tolerance for vendor-specific rounding
  if (Math.abs(a - b) <= Math.max(a, b) * 0.05) return { status: 'match', sourcesJs: a, dev: b }
  return { status: 'drift', sourcesJs: a, dev: b }
}

function flagMatch(sourcesJsFlag, devFlag) {
  // 📖 sources.js stores capability flags as booleans (true/false) or null/undefined
  const a = sourcesJsFlag === true
  const b = devFlag === true
  if (!a && !b) return { status: 'both-off' }
  if (!a && b) return { status: 'add', sourcesJs: false, dev: true }
  if (a && !b) return { status: 'drift', sourcesJs: true, dev: false }
  return { status: 'match' }
}

function numMatch(sourcesJsNum, devNum) {
  const a = (typeof sourcesJsNum === 'number' && Number.isFinite(sourcesJsNum)) ? sourcesJsNum : null
  const b = (typeof devNum === 'number' && Number.isFinite(devNum)) ? devNum : null
  if (a == null && b == null) return { status: 'both-null' }
  if (a == null && b != null) return { status: 'add', sourcesJs: null, dev: b }
  if (a != null && b == null) return { status: 'dev-missing', sourcesJs: a, dev: null }
  if (a === b) return { status: 'match', sourcesJs: a, dev: b }
  return { status: 'drift', sourcesJs: a, dev: b }
}

// ─── Main detection ──────────────────────────────────────────────────────────

/**
 * 📖 Run drift detection over the sources.js model list against the live catalog.
 * 📖 Returns a list of per-field mismatches. Use `summarizeDrift` + `formatDriftReport`
 * 📖 to render the result.
 *
 * 📖 Each model in `models` should be a sources.js tuple:
 * 📖   [modelId, label, tier, sweScore, ctx, providerKey, ...]
 * 📖 or an object with the same fields.
 *
 * @param {Array} models — sources.js MODELS array
 * @param {object} catalog — parsed models.dev catalog (or null = no drift)
 * @param {object} [opts]
 * @param {object} [opts.index] — Pre-built index (skips the build)
 * @param {number} [opts.threshold=0] — Min mismatches to report; 0 = all
 * @returns {Array<{
 *   modelId: string, label: string, field: string,
 *   sourcesJsValue: any, modelsDevValue: any,
 *   action: 'update'|'add'|'drift', matchKind: 'exact'|'alias'|'substring'|'none'
 * }>}
 */
export function detectDrift(models, catalog, opts = {}) {
  if (!Array.isArray(models) || models.length === 0) return []
  if (!catalog || typeof catalog !== 'object') return []

  const index = opts.index ?? buildModelIndex(catalog)
  const threshold = opts.threshold ?? 0
  const out = []

  for (const entry of models) {
    // 📖 Accept both tuple form and object form
    let modelId, label, ctx, reasoning, vision, thinking, maxTokens
    let isTupleForm = false
    if (Array.isArray(entry)) {
      [modelId, label, , , ctx] = entry
      isTupleForm = true
      // 📖 The 6th+ elements of the sources.js tuple are providerKey + metadata;
      // 📖 for drift we only need the first 5.
    } else if (entry && typeof entry === 'object') {
      ({ modelId, label, ctx, reasoning, vision, thinking, maxTokens } = entry)
    } else {
      continue
    }
    if (!modelId) continue

    const match = lookupModelDevMeta(modelId, label, index)
    if (!match) continue
    const norm = match.entry
    const matchKind = match.matchKind

    // 📖 Skip substring matches for ctx/metadata to avoid false positives.
    // 📖 Only exact + alias matches contribute to drift.
    if (matchKind === 'substring') continue

    // ctx
    const ctxCmp = contextMatch(ctx, norm.contextWindow)
    if (ctxCmp.status === 'drift' || ctxCmp.status === 'add') {
      out.push({
        modelId, label, field: 'ctx',
        sourcesJsValue: ctxCmp.sourcesJs,
        modelsDevValue: ctxCmp.dev,
        action: ctxCmp.status === 'add' ? 'add' : 'update',
        matchKind,
      })
    }

    // 📖 Tuple-form entries carry no capability flags or maxTokens (arity 5), so
    // 📖 flagMatch(undefined, true) used to report a bogus "add" for every capable
    // 📖 model and bury the real ctx drift under noise. Only object-form entries
    // 📖 (which can actually hold these fields) are compared.
    if (isTupleForm) continue

    // maxTokens
    const maxCmp = numMatch(maxTokens, norm.maxOutputTokens)
    if (maxCmp.status === 'drift' || maxCmp.status === 'add') {
      out.push({
        modelId, label, field: 'maxTokens',
        sourcesJsValue: maxCmp.sourcesJs,
        modelsDevValue: maxCmp.dev,
        action: maxCmp.status === 'add' ? 'add' : 'update',
        matchKind,
      })
    }
    // reasoning
    const rCmp = flagMatch(reasoning, norm.reasoning)
    if (rCmp.status === 'drift' || rCmp.status === 'add') {
      out.push({
        modelId, label, field: 'reasoning',
        sourcesJsValue: rCmp.sourcesJs,
        modelsDevValue: rCmp.dev,
        action: rCmp.status === 'add' ? 'add' : 'update',
        matchKind,
      })
    }
    // vision
    const vCmp = flagMatch(vision, norm.vision)
    if (vCmp.status === 'drift' || vCmp.status === 'add') {
      out.push({
        modelId, label, field: 'vision',
        sourcesJsValue: vCmp.sourcesJs,
        modelsDevValue: vCmp.dev,
        action: vCmp.status === 'add' ? 'add' : 'update',
        matchKind,
      })
    }
    // thinking
    const tCmp = flagMatch(thinking, norm.thinking)
    if (tCmp.status === 'drift' || tCmp.status === 'add') {
      out.push({
        modelId, label, field: 'thinking',
        sourcesJsValue: tCmp.sourcesJs,
        modelsDevValue: tCmp.dev,
        action: tCmp.status === 'add' ? 'add' : 'update',
        matchKind,
      })
    }
  }

  if (threshold > 0 && out.length < threshold) {
    return []
  }
  return out
}

// ─── Summary + report ────────────────────────────────────────────────────────

/**
 * 📖 Aggregate stats over a drift result list. Used by the TUI footer chip and
 * 📖 the /health endpoint.
 *
 * @param {Array} mismatches — Output of detectDrift
 * @returns {{
 *   total: number,
 *   byField: Record<string, number>,
 *   byAction: Record<string, number>,
 *   modelsAffected: string[]
 * }}
 */
export function summarizeDrift(mismatches) {
  const byField = Object.fromEntries(DRIFT_FIELDS.map(f => [f, 0]))
  const byAction = { update: 0, add: 0, drift: 0 }
  const modelsSet = new Set()
  for (const m of mismatches || []) {
    byField[m.field] = (byField[m.field] ?? 0) + 1
    byAction[m.action] = (byAction[m.action] ?? 0) + 1
    modelsSet.add(m.modelId)
  }
  return {
    total: (mismatches || []).length,
    byField,
    byAction,
    modelsAffected: Array.from(modelsSet).sort(),
  }
}

/**
 * 📖 Format a drift report for human reading. Used by the CLI script and the
 * 📖 GitHub Actions workflow (which posts the report to an issue).
 *
 * @param {Array} mismatches — Output of detectDrift
 * @param {object} [opts]
 * @param {boolean} [opts.useColor=true] — ANSI-color the output
 * @returns {string} Multi-line report
 */
export function formatDriftReport(mismatches, opts = {}) {
  const useColor = opts.useColor !== false && process.stdout?.isTTY === true
  const RED = useColor ? '\x1b[31m' : ''
  const YEL = useColor ? '\x1b[33m' : ''
  const GRN = useColor ? '\x1b[32m' : ''
  const DIM = useColor ? '\x1b[2m' : ''
  const RST = useColor ? '\x1b[0m' : ''

  const summary = summarizeDrift(mismatches)
  if (summary.total === 0) {
    return `${GRN}✓ No catalog drift detected${RST} ${DIM}(all models match models.dev)${RST}`
  }
  const lines = []
  lines.push(`${YEL}⚠️  Catalog drift detected (${summary.total} mismatches across ${summary.modelsAffected.length} models)${RST}`)
  lines.push('')

  // 📖 Group by model for readability
  const byModel = new Map()
  for (const m of mismatches) {
    const list = byModel.get(m.modelId) ?? []
    list.push(m)
    byModel.set(m.modelId, list)
  }
  for (const [modelId, list] of byModel) {
    const label = list[0].label || modelId
    lines.push(`  ${label} ${DIM}(${modelId})${RST}`)
    for (const m of list) {
      const arrow = m.action === 'add' ? '← ADD' : '← UPDATE'
      const color = m.action === 'add' ? GRN : RED
      const sj = m.sourcesJsValue === null || m.sourcesJsValue === undefined ? '—' : String(m.sourcesJsValue)
      const dv = m.modelsDevValue === null || m.modelsDevValue === undefined ? '—' : String(m.modelsDevValue)
      lines.push(`    ${DIM}${m.field.padEnd(11)}${RST} sources.js=${sj}  models.dev=${dv}  ${color}${arrow}${RST}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// Re-export normalizeModelDevEntry for convenience (drift callers often need it)
export { normalizeModelDevEntry }

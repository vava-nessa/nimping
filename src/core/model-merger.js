import { parseCtxToK, parseSweToNum } from './utils.js'
import { lookupExtendedBenchmark, mergeExtendedBenchmark, getCatalogStats as getExtendedBenchStats } from './extended-benchmarks.js'

const TIER_RANK = { 'S+': 0, 'S': 1, 'A+': 2, 'A': 3, 'A-': 4, 'B+': 5, 'B': 6, 'C': 7 }

/**
 * Generate a unique slug from a label.
 * "DeepSeek V3.2" → "deepseek-v3-2"
 * Appends suffix if collision detected.
 */
function slugify(label, existingSlugs) {
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  let slug = base
  let i = 2
  while (existingSlugs.has(slug)) {
    slug = `${base}-${i++}`
  }
  existingSlugs.add(slug)
  return slug
}

/**
 * Build merged model list from flat MODELS array.
 * Groups by display label. Each merged entry contains all providers.
 *
 * @param {Array} models - Flat array of [modelId, label, tier, sweScore, ctx, providerKey]
 * @returns {Array<MergedModel>}
 *
 * MergedModel: {
 *   slug: string,           // unique URL-safe identifier
 *   label: string,          // display name
 *   tier: string,           // best tier across providers
 *   sweScore: string,       // highest SWE score
 *   ctx: string,            // largest context window
 *   providerCount: number,
 *   providers: Array<{ modelId: string, providerKey: string, tier: string }>
 * }
 */
export function buildMergedModels(models) {
  const groups = new Map()

  for (const [modelId, label, tier, sweScore, ctx, providerKey] of models) {
    if (!groups.has(label)) {
      groups.set(label, { label, tier, sweScore, ctx, providers: [] })
    }

    const group = groups.get(label)
    group.providers.push({ modelId, providerKey, tier })

    // Keep best tier
    if ((TIER_RANK[tier] ?? 99) < (TIER_RANK[group.tier] ?? 99)) {
      group.tier = tier
    }
    // Keep highest SWE score
    if (parseSweToNum(sweScore) > parseSweToNum(group.sweScore)) {
      group.sweScore = sweScore
    }
    // Keep largest context
    if (parseCtxToK(ctx) > parseCtxToK(group.ctx)) {
      group.ctx = ctx
    }
  }

  const existingSlugs = new Set()
  return Array.from(groups.values()).map(g => ({
    ...g,
    slug: slugify(g.label, existingSlugs),
    providerCount: g.providers.length,
  }))
}

// ─── Extended-benchmark overlay (t4) ─────────────────────────────────────────

/**
 * 📖 Overlay the extended-benchmark catalog (Coding/Math/Agentic/Reasoning/MMLU-Pro/
 * 📖 GPQA/HLE + reasoning/vision flags) onto every merged model. The catalog is
 * 📖 a static JSON in `src/data/benchmarks.json`, looked up via prefix-index for
 * 📖 O(key length) cost. We try the group's primary modelId first, then any of its
 * 📖 provider variants as a fallback.
 *
 * 📖 Returns a NEW array of merged models — does not mutate the input.
 *
 * @param {Array} mergedModels — Output of buildMergedModels
 * @returns {Array} The same models with `extendedBench` + `metaSourceExt` set
 */
export function overlayExtendedBenchmarks(mergedModels) {
  if (!Array.isArray(mergedModels)) return mergedModels
  return mergedModels.map(m => {
    // 📖 Try the primary modelId first, then provider variants
    let entry = null
    if (m.providers && m.providers.length > 0) {
      for (const p of m.providers) {
        entry = lookupExtendedBenchmark(p.modelId)
        if (entry) break
      }
    }
    return mergeExtendedBenchmark(m, entry)
  })
}

// ─── models.dev overlay (t5) ──────────────────────────────────────────────────

/**
 * 📖 Async: enrich every merged model with live metadata from models.dev
 * 📖 (context window, max output tokens, reasoning/vision/thinking flags). This
 * 📖 runs in the background — the TUI renders with sources.js values first, then
 * 📖 re-renders once the fetch resolves. If the fetch fails, the overlay is a
 * 📖 no-op and `metaSource` stays at 'sources.js'.
 *
 * 📖 `metaSource` reflects which layer currently holds the values:
 * 📖   - 'sources.js'      — curated only (no live data, or fetch failed)
 * 📖   - 'models.dev'      — live values replaced the curated ones
 * 📖   - 'sources.js+md'   — live overlay + curated (no overrides applied)
 *
 * @param {Array} mergedModels — Output of buildMergedModels (or overlayExtendedBenchmarks)
 * @param {object} [opts]
 * @param {Function} [opts.fetchCatalog] — Injected fetcher (defaults to fetchModelsDevCatalog)
 * @param {Function} [opts.buildIndex]  — Injected indexer (defaults to buildModelIndex)
 * @param {Function} [opts.lookup]      — Injected lookup (defaults to lookupModelDevMeta)
 * @param {boolean} [opts.mutate=false] — Mutate input in place
 * @returns {Promise<Array>} The same models with `modelsDevMeta` + `metaSource` set
 */
export async function overlayModelsDevMetadata(mergedModels, opts = {}) {
  if (!Array.isArray(mergedModels)) return mergedModels

  // 📖 Resolve dependencies (with lazy import to avoid a hard dep when t5 is unused)
  const fetchCatalog = opts.fetchCatalog
    ?? (await import('./models-dev-fetcher.js')).fetchModelsDevCatalog
  const buildIndex = opts.buildIndex
    ?? (await import('./models-dev-index.js')).buildModelIndex
  const lookup = opts.lookup
    ?? (await import('./models-dev-index.js')).lookupModelDevMeta

  let catalog = null
  try {
    catalog = await fetchCatalog({ silent: true })
  } catch {
    catalog = null
  }
  if (!catalog || typeof catalog !== 'object') {
    // 📖 Fetch failed — leave models untouched, mark provenance
    return mergedModels.map(m => ({ ...m, modelsDevMeta: null, metaSource: 'sources.js' }))
  }

  const index = buildIndex(catalog)
  const touchedAt = Date.now()

  for (let i = 0; i < mergedModels.length; i++) {
    const m = mergedModels[i]
    let bestMatch = null
    if (m.providers && m.providers.length > 0) {
      // 📖 Try the full "<providerKey>/<modelId>" key first (most common case),
      // 📖 then the bare modelId (handles the modelId-already-includes-prefix case).
      for (const p of m.providers) {
        const fullKey = p.providerKey ? `${p.providerKey}/${p.modelId}` : p.modelId
        const r1 = lookup(fullKey, m.label, index)
        if (r1) { bestMatch = r1; break }
        const r2 = lookup(p.modelId, m.label, index)
        if (r2) { bestMatch = r2; break }
      }
    }
    if (!bestMatch && m.slug) bestMatch = lookup(m.slug, m.label, index)
    // 📖 Skip substring matches entirely: a label-only match can bind the WRONG
    // 📖 catalog model and overwrite the curated ctx window with its value
    // 📖 (detectDrift ignores substring matches for the same reason).
    if (bestMatch && bestMatch.matchKind === 'substring') bestMatch = null
    if (!bestMatch) {
      if (opts.mutate) {
        Object.assign(m, { modelsDevMeta: null, metaSource: 'sources.js' })
        mergedModels[i] = m
      } else {
        mergedModels[i] = { ...m, modelsDevMeta: null, metaSource: 'sources.js' }
      }
      continue
    }
    const norm = bestMatch.entry
    const liveCtx = typeof norm.contextWindow === 'number' ? formatCtxFromNum(norm.contextWindow) : null
    const overlay = {
      contextWindow:    liveCtx ?? m.ctx,
      contextWindowNum: norm.contextWindow ?? null,
      maxOutputTokens:  norm.maxOutputTokens ?? null,
      reasoning: norm.reasoning === true,
      vision:    norm.vision === true,
      thinking:  norm.thinking === true,
      toolCall:  norm.toolCall === true,
      matchKind: bestMatch.matchKind,
      lastFetchedAt: touchedAt,
    }
    if (opts.mutate) {
      Object.assign(m, { modelsDevMeta: overlay, metaSource: 'models.dev' })
      mergedModels[i] = m
    } else {
      mergedModels[i] = { ...m, modelsDevMeta: overlay, metaSource: 'models.dev' }
    }
  }
  return mergedModels
}

// 📖 formatCtxFromNum: Convert a raw token count (e.g. 128000) into a compact string
// 📖 matching the sources.js convention ("128k", "1M"). Used by overlayModelsDevMetadata.
function formatCtxFromNum(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return (Number.isInteger(m) ? m.toString() : m.toFixed(1)) + 'M'
  }
  if (n >= 1000) {
    const k = n / 1000
    return (Number.isInteger(k) ? k.toString() : k.toFixed(0)) + 'k'
  }
  return n.toString()
}

// ─── Stats helper ─────────────────────────────────────────────────────────────

/**
 * 📖 Aggregate stats about all enrichment layers — used by the TUI footer chip,
 * 📖 the web dashboard /stats endpoint, and the drift report.
 *
 * @returns {{
 *   extendedBench: { total: number, lastUpdated: string, source: string, byField: object }
 * }}
 */
export function getEnrichmentStats() {
  return {
    extendedBench: getExtendedBenchStats(),
  }
}

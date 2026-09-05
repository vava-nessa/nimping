/**
 * @file models-dev-index.js
 * @description Build a normalized lookup index over the models.dev catalog.
 *              Used to enrich `sources.js` models with live metadata (context window,
 *              max output tokens, reasoning/vision/thinking support).
 *
 * @details
 *   📖 Why this exists:
 *   📖 - models.dev returns a nested object: `{ <providerKey>: { models: { <id>: {...} } } }`.
 *   📖 - sources.js uses a flat array with display labels. We need a fast, normalized
 *   📖   way to look up a model by either its `provider/modelId` or by display label.
 *   📖 - Lookup order: exact id → provider-prefixed id → display label substring.
 *   📖 - Substring matches are a last resort — they can produce false positives
 *   📖   (e.g. "deepseek-chat" substring of "deepseek-chat-2"). We log them via
 *   📖   the `metaSource` field so callers can surface the uncertainty.
 *
 *   📖 Provider aliases: the catalog may list "together" while sources.js uses
 *   📖 "togetherai". We provide a small alias map to bridge the two. New aliases
 *   📖 can be added without touching the lookup logic.
 *
 *   📖 Cross-surface: pure logic, used by the TUI, Web Dashboard, and drift detector.
 *
 * @functions
 *   → buildModelIndex(catalog)                    — Returns { byId, byProviderModel, byLabel }
 *   → lookupModelDevMeta(modelId, label, index?)  — Returns the normalized entry or null
 *   → normalizeModelDevEntry(rawEntry)            — Shape-validate a raw models.dev model
 *   → PROVIDER_ALIASES                            — Map of canonical provider keys
 *
 * @exports buildModelIndex, lookupModelDevMeta, normalizeModelDevEntry, PROVIDER_ALIASES
 *
 * @see src/core/models-dev-fetcher.js — provides the catalog
 * @see src/core/models-drift.js      — uses this for drift detection
 */

// ─── Provider alias map ──────────────────────────────────────────────────────

/**
 * 📖 Map of source provider keys (used by sources.js) to models.dev provider keys
 * 📖 (used by their catalog). The lookup falls back to the source key if no alias
 * 📖 matches, so adding a new provider is a no-op until a divergence shows up.
 */
export const PROVIDER_ALIASES = {
  // sources.js → models.dev
  nvidiaNim:  'nvidia',
  nvidia:     'nvidia',
  openrouter: 'openrouter',
  orcarouter: 'orcarouter',
  'vercel-gateway': 'vercel',
  groq:       'groq',
  cerebras:   'cerebras',
  github:     'github-models',
  mistral:    'mistral',
  cloudflare: 'cloudflare-workers-ai',
  opencode:   'opencode',
  scaleway:   'scaleway',
  google:     'google',
  zai:        'zai',
  zaiOrg:     'zai',
  kilocode:   'kilocode',
  kilocodeAi: 'kilo',
  deepseek:   'deepseek',
  qwen:       'qwen',
  together:   'togetherai',
  novita:     'novita-ai',
  ollama:     'ollama',
  openhands:  'openhands',
  xai:        'xai',
  cohere:     'cohere',
  perplexity: 'perplexity',
  anthropic:  'anthropic',
  openai:     'openai',
  meta:       'meta',
  moonshotai: 'moonshotai',
  zhipu:      'zhipu',
  stepfun:    'stepfun',
  bytedance:  'bytedance',
  stockmark:  'stockmark',
  minimax:    'minimax',
  minimaxai:  'minimax',
  poolside:   'poolside',
  cohereCommand: 'cohere',
  llm7:       'llm7',
  routeway:   'routeway',
  dashscope:  'dashscope',
}

function aliasesFor(providerKey) {
  if (!providerKey) return []
  const lower = String(providerKey).toLowerCase()
  const aliased = PROVIDER_ALIASES[providerKey] ?? PROVIDER_ALIASES[lower]
  if (aliased && aliased !== providerKey) return [providerKey, aliased]
  return [providerKey]
}

// ─── Shape normalisation ─────────────────────────────────────────────────────

/**
 * 📖 Convert a raw models.dev model entry into the normalized shape our merger
 * 📖 consumes. Defensive: returns null if the entry is unusable, so callers can
 * 📖 skip it without try/catch.
 *
 * 📖 Normalized shape:
 * 📖   {
 * 📖     id: string,
 * 📖     name: string,
 * 📖     contextWindow: number|null,
 * 📖     maxOutputTokens: number|null,
 * 📖     reasoning: boolean,
 * 📖     vision: boolean,
 * 📖     thinking: boolean,
 * 📖     toolCall: boolean,
 * 📖     provider: string,         // original provider key
 * 📖     raw: object               // original entry (for debug / future fields)
 * 📖   }
 *
 * @param {object} rawEntry
 * @returns {object|null}
 */
export function normalizeModelDevEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== 'object') return null
  const id = rawEntry.id
  if (typeof id !== 'string' || !id) return null
  const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null
  const boolOrFalse = (v) => v === true

  // 📖 Context + max tokens come from `limit` (flat) or top-level (nested)
  const limit = rawEntry.limit && typeof rawEntry.limit === 'object' ? rawEntry.limit : {}
  const contextWindow = numOrNull(limit.context ?? rawEntry.context ?? rawEntry.contextWindow)
  const maxOutputTokens = numOrNull(limit.output ?? rawEntry.max_tokens ?? rawEntry.maxTokens)

  // 📖 Vision is a modality flag (flat) or a top-level boolean (nested)
  const modalities = rawEntry.modalities && typeof rawEntry.modalities === 'object' ? rawEntry.modalities : {}
  const visionFromModalities = Array.isArray(modalities.input)
    ? modalities.input.some(m => typeof m === 'string' && (m.toLowerCase().includes('image') || m.toLowerCase().includes('video')))
    : false
  const vision = boolOrFalse(rawEntry.vision) || visionFromModalities

  // 📖 Provider is the id prefix (flat) or a top-level field (nested)
  const slashIdx = id.indexOf('/')
  const providerFromId = slashIdx !== -1 ? id.slice(0, slashIdx) : ''
  const provider = typeof rawEntry.provider === 'string' && rawEntry.provider
    ? rawEntry.provider
    : providerFromId

  return {
    id,
    name: typeof rawEntry.name === 'string' ? rawEntry.name : id,
    contextWindow,
    maxOutputTokens,
    reasoning: boolOrFalse(rawEntry.reasoning),
    vision,
    thinking: boolOrFalse(rawEntry.thinking),
    toolCall: boolOrFalse(rawEntry.tool_call ?? rawEntry.toolCall),
    provider,
    raw: rawEntry,
  }
}

// ─── Index builder ───────────────────────────────────────────────────────────

/**
 * 📖 Build a normalized index over the models.dev catalog. Returns three maps:
 * 📖   - byId: "deepseek/deepseek-chat" → normalized entry
 * 📖   - byProviderModel: "deepseek/deepseek-chat" → normalized entry (same key, exposed
 * 📖     separately so the merger can pick whichever it prefers)
 * 📖   - byLabel: "DeepSeek Chat" → normalized entry[]  (substring fallback)
 *
 * @param {object} catalog — The raw models.dev catalog
 * @returns {{
 *   byId: Map<string, object>,
 *   byProviderModel: Map<string, object>,
 *   byLabel: Map<string, object[]>,
 *   total: number,
 *   providers: string[]
 * }}
 */
export function buildModelIndex(catalog) {
  const byId = new Map()
  const byProviderModel = new Map()
  const byLabel = new Map()
  const providers = []
  let total = 0

  if (!catalog || typeof catalog !== 'object') {
    return { byId, byProviderModel, byLabel, total: 0, providers: [] }
  }

  // 📖 Detect format: flat catalogs have keys that look like model ids
  // 📖 ("provider/model-name") while nested catalogs have keys that look like
  // 📖 provider ids with a `models` sub-object.
  const entries = Object.entries(catalog)
  const isFlat = entries.length > 0 && entries.every(([k, v]) => {
    if (!v || typeof v !== 'object') return false
    if (k.includes('/')) return typeof v.limit === 'object' || typeof v.id === 'string'
    return false
  })

  if (isFlat) {
    // 📖 Flat format: each top-level key is "<provider>/<modelId>"
    for (const [idKey, rawEntry] of entries) {
      if (!rawEntry || typeof rawEntry !== 'object') continue
      const norm = normalizeModelDevEntry(rawEntry)
      if (!norm) continue
      const providerKey = norm.provider || idKey.slice(0, idKey.indexOf('/'))
      if (!providers.includes(providerKey)) providers.push(providerKey)
      if (!byId.has(idKey)) byId.set(idKey, norm)
      if (!byProviderModel.has(idKey)) byProviderModel.set(idKey, norm)
      const label = norm.name || idKey
      const arr = byLabel.get(label) ?? []
      arr.push(norm)
      byLabel.set(label, arr)
      total++
    }
  } else {
    // 📖 Nested format: { <provider>: { id, name, models: {...} } }
    for (const [providerKey, providerBucket] of entries) {
      if (!providerBucket || typeof providerBucket !== 'object') continue
      const models = providerBucket.models
      if (!models || typeof models !== 'object') continue
      providers.push(providerKey)
      for (const [modelId, rawEntry] of Object.entries(models)) {
        const norm = normalizeModelDevEntry(rawEntry)
        if (!norm) continue
        norm.provider = providerKey
        const idKey = `${providerKey}/${modelId}`
        if (!byId.has(idKey)) byId.set(idKey, norm)
        if (!byProviderModel.has(idKey)) byProviderModel.set(idKey, norm)
        const label = norm.name || modelId
        const arr = byLabel.get(label) ?? []
        arr.push(norm)
        byLabel.set(label, arr)
        total++
      }
    }
  }
  return { byId, byProviderModel, byLabel, total, providers }
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

/**
 * 📖 Look up a model in the index. Tries in order:
 * 📖   1. Exact "provider/modelId" match (O(1))
 * 📖   2. Aliased provider variants (e.g. "nvidiaNim" → "nvidia")
 * 📖   3. Display-label substring match (last resort, may produce false positives)
 *
 * 📖 Returns a small wrapper so callers know HOW the match was made:
 * 📖   { entry, matchKind: 'exact'|'alias'|'substring' }
 *
 * @param {string} modelId
 * @param {string} [label] — display label from sources.js (helps the substring fallback)
 * @param {object} [index] — Optional pre-built index (defaults to building one)
 * @param {object} [catalog] — Optional catalog (used when index is omitted)
 * @returns {{ entry: object, matchKind: string }|null}
 */
export function lookupModelDevMeta(modelId, label, index, catalog) {
  if (!modelId || typeof modelId !== 'string') return null
  let idx = index
  if (!idx) {
    if (!catalog) return null
    idx = buildModelIndex(catalog)
  }

  // Rule 1: exact match — supports both "provider/modelId" and bare "modelId"
  if (idx.byProviderModel.has(modelId)) {
    return { entry: idx.byProviderModel.get(modelId), matchKind: 'exact' }
  }
  // 📖 Try the bare model id in case the catalog's provider is implicit
  if (!modelId.includes('/') && idx.byId.has(modelId)) {
    return { entry: idx.byId.get(modelId), matchKind: 'exact' }
  }

  // Rule 2: provider alias variants. Strip the provider prefix from the input
  // and try each alias.
  if (modelId.includes('/')) {
    const slash = modelId.indexOf('/')
    const providerKey = modelId.slice(0, slash)
    const rest = modelId.slice(slash + 1)
    for (const alias of aliasesFor(providerKey)) {
      const altKey = `${alias}/${rest}`
      if (idx.byProviderModel.has(altKey)) {
        return { entry: idx.byProviderModel.get(altKey), matchKind: 'alias' }
      }
    }
    // 📖 Try the bare rest under any provider (last-ditch exact)
    for (const providerKey2 of idx.providers ?? []) {
      const altKey2 = `${providerKey2}/${rest}`
      if (idx.byProviderModel.has(altKey2)) {
        return { entry: idx.byProviderModel.get(altKey2), matchKind: 'alias' }
      }
    }
  }

  // Rule 3: display-label substring fallback
  if (label && typeof label === 'string') {
    const labelLower = label.toLowerCase()
    // 📖 Prefer entries whose name matches the label exactly first
    if (idx.byLabel.has(label)) {
      const arr = idx.byLabel.get(label)
      if (arr.length > 0) return { entry: arr[0], matchKind: 'substring' }
    }
    // 📖 Then scan for a substring match (lowercase)
    for (const [key, arr] of idx.byLabel.entries()) {
      if (!arr || arr.length === 0) continue
      const keyLower = key.toLowerCase()
      if (keyLower.includes(labelLower) || labelLower.includes(keyLower)) {
        return { entry: arr[0], matchKind: 'substring' }
      }
    }
  }

  return null
}

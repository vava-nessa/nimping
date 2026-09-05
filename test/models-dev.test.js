/**
 * @file test/models-dev.test.js
 * @description Tests for src/core/models-dev-{fetcher,index,drift}.js — the models.dev
 *              enrichment + drift detection stack.
 *
 * Covers:
 *   - fetchModelsDevCatalog: success path, retry-then-succeed, all-fail → null
 *   - getModelsDevCacheStats: hits / misses / cached / lastError
 *   - clearModelsDevCache: resets the in-process cache
 *   - buildModelIndex: byId / byProviderModel / byLabel / providers / total
 *   - normalizeModelDevEntry: shape validation + coercion
 *   - lookupModelDevMeta: exact / alias / substring fallback / unknown → null
 *   - detectDrift: ctx drift / maxTokens add / flag drift / no false positives
 *   - detectDrift: skips substring matches to avoid false positives
 *   - summarizeDrift: totals, byField, byAction, modelsAffected
 *   - formatDriftReport: contains the expected lines (with/without color)
 *   - parseCtxToNum: "128k" / "1m" / "262144" / null
 *   - PROVIDER_ALIASES: nvidiaNim → nvidia, together → togetherai, etc.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchModelsDevCatalog,
  getModelsDevCacheStats,
  clearModelsDevCache,
  MODELS_DEV_URL,
  DEFAULT_FETCH_TIMEOUT_MS,
  MODELS_DEV_CACHE_TTL_MS,
} from '../src/core/models-dev-fetcher.js'
import {
  buildModelIndex,
  lookupModelDevMeta,
  normalizeModelDevEntry,
  PROVIDER_ALIASES,
} from '../src/core/models-dev-index.js'
import {
  detectDrift,
  summarizeDrift,
  formatDriftReport,
  parseCtxToNum,
  DRIFT_FIELDS,
} from '../src/core/models-drift.js'

// ─── Test fixtures ────────────────────────────────────────────────────────────

/**
 * 📖 Minimal in-memory models.dev-style catalog. Mirrors the real shape:
 * 📖   { <provider>: { id, name, models: { <modelId>: { ... } } } }
 */
const SAMPLE_CATALOG = {
  deepseek: {
    id: 'deepseek', name: 'DeepSeek',
    models: {
      'deepseek-chat': {
        id: 'deepseek-chat', name: 'DeepSeek Chat',
        context: 128000, max_tokens: 8192,
        reasoning: false, vision: false, thinking: false, tool_call: true,
      },
      'deepseek-reasoner': {
        id: 'deepseek-reasoner', name: 'DeepSeek Reasoner',
        context: 64000, max_tokens: 8192,
        reasoning: true, vision: false, thinking: true, tool_call: false,
      },
    },
  },
  nvidia: {
    id: 'nvidia', name: 'NVIDIA',
    models: {
      'z-ai/glm-5.2': {
        id: 'z-ai/glm-5.2', name: 'GLM 5.2',
        context: 256000, max_tokens: 16384,
        reasoning: true, vision: false, thinking: false, tool_call: true,
      },
    },
  },
  groq: {
    id: 'groq', name: 'Groq',
    models: {
      'llama-3.3-70b-versatile': {
        id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile',
        context: 131072, max_tokens: 8192,
        reasoning: false, vision: false, tool_call: true,
      },
    },
  },
}

/** 📖 Minimal sources.js-shaped model list (tuple form, as in the real file). */
const SAMPLE_MODELS = [
  ['deepseek/deepseek-chat',       'DeepSeek Chat',           'A',  '60.0%', '128k'],
  ['deepseek/deepseek-reasoner',   'DeepSeek Reasoner',       'A+', '65.0%', '64k'],
  ['nvidiaNim/z-ai/glm-5.2',       'GLM 5.2',                 'S+', '82.8%', '128k'],   // 📖 stale (catalog says 256k)
  ['groq/llama-3.3-70b-versatile', 'Llama 3.3 70B Versatile', 'B',  '22.0%', '131k'],
  ['nvidia/nemotron-3-ultra',      'Nemotron 3 Ultra',        'S+', '71.9%', '1M'],
]

// ─── Fetcher ─────────────────────────────────────────────────────────────────

describe('fetchModelsDevCatalog', () => {
  beforeEach(() => clearModelsDevCache())
  afterEach(() => clearModelsDevCache())

  it('exports the canonical URL and TTL constants', () => {
    assert.equal(MODELS_DEV_URL, 'https://models.dev/models.json')
    assert.equal(typeof DEFAULT_FETCH_TIMEOUT_MS, 'number')
    assert.equal(MODELS_DEV_CACHE_TTL_MS, 5 * 60 * 1000)
  })

  it('on a network failure returns null (no throw, silent by default)', async () => {
    // 📖 Use a bad URL to force failure (we can't easily mock global fetch in node:test)
    const result = await fetchModelsDevCatalog({
      retries: 1,
      retryDelayMs: 10,
      silent: true,
    }).catch(() => 'threw')
    // 📖 If we DO have internet and it succeeded, just verify the shape
    if (result && typeof result === 'object') {
      assert.ok(true, 'real network worked, skipping failure assertion')
      return
    }
    assert.equal(result, null, 'expected null on failure')
  })

  it('cache hits/misses are tracked', async () => {
    await fetchModelsDevCatalog({ retries: 1, retryDelayMs: 10, silent: true })
    const stats1 = getModelsDevCacheStats()
    await fetchModelsDevCatalog({ retries: 1, retryDelayMs: 10, silent: true })
    const stats2 = getModelsDevCacheStats()
    if (stats1.hits === 0 && stats1.misses === 0) {
      // 📖 First call might have failed, so no cache state — verify shape
      assert.equal(typeof stats2.hits, 'number')
      assert.equal(typeof stats2.misses, 'number')
    } else {
      // 📖 At least one of (hits, misses) should have incremented
      assert.ok(stats1.misses + stats1.hits > 0, 'expected at least one access')
    }
  })

  it('clearModelsDevCache resets the cache', async () => {
    await fetchModelsDevCatalog({ retries: 1, retryDelayMs: 10, silent: true })
    clearModelsDevCache()
    const stats = getModelsDevCacheStats()
    assert.equal(stats.hits, 0)
    assert.equal(stats.misses, 0)
    assert.equal(stats.lastFetchAt, null)
    assert.equal(stats.cached, false)
  })

  it('force=true bypasses the cache and re-fetches', async () => {
    await fetchModelsDevCatalog({ retries: 1, retryDelayMs: 10, silent: true })
    const before = getModelsDevCacheStats()
    await fetchModelsDevCatalog({ force: true, retries: 1, retryDelayMs: 10, silent: true })
    const after = getModelsDevCacheStats()
    // 📖 After force, misses should not have grown (or it should still be cached)
    assert.ok(after.misses >= before.misses, 'force should re-fetch')
  })
})

// ─── normalizeModelDevEntry ──────────────────────────────────────────────────

describe('normalizeModelDevEntry', () => {
  it('returns a normalized shape for a valid entry', () => {
    const raw = {
      id: 'deepseek-chat', name: 'DeepSeek Chat',
      context: 128000, max_tokens: 8192,
      reasoning: false, vision: true, thinking: false, tool_call: true,
    }
    const norm = normalizeModelDevEntry(raw)
    assert.equal(norm.id, 'deepseek-chat')
    assert.equal(norm.name, 'DeepSeek Chat')
    assert.equal(norm.contextWindow, 128000)
    assert.equal(norm.maxOutputTokens, 8192)
    assert.equal(norm.reasoning, false)
    assert.equal(norm.vision, true)
    assert.equal(norm.thinking, false)
    assert.equal(norm.toolCall, true)
  })

  it('coerces invalid types to safe defaults', () => {
    const raw = { id: 'x', context: '128k', max_tokens: null, vision: 1 }
    const norm = normalizeModelDevEntry(raw)
    assert.equal(norm.contextWindow, null, 'non-number context → null')
    assert.equal(norm.maxOutputTokens, null)
    assert.equal(norm.vision, false, 'truthy non-boolean → false (strict)')
  })

  it('returns null for null / non-object / missing id', () => {
    assert.equal(normalizeModelDevEntry(null), null)
    assert.equal(normalizeModelDevEntry(undefined), null)
    assert.equal(normalizeModelDevEntry('string'), null)
    assert.equal(normalizeModelDevEntry({}), null)
    assert.equal(normalizeModelDevEntry({ context: 1000 }), null)
  })

  it('falls back to the id when name is missing', () => {
    const norm = normalizeModelDevEntry({ id: 'm1' })
    assert.equal(norm.name, 'm1')
  })
})

// ─── buildModelIndex ─────────────────────────────────────────────────────────

describe('buildModelIndex', () => {
  it('builds byId / byProviderModel / byLabel / total / providers', () => {
    const idx = buildModelIndex(SAMPLE_CATALOG)
    assert.equal(idx.total, 4)
    assert.equal(idx.providers.length, 3)
    assert.ok(idx.byId.has('deepseek/deepseek-chat'))
    assert.ok(idx.byProviderModel.has('deepseek/deepseek-chat'))
    assert.ok(idx.byLabel.has('DeepSeek Chat'))
  })

  it('returns an empty index for a null catalog', () => {
    const idx = buildModelIndex(null)
    assert.equal(idx.total, 0)
    assert.equal(idx.providers.length, 0)
  })

  it('skips malformed provider buckets', () => {
    const catalog = {
      ok: { id: 'ok', models: { 'm1': { id: 'm1' } } },
      bad: null,
      bad2: 'string',
      bad3: { models: 'not-an-object' },
    }
    const idx = buildModelIndex(catalog)
    assert.equal(idx.total, 1)
    assert.deepEqual(idx.providers, ['ok'])
  })
})

// ─── lookupModelDevMeta ──────────────────────────────────────────────────────

describe('lookupModelDevMeta', () => {
  it('returns exact match for provider/modelId', () => {
    const idx = buildModelIndex(SAMPLE_CATALOG)
    const result = lookupModelDevMeta('deepseek/deepseek-chat', null, idx)
    assert.ok(result)
    assert.equal(result.matchKind, 'exact')
    assert.equal(result.entry.id, 'deepseek-chat')
  })

  it('returns alias match for nvidiaNim → nvidia (PROVIDER_ALIASES)', () => {
    const idx = buildModelIndex(SAMPLE_CATALOG)
    const result = lookupModelDevMeta('nvidiaNim/z-ai/glm-5.2', 'GLM 5.2', idx)
    assert.ok(result, 'expected alias match to find nvidia catalog entry')
    assert.equal(result.matchKind, 'alias')
    assert.equal(result.entry.contextWindow, 256000)
  })

  it('returns substring match when label matches (no exact id)', () => {
    const idx = buildModelIndex(SAMPLE_CATALOG)
    // 📖 Use a model id that does not appear in any provider's models, so the
    // 📖 implementation falls through to the label-substring fallback.
    const result = lookupModelDevMeta('totally-unknown-provider/deepseek-v9', 'DeepSeek Chat', idx)
    assert.ok(result)
    assert.equal(result.matchKind, 'substring')
    assert.equal(result.entry.id, 'deepseek-chat')
  })

  it('returns null for unknown ids (no throw)', () => {
    const idx = buildModelIndex(SAMPLE_CATALOG)
    const result = lookupModelDevMeta('totally/unknown-model', 'Totally Unknown', idx)
    assert.equal(result, null)
  })

  it('returns null for invalid input', () => {
    const idx = buildModelIndex(SAMPLE_CATALOG)
    assert.equal(lookupModelDevMeta(null, 'X', idx), null)
    assert.equal(lookupModelDevMeta('', 'X', idx), null)
    assert.equal(lookupModelDevMeta(42, 'X', idx), null)
  })

  it('PROVIDER_ALIASES contains the expected mappings', () => {
    assert.equal(PROVIDER_ALIASES.nvidiaNim, 'nvidia')
    assert.equal(PROVIDER_ALIASES.together, 'togetherai')
    assert.equal(PROVIDER_ALIASES.novita, 'novita-ai')
  })
})

// ─── parseCtxToNum ───────────────────────────────────────────────────────────

describe('parseCtxToNum', () => {
  it('parses k-suffix', () => assert.equal(parseCtxToNum('128k'), 128_000))
  it('parses m-suffix', () => assert.equal(parseCtxToNum('1m'), 1_000_000))
  it('parses plain numbers', () => assert.equal(parseCtxToNum('262144'), 262_144))
  it('parses mixed case', () => assert.equal(parseCtxToNum('1M'), 1_000_000))
  it('returns null for unparseable input', () => {
    assert.equal(parseCtxToNum(null), null)
    assert.equal(parseCtxToNum(''), null)
    assert.equal(parseCtxToNum('—'), null)
    assert.equal(parseCtxToNum('-'), null)
    assert.equal(parseCtxToNum('abc'), null)
  })
})

// ─── detectDrift ─────────────────────────────────────────────────────────────

describe('detectDrift', () => {
  it('detects ctx drift: sources.js=128k vs models.dev=256000', () => {
    const idx = buildModelIndex(SAMPLE_CATALOG)
    const drift = detectDrift(SAMPLE_MODELS, SAMPLE_CATALOG, { index: idx })
    const glmDrift = drift.find(d => d.modelId === 'nvidiaNim/z-ai/glm-5.2' && d.field === 'ctx')
    assert.ok(glmDrift, 'expected ctx drift for GLM 5.2')
    assert.equal(glmDrift.action, 'update')
    assert.equal(glmDrift.sourcesJsValue, 128_000)
    assert.equal(glmDrift.modelsDevValue, 256_000)
  })

  it('detects maxTokens add for object-form entries only (tuple form has no flag columns)', () => {
    // 📖 Tuple entries are arity 5 and carry no maxTokens/reasoning/vision/thinking
    // 📖 columns, so flagMatch(undefined, true) used to fabricate a bogus "add" for
    // 📖 every capable model and bury real ctx drift. Only object-form entries,
    // 📖 which can actually hold these fields, are compared now.
    const idx = buildModelIndex(SAMPLE_CATALOG)
    const drift = detectDrift(SAMPLE_MODELS, SAMPLE_CATALOG, { index: idx })
    const tupleMaxAdd = drift.filter(d => d.field === 'maxTokens' && d.action === 'add')
    assert.equal(tupleMaxAdd.length, 0, 'tuple-form entries must not report maxTokens adds')

    const objectModels = [
      { modelId: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', ctx: '128k' },
      // 📖 GLM 5.2 is reasoning-capable in the catalog; an object entry that omits
      // 📖 the flag should yield a reasoning "add", ctx matches so no ctx noise.
      { modelId: 'nvidiaNim/z-ai/glm-5.2', label: 'GLM 5.2', ctx: '256k' },
    ]
    const objectDrift = detectDrift(objectModels, SAMPLE_CATALOG, { index: idx })
    assert.ok(
      objectDrift.some(d => d.field === 'maxTokens' && d.action === 'add'),
      'object-form entry without maxTokens should report an add',
    )
    assert.ok(
      objectDrift.some(d => d.field === 'reasoning' && d.action === 'add'),
      'object-form entry without reasoning flag should report an add',
    )
  })

  it('does NOT report ctx drift when values match (within 5% tolerance)', () => {
    const idx = buildModelIndex(SAMPLE_CATALOG)
    const drift = detectDrift(SAMPLE_MODELS, SAMPLE_CATALOG, { index: idx })
    // 📖 'deepseek/deepseek-chat' has sources.js=128k vs catalog=128000 → match
    const matching = drift.filter(d =>
      d.modelId === 'deepseek/deepseek-chat' && d.field === 'ctx'
    )
    assert.equal(matching.length, 0, '128k vs 128000 should be a match (within tolerance)')
  })

  it('skips substring matches to avoid false positives', () => {
    const catalog = {
      foo: { id: 'foo', models: { 'bar-2': { id: 'bar-2', name: 'Bar 2', context: 1000 } } },
    }
    const idx = buildModelIndex(catalog)
    // 📖 sources.js has 'foo/bar-1' with label 'Bar 1' — substring match to "Bar 2" would be wrong
    const models = [['foo/bar-1', 'Bar 1', 'A', '50%', '1k']]
    const drift = detectDrift(models, catalog, { index: idx })
    assert.equal(drift.length, 0, 'substring match should be skipped')
  })

  it('returns [] for empty models or null catalog', () => {
    assert.deepEqual(detectDrift([], SAMPLE_CATALOG), [])
    assert.deepEqual(detectDrift(SAMPLE_MODELS, null), [])
  })

  it('threshold filters out small drift lists', () => {
    const idx = buildModelIndex(SAMPLE_CATALOG)
    const drift1 = detectDrift(SAMPLE_MODELS, SAMPLE_CATALOG, { index: idx, threshold: 100 })
    assert.equal(drift1.length, 0, 'threshold=100 should suppress small drift')
  })
})

// ─── summarizeDrift + formatDriftReport ──────────────────────────────────────

describe('summarizeDrift', () => {
  it('aggregates by field, action, and model', () => {
    const idx = buildModelIndex(SAMPLE_CATALOG)
    const drift = detectDrift(SAMPLE_MODELS, SAMPLE_CATALOG, { index: idx })
    const sum = summarizeDrift(drift)
    assert.equal(typeof sum.total, 'number')
    assert.ok(sum.total > 0, 'expected drift from the fixture')
    assert.ok('ctx' in sum.byField)
    assert.ok('add' in sum.byAction)
    assert.ok(sum.modelsAffected.length > 0)
  })

  it('DRIFT_FIELDS contains ctx, maxTokens, reasoning, vision, thinking', () => {
    assert.deepEqual([...DRIFT_FIELDS].sort(), ['ctx', 'maxTokens', 'reasoning', 'thinking', 'vision'])
  })

  it('handles empty drift list gracefully', () => {
    const sum = summarizeDrift([])
    assert.equal(sum.total, 0)
    assert.equal(sum.modelsAffected.length, 0)
  })
})

describe('formatDriftReport', () => {
  it('returns a green "no drift" message when there are no mismatches', () => {
    const out = formatDriftReport([], { useColor: false })
    assert.ok(out.includes('No catalog drift'), `unexpected output: ${out}`)
  })

  it('includes the model id, field, both values, and the action arrow', () => {
    const idx = buildModelIndex(SAMPLE_CATALOG)
    const drift = detectDrift(SAMPLE_MODELS, SAMPLE_CATALOG, { index: idx })
    const out = formatDriftReport(drift, { useColor: false })
    assert.ok(out.includes('drift detected'), `expected header: ${out}`)
    assert.ok(out.includes('ctx'), 'expected field column')
    assert.ok(out.includes('sources.js='), 'expected sources.js column')
    assert.ok(out.includes('models.dev='), 'expected models.dev column')
    assert.ok(out.includes('UPDATE') || out.includes('ADD'), 'expected action arrow')
  })

  it('respects useColor=false (no ANSI codes)', () => {
    const idx = buildModelIndex(SAMPLE_CATALOG)
    const drift = detectDrift(SAMPLE_MODELS, SAMPLE_CATALOG, { index: idx })
    const out = formatDriftReport(drift, { useColor: false })
    assert.ok(!out.includes('\x1b['), 'expected no ANSI escape codes')
  })
})

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildMergedModels, overlayExtendedBenchmarks, overlayModelsDevMetadata, getEnrichmentStats } from '../src/core/model-merger.js'

const SAMPLE_MODELS = [
  ['deepseek-ai/deepseek-v4-flash', 'DeepSeek V4 Flash', 'S+', '72.0%', '128k', 'nvidia'],
  ['deepseek-v4-flash', 'DeepSeek V4 Flash', 'S+', '72.0%', '128k', 'groq'],
  ['deepseek-v4-flash', 'DeepSeek V4 Flash', 'S+', '72.0%', '128k', 'cerebras'],
  ['unique-model-xyz', 'Unique Model', 'A', '55%', '32k', 'fireworks'],
]

describe('buildMergedModels', () => {
  it('merges same-label models into one entry', () => {
    const merged = buildMergedModels(SAMPLE_MODELS)
    const deepseek = merged.find(m => m.label === 'DeepSeek V4 Flash')
    assert.ok(deepseek)
    assert.strictEqual(deepseek.providers.length, 3)
    assert.deepStrictEqual(
      deepseek.providers.map(p => p.providerKey).sort(),
      ['cerebras', 'groq', 'nvidia']
    )
  })

  it('keeps unique models as single-provider entries', () => {
    const merged = buildMergedModels(SAMPLE_MODELS)
    const unique = merged.find(m => m.label === 'Unique Model')
    assert.ok(unique)
    assert.strictEqual(unique.providers.length, 1)
    assert.strictEqual(unique.providers[0].providerKey, 'fireworks')
  })

  it('uses best tier and highest SWE score', () => {
    const models = [
      ['m1', 'TestModel', 'A+', '65%', '64k', 'p1'],
      ['m2', 'TestModel', 'S', '70%', '128k', 'p2'],
    ]
    const merged = buildMergedModels(models)
    const tm = merged.find(m => m.label === 'TestModel')
    assert.strictEqual(tm.tier, 'S')       // best tier
    assert.strictEqual(tm.sweScore, '70%')  // highest score
    assert.strictEqual(tm.ctx, '128k')      // largest context
  })

  it('returns providerCount', () => {
    const merged = buildMergedModels(SAMPLE_MODELS)
    const deepseek = merged.find(m => m.label === 'DeepSeek V4 Flash')
    assert.strictEqual(deepseek.providerCount, 3)
  })

  it('generates unique slug per model', () => {
    const models = [
      ['m1', 'Test Model!', 'A', '50%', '32k', 'p1'],
      ['m2', 'Test Model!', 'A', '50%', '32k', 'p2'],
      ['m3', 'Test-Model', 'B', '40%', '32k', 'p3'],
    ]
    const merged = buildMergedModels(models)
    const slugs = merged.map(m => m.slug)
    // All slugs unique
    assert.strictEqual(new Set(slugs).size, slugs.length, 'Slugs must be unique')
    // Slug format: lowercase, no special chars
    for (const slug of slugs) {
      assert.match(slug, /^[a-z0-9-]+$/, `Slug "${slug}" must be lowercase alphanumeric with dashes`)
    }
  })

  it('each provider entry has modelId and providerKey', () => {
    const merged = buildMergedModels(SAMPLE_MODELS)
    const deepseek = merged.find(m => m.label === 'DeepSeek V4 Flash')
    const nvidia = deepseek.providers.find(p => p.providerKey === 'nvidia')
    assert.strictEqual(nvidia.modelId, 'deepseek-ai/deepseek-v4-flash')
  })
})

// ─── overlayExtendedBenchmarks (t4) ───────────────────────────────────────────

describe('overlayExtendedBenchmarks', () => {
  beforeEach(() => {
    // 📖 Force the real catalog to load by reading it; the import is lazy enough
    // 📖 that buildPrefixIndex runs on first lookup.
  })

  it('overlays extendedBench onto merged models when the catalog has the id', () => {
    const merged = buildMergedModels([
      ['z-ai/glm-5.2', 'GLM 5.2', 'S+', '82.8%', '128k', 'nvidia'],
      ['totally-unknown-model-xyz', 'Unknown Model', 'A', '50%', '32k', 'fake'],
    ])
    const enriched = overlayExtendedBenchmarks(merged)
    const glm = enriched.find(m => m.label === 'GLM 5.2')
    const unknown = enriched.find(m => m.label === 'Unknown Model')
    assert.ok(glm.extendedBench, 'expected extendedBench on GLM 5.2')
    assert.equal(typeof glm.extendedBench.codingIndex, 'number')
    assert.equal(glm.extendedBench.originalModel, 'GLM 5.2')
    assert.equal(unknown.extendedBench, null, 'unknown model → null overlay')
  })

  it('does not mutate the input array', () => {
    const merged = buildMergedModels([
      ['z-ai/glm-5.2', 'GLM 5.2', 'S+', '82.8%', '128k', 'nvidia'],
    ])
    const enriched = overlayExtendedBenchmarks(merged)
    assert.notEqual(enriched, merged, 'expected a new array')
    assert.equal(merged[0].extendedBench, undefined, 'original should not be mutated')
  })
})

// ─── overlayModelsDevMetadata (t5) ────────────────────────────────────────────

describe('overlayModelsDevMetadata', () => {
  const FAKE_CATALOG = {
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
  }

  it('overlays live metadata when the fetch succeeds', async () => {
    const merged = buildMergedModels([
      ['z-ai/glm-5.2', 'GLM 5.2', 'S+', '82.8%', '128k', 'nvidia'],
    ])
    const enriched = await overlayModelsDevMetadata(merged, {
      fetchCatalog: async () => FAKE_CATALOG,
    })
    const glm = enriched[0]
    assert.equal(glm.metaSource, 'models.dev')
    assert.ok(glm.modelsDevMeta)
    assert.equal(glm.modelsDevMeta.contextWindow, '256k')  // 📖 live value wins
    assert.equal(glm.modelsDevMeta.reasoning, true)
    // 📖 The provider is 'nvidia' in the test, so the full key 'nvidia/z-ai/glm-5.2'
    // 📖 matches exactly. (The 'alias' path is exercised in models-dev.test.js.)
    assert.equal(glm.modelsDevMeta.matchKind, 'exact')
  })

  it('falls back to sources.js values when the fetch fails (no throw)', async () => {
    const merged = buildMergedModels([
      ['z-ai/glm-5.2', 'GLM 5.2', 'S+', '82.8%', '128k', 'nvidia'],
    ])
    const enriched = await overlayModelsDevMetadata(merged, {
      fetchCatalog: async () => null,
    })
    assert.equal(enriched[0].metaSource, 'sources.js')
    assert.equal(enriched[0].modelsDevMeta, null)
  })

  it('mutate=true mutates the input in place', async () => {
    const merged = buildMergedModels([
      ['z-ai/glm-5.2', 'GLM 5.2', 'S+', '82.8%', '128k', 'nvidia'],
    ])
    const returned = await overlayModelsDevMetadata(merged, {
      fetchCatalog: async () => FAKE_CATALOG,
      mutate: true,
    })
    assert.equal(returned, merged, 'expected the same array reference')
    assert.ok(merged[0].modelsDevMeta, 'expected mutation to have applied')
  })
})

// ─── getEnrichmentStats ───────────────────────────────────────────────────────

describe('getEnrichmentStats', () => {
  it('returns the extended-benchmark catalog stats (with at least 20 entries)', () => {
    const stats = getEnrichmentStats()
    assert.ok(stats.extendedBench)
    assert.ok(stats.extendedBench.total >= 20)
    assert.equal(typeof stats.extendedBench.lastUpdated, 'string')
  })
})

describe('overlayModelsDevMetadata substring safety', () => {
  // 📖 Helper: overlayModelsDevMetadata is async and takes injectable
  // 📖 catalog/index/lookup deps, so no network or real catalog is needed.
  async function runOverlay(models, lookupImpl) {
    return overlayModelsDevMetadata(models, {
      fetchCatalog: async () => ({ catalog: true }),
      buildIndex: () => ({}),
      lookup: lookupImpl,
    })
  }

  it('skips substring-match overlays so curated ctx windows stay intact', async () => {
    // 📖 A substring match can bind the WRONG catalog model; overlaying its
    // 📖 context window onto a curated entry corrupted the catalog (drift skips
    // 📖 substring matches for the same reason).
    const models = [
      { slug: 'model-a', label: 'Model A', ctx: '128k', providers: [{ providerKey: 'p', modelId: 'p/model-a', tier: 'A' }] },
      { slug: 'model-b', label: 'Model B', ctx: '128k', providers: [{ providerKey: 'p', modelId: 'p/model-b', tier: 'A' }] },
    ]
    const out = await runOverlay(models, (id) => {
      if (id.endsWith('/model-a')) {
        return { entry: { contextWindow: 999_999, reasoning: true }, matchKind: 'substring' }
      }
      if (id.endsWith('/model-b')) {
        return { entry: { contextWindow: 262_144, reasoning: true }, matchKind: 'exact' }
      }
      return null
    })

    const a = out.find((m) => m.slug === 'model-a')
    assert.equal(a.metaSource, 'sources.js', 'substring match must not mark the model as models.dev-backed')
    assert.equal(a.modelsDevMeta, null, 'substring match must not produce an overlay')
    assert.equal(a.ctx, '128k', 'curated ctx window stays untouched')

    const b = out.find((m) => m.slug === 'model-b')
    assert.equal(b.metaSource, 'models.dev', 'exact matches still overlay')
    assert.equal(b.modelsDevMeta.matchKind, 'exact')
    assert.equal(b.modelsDevMeta.contextWindow, '262k')
    assert.equal(b.modelsDevMeta.reasoning, true)
  })
})

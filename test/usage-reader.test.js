/**
 * @file test/usage-reader.test.js
 * @description Tests for lib/usage-reader.js pure functions (Task 3).
 *
 * Each describe block gets its own isolated temp directory via makeTempDir().
 */

import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadUsageSnapshot, loadUsageMap, usageForModelId, usageForRow, SNAPSHOT_TTL_MS, CACHE_TTL_MS, clearUsageCache, buildUsageSnapshotKey } from '../src/core/usage-reader.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create an isolated temp dir; returns helpers + cleanup. */
function makeTempDir(label) {
  const dir = join(tmpdir(), `fcm-ur-${label}-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const statsFile = join(dir, 'token-stats.json')
  const write = (data) => writeFileSync(statsFile, JSON.stringify(data))
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  return { dir, statsFile, write, cleanup }
}

/** Return an ISO timestamp that is `offsetMs` milliseconds before now (default 60s = fresh). */
function freshTs(offsetMs = 60 * 1000) {
  return new Date(Date.now() - offsetMs).toISOString()
}

// ─── Suite: loadUsageMap ──────────────────────────────────────────────────────

describe('usage-reader – loadUsageMap', () => {
  let ctx

  before(() => { ctx = makeTempDir('lum') })
  beforeEach(() => clearUsageCache())
  after(() => ctx.cleanup())

  it('returns empty map when file does not exist', () => {
    const nonexistent = join(ctx.dir, 'no-such-file.json')
    const map = loadUsageMap(nonexistent)
    assert.ok(typeof map === 'object' && map !== null, 'must return an object')
    assert.strictEqual(Object.keys(map).length, 0, 'empty map for missing file')
  })

  it('returns empty map when file contains invalid JSON', () => {
    writeFileSync(ctx.statsFile, '{ this is not valid json !!!}')
    const map = loadUsageMap(ctx.statsFile)
    assert.ok(typeof map === 'object' && map !== null)
    assert.strictEqual(Object.keys(map).length, 0)
  })

  it('returns empty map when file is valid JSON but has no quotaSnapshots', () => {
    ctx.write({ byAccount: {}, byModel: {}, hourly: {}, daily: {} })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(Object.keys(map).length, 0)
  })

  it('returns empty map when quotaSnapshots.byProviderModel is missing', () => {
    ctx.write({ quotaSnapshots: { byAccount: {} } })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(Object.keys(map).length, 0)
  })

  it('returns map of provider+model -> quotaPercent for valid stats', () => {
    ctx.write({
      quotaSnapshots: {
        byAccount: {},
        byProviderModel: {
          [buildUsageSnapshotKey('groq', 'claude-3-5')]: { quotaPercent: 80, updatedAt: freshTs(), providerKey: 'groq', modelId: 'claude-3-5' },
          [buildUsageSnapshotKey('openrouter', 'gpt-4o')]: { quotaPercent: 45, updatedAt: freshTs(), providerKey: 'openrouter', modelId: 'gpt-4o' },
        },
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(Object.keys(map).length, 2)
    assert.strictEqual(map['groq::claude-3-5'], 80)
    assert.strictEqual(map['openrouter::gpt-4o'], 45)
  })

  it('includes quotaPercent for provider-scoped entry with updatedAt', () => {
    // BEHAVIOR UPDATE (quality pass): snapshots are now gated by quota
    // capabilities. Only providers with usageDisplay 'percent' are surfaced;
    // a fresh entry for an 'ok'-display provider must NOT leak into the map.
    ctx.write({
      quotaSnapshots: {
        byAccount: {},
        byProviderModel: {
          [buildUsageSnapshotKey('cerebras', 'llama-4')]: { quotaPercent: 60, updatedAt: freshTs(), providerKey: 'cerebras', modelId: 'llama-4' },
          [buildUsageSnapshotKey('googleai', 'gemini-pro')]: { quotaPercent: 60, updatedAt: freshTs(), providerKey: 'googleai', modelId: 'gemini-pro' },
        },
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(map['cerebras::llama-4'], 60, 'percent-capable provider entry must be included')
    assert.strictEqual(map['googleai::gemini-pro'], undefined, 'ok-display provider entry must be gated out')
  })

  it('skips byProviderModel entries missing quotaPercent field', () => {
    ctx.write({
      quotaSnapshots: {
        byAccount: {},
        byProviderModel: {
          [buildUsageSnapshotKey('groq', 'good-model')]: { quotaPercent: 70, updatedAt: freshTs(), providerKey: 'groq', modelId: 'good-model' },
          [buildUsageSnapshotKey('groq', 'bad-model')]: { updatedAt: freshTs(), providerKey: 'groq', modelId: 'bad-model' },
        },
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.ok('groq::good-model' in map, 'good-model must be included')
    assert.ok(!('groq::bad-model' in map), 'bad-model missing quotaPercent must be skipped')
  })

  it('handles non-numeric quotaPercent gracefully (skips entry)', () => {
    ctx.write({
      quotaSnapshots: {
        byAccount: {},
        byProviderModel: {
          [buildUsageSnapshotKey('groq', 'fine-model')]: { quotaPercent: 55, updatedAt: freshTs(), providerKey: 'groq', modelId: 'fine-model' },
          [buildUsageSnapshotKey('groq', 'weird-model')]: { quotaPercent: 'lots', updatedAt: freshTs(), providerKey: 'groq', modelId: 'weird-model' },
        },
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.ok('groq::fine-model' in map)
    assert.ok(!('groq::weird-model' in map), 'non-numeric quotaPercent must be skipped')
  })

  it('handles null or empty quotaSnapshots gracefully', () => {
    ctx.write({ quotaSnapshots: null })
    assert.doesNotThrow(() => loadUsageMap(ctx.statsFile))

    ctx.write({ quotaSnapshots: {} })
    const map2 = loadUsageMap(ctx.statsFile)
    assert.strictEqual(Object.keys(map2).length, 0)
  })
})

describe('usage-reader – loadUsageSnapshot', () => {
  let ctx

  before(() => { ctx = makeTempDir('lus') })
  beforeEach(() => clearUsageCache())
  after(() => ctx.cleanup())

  it('returns model and provider maps', () => {
    ctx.write({
      quotaSnapshots: {
        byProviderModel: {
          [buildUsageSnapshotKey('groq', 'model-a')]: { quotaPercent: 80, updatedAt: freshTs(), providerKey: 'groq', modelId: 'model-a' },
        },
        byProvider: {
          groq: { quotaPercent: 64, updatedAt: freshTs() },
        },
      },
    })

    const snapshot = loadUsageSnapshot(ctx.statsFile)
    assert.strictEqual(snapshot.byProviderModel['groq::model-a'], 80)
    assert.strictEqual(snapshot.byProvider.groq, 64)
  })
})

// ─── Suite: usageForModelId ───────────────────────────────────────────────────

describe('usage-reader – usageForModelId', () => {
  let ctx

  before(() => { ctx = makeTempDir('ufm') })
  beforeEach(() => clearUsageCache())
  after(() => ctx.cleanup())

  it('returns null when model not in map', () => {
    ctx.write({
      quotaSnapshots: {
        byAccount: {},
        byModel: {
          'existing-model': { quotaPercent: 70, updatedAt: freshTs() },
        },
      },
    })
    const result = usageForModelId('no-such-model', ctx.statsFile)
    assert.strictEqual(result, null)
  })

  it('returns quotaPercent for known model', () => {
    ctx.write({
      quotaSnapshots: {
        byAccount: {},
        byModel: {
          'known-model': { quotaPercent: 88, updatedAt: freshTs() },
        },
      },
    })
    const result = usageForModelId('known-model', ctx.statsFile)
    assert.strictEqual(result, 88)
  })

  it('returns null for missing file', () => {
    const result = usageForModelId('any-model', join(ctx.dir, 'does-not-exist.json'))
    assert.strictEqual(result, null)
  })

  it('returns null for malformed file', () => {
    writeFileSync(ctx.statsFile, 'BROKEN')
    const result = usageForModelId('any-model', ctx.statsFile)
    assert.strictEqual(result, null)
  })
})

describe('usage-reader – usageForRow', () => {
  let ctx

  before(() => { ctx = makeTempDir('ufr') })
  beforeEach(() => clearUsageCache())
  after(() => ctx.cleanup())

  it('prefers provider-scoped model quota when available', () => {
    ctx.write({
      quotaSnapshots: {
        byProviderModel: { [buildUsageSnapshotKey('groq', 'model-a')]: { quotaPercent: 71, updatedAt: freshTs(), providerKey: 'groq', modelId: 'model-a' } },
        byProvider: { groq: { quotaPercent: 55, updatedAt: freshTs() } },
      },
    })

    assert.strictEqual(usageForRow('groq', 'model-a', ctx.statsFile), 71)
  })

  it('falls back to provider quota when model is missing', () => {
    ctx.write({
      quotaSnapshots: {
        byProviderModel: {},
        byProvider: { groq: { quotaPercent: 77, updatedAt: freshTs() } },
      },
    })

    assert.strictEqual(usageForRow('groq', 'unknown-model', ctx.statsFile), 77)
  })

  it('returns null when neither model nor provider usage exists', () => {
    ctx.write({ quotaSnapshots: { byProviderModel: {}, byProvider: {} } })
    assert.strictEqual(usageForRow('cerebras', 'model-x', ctx.statsFile), null)
  })

  it('returns null for providers whose Usage percent is not applicable', () => {
    ctx.write({
      quotaSnapshots: {
        byProviderModel: {
          [buildUsageSnapshotKey('nvidia', 'model-x')]: { quotaPercent: 37, updatedAt: freshTs(), providerKey: 'nvidia', modelId: 'model-x' },
        },
        byProvider: { nvidia: { quotaPercent: 37, updatedAt: freshTs() } },
      },
    })
    assert.strictEqual(usageForRow('nvidia', 'model-x', ctx.statsFile), null)
  })
})

// ─── Suite: multi-account aggregation (integration) ──────────────────────────

describe('usage-reader – aggregation from multiple accounts (integration)', () => {
  let ctx

  before(() => { ctx = makeTempDir('agg') })
  beforeEach(() => clearUsageCache())
  after(() => ctx.cleanup())

  it('provider-scoped quotaPercent keeps identical model IDs isolated per Origin', () => {
    const freshTime = new Date(Date.now() - 60 * 1000).toISOString() // 1 min ago = fresh
    ctx.write({
      quotaSnapshots: {
        byAccount: {
          'acct-a': { quotaPercent: 90, providerKey: 'nvidia', modelId: 'shared', updatedAt: freshTime },
          'acct-b': { quotaPercent: 50, providerKey: 'groq', modelId: 'shared', updatedAt: freshTime },
        },
        byProviderModel: {
          'nvidia::shared': { quotaPercent: 90, updatedAt: freshTime, providerKey: 'nvidia', modelId: 'shared' },
          'groq::shared': { quotaPercent: 50, updatedAt: freshTime, providerKey: 'groq', modelId: 'shared' },
        },
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(map['nvidia::shared'], undefined, 'nvidia snapshots are not surfaced as Usage %')
    assert.strictEqual(map['groq::shared'], 50, 'groq value must stay scoped to groq only')
  })
})

// ─── Suite: snapshot freshness (TTL) ─────────────────────────────────────────

describe('usage-reader – snapshot freshness TTL', () => {
  let ctx

  before(() => { ctx = makeTempDir('ttl') })
  beforeEach(() => clearUsageCache())
  after(() => ctx.cleanup())

  it('exports SNAPSHOT_TTL_MS as a positive number (30 minutes)', () => {
    assert.ok(typeof SNAPSHOT_TTL_MS === 'number', 'SNAPSHOT_TTL_MS must be a number')
    assert.ok(SNAPSHOT_TTL_MS > 0, 'SNAPSHOT_TTL_MS must be positive')
    assert.strictEqual(SNAPSHOT_TTL_MS, 30 * 60 * 1000, 'SNAPSHOT_TTL_MS must be 30 minutes')
  })

  it('loadUsageMap includes fresh provider-scoped model entry (updatedAt within TTL)', () => {
    const freshTime = new Date(Date.now() - 60 * 1000).toISOString() // 1 min ago
    ctx.write({
      quotaSnapshots: {
        byProviderModel: {
          'groq::fresh-model': { quotaPercent: 75, updatedAt: freshTime, providerKey: 'groq', modelId: 'fresh-model' },
        },
        byProvider: {},
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(map['groq::fresh-model'], 75, 'fresh entry must be included')
  })

  it('loadUsageMap excludes stale provider-scoped model entry (updatedAt older than TTL)', () => {
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString() // 31 min ago
    ctx.write({
      quotaSnapshots: {
        byProviderModel: {
          'groq::stale-model': { quotaPercent: 60, updatedAt: staleTime, providerKey: 'groq', modelId: 'stale-model' },
        },
        byProvider: {},
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.ok(!('groq::stale-model' in map), 'stale entry (>30m) must be excluded from loadUsageMap')
  })

  it('loadUsageMap excludes model entry exactly at TTL boundary (exclusive)', () => {
    // Exactly at 30m (boundary): should be treated as stale
    const boundaryTime = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    ctx.write({
      quotaSnapshots: {
        byModel: {
          'boundary-model': { quotaPercent: 50, updatedAt: boundaryTime },
        },
        byProvider: {},
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.ok(Object.keys(map).length === 0, 'entry at exactly TTL boundary must be excluded')
  })

  it('loadUsageMap includes model entry just inside TTL (updatedAt < 30m ago)', () => {
    // 29m59s ago: just within TTL — must be included
    const justFreshTime = new Date(Date.now() - (30 * 60 * 1000 - 1000)).toISOString()
    ctx.write({
      quotaSnapshots: {
        byProviderModel: {
          'groq::just-fresh-model': { quotaPercent: 88, updatedAt: justFreshTime, providerKey: 'groq', modelId: 'just-fresh-model' },
        },
        byProvider: {},
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(map['groq::just-fresh-model'], 88, 'entry just inside TTL must be included')
  })

  it('loadUsageMap includes entry without updatedAt (backward compat: no TTL filter)', () => {
    // Old snapshots without updatedAt are included to preserve backward compatibility.
    // (Freshness check only applies when updatedAt is present.)
    ctx.write({
      quotaSnapshots: {
        byProviderModel: {
          'groq::no-timestamp-model': { quotaPercent: 42, providerKey: 'groq', modelId: 'no-timestamp-model' },
        },
        byProvider: {},
      },
    })
    const map = loadUsageMap(ctx.statsFile)
    assert.strictEqual(map['groq::no-timestamp-model'], 42, 'entry without updatedAt must still be included for backward compat')
  })

  it('loadUsageSnapshot excludes stale provider entry (updatedAt older than TTL)', () => {
    // BEHAVIOR UPDATE (quality pass): byProvider entries are keyed by real
    // providerKey and gated by quota capabilities, so use percent-capable
    // providers. openrouter has resetCadence 'unknown' (no daily invalidation),
    // keeping the fresh-entry assertion deterministic regardless of midnight.
    const staleTime = new Date(Date.now() - 45 * 60 * 1000).toISOString() // 45 min ago
    const freshTime = new Date(Date.now() - 5 * 60 * 1000).toISOString() // 5 min ago
    ctx.write({
      quotaSnapshots: {
        byProviderModel: {
          'groq::model-b': { quotaPercent: 80, updatedAt: freshTime, providerKey: 'groq', modelId: 'model-b' },
        },
        byProvider: {
          groq: { quotaPercent: 70, updatedAt: staleTime },
          openrouter: { quotaPercent: 60, updatedAt: freshTime },
        },
      },
    })
    const snap = loadUsageSnapshot(ctx.statsFile)
    assert.ok(!('groq' in snap.byProvider), 'stale provider must be excluded')
    assert.strictEqual(snap.byProvider.openrouter, 60, 'fresh provider must be included')
  })

  it('usageForRow returns null when model snapshot is stale (falls back to provider, but provider also stale)', () => {
    const staleTime = new Date(Date.now() - 40 * 60 * 1000).toISOString() // 40 min ago
    ctx.write({
      quotaSnapshots: {
        byProviderModel: {
          'stale-prov::stale-model': { quotaPercent: 50, updatedAt: staleTime, providerKey: 'stale-prov', modelId: 'stale-model' },
        },
        byProvider: {
          'stale-prov': { quotaPercent: 60, updatedAt: staleTime },
        },
      },
    })
    const result = usageForRow('stale-prov', 'stale-model', ctx.statsFile)
    assert.strictEqual(result, null, 'both model and provider are stale: result must be null')
  })

  it('usageForRow uses fresh provider fallback when model is stale', () => {
    // BEHAVIOR UPDATE (quality pass): usageForRow returns null for providers
    // without usageDisplay 'percent', so the fallback scenario now uses a real
    // percent-capable provider (openrouter, no daily reset => deterministic).
    const staleTime = new Date(Date.now() - 40 * 60 * 1000).toISOString()
    const freshTime = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    ctx.write({
      quotaSnapshots: {
        byProviderModel: {
          'openrouter::stale-model': { quotaPercent: 50, updatedAt: staleTime, providerKey: 'openrouter', modelId: 'stale-model' },
        },
        byProvider: {
          openrouter: { quotaPercent: 72, updatedAt: freshTime },
        },
      },
    })
    const result = usageForRow('openrouter', 'stale-model', ctx.statsFile)
    assert.strictEqual(result, 72, 'stale model snapshot must fall back to fresh provider')
  })

  it('usageForModelId returns null when snapshot is stale', () => {
    const staleTime = new Date(Date.now() - 35 * 60 * 1000).toISOString()
    ctx.write({
      quotaSnapshots: {
        byAccount: {},
        byModel: {
          'some-model': { quotaPercent: 55, updatedAt: staleTime },
        },
      },
    })
    const result = usageForModelId('some-model', ctx.statsFile)
    assert.strictEqual(result, null, 'stale model snapshot must return null from usageForModelId')
  })
})

// ─── Suite: module-level cache (Task 4) ──────────────────────────────────────

describe('usage-reader – module-level parse cache', () => {
  let ctx

  before(() => { ctx = makeTempDir('cache') })
  after(() => ctx.cleanup())

  it('exports CACHE_TTL_MS as a positive number between 500ms and 1000ms', () => {
    assert.ok(typeof CACHE_TTL_MS === 'number', 'CACHE_TTL_MS must be a number')
    assert.ok(CACHE_TTL_MS >= 500, 'CACHE_TTL_MS must be at least 500ms')
    assert.ok(CACHE_TTL_MS <= 1000, 'CACHE_TTL_MS must be at most 1000ms')
  })

  it('exports clearUsageCache as a function', () => {
    assert.ok(typeof clearUsageCache === 'function', 'clearUsageCache must be exported as a function')
  })

  it('returns cached result on second call without rereading disk (same content)', () => {
    clearUsageCache()
    ctx.write({
      quotaSnapshots: {
        byProviderModel: { 'groq::cached-model': { quotaPercent: 33, updatedAt: freshTs(), providerKey: 'groq', modelId: 'cached-model' } },
        byProvider: {},
      },
    })

    const first = loadUsageMap(ctx.statsFile)
    assert.strictEqual(first['groq::cached-model'], 33, 'first call must return the value')

    // Overwrite the file on disk — the cache should shield the second call
    ctx.write({
      quotaSnapshots: {
        byProviderModel: { 'groq::cached-model': { quotaPercent: 99, updatedAt: freshTs(), providerKey: 'groq', modelId: 'cached-model' } },
        byProvider: {},
      },
    })

    const second = loadUsageMap(ctx.statsFile)
    assert.strictEqual(second['groq::cached-model'], 33, 'second call within CACHE_TTL_MS must return cached value, not updated disk value')
  })

  it('clearUsageCache forces re-read from disk on next call', () => {
    clearUsageCache()
    ctx.write({
      quotaSnapshots: {
        byProviderModel: { 'groq::refresh-model': { quotaPercent: 10, updatedAt: freshTs(), providerKey: 'groq', modelId: 'refresh-model' } },
        byProvider: {},
      },
    })

    const first = loadUsageMap(ctx.statsFile)
    assert.strictEqual(first['groq::refresh-model'], 10, 'first call returns initial value')

    // Update disk content
    ctx.write({
      quotaSnapshots: {
        byProviderModel: { 'groq::refresh-model': { quotaPercent: 20, updatedAt: freshTs(), providerKey: 'groq', modelId: 'refresh-model' } },
        byProvider: {},
      },
    })

    // Without clearing, still cached
    const stillCached = loadUsageMap(ctx.statsFile)
    assert.strictEqual(stillCached['groq::refresh-model'], 10, 'before clearUsageCache, must still return cached value')

    // After clearing, must re-read from disk
    clearUsageCache()
    const afterClear = loadUsageMap(ctx.statsFile)
    assert.strictEqual(afterClear['groq::refresh-model'], 20, 'after clearUsageCache, must re-read from disk')
  })

  it('cache is keyed by statsFile path — different paths have independent caches', () => {
    clearUsageCache()
    const ctx2 = makeTempDir('cache2')

    try {
      ctx.write({
        quotaSnapshots: {
          byProviderModel: { 'groq::model-path-a': { quotaPercent: 11, updatedAt: freshTs(), providerKey: 'groq', modelId: 'model-path-a' } },
          byProvider: {},
        },
      })
      ctx2.write({
        quotaSnapshots: {
          byProviderModel: { 'groq::model-path-b': { quotaPercent: 22, updatedAt: freshTs(), providerKey: 'groq', modelId: 'model-path-b' } },
          byProvider: {},
        },
      })

      const mapA = loadUsageMap(ctx.statsFile)
      const mapB = loadUsageMap(ctx2.statsFile)

      assert.strictEqual(mapA['groq::model-path-a'], 11, 'path A must have its own cached value')
      assert.ok(!('groq::model-path-b' in mapA), 'path A cache must not bleed into path B')
      assert.strictEqual(mapB['groq::model-path-b'], 22, 'path B must have its own cached value')
      assert.ok(!('groq::model-path-a' in mapB), 'path B cache must not bleed into path A')
    } finally {
      ctx2.cleanup()
    }
  })

  it('cache expiry after CACHE_TTL_MS causes re-read from disk', async () => {
    clearUsageCache()
    ctx.write({
      quotaSnapshots: {
        byProviderModel: { 'groq::expiry-model': { quotaPercent: 41, updatedAt: freshTs(), providerKey: 'groq', modelId: 'expiry-model' } },
        byProvider: {},
      },
    })

    const first = loadUsageMap(ctx.statsFile)
    assert.strictEqual(first['groq::expiry-model'], 41, 'first call returns initial value')

    // Wait for the cache TTL to expire (CACHE_TTL_MS + small buffer)
    await new Promise((resolve) => setTimeout(resolve, CACHE_TTL_MS + 100))

    // Update disk content after TTL has elapsed
    ctx.write({
      quotaSnapshots: {
        byProviderModel: { 'groq::expiry-model': { quotaPercent: 99, updatedAt: freshTs(), providerKey: 'groq', modelId: 'expiry-model' } },
        byProvider: {},
      },
    })

    const afterExpiry = loadUsageMap(ctx.statsFile)
    assert.strictEqual(afterExpiry['groq::expiry-model'], 99, 'after CACHE_TTL_MS, must re-read from disk')
  })

  it('30-minute data freshness (SNAPSHOT_TTL_MS) is preserved even when cache is active', () => {
    clearUsageCache()
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString()
    ctx.write({
      quotaSnapshots: {
        byProviderModel: { 'groq::stale-cached-model': { quotaPercent: 77, updatedAt: staleTime, providerKey: 'groq', modelId: 'stale-cached-model' } },
        byProvider: {},
      },
    })

    const map = loadUsageMap(ctx.statsFile)
    assert.ok(!('groq::stale-cached-model' in map), 'stale data must still be excluded even when result is cached')
  })

  it('daily-reset providers are invalidated after day rollover even if within generic TTL', () => {
    clearUsageCache()
    const justBeforeMidnight = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const yesterdaySameClock = new Date(yesterday.getTime() + 5 * 60 * 1000).toISOString()

    ctx.write({
      quotaSnapshots: {
        byProviderModel: {
          'groq::yesterday-model': { quotaPercent: 20, updatedAt: yesterdaySameClock, providerKey: 'groq', modelId: 'yesterday-model' },
          'openrouter::recent-model': { quotaPercent: 33, updatedAt: justBeforeMidnight, providerKey: 'openrouter', modelId: 'recent-model' },
        },
        byProvider: {},
      },
    })

    const map = loadUsageMap(ctx.statsFile)
    assert.ok(!('groq::yesterday-model' in map), 'daily-reset provider must drop yesterday snapshot immediately')
    assert.strictEqual(map['openrouter::recent-model'], 33, 'non-daily provider keeps fresh snapshot')
  })
})

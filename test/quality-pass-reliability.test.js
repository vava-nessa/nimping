/**
 * @file test/quality-pass-reliability.test.js
 * @description Regression tests for the reliability bug-fix pass (phase 2).
 *
 * Covers:
 *   - getApiKey: array-valued keys resolve to the first usable string (never "k1,k2")
 *   - saveConfig: hiddenModels Set survives a save/load roundtrip
 *   - buildPersistedConfig: hiddenModels union + settings per-key shallow merge
 *   - normalizeRouterConfig: boolean port falls back to the default instead of 1
 *   - updater: isNewerVersion (dist-tag rollback is not an update)
 *   - probe-cache: pruned entries do not resurrect; other-process additions merge in
 *   - runtime-telemetry: same prune-resurrection guarantees
 *   - opencode-config / kilo-config: unreadable existing config aborts saves
 *   - legacy-proxy-cleanup: non-FCM aider/amp localhost configs stay untouched
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

// ─── Module imports (env overrides must happen BEFORE the imports) ───────────

// 📖 Route ~/.free-coding-models.json into a throwaway dir for this process.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'fcm-reliability-'))
process.env.FCM_CONFIG_DIR = join(TMP_ROOT, 'fcm-config')

// 📖 os.homedir() honours $HOME on macOS/Linux: point it at a throwaway dir so
// 📖 the opencode/kilo config helpers never touch the real user files.
process.env.HOME = join(TMP_ROOT, 'home')
mkdirSync(process.env.HOME, { recursive: true })

const {
  getApiKey,
  addApiKey,
  saveConfig,
  loadConfig,
  buildPersistedConfig,
  normalizeRouterConfig,
} = await import('../src/core/config.js')
const { isNewerVersion } = await import('../src/core/updater.js')
const probeCache = await import('../src/core/probe-cache.js')
const telemetry = await import('../src/core/runtime-telemetry.js')
const opencodeConfig = await import('../src/core/opencode-config.js')
const kiloConfig = await import('../src/core/kilo-config.js')
const { cleanupLegacyProxyArtifacts } = await import('../src/core/legacy-proxy-cleanup.js')
const { CURRENT_PROBE_VERSION } = probeCache

// ─── Fix 1: getApiKey with array-valued keys ─────────────────────────────────

describe('getApiKey with multi-key arrays', () => {
  // 📖 'testprov' has no env var mapping, so the env override never interferes.
  it('returns the first non-empty entry of an array value', () => {
    assert.equal(getApiKey({ apiKeys: { testprov: ['key-1', 'key-2'] } }, 'testprov'), 'key-1')
  })

  it('skips empty entries inside the array', () => {
    assert.equal(getApiKey({ apiKeys: { testprov: ['', 'key-2'] } }, 'testprov'), 'key-2')
  })

  it('still returns plain string values as-is', () => {
    assert.equal(getApiKey({ apiKeys: { testprov: 'plain-key' } }, 'testprov'), 'plain-key')
  })

  it('returns null when the array holds no usable key', () => {
    assert.equal(getApiKey({ apiKeys: { testprov: [''] } }, 'testprov'), null)
  })

  it('addApiKey still converts a second key to an array (unchanged behavior)', () => {
    const config = { apiKeys: {} }
    assert.equal(addApiKey(config, 'testprov', 'a'), true)
    assert.equal(addApiKey(config, 'testprov', 'b'), true)
    assert.deepEqual(config.apiKeys.testprov, ['a', 'b'])
    assert.equal(getApiKey(config, 'testprov'), 'a')
  })
})

// ─── Fix 2 + 5: hiddenModels persistence + settings per-key merge ────────────

describe('buildPersistedConfig merge semantics', () => {
  it('unions hiddenModels from disk and incoming', () => {
    const merged = buildPersistedConfig(
      { hiddenModels: ['prov/b-model'] },
      { hiddenModels: ['prov/a-model'] },
    )
    assert.deepEqual([...merged.hiddenModels].sort(), ['prov/a-model', 'prov/b-model'])
  })

  it('lets incoming win when auto-hide is explicitly disabled (unhide-all persists)', () => {
    const merged = buildPersistedConfig(
      { hiddenModels: [], settings: { autoHideBrokenModels: false } },
      { hiddenModels: ['prov/a-model'] },
    )
    assert.equal(merged.hiddenModels.size, 0)
    assert.equal(merged.settings.autoHideBrokenModels, false)
  })

  it('shallow-merges settings per top-level key instead of replacing wholesale', () => {
    const merged = buildPersistedConfig(
      { settings: { theme: 'dark' } },
      { settings: { theme: 'light', tierFilter: 'A' } },
    )
    assert.equal(merged.settings.theme, 'dark')    // incoming wins per key
    assert.equal(merged.settings.tierFilter, 'A')  // disk-only key survives
  })
})

describe('saveConfig hiddenModels roundtrip', () => {
  it('persists hiddenModels Set entries and they survive a reload', () => {
    const config = loadConfig()
    config.hiddenModels = new Set(['nvidia/test/dead-model'])
    const result = saveConfig(config)
    assert.equal(result.success, true)

    const reloaded = loadConfig()
    assert.ok(reloaded.hiddenModels instanceof Set)
    assert.ok(reloaded.hiddenModels.has('nvidia/test/dead-model'))

    // 📖 A second save from a config whose in-memory set is empty (e.g. a daemon
    // 📖 autosave that never saw the probe's addition) must not wipe the set:
    // 📖 that is exactly the stale-writer case the union merge exists for.
    const stale = loadConfig()
    stale.hiddenModels = new Set()
    stale.settings.pingInterval = 5000
    assert.equal(saveConfig(stale).success, true)
    assert.ok(loadConfig().hiddenModels.has('nvidia/test/dead-model'))
  })
})

// ─── Fix 13: normalizePositiveInteger rejects booleans ───────────────────────

describe('normalizeRouterConfig boolean safety', () => {
  it('falls back to the default port for a boolean value', () => {
    assert.equal(normalizeRouterConfig({ port: true }).port, 19280)
    assert.equal(normalizeRouterConfig({ port: false }).port, 19280)
  })

  it('still accepts numeric ports and numeric strings', () => {
    assert.equal(normalizeRouterConfig({ port: 5123 }).port, 5123)
    assert.equal(normalizeRouterConfig({ port: '7' }).port, 7)
  })
})

// ─── Fix 11: semver update compare ───────────────────────────────────────────

describe('isNewerVersion (updater)', () => {
  it('reports an update only for strictly greater versions', () => {
    assert.equal(isNewerVersion('0.5.87', '0.5.86'), true)
    assert.equal(isNewerVersion('1.0.0', '0.99.99'), true)
    assert.equal(isNewerVersion('0.6', '0.5.99'), true)
  })

  it('never treats equal or lower remote versions as an update (no downgrade)', () => {
    assert.equal(isNewerVersion('0.5.86', '0.5.86'), false)
    assert.equal(isNewerVersion('0.5.85', '0.5.86'), false)
    assert.equal(isNewerVersion('0.5.9', '0.5.10'), false)
  })

  it('tolerates a v prefix and garbage parts', () => {
    assert.equal(isNewerVersion('v1.0.0', '0.9.9'), true)
    assert.equal(isNewerVersion('', ''), false)
    assert.equal(isNewerVersion('abc', '1.0.0'), false)
  })
})

// ─── Fix 10: probe-cache prune resurrection + external merges ────────────────

describe('probe-cache flush merge safety', () => {
  it('keeps pruned entries pruned after flush + reload, and merges other-process additions', () => {
    const cachePath = join(TMP_ROOT, 'probe-cache.json')
    probeCache.clearCache({ path: cachePath })
    probeCache.loadCache({ path: cachePath })

    probeCache.recordProbeResults('prov', [
      { modelId: 'keep', status: 'ok', latencyMs: 10 },
      { modelId: 'gone', status: 'ok', latencyMs: 12 },
    ])
    probeCache.flushCache({ path: cachePath })

    // 📖 Catalog no longer lists 'gone' → pruned this session.
    assert.equal(probeCache.pruneStaleEntries('prov', ['keep']), 1)

    // 📖 Simulate another process writing the file between our load and flush:
    // 📖 the stale disk copy still has 'gone' plus a brand-new 'external' entry.
    const onDisk = JSON.parse(readFileSync(cachePath, 'utf8'))
    onDisk.providers.prov.models.external = {
      status: 'ok', lastProbedAt: Date.now(), probeVersion: CURRENT_PROBE_VERSION,
    }
    writeFileSync(cachePath, JSON.stringify(onDisk))

    assert.equal(probeCache.flushCache({ path: cachePath }), true)

    const reloaded = probeCache.loadCache({ path: cachePath })
    const models = reloaded.providers.prov.models
    assert.ok(models.keep, 'kept entry survives')
    assert.equal(models.gone, undefined, 'pruned entry must not resurrect from the stale disk file')
    assert.ok(models.external, 'entry added by another process still merges in')

    probeCache.clearCache({ path: cachePath })
  })
})

describe('runtime-telemetry flush merge safety', () => {
  it('keeps pruned entries pruned after flush + reload, and merges other-process additions', () => {
    const telemetryPath = join(TMP_ROOT, 'runtime-telemetry.json')
    telemetry.clearRuntimeTelemetry({ path: telemetryPath })
    telemetry.loadRuntimeTelemetry({ path: telemetryPath })

    const now = Date.now()
    telemetry.recordModelCall('prov', 'keep', { success: true, latencyMs: 5 }, { now })
    telemetry.recordModelCall('prov', 'gone', { success: true, latencyMs: 5 }, { now: now - 60000 })
    telemetry.flushRuntimeTelemetry({ path: telemetryPath })

    // 📖 Only 'gone' is older than the 30s max age.
    assert.equal(telemetry.pruneStaleEntries(30000, { now }), 1)

    const onDisk = JSON.parse(readFileSync(telemetryPath, 'utf8'))
    onDisk.models['prov/gone'] = { providerKey: 'prov', modelId: 'gone', totalCalls: 1, lastUpdated: now }
    onDisk.models['prov/external'] = { providerKey: 'prov', modelId: 'external', totalCalls: 3, lastUpdated: now }
    writeFileSync(telemetryPath, JSON.stringify(onDisk))

    assert.equal(telemetry.flushRuntimeTelemetry({ path: telemetryPath }), true)

    const reloaded = telemetry.loadRuntimeTelemetry({ path: telemetryPath })
    assert.ok(reloaded.models['prov/keep'], 'kept entry survives')
    assert.ok(reloaded.models['prov/external'], 'entry added by another process still merges in')
    assert.equal(reloaded.models['prov/gone'], undefined, 'pruned entry must not resurrect')

    telemetry.clearRuntimeTelemetry({ path: telemetryPath })
  })
})

// ─── Fix 18 + 24: unreadable tool config aborts saves, writes are atomic ─────

describe('opencode-config corrupt-file guard', () => {
  const cfgDir = join(process.env.HOME, '.config', 'opencode')
  const cfgPath = join(cfgDir, 'opencode.json')

  it('loadOpenCodeConfig returns null for an existing non-empty corrupt file', () => {
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(cfgPath, '{ definitely not json')
    assert.equal(opencodeConfig.loadOpenCodeConfig(), null)
  })

  it('saveOpenCodeConfig aborts and leaves the corrupt file untouched', () => {
    assert.equal(opencodeConfig.saveOpenCodeConfig({ model: 'new' }), false)
    assert.equal(readFileSync(cfgPath, 'utf8'), '{ definitely not json')
    // 📖 A null config is refused too (callers that pass the load result through).
    assert.equal(opencodeConfig.saveOpenCodeConfig(null), false)
  })

  it('still saves normally when the file is valid, with a backup + atomic replace', () => {
    writeFileSync(cfgPath, JSON.stringify({ model: 'orig' }))
    assert.equal(opencodeConfig.saveOpenCodeConfig({ model: 'new' }), true)
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), { model: 'new' })
    assert.ok(existsSync(join(cfgDir, 'opencode.json.bak')))
  })
})

describe('kilo-config corrupt-file guard', () => {
  const cfgDir = join(process.env.HOME, '.config', 'kilo')
  const cfgPath = join(cfgDir, 'opencode.json')

  it('loadKiloConfig returns null and saveKiloConfig aborts on a corrupt file', () => {
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(cfgPath, 'not json at all')
    assert.equal(kiloConfig.loadKiloConfig(), null)
    assert.equal(kiloConfig.saveKiloConfig({ model: 'x' }), false)
    assert.equal(readFileSync(cfgPath, 'utf8'), 'not json at all')
  })
})

// ─── Fix 22: legacy proxy cleanup must not eat unrelated localhost configs ───

describe('legacy-proxy-cleanup aider/amp gating', () => {
  function buildTmpPaths(home) {
    return {
      configPath: join(home, 'fcm-config.json'),
      dataDir: join(home, 'fcm-data'),
      opencodeConfigPath: join(home, 'oc.json'),
      openclawConfigPath: join(home, 'openclaw.json'),
      crushConfigPath: join(home, 'crush.json'),
      gooseProvidersDir: join(home, 'goose-providers'),
      gooseSecretsPath: join(home, 'goose-secrets.yaml'),
      gooseConfigPath: join(home, 'goose-config.yaml'),
      piModelsPath: join(home, 'pi-models.json'),
      piSettingsPath: join(home, 'pi-settings.json'),
      aiderConfigPath: join(home, '.aider.conf.yml'),
      ampConfigPath: join(home, 'amp-settings.json'),
      qwenConfigPath: join(home, 'qwen-settings.json'),
      launchAgentPath: join(home, 'launchd.plist'),
      systemdServicePath: join(home, 'fcm-proxy.service'),
      shellProfilePaths: [],
    }
  }

  it('leaves a non-FCM aider config (e.g. ollama) untouched', () => {
    const home = mkdtempSync(join(tmpdir(), 'fcm-aider-'))
    const paths = buildTmpPaths(home)
    writeFileSync(paths.aiderConfigPath, 'model: ollama_chat/qwen3\nopenai-api-base: http://127.0.0.1:11434\n')
    cleanupLegacyProxyArtifacts({ homeDir: home, paths })
    assert.ok(existsSync(paths.aiderConfigPath), 'ollama-style aider config must survive cleanup')
    rmSync(home, { recursive: true, force: true })
  })

  it('leaves a user-owned localhost amp.url alone', () => {
    const home = mkdtempSync(join(tmpdir(), 'fcm-amp-'))
    const paths = buildTmpPaths(home)
    mkdirSync(dirname(paths.ampConfigPath), { recursive: true })
    writeFileSync(paths.ampConfigPath, JSON.stringify({ 'amp.url': 'http://127.0.0.1:11434', 'amp.model': 'qwen' }))
    cleanupLegacyProxyArtifacts({ homeDir: home, paths })
    const amp = JSON.parse(readFileSync(paths.ampConfigPath, 'utf8'))
    assert.equal(amp['amp.url'], 'http://127.0.0.1:11434')
    rmSync(home, { recursive: true, force: true })
  })

  it('removes an FCM proxy aider config, with a backup before the unlink', () => {
    const home = mkdtempSync(join(tmpdir(), 'fcm-aider2-'))
    const paths = buildTmpPaths(home)
    writeFileSync(paths.aiderConfigPath, '# FCM Proxy V2\nopenai-api-base: http://127.0.0.1:8787/v1\n')
    cleanupLegacyProxyArtifacts({ homeDir: home, paths })
    assert.equal(existsSync(paths.aiderConfigPath), false, 'FCM proxy aider config is removed')
    const backups = readdirSync(home).filter((f) => f.startsWith('.aider.conf.yml.backup-'))
    assert.ok(backups.length > 0, 'a backup is written before the unlink')
    rmSync(home, { recursive: true, force: true })
  })
})

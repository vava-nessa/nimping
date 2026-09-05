/**
 * @file test/quality-pass-core-coverage.test.js
 * @description High-value coverage for modules that previous suites only
 * touched indirectly. All tests are zero-network (127.0.0.1 throwaway servers
 * or pure functions) and use no real API keys.
 *
 * Coverage map:
 *   1. installed-models-manager: parseToolConfig on corrupt/partial tool
 *      configs never crashes; zcode scanner dedupes a model listed in both
 *      config.json and the cache (no ghost rows, no phantom "-small" variants).
 *   2. config: save/load roundtrip keeps future (unknown) settings keys, and a
 *      stale writer cannot wipe apiKeys another writer saved after it loaded.
 *   3. ping: wire-level classification against a local HTTP server
 *      (401, 429 + Retry-After cooldown, 200 with an error-shaped body).
 *   4. router daemon: upstream that accepts the connection, answers 200, then
 *      dies with ZERO relayed chunks still fails over to the fallback provider.
 *   5. tool-launchers: prepareExternalToolLaunch with no API key returns a
 *      blocked plan and writes nothing.
 *   6. key-handler: the T key cycles tier filters and wraps from the last tier
 *      back to the first.
 *   7. endpoint-installer: aider + openhands installs record 0600 secret files
 *      with the right model ids, and a hostile API key survives a real
 *      /bin/sh source round-trip.
 */

import './helpers/isolated-config-dir.js'

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

import { loadConfig, saveConfig, normalizeRouterConfig, DEFAULT_ROUTER_SETTINGS } from '../src/core/config.js'
import { parseToolConfig, scanAllToolConfigs } from '../src/core/installed-models-manager.js'
import { ping } from '../src/core/ping.js'
import { isProviderQuotaPaused, clearProviderQuotaPause } from '../src/core/provider-cooldown.js'
import { prepareExternalToolLaunch } from '../src/core/tool-launchers.js'
import { createKeyHandler } from '../src/tui/key-handler.js'
import { TIER_CYCLE } from '../src/core/constants.js'
import { installProviderEndpoints } from '../src/core/endpoint-installer.js'
import { createRouterRuntimeForTest } from '../src/core/router-daemon.js'
import { ENV_VARS } from '../src/core/config.js'
import { sources } from '../sources.js'

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Unique temp dir per call, cleaned by the caller in a finally block. */
function makeTempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `fcm-qpcov-${label}-`))
  return dir
}

function listenOnRandomPort(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

function closeServer(server) {
  return new Promise((resolve) => { server.close(() => resolve()) })
}

// ─── 1. installed-models-manager ──────────────────────────────────────────────

describe('installed-models-manager corrupt/partial tool configs', () => {
  it('parseToolConfig returns a safe empty result on corrupt JSON (no crash)', () => {
    const home = makeTempDir('corrupt')
    try {
      const crushPath = join(home, '.config', 'crush', 'crush.json')
      mkdirSync(dirname(crushPath), { recursive: true })
      writeFileSync(crushPath, '{ this is not valid json !!!')

      const result = parseToolConfig('crush', { crush: crushPath })
      assert.equal(result.isValid, false)
      assert.deepEqual(result.models, [])
      assert.equal(result.configPath, crushPath)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('parseToolConfig survives partial config fields (providers without models, empty size slots)', () => {
    const home = makeTempDir('partial')
    try {
      const crushPath = join(home, '.config', 'crush', 'crush.json')
      mkdirSync(dirname(crushPath), { recursive: true })
      // 📖 Every shape a half-written or hand-edited config can take:
      // 📖 provider without a models list, models slots without a model id.
      writeFileSync(crushPath, JSON.stringify({
        providers: { 'manual-provider': {} },
        models: { large: {}, small: {} },
      }))

      const result = parseToolConfig('crush', { crush: crushPath })
      assert.equal(result.isValid, true)
      assert.deepEqual(result.models, [])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('parseToolConfig returns an invalid result for unknown tool modes', () => {
    const result = parseToolConfig('does-not-exist', {})
    assert.equal(result.isValid, false)
    assert.deepEqual(result.models, [])
  })
})

describe('installed-models-manager zcode dedupe', () => {
  it('scanAllToolConfigs yields one row for a model present in both zcode config and cache (no ghosts, no -small phantoms)', () => {
    const home = makeTempDir('zcode-dedupe')
    try {
      const configPath = join(home, '.zcode', 'v2', 'config.json')
      const cachePath = join(home, '.zcode', 'v2', 'bots-model-cache.v2.json')
      mkdirSync(dirname(configPath), { recursive: true })

      // 📖 Same model registered as source of truth (config.json) AND in the
      // 📖 cache with a prettier label. The old implementation appended a
      // 📖 duplicate block and minted phantom small variants; the Map-keyed
      // 📖 merge must keep exactly one row and only upgrade metadata.
      writeFileSync(configPath, JSON.stringify({
        provider: {
          'fcm-nvidia': {
            enabled: true,
            models: {
              'deepseek-ai/deepseek-v4-flash-0731': { limit: { context: 128000 } },
            },
          },
        },
      }))
      writeFileSync(cachePath, JSON.stringify({
        providers: [{
          id: 'fcm-nvidia',
          models: [
            { id: 'deepseek-ai/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash', contextWindow: 128000 },
          ],
        }],
      }))

      const paths = { zcodeConfig: configPath, zcodeCache: cachePath }
      const scan = scanAllToolConfigs(paths)
      const zcode = scan.find((entry) => entry.toolMode === 'zcode')
      assert.ok(zcode, 'zcode entry must exist in the scan')
      assert.equal(zcode.isValid, true)

      const ids = zcode.models.map((m) => m.modelId)
      assert.equal(ids.filter((id) => id === 'deepseek-ai/deepseek-v4-flash-0731').length, 1, 'exactly one row for the duplicated model')
      assert.ok(!ids.some((id) => id.endsWith('-small')), `no phantom small variants, got: ${ids.join(', ')}`)
      const row = zcode.models.find((m) => m.modelId === 'deepseek-ai/deepseek-v4-flash-0731')
      assert.equal(row.label, 'DeepSeek V4 Flash', 'cache label upgrade wins over the raw id')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('scanAllToolConfigs keeps each tool entry independent (no cross-tool ghost rows)', () => {
    const home = makeTempDir('cross-tool')
    try {
      const crushPath = join(home, '.config', 'crush', 'crush.json')
      const zcodeConfig = join(home, '.zcode', 'v2', 'config.json')
      mkdirSync(dirname(crushPath), { recursive: true })
      mkdirSync(dirname(zcodeConfig), { recursive: true })

      const sharedModel = 'deepseek-ai/deepseek-v4-flash-0731'
      writeFileSync(crushPath, JSON.stringify({
        providers: { 'fcm-nvidia': { models: [{ id: sharedModel, name: 'DeepSeek V4 Flash' }] } },
      }))
      writeFileSync(zcodeConfig, JSON.stringify({
        provider: { 'fcm-nvidia': { enabled: true, models: { [sharedModel]: {} } } },
      }))

      const paths = { crush: crushPath, zcodeConfig, zcodeCache: join(home, 'missing-cache.json') }
      const scan = scanAllToolConfigs(paths)

      const crush = scan.find((e) => e.toolMode === 'crush')
      const zcode = scan.find((e) => e.toolMode === 'zcode')
      assert.deepEqual(crush.models.map((m) => m.modelId), [sharedModel])
      assert.deepEqual(zcode.models.map((m) => m.modelId), [sharedModel])
      // 📖 Each tool reports its own copy exactly once; the scan never merges
      // 📖 or duplicates entries across tools.
      assert.equal(crush.models.length, 1)
      assert.equal(zcode.models.length, 1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ─── 2. config save/load ──────────────────────────────────────────────────────

describe('config save/load future-proofing', () => {
  it('a settings key the schema does not know survives a save/load roundtrip', () => {
    // 📖 Future-proofing guard: settings is intentionally open (spread-merged),
    // 📖 so a newer CLI writing a new flag must not have it silently dropped by
    // 📖 an older surface that saves concurrently.
    const config = loadConfig()
    config.settings.someFutureFlag = { experimental: true }
    assert.equal(saveConfig(config).success, true)

    const reloaded = loadConfig()
    assert.deepEqual(reloaded.settings.someFutureFlag, { experimental: true })
  })

  it('unknown TOP-LEVEL keys are whitelisted out (shape stays canonical)', () => {
    // 📖 Intentional boundary, locked here so it is a documented decision and
    // 📖 not an accident: junk top-level keys (typos, migrations leftovers)
    // 📖 never leak into the persisted file.
    const config = loadConfig()
    config.definitelyNotASchemaKey = 'junk'
    assert.equal(saveConfig(config).success, true)

    const reloaded = loadConfig()
    assert.equal('definitelyNotASchemaKey' in reloaded, false)
  })
})

describe('config two-writer apiKeys merge', () => {
  it('a stale writer must not wipe keys another writer saved after it loaded', () => {
    // 📖 Writer A loads. Writer B loads, adds a Groq key, saves. Writer A then
    // 📖 saves its (now stale) snapshot with only the NVIDIA key. The
    // 📖 buildPersistedConfig union must keep both keys on disk.
    const writerA = loadConfig()
    writerA.apiKeys.nvidia = 'nvapi-writer-a'

    const writerB = loadConfig()
    writerB.apiKeys.groq = 'gsk-writer-b'
    assert.equal(saveConfig(writerB).success, true)

    assert.equal(saveConfig(writerA).success, true, 'stale writer A save must succeed')

    const finalConfig = loadConfig()
    assert.equal(finalConfig.apiKeys.nvidia, 'nvapi-writer-a', 'key from writer A must survive')
    assert.equal(finalConfig.apiKeys.groq, 'gsk-writer-b', 'key saved by writer B must survive writer A')
  })
})

// ─── 3. ping classification against a local server ───────────────────────────

describe('ping classification against a local http server', () => {
  it('401 classifies as code 401 with a real latency measurement (auth failure is still reachability)', async () => {
    const server = createHttpServer((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
    })
    const port = await listenOnRandomPort(server)
    try {
      const result = await ping('wrong-key', 'test/model', 'unit-ping-auth', `http://127.0.0.1:${port}/v1/chat/completions`)
      assert.equal(result.code, '401')
      assert.equal(typeof result.ms, 'number')
      assert.ok(result.ms >= 0)
    } finally {
      await closeServer(server)
    }
  })

  it('429 with Retry-After pauses the provider quota circuit breaker (issue #146 path)', async () => {
    const providerKey = 'unit-ping-cooldown'
    clearProviderQuotaPause(providerKey)
    const server = createHttpServer((req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' })
      res.end(JSON.stringify({ error: { message: 'rate limited' } }))
    })
    const port = await listenOnRandomPort(server)
    try {
      assert.equal(isProviderQuotaPaused(providerKey), false, 'provider must start unpaused')
      const result = await ping('key', 'test/model', providerKey, `http://127.0.0.1:${port}/v1/chat/completions`)
      assert.equal(result.code, '429')
      assert.equal(isProviderQuotaPaused(providerKey), true, '429 + Retry-After must open the provider-level cooldown')
    } finally {
      clearProviderQuotaPause(providerKey)
      await closeServer(server)
    }
  })

  it('429 without any Retry-After signal leaves the cooldown untouched', async () => {
    const providerKey = 'unit-ping-cooldown-none'
    clearProviderQuotaPause(providerKey)
    const server = createHttpServer((req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'slow down' } }))
    })
    const port = await listenOnRandomPort(server)
    try {
      const result = await ping('key', 'test/model', providerKey, `http://127.0.0.1:${port}/v1/chat/completions`)
      assert.equal(result.code, '429')
      assert.equal(isProviderQuotaPaused(providerKey), false, 'no retry signal means no blind cooldown')
    } finally {
      clearProviderQuotaPause(providerKey)
      await closeServer(server)
    }
  })

  it('200 with an error-shaped JSON body still reports code 200 (ping measures HTTP reachability, body semantics are upstream layers)', async () => {
    // 📖 Documented boundary: the ping layer never parses bodies, so a gateway
    // 📖 that answers 200 with {"error": ...} counts as reachable with real
    // 📖 latency. Verdict/status logic built on top of pings owns semantics.
    const server = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'model overloaded internally' } }))
    })
    const port = await listenOnRandomPort(server)
    try {
      const result = await ping('key', 'test/model', 'unit-ping-errorbody', `http://127.0.0.1:${port}/v1/chat/completions`)
      assert.equal(result.code, '200')
      assert.equal(typeof result.ms, 'number')
    } finally {
      await closeServer(server)
    }
  })
})

// ─── 4. router daemon: zero-chunk upstream stream still fails over ───────────

function buildRouterTestConfig(models, overrides = {}) {
  const router = normalizeRouterConfig({
    ...DEFAULT_ROUTER_SETTINGS,
    enabled: true,
    onboardingSeen: true,
    activeSet: 'test-set',
    sets: {
      'test-set': {
        name: 'test-set',
        created: '2026-04-23T00:00:00.000Z',
        models,
        familyFailover: overrides.familyFailover,
      },
    },
    failover: {
      ...DEFAULT_ROUTER_SETTINGS.failover,
      maxRetries: overrides.maxRetries ?? models.length,
      requestTimeoutMs: 500,
      streamStallTimeoutMs: 100,
    },
    circuitBreaker: {
      ...DEFAULT_ROUTER_SETTINGS.circuitBreaker,
      failureThreshold: 1,
    },
  })
  return {
    telemetry: { enabled: false },
    apiKeys: { groq: 'gsk-router-test', nvidia: 'nvapi-router-test' },
    router,
  }
}

async function withSourceUrls(overrides, fn) {
  const originals = new Map()
  for (const [provider, url] of Object.entries(overrides)) {
    originals.set(provider, sources[provider]?.url)
    sources[provider].url = url
  }
  try {
    return await fn()
  } finally {
    for (const [provider, url] of originals) {
      sources[provider].url = url
    }
  }
}

function readNodeRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function withMockProvider(responder, fn) {
  const requests = []
  const server = createHttpServer(async (req, res) => {
    const bodyText = await readNodeRequestBody(req)
    requests.push({ headers: req.headers, body: bodyText ? JSON.parse(bodyText) : null })
    const response = await responder(req, res)
    if (!response || res.writableEnded || res.destroyed) return
    res.writeHead(response.status ?? 200, response.headers || { 'content-type': 'application/json' })
    res.end(JSON.stringify(response.body ?? { id: 'chatcmpl-test', choices: [] }))
  })
  const port = await listenOnRandomPort(server)
  try {
    return await fn({ requests, url: `http://127.0.0.1:${port}/v1/chat/completions` })
  } finally {
    await closeServer(server)
  }
}

async function withRouterTestServer(config, fn) {
  const tokenPath = join(tmpdir(), `fcm-qpcov-router-${process.pid}-${Date.now()}.json`)
  const runtime = createRouterRuntimeForTest({
    config,
    tokenPath,
    logger: { level: 'error', error() {}, warn() {}, info() {}, debug() {} },
  })
  const server = createHttpServer((req, res) => void runtime.handleHttp(req, res))
  const port = await listenOnRandomPort(server)
  runtime.port = port
  runtime.server = server
  try {
    return await fn({ runtime, baseUrl: `http://127.0.0.1:${port}` })
  } finally {
    try { runtime.tokenTracker.flush({ force: true }) } catch {}
    await closeServer(server)
    rmSync(tokenPath, { force: true })
  }
}

describe('router daemon mid-stream zero-chunk failover', () => {
  it('fails over when an upstream answers 200 then dies before relaying a single chunk', async () => {
    // 📖 Gap between the covered pre-byte 5xx failover and the covered
    // 📖 after-partial-output no-failover: headers say 200, the SSE stream
    // 📖 starts, and the upstream dies with ZERO chunks relayed. The client
    // 📖 has seen nothing, so the router must fail over to the next provider.
    await withMockProvider((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      setTimeout(() => res.destroy(new Error('upstream died before first chunk')), 5)
      return null
    }, async (groqProvider) => {
      await withMockProvider((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"choices":[{"delta":{"content":"fallback-ok"}}]}\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
        return null
      }, async (nvidiaProvider) => {
        await withSourceUrls({ groq: groqProvider.url, nvidia: nvidiaProvider.url }, async () => {
          const config = buildRouterTestConfig([
            { provider: 'groq', model: 'openai/gpt-oss-120b', priority: 1 },
            { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4-flash-0731', priority: 2 },
          ])
          await withRouterTestServer(config, async ({ baseUrl }) => {
            const response = await fetch(`${baseUrl}/v1/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model: 'fcm', messages: [{ role: 'user', content: 'ping' }], stream: true }),
            })
            const text = await response.text()

            assert.equal(response.status, 200)
            assert.equal(response.headers.get('x-fcm-router-model'), 'nvidia/deepseek-ai/deepseek-v4-flash-0731', 'client must be served by the fallback provider')
            assert.match(text, /fallback-ok/, 'client must receive the fallback completion')
            assert.equal(groqProvider.requests.length, 1, 'dead upstream was attempted once')
            assert.equal(nvidiaProvider.requests.length, 1, 'fallback provider served the request')
          })
        })
      })
    })
  })
})

// ─── 5. tool-launchers: no API key -> blocked plan, no writes ─────────────────

describe('prepareExternalToolLaunch without an API key', () => {
  it('returns a blocked plan with warnings and zero config artifacts', () => {
    const home = makeTempDir('no-key')
    try {
      // 📖 Make sure neither the config nor the environment can leak a key:
      // 📖 getApiKey() checks process.env candidates before config.apiKeys.
      for (const candidate of [].concat(ENV_VARS.nvidia || [])) {
        if (candidate) delete process.env[candidate]
      }

      const model = { modelId: 'deepseek-ai/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash', providerKey: 'nvidia' }
      const config = { apiKeys: {} }
      const paths = { crushConfigPath: join(home, 'crush.json') }

      const plan = prepareExternalToolLaunch('crush', model, config, {
        paths,
        inheritedEnv: { PATH: process.env.PATH || '' },
      })

      assert.equal(plan.blocked, true, 'launch must be blocked without a key')
      assert.equal(plan.exitCode, 1)
      assert.deepEqual(plan.configArtifacts, [], 'no config files may be written')
      assert.ok(Array.isArray(plan.warnings) && plan.warnings.length > 0)
      assert.match(plan.warnings.join(' '), /No API key/)
      assert.match(plan.warnings.join(' '), /nvidia/i, 'warning must name the provider')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ─── 6. key-handler: T key tier cycle wrap ────────────────────────────────────

describe('key-handler T key tier cycle', () => {
  function buildMinimalCtx(state, calls) {
    return {
      state,
      TIER_CYCLE,
      noteUserActivity: () => {},
      applyTierFilter: () => { calls.applyTierFilter += 1 },
      sortResultsWithPinnedFavorites: (visible) => visible,
      adjustScrollOffset: () => {},
      saveConfig: () => { calls.saveConfig += 1; return { success: true } },
      exit: () => {},
    }
  }

  it('cycles forward from the first tier', async () => {
    const calls = { applyTierFilter: 0, saveConfig: 0 }
    const state = {
      tierFilterMode: 0,
      results: [],
      visibleSorted: [],
      sortColumn: 'avg',
      sortDirection: 'desc',
      favoritesPinnedAndSticky: false,
      benchmarkResults: {},
      cursor: 0,
      scrollOffset: 0,
      config: { settings: {} },
    }
    const handler = createKeyHandler(buildMinimalCtx(state, calls))
    await handler('t', { name: 't', shift: false, ctrl: false, meta: false })

    assert.equal(state.tierFilterMode, 1)
    assert.equal(calls.applyTierFilter, 1, 'filter must be re-applied after cycling')
    assert.equal(state.config.settings.tierFilter, TIER_CYCLE[1], 'new tier must be persisted into settings')
  })

  it('wraps from the last tier back to the first (All)', async () => {
    const calls = { applyTierFilter: 0, saveConfig: 0 }
    const state = {
      tierFilterMode: TIER_CYCLE.length - 1,
      results: [],
      visibleSorted: [],
      sortColumn: 'avg',
      sortDirection: 'desc',
      favoritesPinnedAndSticky: false,
      benchmarkResults: {},
      cursor: 0,
      scrollOffset: 0,
      config: { settings: {} },
    }
    const handler = createKeyHandler(buildMinimalCtx(state, calls))
    await handler('t', { name: 't', shift: false, ctrl: false, meta: false })

    assert.equal(state.tierFilterMode, 0, 'must wrap to the first entry, not overflow')
    assert.equal(state.config.settings.tierFilter, TIER_CYCLE[0])
    assert.equal(calls.applyTierFilter, 1)
    assert.equal(calls.saveConfig, 1, 'view preference must be persisted')
  })
})

// ─── 7. endpoint-installer: 0600 secrets + hostile key round-trip ────────────

describe('endpoint-installer secret files', () => {
  it('aider install writes the right model ids and a 0600 config file', () => {
    const home = makeTempDir('aider')
    try {
      const aiderConfigPath = join(home, '.aider.conf.yml')
      const config = { apiKeys: { nvidia: 'nvapi-secret' } }

      const result = installProviderEndpoints(config, 'nvidia', 'aider', {
        scope: 'selected',
        modelIds: ['deepseek-ai/deepseek-v4-flash-0731'],
        paths: { aiderConfigPath },
        track: false, // 📖 Keep the test hermetic: no config tracking, no real writes.
      })

      assert.equal(result.modelCount, 1)
      const written = readFileSync(aiderConfigPath, 'utf8')
      assert.match(written, /model: openai\/deepseek-ai\/deepseek-v4-flash-0731/)
      assert.match(written, /openai-api-key: nvapi-secret/)
      assert.equal(statSync(aiderConfigPath).mode & 0o777, 0o600, 'config carries a plaintext key: must be 0600')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('openhands env install records 0600 mode, model + base-url lines, and a hostile key survives /bin/sh sourcing', () => {
    if (process.platform === 'win32') return
    const home = makeTempDir('openhands')
    try {
      const envFilePath = join(home, '.fcm-openhands-env')
      // 📖 Key with every character that breaks naive shell escaping.
      const hostileKey = `p@ss'w0rd "$(whoami)" $(echo pwned) back\\slash`
      const config = { apiKeys: { groq: hostileKey } }

      const result = installProviderEndpoints(config, 'groq', 'openhands', {
        scope: 'selected',
        modelIds: ['openai/gpt-oss-120b'],
        paths: { envFilePath },
        track: false,
      })

      assert.equal(result.modelCount, 1)
      assert.equal(statSync(envFilePath).mode & 0o777, 0o600, 'env file carries a plaintext key: must be 0600')

      const envContent = readFileSync(envFilePath, 'utf8')
      assert.match(envContent, /export OPENAI_MODEL="openai\/gpt-oss-120b"/)
      assert.match(envContent, /export OPENAI_BASE_URL="/)

      // 📖 Portable POSIX proof: `.` works in every /bin/sh (dash included),
      // 📖 unlike `source`. Sourcing the real installer output must yield the
      // 📖 exact literal key, byte for byte.
      const sourced = spawnSync('/bin/sh', ['-c', `. '${envFilePath}' && printf '%s' "$OPENAI_API_KEY"`], { encoding: 'utf8' })
      assert.equal(sourced.status, 0, `sh failed: ${sourced.stderr}`)
      assert.equal(sourced.stdout, hostileKey, 'key must round-trip literally through a real shell')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

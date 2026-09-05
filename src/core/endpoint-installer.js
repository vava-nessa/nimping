/**
 * @file src/endpoint-installer.js
 * @description Install and refresh FCM-managed provider catalogs inside external tool configs.
 *
 * @details
 *   📖 This module powers the Install Endpoints flow in the TUI.
 *   It lets users pick one configured provider, choose a target tool, then install either:
 *   - the full provider catalog (`all` models), or
 *   - a curated subset of specific models (`selected`)
 *
 *   📖 The implementation is intentionally conservative:
 *   - it writes managed provider entries under an `fcm-*` namespace to avoid clobbering user-defined providers
 *   - it merges into existing config files instead of replacing them
 *   - it records successful installs in `~/.free-coding-models.json` so catalogs can be refreshed automatically later
 *
 *   📖 Tool-specific notes:
 *   - OpenCode CLI and OpenCode Desktop share the same `opencode.json`
 *   - Crush gets a managed provider block in `crush.json`
 *   - Goose gets a declarative custom provider JSON + a matching secret in `secrets.yaml`
 *   - OpenClaw gets a managed `models.providers` entry plus matching allowlist rows
 *   - Pi gets models.json + settings.json under ~/.pi/agent/
 *   - Aider gets ~/.aider.conf.yml with OpenAI-compatible config
 *   - Amp gets ~/.config/amp/settings.json
 *   - Qwen gets ~/.qwen/settings.json with modelProviders
 *   - OpenHands gets a sourceable env file (~/.fcm-openhands-env)
 *
 * @functions
 *   → `getConfiguredInstallableProviders` — list configured providers that support direct endpoint installs
 *   → `getProviderCatalogModels` — return the current FCM catalog for one provider
 *   → `getInstallTargetModes` — stable install target list exposed in the TUI
 *   → `installProviderEndpoints` — install one provider catalog into one external tool
 *   → `refreshInstalledEndpoints` — replay tracked installs to keep catalogs in sync on future launches
 *
 * @exports
 *   getConfiguredInstallableProviders, getProviderCatalogModels, getInstallTargetModes,
 *   installProviderEndpoints, refreshInstalledEndpoints
 *
 * @see ../sources.js
 * @see src/config.js
 * @see src/tool-metadata.js
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { MODELS, sources } from '../../sources.js'
import { getApiKey, saveConfig } from './config.js'
import { ENV_VAR_NAMES, PROVIDER_METADATA } from './provider-metadata.js'
import { getToolMeta } from './tool-metadata.js'
import { ensureDir, readJson as sharedReadJson, shellSingleQuote, atomicWriteJson } from './shared-helpers.js'

// 📖 replicate uses /v1/predictions (not /chat/completions), so it's not OpenAI-compatible.
// 📖 zai and opencode-zen ARE OpenAI-compatible and CAN be installed into any tool.
const DIRECT_INSTALL_UNSUPPORTED_PROVIDERS = new Set(['replicate'])
// 📖 Install Endpoints only lists tools whose persisted config shape is actually supported here.
// 📖 jcode is CLI-only and uses an env-file helper (same as openhands) — selectable in both CLI and Web.
const INSTALL_TARGET_MODES = ['opencode', 'pi', 'jcode', 'opencode-desktop', 'opencode-web', 'openclaw', 'crush', 'goose', 'aider', 'qwen', 'openhands', 'amp', 'forgecode', 'fcm_router', 'zcode']

function getDefaultPaths() {
  const home = homedir()
  return {
    opencodeConfigPath: join(home, '.config', 'opencode', 'opencode.json'),
    openclawConfigPath: join(home, '.openclaw', 'openclaw.json'),
    crushConfigPath: join(home, '.config', 'crush', 'crush.json'),
    gooseProvidersDir: join(home, '.config', 'goose', 'custom_providers'),
    gooseSecretsPath: join(home, '.config', 'goose', 'secrets.yaml'),
    piModelsPath: join(home, '.pi', 'agent', 'models.json'),
    piSettingsPath: join(home, '.pi', 'agent', 'settings.json'),
    aiderConfigPath: join(home, '.aider.conf.yml'),
    ampConfigPath: join(home, '.config', 'amp', 'settings.json'),
    qwenConfigPath: join(home, '.qwen', 'settings.json'),
    forgeCodeConfigPath: join(home, '.forge', '.forge.toml'),
    zcodeConfigPath: join(home, '.zcode', 'v2', 'config.json'),
    zcodeModelCachePath: join(home, '.zcode', 'v2', 'bots-model-cache.v2.json'),
  }
}

// 📖 ensureDirFor replaced by shared ensureDir (same logic)
const ensureDirFor = ensureDir

function backupIfExists(filePath) {
  if (!existsSync(filePath)) return null
  const backupPath = `${filePath}.backup-${Date.now()}`
  copyFileSync(filePath, backupPath)
  return backupPath
}

// 📖 readJson with default fallback of {} — matches shared helper's signature
function readJson(filePath, fallback = {}) {
  return sharedReadJson(filePath, fallback)
}

// 📖 These configs carry plaintext API keys - 0600 at creation, chmod after write
// 📖 so pre-existing wide-permission files get tightened too (mode only applies at creation).
function writeSecretFile(filePath, content) {
  ensureDirFor(filePath)
  writeFileSync(filePath, content, { mode: 0o600 })
  chmodSync(filePath, 0o600)
}

function writeJson(filePath, value, { backup = true } = {}) {
  ensureDirFor(filePath)
  const backupPath = backup ? backupIfExists(filePath) : null
  // 📖 Atomic tmp + rename via the shared helper instead of an in-place
  // 📖 writeFileSync, so a crash mid-write can never truncate a tool config.
  // 📖 0600 because these configs carry plaintext API keys.
  atomicWriteJson(filePath, value, 0o600)
  return backupPath
}

function readSimpleYamlMap(filePath) {
  if (!existsSync(filePath)) return {}
  const out = {}
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1)
    }
    out[match[1]] = value
  }
  return out
}

function writeSimpleYamlMap(filePath, entries) {
  ensureDirFor(filePath)
  const backupPath = backupIfExists(filePath)
  const lines = Object.keys(entries)
    .sort()
    .map((key) => `${key}: ${JSON.stringify(String(entries[key] ?? ''))}`)
  writeSecretFile(filePath, lines.join('\n') + '\n')
  return backupPath
}

function canonicalizeToolMode(toolMode) {
  return toolMode === 'opencode-desktop' || toolMode === 'opencode-web' ? 'opencode' : toolMode
}

function getManagedProviderId(providerKey) {
  return `fcm-${providerKey}`
}

function getProviderLabel(providerKey) {
  // 📖 fcm_router is now in PROVIDER_METADATA (provider-metadata.js) so all
  // 📖 surfaces resolve to the same label. Issue #140 surfaced because this
  // 📖 helper was the only place that knew about fcm_router.
  return PROVIDER_METADATA[providerKey]?.label || sources[providerKey]?.name || providerKey
}

function getManagedProviderLabel(providerKey) {
  if (providerKey === 'fcm_router') return 'FCM Smart Router'
  return `FCM ${getProviderLabel(providerKey)}`
}

export function parseContextWindow(ctx) {
  if (typeof ctx !== 'string' || !ctx.trim()) return 128000
  const trimmed = ctx.trim().toLowerCase()
  const multiplier = trimmed.endsWith('m') ? 1_000_000 : trimmed.endsWith('k') ? 1_000 : 1
  const numeric = Number.parseFloat(trimmed.replace(/[mk]$/i, ''))
  if (!Number.isFinite(numeric) || numeric <= 0) return 128000
  return Math.round(numeric * multiplier)
}

function getDefaultMaxTokens(contextWindow) {
  return Math.max(4096, Math.min(contextWindow, 32768))
}

function resolveProviderBaseUrl(providerKey) {
  if (providerKey === 'fcm_router') {
    return `http://localhost:${process.env.FCM_ROUTER_PORT || '19280'}/v1`
  }

  const providerUrl = sources[providerKey]?.url
  if (!providerUrl) return null

  if (providerKey === 'cloudflare') {
    const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim()
    if (!accountId) return null
    return providerUrl
      .replace(/\{\$CLOUDFLARE_ACCOUNT_ID\}/g, encodeURIComponent(accountId))
      .replace(/\{account_id\}/g, encodeURIComponent(accountId))
      .replace(/\/chat\/completions$/i, '')
  }

  return providerUrl
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/responses$/i, '')
    .replace(/\/predictions$/i, '')
}

function resolveGooseBaseUrl(providerKey) {
  if (providerKey === 'fcm_router') {
    return `http://localhost:${process.env.FCM_ROUTER_PORT || '19280'}/v1`
  }
  const providerUrl = sources[providerKey]?.url
  if (!providerUrl) return null
  if (providerKey === 'cloudflare') {
    const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim()
    if (!accountId) return null
    return providerUrl
      .replace(/\{\$CLOUDFLARE_ACCOUNT_ID\}/g, encodeURIComponent(accountId))
      .replace(/\{account_id\}/g, encodeURIComponent(accountId))
  }
  return providerUrl
}

function getDirectInstallSupport(providerKey) {
  if (providerKey === 'fcm_router') return { supported: true, reason: null }
  if (!sources[providerKey]) {
    return { supported: false, reason: 'Unknown provider' }
  }
  if (DIRECT_INSTALL_UNSUPPORTED_PROVIDERS.has(providerKey)) {
    return { supported: false, reason: 'This provider still needs a dedicated runtime bridge' }
  }
  if (providerKey === 'cloudflare' && !(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim()) {
    return { supported: false, reason: 'CLOUDFLARE_ACCOUNT_ID is required for direct installs' }
  }
  return { supported: true, reason: null }
}

function buildInstallRecord(providerKey, toolMode, scope, modelIds) {
  return {
    providerKey,
    toolMode: canonicalizeToolMode(toolMode),
    scope: scope === 'selected' ? 'selected' : 'all',
    modelIds: scope === 'selected' ? [...new Set(modelIds)] : [],
    lastSyncedAt: new Date().toISOString(),
  }
}

function upsertInstallRecord(config, record) {
  if (!Array.isArray(config.endpointInstalls)) config.endpointInstalls = []
  const next = config.endpointInstalls.filter(
    (entry) => !(entry?.providerKey === record.providerKey && entry?.toolMode === record.toolMode)
  )
  next.push(record)
  config.endpointInstalls = next
}

function buildCatalogModel(modelId, label, tier, sweScore, ctx) {
  return { modelId, label, tier, sweScore, ctx }
}

export function getProviderCatalogModels(providerKey) {
  if (providerKey === 'fcm_router') {
    return [
      buildCatalogModel('fcm', 'FCM Smart Router', 'S+', 100, '200k')
    ]
  }

  const seen = new Set()
  return MODELS
    .filter((entry) => entry[5] === providerKey)
    .map(([modelId, label, tier, sweScore, ctx]) => buildCatalogModel(modelId, label, tier, sweScore, ctx))
    .filter((entry) => {
      if (seen.has(entry.modelId)) return false
      seen.add(entry.modelId)
      return true
    })
}

export function getConfiguredInstallableProviders(config) {
  return Object.keys(sources)
    .filter((providerKey) => getApiKey(config, providerKey))
    .map((providerKey) => {
      const support = getDirectInstallSupport(providerKey)
      return {
        providerKey,
        label: getProviderLabel(providerKey),
        modelCount: getProviderCatalogModels(providerKey).length,
        supported: support.supported,
        reason: support.reason,
      }
    })
    .filter((provider) => provider.supported)
}

export function getInstallTargetModes() {
  return [...INSTALL_TARGET_MODES]
}

function requireConfiguredProviderKey(config, providerKey) {
  if (providerKey === 'fcm_router') return 'fcm-local'
  const apiKey = getApiKey(config, providerKey)
  if (!apiKey) {
    throw new Error(`No configured API key found for ${getProviderLabel(providerKey)}`)
  }
  return apiKey
}

function resolveSelectedModels(providerKey, scope, modelIds) {
  const catalog = getProviderCatalogModels(providerKey)
  if (scope !== 'selected') return catalog
  const selectedSet = new Set(modelIds)
  return catalog.filter((model) => selectedSet.has(model.modelId))
}

function installIntoOpenCode(providerKey, models, apiKey, paths) {
  const filePath = paths.opencodeConfigPath
  const providerId = getManagedProviderId(providerKey)
  const config = readJson(filePath, {})
  if (!config.provider || typeof config.provider !== 'object') config.provider = {}

  config.provider[providerId] = {
    npm: '@ai-sdk/openai-compatible',
    name: getManagedProviderLabel(providerKey),
    options: {
      baseURL: resolveProviderBaseUrl(providerKey),
      apiKey,
    },
    models: Object.fromEntries(models.map((model) => [model.modelId, { name: model.label }])),
  }

  const backupPath = writeJson(filePath, config)
  return { path: filePath, backupPath, providerId, modelCount: models.length }
}

function installIntoCrush(providerKey, models, apiKey, paths) {
  const filePath = paths.crushConfigPath
  const providerId = getManagedProviderId(providerKey)
  const config = readJson(filePath, { $schema: 'https://charm.land/crush.json' })
  if (!config.providers || typeof config.providers !== 'object') config.providers = {}

  config.providers[providerId] = {
    name: getManagedProviderLabel(providerKey),
    type: 'openai-compat',
    base_url: resolveProviderBaseUrl(providerKey),
    api_key: apiKey,
    models: models.map((model) => ({
      id: model.modelId,
      name: model.label,
      context_window: parseContextWindow(model.ctx),
      default_max_tokens: getDefaultMaxTokens(parseContextWindow(model.ctx)),
    })),
  }

  const backupPath = writeJson(filePath, config)
  return { path: filePath, backupPath, providerId, modelCount: models.length }
}

function installIntoGoose(providerKey, models, apiKey, paths) {
  const providerId = getManagedProviderId(providerKey)
  const providerFilePath = join(paths.gooseProvidersDir, `${providerId}.json`)
  const secretEnvName = `FCM_${providerKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

  const providerConfig = {
    name: providerId,
    engine: 'openai',
    display_name: getManagedProviderLabel(providerKey),
    description: `Managed by free-coding-models for ${getProviderLabel(providerKey)}`,
    api_key_env: secretEnvName,
    base_url: resolveGooseBaseUrl(providerKey),
    models: models.map((model) => ({
      name: model.modelId,
      context_limit: parseContextWindow(model.ctx),
    })),
    supports_streaming: true,
    requires_auth: true,
  }

  const providerBackupPath = writeJson(providerFilePath, providerConfig)

  const secrets = readSimpleYamlMap(paths.gooseSecretsPath)
  secrets[secretEnvName] = apiKey
  const secretsBackupPath = writeSimpleYamlMap(paths.gooseSecretsPath, secrets)

  return {
    path: providerFilePath,
    backupPath: providerBackupPath,
    providerId,
    modelCount: models.length,
    extraPath: paths.gooseSecretsPath,
    extraBackupPath: secretsBackupPath,
  }
}

function installIntoOpenClaw(providerKey, models, apiKey, paths) {
  const filePath = paths.openclawConfigPath
  const providerId = getManagedProviderId(providerKey)
  const config = readJson(filePath, {})
  const primaryModel = models[0]
  const primaryModelRef = primaryModel ? `${providerId}/${primaryModel.modelId}` : null

  if (!config.models || typeof config.models !== 'object') config.models = {}
  if (config.models.mode !== 'replace') config.models.mode = 'merge'
  if (!config.models.providers || typeof config.models.providers !== 'object') config.models.providers = {}
  if (!config.agents || typeof config.agents !== 'object') config.agents = {}
  if (!config.agents.defaults || typeof config.agents.defaults !== 'object') config.agents.defaults = {}
  if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') config.agents.defaults.model = {}
  if (!config.agents.defaults.models || typeof config.agents.defaults.models !== 'object') config.agents.defaults.models = {}
  if (!config.env || typeof config.env !== 'object') config.env = {}

  config.models.providers[providerId] = {
    baseUrl: resolveProviderBaseUrl(providerKey),
    apiKey,
    api: 'openai-completions',
    models: models.map((model) => {
      const contextWindow = parseContextWindow(model.ctx)
      return {
        id: model.modelId,
        name: model.label,
        api: 'openai-completions',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: getDefaultMaxTokens(contextWindow),
      }
    }),
  }

  for (const modelRef of Object.keys(config.agents.defaults.models)) {
    if (modelRef.startsWith(`${providerId}/`)) delete config.agents.defaults.models[modelRef]
  }
  for (const model of models) {
    config.agents.defaults.models[`${providerId}/${model.modelId}`] = {}
  }

  if (primaryModelRef) {
    config.agents.defaults.model.primary = primaryModelRef
  }

  const providerEnvName = ENV_VAR_NAMES[providerKey]
  if (providerEnvName && apiKey) {
    config.env[providerEnvName] = apiKey
  }

  const backupPath = writeJson(filePath, config)
  return { path: filePath, backupPath, providerId, modelCount: models.length, primaryModelRef }
}

// 📖 installIntoPi writes models.json + settings.json under ~/.pi/agent/
function installIntoPi(providerKey, models, apiKey, paths) {
  const providerId = getManagedProviderId(providerKey)
  const baseUrl = resolveProviderBaseUrl(providerKey)

  // 📖 Write models.json with provider config
  const modelsConfig = readJson(paths.piModelsPath, { providers: {} })
  if (!modelsConfig.providers || typeof modelsConfig.providers !== 'object') modelsConfig.providers = {}
  modelsConfig.providers[providerId] = {
    baseUrl,
    api: 'openai-completions',
    apiKey,
    models: models.map((model) => ({ id: model.modelId, name: model.label })),
  }
  const modelsBackupPath = writeJson(paths.piModelsPath, modelsConfig)

  // 📖 Write settings.json to set default provider
  const settingsConfig = readJson(paths.piSettingsPath, {})
  settingsConfig.defaultProvider = providerId
  settingsConfig.defaultModel = models[0]?.modelId ?? ''
  writeJson(paths.piSettingsPath, settingsConfig, { backup: true })

  return { path: paths.piModelsPath, backupPath: modelsBackupPath, providerId, modelCount: models.length }
}

// 📖 installIntoAider writes ~/.aider.conf.yml with OpenAI-compatible config
function installIntoAider(providerKey, models, apiKey, paths) {
  const providerId = getManagedProviderId(providerKey)
  const baseUrl = resolveProviderBaseUrl(providerKey)
  const backupPath = backupIfExists(paths.aiderConfigPath)
  // 📖 Aider YAML config — one model at a time, uses first selected model
  const primaryModel = models[0]
  const lines = [
    '# 📖 Managed by free-coding-models',
    `openai-api-base: ${baseUrl}`,
    `openai-api-key: ${apiKey}`,
    `model: openai/${primaryModel.modelId}`,
    '',
  ]
  writeSecretFile(paths.aiderConfigPath, lines.join('\n'))
  return { path: paths.aiderConfigPath, backupPath, providerId, modelCount: models.length }
}

// 📖 installIntoAmp writes ~/.config/amp/settings.json with model+URL
function installIntoAmp(providerKey, models, apiKey, paths) {
  const providerId = getManagedProviderId(providerKey)
  const baseUrl = resolveProviderBaseUrl(providerKey)
  const config = readJson(paths.ampConfigPath, {})
  config['amp.url'] = baseUrl
  config['amp.model'] = models[0]?.modelId ?? ''
  const backupPath = writeJson(paths.ampConfigPath, config)
  return { path: paths.ampConfigPath, backupPath, providerId, modelCount: models.length }
}

// 📖 installIntoQwen writes ~/.qwen/settings.json with modelProviders config
function installIntoQwen(providerKey, models, apiKey, paths) {
  const providerId = getManagedProviderId(providerKey)
  const baseUrl = resolveProviderBaseUrl(providerKey)
  const config = readJson(paths.qwenConfigPath, {})
  if (!config.modelProviders || typeof config.modelProviders !== 'object') config.modelProviders = {}
  if (!Array.isArray(config.modelProviders.openai)) config.modelProviders.openai = []

  // 📖 Remove existing FCM-managed entries, then prepend all selected models
  const filtered = config.modelProviders.openai.filter(
    (entry) => !models.some((m) => m.modelId === entry?.id)
  )
  const newEntries = models.map((model) => ({
    id: model.modelId,
    name: model.label,
    envKey: ENV_VAR_NAMES[providerKey] || 'OPENAI_API_KEY',
    baseUrl,
  }))
  config.modelProviders.openai = [...newEntries, ...filtered]
  config.model = models[0]?.modelId ?? ''
  const backupPath = writeJson(paths.qwenConfigPath, config)
  return { path: paths.qwenConfigPath, backupPath, providerId, modelCount: models.length }
}

// 📖 installIntoEnvBasedTool handles tools that rely on env vars only.
// 📖 We write a small .env-style helper file so users can source it before launching.
// 📖 `paths` is optional and lets tests override the env file location.
function installIntoEnvBasedTool(providerKey, models, apiKey, toolMode, paths = {}) {
  const providerId = getManagedProviderId(providerKey)
  const home = homedir()
  const envFileName = `.fcm-${toolMode}-env`
  const envFilePath = paths?.envFilePath ?? join(home, envFileName)
  const primaryModel = models[0]
  const effectiveApiKey = apiKey
  const effectiveBaseUrl = resolveProviderBaseUrl(providerKey)
  const effectiveModelId = primaryModel.modelId

  const envLines = [
    '# 📖 Managed by free-coding-models — source this file before launching the tool',
    `# 📖 Provider: ${getProviderLabel(providerKey)} (${models.length} models)`,
    '# 📖 Connection: Direct provider',
    // 📖 Single-quote the key so quotes/$()/backticks in it stay literal on `source`.
    `export OPENAI_API_KEY=${shellSingleQuote(effectiveApiKey)}`,
    `export OPENAI_BASE_URL="${effectiveBaseUrl}"`,
    `export OPENAI_MODEL="${effectiveModelId}"`,
    `export LLM_API_KEY=${shellSingleQuote(effectiveApiKey)}`,
    `export LLM_BASE_URL="${effectiveBaseUrl}"`,
    `export LLM_MODEL="openai/${effectiveModelId}"`,
  ]

  const backupPath = backupIfExists(envFilePath)
  writeSecretFile(envFilePath, envLines.join('\n') + '\n')
  return { path: envFilePath, backupPath, providerId, modelCount: models.length }
}

// 📖 installIntoForgeCode: writes a managed [[providers]] block into ~/.forge/.forge.toml.
// 📖 ForgeCode uses TOML config with [[providers]] entries for custom OpenAI-compatible endpoints.
// 📖 Each provider gets one [[providers]] entry with the model catalog noted in comments.
// 📖 The API key is referenced via an env var so ForgeCode picks it up at runtime.
function installIntoForgeCode(providerKey, models, apiKey, paths) {
  const filePath = paths.forgeCodeConfigPath
  const providerId = getManagedProviderId(providerKey)
  const secretEnvName = `FCM_${providerKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
  const baseUrl = resolveProviderBaseUrl(providerKey)

  if (!baseUrl) {
    throw new Error(`Cannot resolve base URL for ${getProviderLabel(providerKey)}`)
  }

  // 📖 Ensure the API key is in env for ForgeCode to use
  process.env[secretEnvName] = apiKey

  const completionsUrl = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`

  // 📖 Read existing content
  let content = ''
  if (existsSync(filePath)) {
    content = readFileSync(filePath, 'utf8')
  }

  // 📖 Remove any previous FCM-managed provider block for this provider
  const markerStart = `# >>> FCM managed provider: ${providerId}`
  const markerEnd = `# <<< FCM managed provider: ${providerId}`
  const markerRegex = new RegExp(
    `\\n?${markerStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${markerEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
    'g'
  )
  content = content.replace(markerRegex, '\n')

  // 📖 Build a fresh [[providers]] TOML block with model catalog comments
  const modelComments = models.map(m => `# 📖 Model: ${m.label} (${m.modelId}) — ${m.tier}`).join('\n')
  const providerBlock = [
    '',
    markerStart,
    `# 📖 Provider: ${getManagedProviderLabel(providerKey)} (${models.length} models)`,
    modelComments,
    '[[providers]]',
    `id = "${providerId}"`,
    `url = "${completionsUrl}"`,
    `api_key_vars = "${secretEnvName}"`,
    'response_type = "OpenAI"',
    'auth_methods = ["api_key"]',
    markerEnd,
  ].join('\n')

  content = content.trimEnd() + '\n' + providerBlock + '\n'

  ensureDirFor(filePath)
  const backupPath = backupIfExists(filePath)
  writeFileSync(filePath, content)

  return { path: filePath, backupPath, providerId, modelCount: models.length }
}

// 📖 installIntoFcmRouter: adds provider endpoints to the running FCM Router daemon
// 📖 via the /sets API so the router can use them for failover routing.
// 📖 Uses the daemon's expected schema: { provider, model, priority } per model entry.
function installIntoFcmRouter(providerKey, models, apiKey) {
  const baseUrl = `http://localhost:${process.env.FCM_ROUTER_PORT || '19280'}`
  const routerSetName = `fcm-${providerKey}`
  // 📖 Map to the daemon's expected model schema (provider + model + priority)
  const routerModels = models.map((m, index) => ({
    provider: providerKey,
    model: m.modelId,
    priority: index + 1,
  }))
  const payload = { name: routerSetName, models: routerModels }

  // 📖 Try POST first (creates the set), then PUT to update if it already exists.
  // 📖 Both are fire-and-forget: the daemon may not be running during install,
  // 📖 and that's OK — the set will be picked up on next daemon restart via config.
  void (async () => {
    try {
      const createRes = await fetch(`${baseUrl}/sets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(3000),
      })
      // 📖 If the set already exists (name conflict), update it via PUT
      if (!createRes.ok) {
        await fetch(`${baseUrl}/sets/${encodeURIComponent(routerSetName)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(3000),
        }).catch(() => {})
      }
    } catch {
      // 📖 Daemon unreachable — silently ignore, user can restart daemon later
    }
  })()

  return { path: `FCM Router (${baseUrl})`, backupPath: null, providerId: providerKey, modelCount: models.length }
}

// 📖 installIntoZCode: Writes provider + models into ZCode's config.json and updates
// 📖 bots-model-cache.v2.json so the models appear immediately in ZCode's model picker.
// 📖 Uses deterministic provider ID (fcm-{providerKey}) so re-running replaces/merges
// 📖 without duplicating the provider entry.
// 📖 When scope === 'selected' — merges models with existing ones.
// 📖 When scope === 'all' — replaces all models (full sync).
function installIntoZCode(providerKey, models, apiKey, paths, scope) {
  const configPath = paths.zcodeConfigPath
  const cachePath = paths.zcodeModelCachePath
  const providerId = `fcm-${providerKey}`
  const baseUrl = resolveProviderBaseUrl(providerKey)
  const providerLabel = getManagedProviderLabel(providerKey)

  if (!baseUrl) {
    throw new Error(`Cannot resolve base URL for ${getProviderLabel(providerKey)}`)
  }

  function buildModelEntry(model) {
    const ctx = parseContextWindow(model.ctx)
    const entry = {
      id: model.modelId,
      name: model.label || model.modelId,
      kinds: ['openai-compatible'],
      defaultKind: 'openai-compatible',
      modalities: { input: ['text'], output: ['text'] },
      contextWindow: ctx,
    }
    if (ctx > 8192) {
      entry.maxOutputTokens = getDefaultMaxTokens(ctx)
    }
    return entry
  }

  function buildConfigModelEntry(model) {
    const ctx = parseContextWindow(model.ctx)
    const entry = {
      limit: { context: ctx },
      modalities: { input: ['text'], output: ['text'] },
    }
    if (ctx > 8192) {
      entry.limit.output = getDefaultMaxTokens(ctx)
    }
    return entry
  }

  const newModelIds = new Set(models.map((m) => m.modelId))
  let configModified = false
  let cacheModified = false

  // ── 1. Write to config.json ───────────────────────────────────────────────
  const config = readJson(configPath, { $schema: 'https://opencode.ai/config.json' })
  if (!config.provider || typeof config.provider !== 'object') config.provider = {}

  const existingProvider = config.provider[providerId]

  if (scope === 'selected' && existingProvider) {
    // 📖 Merge mode: add/update selected models, keep existing ones
    for (const model of models) {
      existingProvider.models[model.modelId] = buildConfigModelEntry(model)
    }
    configModified = true
  } else if (scope === 'selected' && !existingProvider) {
    // 📖 No existing provider, but scope is selected — create with only selected models
    config.provider[providerId] = {
      name: providerLabel,
      kind: 'openai-compatible',
      options: { apiKey, baseURL: baseUrl, apiKeyRequired: true },
      enabled: true,
      source: 'custom',
      models: Object.fromEntries(models.map((m) => [m.modelId, buildConfigModelEntry(m)])),
    }
    configModified = true
  } else {
    // 📖 scope === 'all' — replace all models (full sync), skip if identical
    const existingModelIds = existingProvider ? Object.keys(existingProvider.models || {}) : []
    const modelsUnchanged = existingProvider
      && existingModelIds.length === models.length
      && models.every((m) => existingModelIds.includes(m.modelId))

    if (!modelsUnchanged) {
      config.provider[providerId] = {
        name: providerLabel,
        kind: 'openai-compatible',
        options: { apiKey, baseURL: baseUrl, apiKeyRequired: true },
        enabled: true,
        source: 'custom',
        models: Object.fromEntries(models.map((m) => [m.modelId, buildConfigModelEntry(m)])),
      }
      configModified = true
    }
  }

  const configBackupPath = configModified ? writeJson(configPath, config) : null

  // ── 2. Write to bots-model-cache.v2.json ──────────────────────────────────
  const cache = readJson(cachePath, { version: 2, updatedAt: Date.now(), providers: [] })
  if (!Array.isArray(cache.providers)) cache.providers = []

  const existingCacheIdx = cache.providers.findIndex((p) => p?.id === providerId)

  if (scope === 'selected') {
    // 📖 Merge mode: add/update selected models in cache, keep existing ones
    if (existingCacheIdx >= 0) {
      const existingModels = cache.providers[existingCacheIdx].models || []
      for (const model of models) {
        const modelIdx = existingModels.findIndex((m) => m.id === model.modelId)
        if (modelIdx >= 0) {
          existingModels[modelIdx] = buildModelEntry(model)
        } else {
          existingModels.push(buildModelEntry(model))
        }
      }
      cache.providers[existingCacheIdx].updatedAt = Date.now()
      cacheModified = true
    } else {
      cache.providers.push({
        id: providerId,
        name: providerLabel,
        enabled: true,
        endpoints: { baseURL: baseUrl, paths: { 'openai-compatible': '/chat/completions' } },
        apiFormat: 'openai-chat-completions',
        source: 'custom',
        apiKeyRequired: true,
        apiKey: '__zcode_cached_api_key_present__',
        defaultKind: 'openai-compatible',
        models: models.map(buildModelEntry),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      cacheModified = true
    }
  } else {
    // 📖 scope === 'all' — replace all models, skip if identical
    const cachedModelIds = existingCacheIdx >= 0
      ? (cache.providers[existingCacheIdx].models || []).map((m) => m.id)
      : []
    const cacheUnchanged = existingCacheIdx >= 0
      && cachedModelIds.length === models.length
      && models.every((m) => cachedModelIds.includes(m.modelId))

    if (!cacheUnchanged) {
      if (existingCacheIdx >= 0) {
        cache.providers[existingCacheIdx].models = models.map(buildModelEntry)
        cache.providers[existingCacheIdx].updatedAt = Date.now()
      } else {
        cache.providers.push({
          id: providerId,
          name: providerLabel,
          enabled: true,
          endpoints: { baseURL: baseUrl, paths: { 'openai-compatible': '/chat/completions' } },
          apiFormat: 'openai-chat-completions',
          source: 'custom',
          apiKeyRequired: true,
          apiKey: '__zcode_cached_api_key_present__',
          defaultKind: 'openai-compatible',
          models: models.map(buildModelEntry),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      }
      cache.updatedAt = Date.now()
      cacheModified = true
    }
  }

  const cacheBackupPath = cacheModified ? writeJson(cachePath, cache) : null

  return {
    path: configPath,
    backupPath: configBackupPath,
    providerId,
    modelCount: models.length,
    extraPath: cachePath,
    extraBackupPath: cacheBackupPath,
  }
}

export function installProviderEndpoints(config, providerKey, toolMode, options = {}) {
  const canonicalToolMode = canonicalizeToolMode(toolMode)
  const support = getDirectInstallSupport(providerKey)
  if (!support.supported) {
    throw new Error(support.reason || 'Direct install is not supported for this provider')
  }

  const apiKey = requireConfiguredProviderKey(config, providerKey)
  const scope = options.scope === 'selected' ? 'selected' : 'all'
  const models = resolveSelectedModels(providerKey, scope, options.modelIds || [])
  if (models.length === 0) {
    throw new Error(`No models available to install for ${getProviderLabel(providerKey)}`)
  }

  const paths = { ...getDefaultPaths(), ...(options.paths || {}) }
  // 📖 Dispatch to the right installer based on canonical tool mode
  let installResult
  if (canonicalToolMode === 'opencode') {
    installResult = installIntoOpenCode(providerKey, models, apiKey, paths)
  } else if (canonicalToolMode === 'openclaw') {
    installResult = installIntoOpenClaw(providerKey, models, apiKey, paths)
  } else if (canonicalToolMode === 'crush') {
    installResult = installIntoCrush(providerKey, models, apiKey, paths)
  } else if (canonicalToolMode === 'goose') {
    installResult = installIntoGoose(providerKey, models, apiKey, paths)
  } else if (canonicalToolMode === 'pi') {
    installResult = installIntoPi(providerKey, models, apiKey, paths)
  } else if (canonicalToolMode === 'aider') {
    installResult = installIntoAider(providerKey, models, apiKey, paths)
  } else if (canonicalToolMode === 'amp') {
    installResult = installIntoAmp(providerKey, models, apiKey, paths)
  } else if (canonicalToolMode === 'qwen') {
    installResult = installIntoQwen(providerKey, models, apiKey, paths)
  } else if (canonicalToolMode === 'jcode') {
    installResult = installIntoEnvBasedTool(providerKey, models, apiKey, canonicalToolMode, paths)
  } else if (canonicalToolMode === 'openhands') {
    installResult = installIntoEnvBasedTool(providerKey, models, apiKey, canonicalToolMode, paths)
  } else if (canonicalToolMode === 'fcm_router') {
    installResult = installIntoFcmRouter(providerKey, models, apiKey)
  } else if (canonicalToolMode === 'forgecode') {
    installResult = installIntoForgeCode(providerKey, models, apiKey, paths)
  } else if (canonicalToolMode === 'zcode') {
    installResult = installIntoZCode(providerKey, models, apiKey, paths, scope)
  } else {
    throw new Error(`Unsupported install target: ${toolMode}`)
  }

  if (options.track !== false) {
    upsertInstallRecord(config, buildInstallRecord(providerKey, canonicalToolMode, scope, models.map((model) => model.modelId)))
    saveConfig(config, { replaceEndpointInstalls: true })
  }

  return {
    ...installResult,
    toolMode: canonicalToolMode,
    toolLabel: getToolMeta(toolMode).label,
    providerKey,
    providerLabel: getProviderLabel(providerKey),
    scope,
    connectionMode: 'direct',
    autoRefreshEnabled: true,
    models,
  }
}

export function refreshInstalledEndpoints(config, options = {}) {
  if (!Array.isArray(config?.endpointInstalls) || config.endpointInstalls.length === 0) {
    return { refreshed: 0, failed: 0, errors: [] }
  }

  let refreshed = 0
  let failed = 0
  const errors = []

  for (const record of config.endpointInstalls) {
    try {
      installProviderEndpoints(config, record.providerKey, record.toolMode, {
        scope: record.scope,
        modelIds: record.modelIds,
        track: false,
        paths: options.paths,
      })
      refreshed += 1
    } catch (error) {
      failed += 1
      errors.push({
        providerKey: record.providerKey,
        toolMode: record.toolMode,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (refreshed > 0) {
    config.endpointInstalls = config.endpointInstalls.map((record) => ({
      ...record,
      lastSyncedAt: new Date().toISOString(),
    }))
    saveConfig(config, { replaceEndpointInstalls: true })
  }

  return { refreshed, failed, errors }
}

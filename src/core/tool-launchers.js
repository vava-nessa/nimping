/**
 * @file src/tool-launchers.js
 * @description Auto-configure and launch external coding tools from the selected model row.
 *
 * @details
 *   📖 This module extends the existing "pick a model and press Enter" workflow to
 *   external CLIs that can consume OpenAI-compatible or provider-specific settings.
 *
 *   📖 The design is pragmatic:
 *   - Write a small managed config file when the tool's config shape is stable enough
 *   - Always export the runtime environment variables before spawning the tool
 *   - Persist the selected model into the tool config before launch so Enter
 *     really means "open this tool on this model right now"
 *   - Keep each launcher isolated so a partial integration does not break others
 *
 *   📖 Goose: writes custom provider JSON + secrets.yaml + updates config.yaml (GOOSE_PROVIDER/GOOSE_MODEL)
 *   📖 Crush: writes crush.json with provider config + models.large/small defaults
 *   📖 Pi: uses --provider/--model CLI flags for guaranteed auto-selection
 *   📖 Aider: writes ~/.aider.conf.yml + passes --model flag
 *   📖 Hermes: uses `hermes config set` CLI commands + `hermes gateway restart` before launching `hermes chat`
 *   📖 Continue: writes ~/.continue/config.yaml with provider: openai + apiBase
 *   📖 Cline: writes ~/.cline/globalState.json with openai-compatible provider config
 *   📖 ForgeCode: writes [[providers]] TOML block into ~/.forge/.forge.toml + sets [session] defaults
 *
 * @functions
 *   → `resolveLauncherModelId` — choose the provider-specific id for a launch
 *   → `writeGooseConfig` — install provider + set GOOSE_PROVIDER/GOOSE_MODEL in config.yaml
 *   → `writeCrushConfig` — write provider + models.large/small to crush.json
 *   → `prepareExternalToolLaunch` — persist selected-model defaults and compute the launch command
 *   → `startExternalTool` — configure and launch the selected external tool mode
 *
 * @exports resolveLauncherModelId, buildToolEnv, prepareExternalToolLaunch, startExternalTool
 *
 * @see src/tool-metadata.js
 * @see src/provider-metadata.js
 * @see sources.js
 */

import chalk from 'chalk'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'
import { sources } from '../../sources.js'
import { PROVIDER_COLOR } from '../tui/render-table.js'
import { getApiKey } from './config.js'
import { ENV_VAR_NAMES, isWindows } from './provider-metadata.js'
import { getToolMeta, TOOL_METADATA } from './tool-metadata.js'
import { PROVIDER_METADATA } from './provider-metadata.js'
import { resolveToolBinaryPath } from './tool-bootstrap.js'
import { ensureDir, readJson, writeJson, shellSingleQuote } from './shared-helpers.js'
import { parseContextWindow } from './endpoint-installer.js'
import { resolveCloudflareUrl } from './ping.js'

const OPENAI_COMPAT_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
]
const SANITIZED_TOOL_ENV_KEYS = [...OPENAI_COMPAT_ENV_KEYS]

// 📖 Parse a context window string (e.g. "128k", "1M", "32k") to token count number.
function parseCtxToTokens(ctx) {
  if (!ctx || typeof ctx !== 'string') return null
  const match = ctx.match(/^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/)
  if (!match) return null
  const num = parseFloat(match[1])
  const suffix = match[2].toLowerCase()
  // 📖 LLM token counts use binary (1024), not decimal (1000).
  if (suffix === 'k') return Math.round(num * 1024)
  if (suffix === 'm') return Math.round(num * 1024 * 1024)
  return Math.round(num)
}

function getDefaultToolPaths(homeDir = homedir()) {
  return {
    aiderConfigPath: join(homeDir, '.aider.conf.yml'),
    crushConfigPath: join(homeDir, '.config', 'crush', 'crush.json'),
    gooseProvidersDir: join(homeDir, '.config', 'goose', 'custom_providers'),
    gooseSecretsPath: join(homeDir, '.config', 'goose', 'secrets.yaml'),
    gooseConfigPath: join(homeDir, '.config', 'goose', 'config.yaml'),
    qwenConfigPath: join(homeDir, '.qwen', 'settings.json'),
    ampConfigPath: join(homeDir, '.config', 'amp', 'settings.json'),
    piModelsPath: join(homeDir, '.pi', 'agent', 'models.json'),
    piSettingsPath: join(homeDir, '.pi', 'agent', 'settings.json'),
    openHandsEnvPath: join(homeDir, '.fcm-openhands-env'),
    hermesConfigPath: join(homeDir, '.hermes', 'config.yaml'),
    continueConfigPath: join(homeDir, '.continue', 'config.yaml'),
    clineConfigPath: join(homeDir, '.cline', 'globalState.json'),
    forgeCodeConfigPath: join(homeDir, '.forge', '.forge.toml'),
    zcodeConfigPath: join(homeDir, '.zcode', 'v2', 'config.json'),
    zcodeModelCachePath: join(homeDir, '.zcode', 'v2', 'bots-model-cache.v2.json'),
  }
}

function backupIfExists(filePath) {
  if (!existsSync(filePath)) return null
  const backupPath = `${filePath}.backup-${Date.now()}`
  copyFileSync(filePath, backupPath)
  return backupPath
}

// 📖 readJson/writeJson imported from shared-helpers.js

function getProviderBaseUrl(providerKey) {
  const url = sources[providerKey]?.url
  if (!url) return null
  let resolvedUrl = url
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/responses$/i, '')
    .replace(/\/predictions$/i, '')
  // 📖 Cloudflare uses account_id in URL - resolve from CLOUDFLARE_ACCOUNT_ID env var
  if (providerKey === 'cloudflare') {
    resolvedUrl = resolveCloudflareUrl(resolvedUrl)
  }
  return resolvedUrl
}

function deleteEnvKeys(env, keys) {
  for (const key of keys) delete env[key]
}

function cloneInheritedEnv(inheritedEnv = process.env, sanitizeKeys = []) {
  const env = { ...inheritedEnv }
  deleteEnvKeys(env, sanitizeKeys)
  return env
}

function applyOpenAiCompatEnv(env, apiKey, baseUrl, modelId) {
  if (!apiKey || !baseUrl || !modelId) return env
  env.OPENAI_API_KEY = apiKey
  env.OPENAI_BASE_URL = baseUrl
  env.OPENAI_API_BASE = baseUrl
  env.OPENAI_MODEL = modelId
  env.LLM_API_KEY = apiKey
  env.LLM_BASE_URL = baseUrl
  env.LLM_MODEL = `openai/${modelId}`
  return env
}

function resolveLaunchCommand(mode, fallbackCommand) {
  return resolveToolBinaryPath(mode) || fallbackCommand
}

/**
 * 📖 resolveLauncherModelId returns the provider-native id used by the direct
 * 📖 launchers. Legacy bridge-specific model remapping has been removed.
 *
 * @param {{ label?: string, modelId?: string }} model
 * @returns {string}
 */
export function resolveLauncherModelId(model) {
  return model?.modelId ?? ''
}

export function buildToolEnv(mode, model, config, options = {}) {
  const {
    sanitize = false,
    includeCompatDefaults = true,
    includeProviderEnv = true,
    inheritedEnv = process.env,
  } = options
  const providerKey = model.providerKey
  const providerUrl = sources[providerKey]?.url || ''
  const baseUrl = getProviderBaseUrl(providerKey)
  const apiKey = sanitize ? (config?.apiKeys?.[providerKey] ?? null) : getApiKey(config, providerKey)
  const env = cloneInheritedEnv(inheritedEnv, sanitize ? SANITIZED_TOOL_ENV_KEYS : [])
  const providerEnvName = ENV_VAR_NAMES[providerKey]
  if (includeProviderEnv && providerEnvName && apiKey) env[providerEnvName] = apiKey

  // 📖 OpenAI-compatible defaults reused by multiple CLIs.
  if (includeCompatDefaults && apiKey && baseUrl) {
    env.OPENAI_API_KEY = apiKey
    env.OPENAI_BASE_URL = baseUrl
    env.OPENAI_API_BASE = baseUrl
    env.OPENAI_MODEL = model.modelId
    env.LLM_API_KEY = apiKey
    env.LLM_BASE_URL = baseUrl
    env.LLM_MODEL = `openai/${model.modelId}`
  }

  return { env, apiKey, baseUrl, providerUrl }
}

// 📖 jcode rejects bare model names (e.g. "gpt-oss-120b") against its hardcoded whitelist.
// 📖 But namespaced names like "openai/gpt-oss-120b" bypass the validation entirely.
// 📖 This helper ensures model IDs always have a namespace prefix for jcode compatibility.
function ensureJcodeModelPrefix(modelId) {
  if (modelId.includes('/')) return modelId
  return `openai/${modelId}`
}

// 📖 Map our provider keys → jcode native provider names + their expected env var.
// 📖 Using native providers avoids the openai-compatible model validation bug where
// 📖 jcode incorrectly routes namespaced models (e.g. "openai/gpt-oss-120b") to OpenRouter.
// 📖 Env var names were extracted from the jcode binary — they must match exactly.
const JCODE_NATIVE_PROVIDERS = {
  groq:       { provider: 'groq',          envKey: 'GROQ_API_KEY' },
  cerebras:   { provider: 'cerebras',      envKey: 'CEREBRAS_API_KEY' },
  deepinfra:  { provider: 'deepinfra',     envKey: 'DEEPINFRA_API_KEY' },
  scaleway:   { provider: 'scaleway',      envKey: 'SCALEWAY_API_KEY' },
  together:   { provider: 'together-ai',   envKey: 'TOGETHER_API_KEY' },
  huggingface:{ provider: 'hugging-face',  envKey: 'HF_TOKEN' },
  fireworks:  { provider: 'fireworks',     envKey: 'FIREWORKS_API_KEY' },
  chutes:     { provider: 'chutes',        envKey: 'CHUTES_API_KEY' },
  openrouter: { provider: 'openrouter',    envKey: 'OPENROUTER_API_KEY' },
  perplexity: { provider: 'perplexity',    envKey: 'PERPLEXITY_API_KEY' },
  zai:        { provider: 'zai',           envKey: 'ZHIPU_API_KEY' },
  mistral:    { provider: 'mistral',       envKey: 'MISTRAL_API_KEY' },
  codestral:  { provider: 'mistral',       envKey: 'MISTRAL_API_KEY' },
}

function spawnCommand(command, args, env) {
  // 📖 Defensive: ensure stdin is back in cooked mode before handing the TTY to
  // 📖 an interactive child (jcode REPL etc). The TUI leaves raw mode enabled;
  // 📖 if the caller forgot to reset it the child will appear to hang.
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false)
  } catch {}
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: isWindows,
      detached: false,
      env,
    })

    child.on('exit', (code) => resolve(code))
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.error(chalk.red(`  X Could not find "${command}" in PATH.`))
        resolve(1)
      } else {
        reject(err)
      }
    })
  })
}

function writeAiderConfig(model, apiKey, baseUrl, paths = getDefaultToolPaths()) {
  const filePath = paths.aiderConfigPath
  const backupPath = backupIfExists(filePath)
  const content = [
    '# 📖 Managed by free-coding-models',
    `openai-api-base: ${baseUrl}`,
    `openai-api-key: ${apiKey}`,
    `model: openai/${model.modelId}`,
    '',
  ].join('\n')
  ensureDir(filePath)
  writeFileSync(filePath, content)
  return { filePath, backupPath }
}

function writeCrushConfig(model, apiKey, baseUrl, providerId, paths = getDefaultToolPaths()) {
  const filePath = paths.crushConfigPath
  const backupPath = backupIfExists(filePath)
  const config = readJson(filePath, { $schema: 'https://charm.land/crush.json' })
  // 📖 Remove legacy disable_default_providers — it can prevent Crush from auto-selecting models
  if (config.options && config.options.disable_default_providers) {
    delete config.options.disable_default_providers
  }
  if (!config.providers || typeof config.providers !== 'object') config.providers = {}
  config.providers[providerId] = {
    name: 'Free Coding Models',
    type: 'openai-compat',
    base_url: baseUrl,
    api_key: apiKey,
    models: [
      {
        name: model.label,
        id: model.modelId,
      },
    ],
  }
  // 📖 Crush expects structured selected models at config.models.{large,small}.
  // 📖 Setting both large AND small ensures Crush auto-selects the model in interactive mode.
  config.models = {
    ...(config.models && typeof config.models === 'object' ? config.models : {}),
    large: { model: model.modelId, provider: providerId },
    small: { model: model.modelId, provider: providerId },
  }
  writeJson(filePath, config)
  return { filePath, backupPath }
}

function writeQwenConfig(model, providerKey, apiKey, baseUrl, paths = getDefaultToolPaths()) {
  const filePath = paths.qwenConfigPath
  const backupPath = backupIfExists(filePath)
  const config = readJson(filePath, {})
  if (!config.modelProviders || typeof config.modelProviders !== 'object') config.modelProviders = {}
  if (!Array.isArray(config.modelProviders.openai)) config.modelProviders.openai = []
  const nextEntry = {
    id: model.modelId,
    name: model.label,
    envKey: ENV_VAR_NAMES[providerKey] || 'OPENAI_API_KEY',
    baseUrl,
  }
  const filtered = config.modelProviders.openai.filter((entry) => entry?.id !== model.modelId)
  filtered.unshift(nextEntry)
  config.modelProviders.openai = filtered
  config.model = model.modelId
  writeJson(filePath, config)
  return { filePath, backupPath, envKey: nextEntry.envKey, apiKey }
}

function writePiConfig(model, apiKey, baseUrl, paths = getDefaultToolPaths()) {
  // 📖 Write models.json with the selected provider config
  const modelsFilePath = paths.piModelsPath
  const modelsBackupPath = backupIfExists(modelsFilePath)
  const modelsConfig = readJson(modelsFilePath, { providers: {} })
  if (!modelsConfig.providers || typeof modelsConfig.providers !== 'object') modelsConfig.providers = {}
  modelsConfig.providers[model.providerKey] = {
    baseUrl,
    api: 'openai-completions',
    apiKey,
    models: [{ id: model.modelId, name: model.label }],
  }
  writeJson(modelsFilePath, modelsConfig)

  // 📖 Write settings.json to set the model as default on next launch
  const settingsFilePath = paths.piSettingsPath
  const settingsBackupPath = backupIfExists(settingsFilePath)
  const settingsConfig = readJson(settingsFilePath, {})
  settingsConfig.defaultProvider = model.providerKey
  settingsConfig.defaultModel = model.modelId
  writeJson(settingsFilePath, settingsConfig)

  return { filePath: modelsFilePath, backupPath: modelsBackupPath, settingsFilePath, settingsBackupPath }
}

// 📖 writeGooseConfig: Install/update the provider in Goose's custom_providers/, set the
// 📖 API key in secrets.yaml, and update config.yaml with GOOSE_PROVIDER + GOOSE_MODEL
// 📖 so Goose auto-selects the model on launch.
function writeGooseConfig(model, apiKey, baseUrl, providerKey, paths = getDefaultToolPaths()) {
  const providerId = `fcm-${providerKey}`
  const providerLabel = PROVIDER_METADATA[providerKey]?.label || sources[providerKey]?.name || providerKey
  const secretEnvName = `FCM_${providerKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

  // 📖 Step 1: Write custom provider JSON (same format as endpoint-installer)
  const providerFilePath = join(paths.gooseProvidersDir, `${providerId}.json`)
  ensureDir(providerFilePath)
  const providerConfig = {
    name: providerId,
    engine: 'openai',
    display_name: `FCM ${providerLabel}`,
    description: `Managed by free-coding-models for ${providerLabel}`,
    api_key_env: secretEnvName,
    base_url: baseUrl?.endsWith('/chat/completions') ? baseUrl : (baseUrl || ''),
    models: [{ name: model.modelId, context_limit: parseContextWindow(model.ctx) }],
    supports_streaming: true,
    requires_auth: true,
  }
  writeFileSync(providerFilePath, JSON.stringify(providerConfig, null, 2) + '\n')

  // 📖 Step 2: Write API key to secrets.yaml (simple key: value format)
  const secretsPath = paths.gooseSecretsPath
  let secretsContent = ''
  if (existsSync(secretsPath)) {
    secretsContent = readFileSync(secretsPath, 'utf8')
  }
  // 📖 Replace existing secret or append new one
  const secretLine = `${secretEnvName}: ${JSON.stringify(apiKey)}`
  const secretRegex = new RegExp(`^${secretEnvName}:.*$`, 'm')
  if (secretRegex.test(secretsContent)) {
    secretsContent = secretsContent.replace(secretRegex, secretLine)
  } else {
    secretsContent = secretsContent.trimEnd() + '\n' + secretLine + '\n'
  }
  ensureDir(secretsPath)
  writeFileSync(secretsPath, secretsContent)

  // 📖 Step 3: Update config.yaml — set GOOSE_PROVIDER and GOOSE_MODEL at top level
  const configPath = paths.gooseConfigPath
  const configBackupPath = backupIfExists(configPath)
  let configContent = ''
  if (existsSync(configPath)) {
    configContent = readFileSync(configPath, 'utf8')
  }
  // 📖 Replace or add GOOSE_PROVIDER line
  if (/^GOOSE_PROVIDER:.*/m.test(configContent)) {
    configContent = configContent.replace(/^GOOSE_PROVIDER:.*/m, `GOOSE_PROVIDER: ${providerId}`)
  } else {
    configContent = `GOOSE_PROVIDER: ${providerId}\n` + configContent
  }
  // 📖 Replace or add GOOSE_MODEL line
  if (/^GOOSE_MODEL:.*/m.test(configContent)) {
    configContent = configContent.replace(/^GOOSE_MODEL:.*/m, `GOOSE_MODEL: ${model.modelId}`)
  } else {
    // 📖 Insert after GOOSE_PROVIDER line
    configContent = configContent.replace(/^(GOOSE_PROVIDER:.*)/m, `$1\nGOOSE_MODEL: ${model.modelId}`)
  }
  writeFileSync(configPath, configContent)

  return { providerFilePath, secretsPath, configPath, configBackupPath }
}

function writeAmpConfig(model, baseUrl, paths = getDefaultToolPaths()) {
  const filePath = paths.ampConfigPath
  const backupPath = backupIfExists(filePath)
  const config = readJson(filePath, {})
  config['amp.url'] = baseUrl
  config['amp.model'] = model.modelId
  writeJson(filePath, config)
  return { filePath, backupPath }
}

function writeOpenHandsEnv(model, apiKey, baseUrl, paths = getDefaultToolPaths()) {
  const filePath = paths.openHandsEnvPath
  const backupPath = backupIfExists(filePath)
  const lines = [
    '# 📖 Managed by free-coding-models',
    // 📖 Single-quote the key so quotes/$()/backticks in it stay literal on `source`.
    `export OPENAI_API_KEY=${shellSingleQuote(apiKey)}`,
    `export OPENAI_BASE_URL="${baseUrl}"`,
    `export OPENAI_MODEL="${model.modelId}"`,
    `export LLM_API_KEY=${shellSingleQuote(apiKey)}`,
    `export LLM_BASE_URL="${baseUrl}"`,
    `export LLM_MODEL="openai/${model.modelId}"`,
  ]
  ensureDir(filePath)
  writeFileSync(filePath, lines.join('\n') + '\n')
  return { filePath, backupPath }
}

// 📖 writeContinueConfig — write ~/.continue/config.yaml with the selected model.
// 📖 Continue CLI uses YAML config with `provider: openai` for OpenAI-compatible endpoints.
function writeContinueConfig(model, apiKey, baseUrl, paths = getDefaultToolPaths()) {
  const filePath = paths.continueConfigPath
  const backupPath = backupIfExists(filePath)
  // 📖 Write a minimal config.yaml that Continue CLI can parse directly
  const content = [
    '# 📖 Managed by free-coding-models',
    'name: FCM Config',
    'version: 0.0.1',
    'schema: v1',
    'models:',
    '  - name: ' + (model.label || model.modelId),
    '    provider: openai',
    '    model: ' + model.modelId,
    ...(baseUrl ? ['    apiBase: ' + baseUrl] : []),
    ...(apiKey ? ['    apiKey: ' + apiKey] : []),
    '    roles:',
    '      - chat',
    '      - edit',
    '      - apply',
    '',
  ].join('\n')
  ensureDir(filePath)
  writeFileSync(filePath, content)
  return { filePath, backupPath }
}

// 📖 writeClineConfig — write ~/.cline/globalState.json with the selected model.
// 📖 Cline CLI stores provider config in globalState.json under apiConfiguration.
function writeClineConfig(model, apiKey, baseUrl, paths = getDefaultToolPaths()) {
  const filePath = paths.clineConfigPath
  const backupPath = backupIfExists(filePath)
  const config = readJson(filePath, {})
  // 📖 Set the API provider to "openai-compatible" and configure the endpoint
  config.apiConfiguration = {
    ...(config.apiConfiguration || {}),
    apiProvider: 'openai-compatible',
    openAiCompatibleApiModelId: model.modelId,
    ...(baseUrl ? { openAiCompatibleApiBaseUrl: baseUrl } : {}),
    ...(apiKey ? { openAiCompatibleApiKey: apiKey } : {}),
  }
  writeJson(filePath, config)
  return { filePath, backupPath }
}

// 📖 writeHermesConfig — configure Hermes Agent via its own `hermes config set` CLI.
// 📖 This avoids YAML parsing and uses Hermes's native config management.
// 📖 Sets model name, base_url (OpenAI-compatible endpoint), and api_key.
function writeHermesConfig(model, apiKey, baseUrl, paths = getDefaultToolPaths()) {
  const configPath = paths.hermesConfigPath
  const backupPath = backupIfExists(configPath)
  const hermesBin = resolveToolBinaryPath('hermes') || 'hermes'

  // 📖 Use `hermes config set` for each field — robust and dependency-free
  // 📖 Must use 'model.default' not 'model', otherwise it replaces the entire model: dict with a string
  // 📖 and subsequent model.provider / model.base_url / model.api_key calls silently fail
  spawnSync(hermesBin, ['config', 'set', 'model.default', model.modelId], { stdio: 'ignore' })
  spawnSync(hermesBin, ['config', 'set', 'model.provider', 'custom'], { stdio: 'ignore' })
  if (baseUrl) {
    spawnSync(hermesBin, ['config', 'set', 'model.base_url', baseUrl], { stdio: 'ignore' })
  }
  if (apiKey) {
    spawnSync(hermesBin, ['config', 'set', 'model.api_key', apiKey], { stdio: 'ignore' })
  }

  return { filePath: configPath, backupPath }
}

// 📖 writeForgeCodeConfig — write a managed [[providers]] block into ~/.forge/.forge.toml.
// 📖 ForgeCode uses TOML config with [[providers]] entries for custom OpenAI-compatible endpoints.
// 📖 Strategy:
// 📖   1. Read the existing .forge.toml (if any)
// 📖   2. Strip any previous FCM-managed provider block (delimited by comments)
// 📖   3. Append a fresh [[providers]] block with the selected model's provider details
// 📖   4. Update or insert [session] defaults to auto-select the model on next `forge` launch
// 📖 The provider ID uses the `fcm-{providerKey}` namespace to avoid clobbering user-defined providers.
// 📖 The API key is referenced via an env var (FCM_{PROVIDER}_API_KEY) and also set in the process env.
function writeForgeCodeConfig(model, apiKey, baseUrl, providerKey, paths = getDefaultToolPaths()) {
  const filePath = paths.forgeCodeConfigPath
  const backupPath = backupIfExists(filePath)
  const providerId = `fcm-${providerKey}`
  const providerLabel = PROVIDER_METADATA[providerKey]?.label || sources[providerKey]?.name || providerKey
  const secretEnvName = `FCM_${providerKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

  // 📖 Ensure the API key is available in env for ForgeCode to pick up
  process.env[secretEnvName] = apiKey

  // 📖 Build the provider's chat completions URL
  const completionsUrl = baseUrl
    ? (baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`)
    : ''

  // 📖 Read existing TOML content (if any)
  let content = ''
  if (existsSync(filePath)) {
    content = readFileSync(filePath, 'utf8')
  }

  // 📖 Remove any previous FCM-managed provider block (between marker comments)
  const markerStart = `# >>> FCM managed provider: ${providerId}`
  const markerEnd = `# <<< FCM managed provider: ${providerId}`
  const markerRegex = new RegExp(
    `\\n?${markerStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${markerEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
    'g'
  )
  content = content.replace(markerRegex, '\n')

  // 📖 Build a fresh [[providers]] TOML block
  const providerBlock = [
    '',
    markerStart,
    '[[providers]]',
    `id = "${providerId}"`,
    `url = "${completionsUrl}"`,
    `api_key_vars = "${secretEnvName}"`,
    'response_type = "OpenAI"',
    'auth_methods = ["api_key"]',
    markerEnd,
  ].join('\n')

  content = content.trimEnd() + '\n' + providerBlock + '\n'

  // 📖 Update or insert [session] defaults so ForgeCode auto-selects this model
  const sessionProviderLine = `provider_id = "${providerId}"`
  const sessionModelLine = `model_id = "${model.modelId}"`

  if (/^\[session\]/m.test(content)) {
    // 📖 Replace existing provider_id/model_id under [session]
    if (/^provider_id\s*=/m.test(content)) {
      content = content.replace(/^provider_id\s*=.*$/m, sessionProviderLine)
    } else {
      content = content.replace(/^\[session\]/m, `[session]\n${sessionProviderLine}`)
    }
    if (/^model_id\s*=/m.test(content)) {
      content = content.replace(/^model_id\s*=.*$/m, sessionModelLine)
    } else {
      content = content.replace(/^\[session\]/m, `[session]\n${sessionModelLine}`)
    }
  } else {
    // 📖 No [session] block — append one
    content = content.trimEnd() + '\n\n[session]\n' + sessionProviderLine + '\n' + sessionModelLine + '\n'
  }

  ensureDir(filePath)
  writeFileSync(filePath, content)
  return { filePath, backupPath }
}

// 📖 writeZCodeConfig: Writes provider + model into ZCode's config.json and
// 📖 bots-model-cache.v2.json so the selected model appears in ZCode's model picker.
// 📖 Uses a deterministic provider ID (fcm-{providerKey}) and merges models so
// 📖 re-running on the same provider/model is idempotent — no duplicates.
export function writeZCodeConfig(model, config, paths = getDefaultToolPaths()) {
  const configPath = paths.zcodeConfigPath
  const cachePath = paths.zcodeModelCachePath

  const providerKey = model.providerKey || 'nvidia'
  const apiKey = getApiKey(config, providerKey)
  // 📖 Use getProviderBaseUrl so Cloudflare's {account_id} placeholder is resolved
  // 📖 (raw sources[].url would leave it literal and ZCode would fail on Cloudflare models).
  const baseUrl = getProviderBaseUrl(providerKey)
  const providerId = `fcm-${providerKey}`
  const providerLabel = `FCM ${sources[providerKey]?.name || providerKey}`

  if (!baseUrl) {
    throw new Error(`Cannot resolve base URL for ${sources[providerKey]?.name || providerKey}`)
  }

  const ctx = parseCtxToTokens(model.ctx) || 200000
  const maxOutput = Math.max(4096, Math.min(ctx, 32768))

  // ── 1. Write to config.json ───────────────────────────────────────────────
  const cfg = readJson(configPath, { $schema: 'https://opencode.ai/config.json' })
  if (!cfg.provider || typeof cfg.provider !== 'object') cfg.provider = {}

  const existingProvider = cfg.provider[providerId]
  let configModified = false

  // 📖 If the provider already exists with this model — skip (idempotent)
  if (existingProvider && existingProvider.models?.[model.modelId]) {
    // Model already configured — skip config write, but still check cache
  } else if (existingProvider) {
    // 📖 Provider exists but model is new — add model to existing provider
    existingProvider.models[model.modelId] = {
      limit: { context: ctx },
      modalities: { input: ['text'], output: ['text'] },
    }
    if (ctx > 8192) {
      existingProvider.models[model.modelId].limit.output = maxOutput
    }
    configModified = true
  } else {
    // 📖 New provider — create it
    cfg.provider[providerId] = {
      name: providerLabel,
      kind: 'openai-compatible',
      options: {
        apiKey: apiKey || '',
        baseURL: baseUrl.replace(/\/v1\/chat\/completions$/, '').replace(/\/v1$/, '') + '/v1',
        apiKeyRequired: true,
      },
      enabled: true,
      source: 'custom',
      models: {
        [model.modelId]: {
          limit: { context: ctx },
          modalities: { input: ['text'], output: ['text'] },
        },
      },
    }
    if (ctx > 8192) {
      cfg.provider[providerId].models[model.modelId].limit.output = maxOutput
    }
    configModified = true
  }

  const configBackupPath = configModified ? writeJson(configPath, cfg) : null

  // ── 2. Write to bots-model-cache.v2.json ──────────────────────────────────
  const cache = readJson(cachePath, { version: 2, updatedAt: Date.now(), providers: [] })
  if (!Array.isArray(cache.providers)) cache.providers = []

  const existingCacheIdx = cache.providers.findIndex((p) => p?.id === providerId)
  const modelAlreadyCached = existingCacheIdx >= 0
    && cache.providers[existingCacheIdx].models?.some((m) => m?.id === model.modelId)

  let cacheModified = false

  if (!modelAlreadyCached) {
    const modelEntry = {
      id: model.modelId,
      name: model.label || model.modelId,
      kinds: ['openai-compatible'],
      defaultKind: 'openai-compatible',
      modalities: { input: ['text'], output: ['text'] },
      contextWindow: ctx,
      ...(ctx > 8192 ? { maxOutputTokens: maxOutput } : {}),
    }

    if (existingCacheIdx >= 0) {
      // 📖 Provider exists in cache — add model to existing entry
      cache.providers[existingCacheIdx].models.push(modelEntry)
      cache.providers[existingCacheIdx].updatedAt = Date.now()
    } else {
      // 📖 New provider in cache
      cache.providers.push({
        id: providerId,
        name: providerLabel,
        enabled: true,
        endpoints: {
          baseURL: baseUrl.replace(/\/v1\/chat\/completions$/, '').replace(/\/v1$/, '') + '/v1',
          paths: { 'openai-compatible': '/chat/completions' },
        },
        apiFormat: 'openai-chat-completions',
        source: 'custom',
        apiKeyRequired: true,
        apiKey: apiKey ? '__zcode_cached_api_key_present__' : '',
        defaultKind: 'openai-compatible',
        models: [modelEntry],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
    cache.updatedAt = Date.now()
    cacheModified = true
  }

  const cacheBackupPath = cacheModified ? writeJson(cachePath, cache) : null

  return {
    filePath: configPath,
    backupPath: configBackupPath,
    providerId,
    cachePath,
    cacheBackupPath,
    skipped: !configModified && !cacheModified,
  }
}

// 📖 restartHermesGateway — restart the Hermes messaging gateway after config changes.
// 📖 Non-blocking: if gateway is not running, this is a no-op.
function restartHermesGateway() {
  const hermesBin = resolveToolBinaryPath('hermes') || 'hermes'
  spawnSync(hermesBin, ['gateway', 'restart'], { stdio: 'ignore', timeout: 10000 })
}


/**
 * 📖 buildCavemanEnv - Build environment variables for Caveman Code
 *
 * Caveman Code supports 20+ providers via OAuth or API keys.
 * FCM passes the provider's API key through the matching env var
 * so Caveman Code can use it without re-authenticating.
 *
 * Supported env vars (from caveman-code source):
 * - ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY
 * - MISTRAL_API_KEY, GOOGLE_API_KEY, etc.
 *
 * @param {Object} model - Selected model with providerKey
 * @param {Object} config - Full app config
 * @param {Object} options - Env options
 * @returns {NodeJS.ProcessEnv}
 */
function buildCavemanEnv(model, config, options = {}) {
  const providerKey = model.providerKey || 'nvidia'
  const apiKey = getApiKey(config, providerKey)

  const env = cloneInheritedEnv(process.env, SANITIZED_TOOL_ENV_KEYS)

  if (apiKey && options.includeProviderEnv) {
    // 📖 Pass the API key through the provider's standard env var name
    // 📖 Caveman Code recognizes these natively and will use them for the selected model
    const providerEnvName = ENV_VAR_NAMES[providerKey]
    if (providerEnvName) {
      env[providerEnvName] = apiKey
    }
    // 📖 Also set OpenAI-compatible defaults for broad compatibility
    const baseUrl = getProviderBaseUrl(providerKey)
    if (baseUrl) {
      env.OPENAI_API_KEY = apiKey
      env.OPENAI_BASE_URL = baseUrl
      env.OPENAI_MODEL = model.modelId
    }
  }

  return env
}

function printConfigArtifacts(toolName, artifacts = []) {
  for (const artifact of artifacts) {
    if (!artifact?.path) continue
    const label = artifact.label ? `${artifact.label}: ` : ''
    console.log(chalk.dim(`  📄 ${toolName} ${label}${artifact.path}`))
    if (artifact.backupPath) console.log(chalk.dim(`  💾 Backup: ${artifact.backupPath}`))
  }
}

/**
 * 📖 prepareExternalToolLaunch persists the selected model into the target tool's
 * 📖 config before launch, then returns the exact command/env/args that should
 * 📖 be spawned. This makes launcher behavior unit-testable without requiring
 * 📖 the real CLIs in PATH.
 *
 * @param {string} mode
 * @param {{ providerKey: string, modelId: string, label: string }} model
 * @param {Record<string, unknown>} config
 * @param {{
 *   paths?: Partial<ReturnType<typeof getDefaultToolPaths>>,
 *   inheritedEnv?: NodeJS.ProcessEnv,
 * }} [options]
 * @returns {{
 *   blocked?: boolean,
 *   exitCode?: number,
 *   warnings?: string[],
 *   command?: string,
 *   args?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   apiKey?: string | null,
 *   baseUrl?: string | null,
 *   meta: { label: string, emoji: string, flag: string | null },
 *   configArtifacts: Array<{ path: string, backupPath: string | null, label?: string }>
 * }}
 */
export function prepareExternalToolLaunch(mode, model, config, options = {}) {
  const meta = getToolMeta(mode)
  const paths = { ...getDefaultToolPaths(), ...(options.paths || {}) }
  const { env, apiKey, baseUrl } = buildToolEnv(mode, model, config, {
    inheritedEnv: options.inheritedEnv,
  })

  const isCliOnlyTool = TOOL_METADATA[mode]?.cliOnly === true

  if (!apiKey && mode !== 'amp' && !isCliOnlyTool) {
    const providerRgb = PROVIDER_COLOR[model.providerKey] ?? [105, 190, 245]
    const providerName = sources[model.providerKey]?.name || model.providerKey
    const coloredProviderName = chalk.bold.rgb(...providerRgb)(providerName)
    return {
      blocked: true,
      exitCode: 1,
      warnings: [
        `  ⚠ No API key configured for ${coloredProviderName}.`,
        '  Configure the provider first from the Settings screen (P) or via env vars.',
      ],
      meta,
      configArtifacts: [],
    }
  }

  if (mode === 'aider') {
    const result = writeAiderConfig(model, apiKey, baseUrl, paths)
    return {
      command: 'aider',
      args: ['--model', `openai/${model.modelId}`],
      env,
      apiKey,
      baseUrl,
      meta,
      configArtifacts: [{ path: result.filePath, backupPath: result.backupPath, label: 'config' }],
    }
  }

  if (mode === 'crush') {
    const launchModelId = resolveLauncherModelId(model)
    applyOpenAiCompatEnv(env, apiKey, baseUrl, launchModelId)
    const result = writeCrushConfig({ ...model, modelId: launchModelId }, apiKey, baseUrl, 'freeCodingModels', paths)
    return {
      command: 'crush',
      args: [],
      env,
      apiKey,
      baseUrl,
      meta,
      configArtifacts: [{ path: result.filePath, backupPath: result.backupPath, label: 'config' }],
    }
  }

  if (mode === 'goose') {
    // 📖 Always use the resolved provider base URL from buildToolEnv (getProviderBaseUrl),
    // 📖 which substitutes Cloudflare's {account_id} placeholder via resolveCloudflareUrl.
    // 📖 Using the raw sources[].url would leave the literal {account_id} in the Goose
    // 📖 provider config, so Goose would POST to /accounts/{account_id}/... and 400.
    const gooseBaseUrl = baseUrl
    const gooseModelId = resolveLauncherModelId(model)
    const result = writeGooseConfig({ ...model, modelId: gooseModelId }, apiKey, gooseBaseUrl, model.providerKey, paths)
    env.GOOSE_PROVIDER = `fcm-${model.providerKey}`
    env.GOOSE_MODEL = gooseModelId
    applyOpenAiCompatEnv(env, apiKey, gooseBaseUrl.replace(/\/chat\/completions$/, ''), gooseModelId)
    return {
      command: 'goose',
      args: [],
      env,
      apiKey,
      baseUrl,
      meta,
      configArtifacts: [
        { path: result.providerFilePath, backupPath: null, label: 'provider' },
        { path: result.secretsPath, backupPath: null, label: 'secrets' },
        { path: result.configPath, backupPath: result.configBackupPath || null, label: 'config' },
      ],
    }
  }

  if (mode === 'qwen') {
    const result = writeQwenConfig(model, model.providerKey, apiKey, baseUrl, paths)
    return {
      command: 'qwen',
      args: [],
      env,
      apiKey,
      baseUrl,
      meta,
      configArtifacts: [{ path: result.filePath, backupPath: result.backupPath, label: 'config' }],
    }
  }

  if (mode === 'openhands') {
    const result = writeOpenHandsEnv(model, apiKey, baseUrl, paths)
    env.LLM_MODEL = model.modelId
    env.LLM_API_KEY = apiKey || env.LLM_API_KEY
    if (baseUrl) env.LLM_BASE_URL = baseUrl
    return {
      command: 'openhands',
      args: ['--override-with-envs'],
      env,
      apiKey,
      baseUrl,
      meta,
      configArtifacts: [{ path: result.filePath, backupPath: result.backupPath, label: 'env file' }],
    }
  }

  if (mode === 'amp') {
    const result = writeAmpConfig(model, baseUrl, paths)
    return {
      command: 'amp',
      args: [],
      env,
      apiKey,
      baseUrl,
      meta,
      configArtifacts: [{ path: result.filePath, backupPath: result.backupPath, label: 'config' }],
    }
  }

  if (mode === 'pi') {
    const result = writePiConfig(model, apiKey, baseUrl, paths)
    return {
      command: 'pi',
      args: ['--provider', model.providerKey, '--model', model.modelId, '--api-key', apiKey],
      env,
      apiKey,
      baseUrl,
      meta,
      configArtifacts: [
        { path: result.filePath, backupPath: result.backupPath, label: 'models' },
        { path: result.settingsFilePath, backupPath: result.settingsBackupPath, label: 'settings' },
      ],
    }
  }

  if (mode === 'hermes') {
    const result = writeHermesConfig(model, apiKey, baseUrl, paths)
    return {
      command: 'hermes',
      args: ['chat'],
      env,
      apiKey,
      baseUrl,
      meta,
      configArtifacts: [{ path: result.filePath, backupPath: result.backupPath, label: 'config' }],
    }
  }

  if (mode === 'continue') {
    const result = writeContinueConfig(model, apiKey, baseUrl, paths)
    return {
      command: 'cn',
      args: [],
      env,
      apiKey,
      baseUrl,
      meta,
      configArtifacts: [{ path: result.filePath, backupPath: result.backupPath, label: 'config' }],
    }
  }

  if (mode === 'cline') {
    const result = writeClineConfig(model, apiKey, baseUrl, paths)
    return {
      command: 'cline',
      args: [],
      env,
      apiKey,
      baseUrl,
      meta,
      configArtifacts: [{ path: result.filePath, backupPath: result.backupPath, label: 'config' }],
    }
  }

  if (mode === 'xcode') {
    return {
      command: 'open',
      args: ['-a', 'Xcode'],
      env,
      apiKey,
      baseUrl,
      meta,
      configArtifacts: [],
    }
  }

  if (mode === 'zcode') {
    // 📖 Write provider + model into ZCode config so it appears in ZCode's model picker.
    const result = writeZCodeConfig(model, config, paths)
    const isMac = process.platform === 'darwin'

    return {
      command: isMac ? 'open' : 'node',
      args: isMac ? ['-a', 'ZCode'] : ['-e', 'process.exit(0)'],
      env,
      apiKey,
      baseUrl,
      meta,
      configArtifacts: [
        { path: result.filePath, backupPath: result.backupPath, label: 'config' },
        ...(result.cachePath ? [{ path: result.cachePath, backupPath: result.cacheBackupPath, label: 'model cache' }] : []),
      ],
    }
  }

  if (mode === 'caveman') {
    const cavemanEnv = buildCavemanEnv(model, config, { includeProviderEnv: options.includeProviderEnv })
    console.log(chalk.dim(`  📖 Caveman Code will use model: ${model.modelId}`))
    return {
      command: 'caveman',
      args: [],
      env: { ...env, ...cavemanEnv },
      apiKey: cavemanEnv.ANTHROPIC_API_KEY || cavemanEnv.OPENAI_API_KEY || null,
      baseUrl: null,
      meta,
      configArtifacts: [],
    }
  }

  if (mode === 'jcode') {
    // 📖 jcode has a hardcoded model whitelist — bare names like "gpt-oss-120b" are rejected.
    // 📖 Namespaced names like "openai/gpt-oss-120b" bypass it, but only work with native providers.
    // 📖 With --provider openai-compatible, jcode incorrectly routes namespaced models to OpenRouter.
    // 📖 Strategy: use jcode's native provider when available, fall back to openai-compatible + workaround.
    const jcodeModelId = ensureJcodeModelPrefix(model.modelId)
    const nativeMapping = JCODE_NATIVE_PROVIDERS[model.providerKey]

    if (nativeMapping) {
      // 📖 Use jcode's native provider — avoids the openai-compatible model validation bug
      const jcodeEnv = { ...env, [nativeMapping.envKey]: apiKey }
      console.log(chalk.dim(`  📖 jcode will use provider: ${nativeMapping.provider} / model: ${jcodeModelId}`))
      return {
        command: 'jcode',
        args: ['repl', '--provider', nativeMapping.provider, '--model', jcodeModelId],
        env: jcodeEnv,
        apiKey,
        baseUrl,
        meta,
        configArtifacts: [],
      }
    }

    // 📖 Fallback for providers without a native jcode match (nvidia, sambanova, etc.)
    // 📖 openai-compatible + namespaced model triggers a false OpenRouter credential check,
    // 📖 so we set a placeholder OPENROUTER_API_KEY to satisfy jcode's validation.
    const providerBaseUrl = model.providerKey === 'nvidia'
      ? 'https://integrate.api.nvidia.com/v1'
      : baseUrl
    const jcodeEnv = {
      ...env,
      OPENAI_BASE_URL: providerBaseUrl,
      OPENAI_API_KEY: apiKey,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY || 'fcm-bypass',
    }
    console.log(chalk.dim(`  📖 jcode will use provider: openai-compatible / model: ${jcodeModelId}`))
    return {
      command: 'jcode',
      args: ['repl', '--provider', 'openai-compatible', '--model', jcodeModelId],
      env: jcodeEnv,
      apiKey,
      baseUrl: providerBaseUrl,
      meta,
      configArtifacts: [],
    }
  }

  if (mode === 'copilot') {
    // 📖 copilot: set BYOK env vars so copilot uses the selected provider/model
    const copilotModelId = resolveLauncherModelId(model)
    env.COPILOT_PROVIDER_BASE_URL = baseUrl
    env.COPILOT_MODEL = copilotModelId
    if (apiKey) env.COPILOT_PROVIDER_API_KEY = apiKey

    // 📖 Set context window limits from model data
    const promptTokens = parseCtxToTokens(model.ctx)
    if (promptTokens) env.COPILOT_PROVIDER_MAX_PROMPT_TOKENS = String(promptTokens)
    // 📖 16k max output as a safety cap — most S+/S tier coding models
    // 📖 support 16-32k output. copilot falls back to built-in model
    // 📖 catalog defaults when a model ID is recognized.
    env.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS = '16384'

    return {
      command: 'copilot',
      args: [],
      env,
      apiKey,
      baseUrl,
      meta,
      configArtifacts: [],
    }
  }

  if (mode === 'forgecode') {
    const result = writeForgeCodeConfig(model, apiKey, baseUrl, model.providerKey, paths)
    return {
      command: 'forge',
      args: [],
      env,
      apiKey,
      baseUrl,
      meta,
      configArtifacts: [{ path: result.filePath, backupPath: result.backupPath, label: 'config' }],
    }
  }

  return {
    blocked: true,
    exitCode: 1,
    warnings: [chalk.red(`  X Unsupported external tool mode: ${mode}`)],
    meta,
    configArtifacts: [],
  }
}

export async function startExternalTool(mode, model, config) {
  const launchPlan = prepareExternalToolLaunch(mode, model, config)
  const { meta } = launchPlan

  if (launchPlan.blocked) {
    for (const warning of launchPlan.warnings || []) console.log(warning)
    console.log()
    return launchPlan.exitCode || 1
  }

  console.log(chalk.cyan(`  ▶ Launching ${meta.label} with ${chalk.bold(model.label)}...`))
  printConfigArtifacts(meta.label, launchPlan.configArtifacts)

  // 📖 Pre-launch hooks for tools that need special treatment
  if (mode === 'hermes') restartHermesGateway()
  if (mode === 'xcode') {
    const xcodeUrl = launchPlan.baseUrl ? launchPlan.baseUrl.replace(/\/v1$/, '').replace(/\/v1\/chat\/completions$/, '') : ''
    console.log(chalk.bold.cyan('\n  🛠️  Xcode Intelligence Setup Instructions:'))
    console.log(chalk.white('  1. Open Xcode and go to ') + chalk.bold('Xcode > Settings > Intelligence'))
    console.log(chalk.white('  2. Click ') + chalk.bold('Add a Chat Provider') + chalk.white(' and select ') + chalk.bold('Internet Hosted'))
    console.log(chalk.white('  3. Enter the following details:'))
    console.log(chalk.dim('     URL: ') + chalk.green(xcodeUrl))
    console.log(chalk.dim('     API Key: ') + chalk.green(launchPlan.apiKey || '<your_api_key>'))
    console.log(chalk.dim('     API Key Header: ') + chalk.green('Authorization') + chalk.dim(' (or x-api-key)'))
    console.log(chalk.dim('     Description: ') + chalk.green(`FCM - ${sources[model.providerKey]?.name || model.providerKey}`))
    console.log(chalk.white(`  4. Click Add, then select `) + chalk.bold(model.modelId) + chalk.white(` from the list.\n`))
    console.log(chalk.dim(`  📖 Attempting to launch Xcode...`))
  }
  if (mode === 'zcode') {
    // 📖 ZCode is a desktop app — config was already written by prepareExternalToolLaunch.
    // 📖 No process to spawn; the TUI stays open.
    console.log(chalk.dim(`  📖 ZCode config updated with model: ${model.modelId}. Open ZCode and select the model from the picker.`))
    return 0
  }
  if (mode === 'crush') console.log(chalk.dim('  📖 Crush will use the provider directly for this launch.'))

  // 📖 Tool-specific info messages (only for modes that have no prepare-step message)
  const infoMessages = {
    openhands: `  📖 OpenHands launched with model: ${model.modelId}`,
    amp:       `  📖 Amp config updated with model: ${model.modelId}`,
    hermes:    `  📖 Hermes Agent configured with model: ${model.modelId}`,
    continue:  `  📖 Continue CLI configured with model: ${model.modelId}`,
    cline:     `  📖 Cline configured with model: ${model.modelId}`,
    caveman:   '  📖 Launching Caveman Code...',
    jcode:     '  📖 Launching jcode...',
    copilot:   `  📖 Copilot CLI configured with model: ${model.modelId}`,
    forgecode: `  📖 ForgeCode configured with model: ${model.modelId}`,
  }
  if (infoMessages[mode]) console.log(chalk.dim(infoMessages[mode]))

	  // 📖 xcode uses raw command ("open"), everything else resolves via tool-bootstrap
	  const command = (mode === 'xcode') ? launchPlan.command : resolveLaunchCommand(mode, launchPlan.command)
  return spawnCommand(command, launchPlan.args, launchPlan.env)
}

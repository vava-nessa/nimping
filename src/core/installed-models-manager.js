/**
 * @file src/installed-models-manager.js
 * @description Scan, parse, and manage models configured in external tool configs.
 *
 * @details
 *   📖 This module provides functions to:
 *   - Scan all supported tool configs for installed models
 *   - Parse tool-specific config files (YAML, JSON)
 *   - Soft-delete models with backup to ~/.free-coding-models-backups.json
 *   - Launch tools with selected models
 *   - Reinstall FCM endpoints for providers
 *
 *   📖 Supported tools:
 *   - Goose (~/.config/goose/config.yaml + custom_providers/*.json)
 *   - Crush (~/.config/crush/crush.json)
 *   - Aider (~/.aider.conf.yml)
 *   - Kilo (~/.config/kilo/opencode.json)
 *   - Qwen (~/.qwen/settings.json)
 *   - Pi (~/.pi/agent/models.json + settings.json)
 *   - OpenHands (~/.fcm-openhands-env)
 *   - Amp (~/.config/amp/settings.json)
 *
 *   📖 Backup system:
 *   - Disabled models are saved to ~/.free-coding-models-backups.json
 * - Each entry includes: toolMode, modelId, originalConfig, configPath, disabledAt
 *
 * @functions
 *   → scanAllToolConfigs — Scan all tool configs and return structured results
 *   → parseToolConfig — Parse a specific tool's config file
 *   → parseGooseConfig — Parse Goose YAML config
 *   → parseCrushConfig — Parse Crush JSON config
 *   → parseAiderConfig — Parse Aider YAML config
 *   → parseKiloConfig — Parse Kilo JSON config
 *   → parseQwenConfig — Parse Qwen JSON config
 *   → parsePiConfig — Parse Pi JSON configs
 *   → parseOpenHandsConfig — Parse OpenHands env file
 *   → parseAmpConfig — Parse Amp JSON config
 *   → softDeleteModel — Remove model from config with backup
 *   → launchToolWithModel — Launch tool with specific model
 *   → reinstallEndpoint — Reinstall FCM endpoint for provider
 *
 * @exports scanAllToolConfigs, softDeleteModel, launchToolWithModel, reinstallEndpoint
 *
 * @see src/tool-launchers.js — for launch functions
 * @see src/endpoint-installer.js — for reinstall logic
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { sources } from '../../sources.js'

const BACKUP_PATH = join(homedir(), '.free-coding-models-backups.json')

/**
 * 📖 Get tool config paths
 */
function getToolConfigPaths(homeDir = homedir()) {
	return {
	    goose: join(homeDir, '.config', 'goose', 'config.yaml'),
	    crush: join(homeDir, '.config', 'crush', 'crush.json'),
	    aider: join(homeDir, '.aider.conf.yml'),
	    kilo: join(homeDir, '.config', 'kilo', 'opencode.json'),
	    qwen: join(homeDir, '.qwen', 'settings.json'),
	    piModels: join(homeDir, '.pi', 'agent', 'models.json'),
	    piSettings: join(homeDir, '.pi', 'agent', 'settings.json'),
	    openHands: join(homeDir, '.fcm-openhands-env'),
	    amp: join(homeDir, '.config', 'amp', 'settings.json'),
	    zcodeConfig: join(homeDir, '.zcode', 'v2', 'config.json'),
	    zcodeCache: join(homeDir, '.zcode', 'v2', 'bots-model-cache.v2.json'),
	  }
}

/**
 * 📖 Simple YAML parser for Goose and Aider configs
 * Handles basic key: value and multiline strings
 */
function parseSimpleYaml(filePath) {
  if (!existsSync(filePath)) return null
  try {
    const content = readFileSync(filePath, 'utf8')
    const result = {}
    let currentKey = null

    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      const colonIndex = trimmed.indexOf(':')
      if (colonIndex === -1) {
        if (currentKey && result[currentKey] !== undefined) {
          result[currentKey] += '\n' + trimmed
        }
        continue
      }

      currentKey = trimmed.slice(0, colonIndex).trim()
      const value = trimmed.slice(colonIndex + 1).trim()

      if (value === '' || value === '|') {
        result[currentKey] = ''
      } else if (value.startsWith('"') || value.startsWith("'")) {
        result[currentKey] = value.slice(1, -1)
      } else {
        result[currentKey] = value
      }
    }

    return result
  } catch (err) {
    return null
  }
}

/**
 * 📖 Parse Goose config for GOOSE_MODEL
 */
function parseGooseConfig(paths = getToolConfigPaths()) {
  const configPath = paths.goose
  if (!existsSync(configPath)) {
    return { isValid: false, models: [], configPath }
  }

  try {
    const yaml = parseSimpleYaml(configPath)
    if (!yaml) {
      return { isValid: false, models: [], configPath }
    }

    const gooseModel = yaml['GOOSE_MODEL']
    const gooseProvider = yaml['GOOSE_PROVIDER']

    const models = []
    if (gooseModel) {
      models.push({
        modelId: gooseModel,
        label: gooseModel,
        tier: '-',
        sweScore: '-',
        providerKey: 'external',
        isExternal: true,
        canLaunch: true,
      })
    }

    return {
      isValid: true,
      hasManagedMarker: yaml['GOOSE_PROVIDER']?.startsWith('fcm-'),
      models,
      configPath,
    }
  } catch (err) {
    return { isValid: false, models: [], configPath }
  }
}

/**
 * 📖 Parse Crush config for models.large/small
 */
function parseCrushConfig(paths = getToolConfigPaths()) {
  const configPath = paths.crush
  if (!existsSync(configPath)) {
    return { isValid: false, models: [], configPath }
  }

  try {
    const content = readFileSync(configPath, 'utf8')
    const config = JSON.parse(content)

    const models = []
// Extract models from providers section
      if (config.providers) {
        for (const providerKey in config.providers) {
          const provider = config.providers[providerKey]
          if (provider.models) {
            for (const model of provider.models) {
              models.push({
                modelId: model.id,
                label: model.name || model.id,
                tier: '-',
                sweScore: '-',
                providerKey: 'external',
                isExternal: true,
                canLaunch: true,
              })
            }
          }
        }
      }

      // Extract models from models section (large/small)
      if (config.models?.large?.model) {
        models.push({
          modelId: config.models.large.model,
          label: `${config.models.large.model} (large)`,
          tier: '-',
          sweScore: '-',
          providerKey: 'external',
          isExternal: true,
          canLaunch: true,
        })
      }
      if (config.models?.small?.model) {
        models.push({
          modelId: config.models.small.model,
          label: `${config.models.small.model} (small)`,
          tier: '-',
          sweScore: '-',
          providerKey: 'external',
          isExternal: true,
          canLaunch: true,
        })
      }

    return {
      isValid: true,
      hasManagedMarker: config.providers?.freeCodingModels !== undefined,
      models,
      configPath,
    }
  } catch (err) {
    return { isValid: false, models: [], configPath }
  }
}

/**
 * 📖 Parse Aider config for model
 */
function parseAiderConfig(paths = getToolConfigPaths()) {
  const configPath = paths.aider
  if (!existsSync(configPath)) {
    return { isValid: false, models: [], configPath }
  }

  try {
    const yaml = parseSimpleYaml(configPath)
    if (!yaml) {
      return { isValid: false, models: [], configPath }
    }

    const models = []
    const aiderModel = yaml['model']
    if (aiderModel) {
      const modelId = aiderModel.startsWith('openai/') ? aiderModel.slice(7) : aiderModel
      models.push({
        modelId,
        label: modelId,
        tier: '-',
        sweScore: '-',
        providerKey: 'external',
        isExternal: true,
        canLaunch: true,
      })
    }

    return {
      isValid: true,
      hasManagedMarker: yaml['openai-api-base']?.includes('build.nvidia.com') || false,
      models,
      configPath,
    }
  } catch (err) {
    return { isValid: false, models: [], configPath }
  }
}

/**
 * 📖 Parse Kilo config for model
 */
function parseKiloConfig(paths = getToolConfigPaths()) {
  const configPath = paths.kilo
  if (!existsSync(configPath)) {
    return { isValid: false, models: [], configPath }
  }

  try {
    const content = readFileSync(configPath, 'utf8')
    const config = JSON.parse(content)

    const models = []
    if (config.model) {
      models.push({
        modelId: config.model,
        label: config.model,
        tier: '-',
        sweScore: '-',
        providerKey: 'external',
        isExternal: true,
        canLaunch: true,
      })
    }

    return {
      isValid: true,
      hasManagedMarker: true, // Kilo CLI integration always uses modelRef format
      models,
      configPath,
    }
  } catch (err) {
    return { isValid: false, models: [], configPath }
  }
}

/**
 * 📖 Parse Qwen config for model
 */
function parseQwenConfig(paths = getToolConfigPaths()) {
  const configPath = paths.qwen
  if (!existsSync(configPath)) {
    return { isValid: false, models: [], configPath }
  }

  try {
    const content = readFileSync(configPath, 'utf8')
    const config = JSON.parse(content)

    const models = []
    if (config.model) {
      models.push({
        modelId: config.model,
        label: config.model,
        tier: '-',
        sweScore: '-',
        providerKey: 'external',
        isExternal: true,
        canLaunch: true,
      })
    }

    return {
      isValid: true,
      hasManagedMarker: Array.isArray(config.modelProviders?.openai) && config.modelProviders.openai.length > 0,
      models,
      configPath,
    }
  } catch (err) {
    return { isValid: false, models: [], configPath }
  }
}

/**
 * 📖 Parse Pi configs for defaultModel
 */
function parsePiConfig(paths = getToolConfigPaths()) {
  const settingsPath = paths.piSettings
  if (!existsSync(settingsPath)) {
    return { isValid: false, models: [], configPath: settingsPath }
  }

  try {
    const content = readFileSync(settingsPath, 'utf8')
    const config = JSON.parse(content)

    const models = []
    if (config.defaultModel && config.defaultProvider) {
      models.push({
        modelId: config.defaultModel,
        label: config.defaultModel,
        tier: '-',
        sweScore: '-',
        providerKey: 'external',
        isExternal: true,
        canLaunch: true,
      })
    }

    return {
      isValid: true,
      hasManagedMarker: config.defaultProvider === 'freeCodingModels',
      models,
      configPath: settingsPath,
    }
  } catch (err) {
    return { isValid: false, models: [], configPath: settingsPath }
  }
}

/**
 * 📖 Parse OpenHands env file for LLM_MODEL
 */
function parseOpenHandsConfig(paths = getToolConfigPaths()) {
  const configPath = paths.openHands
  if (!existsSync(configPath)) {
    return { isValid: false, models: [], configPath }
  }

  try {
    const content = readFileSync(configPath, 'utf8')
    const models = []

    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('export LLM_MODEL="') || trimmed.startsWith('export LLM_MODEL=\'')) {
        const match = trimmed.match(/export LLM_MODEL=(["'])(.*?)\1/)
        if (match) {
          models.push({
            modelId: match[2],
            label: match[2],
            tier: '-',
            sweScore: '-',
            providerKey: 'external',
            isExternal: true,
            canLaunch: true,
          })
        }
      }
    }

    return {
      isValid: true,
      hasManagedMarker: content.includes('Managed by free-coding-models'),
      models,
      configPath,
    }
  } catch (err) {
    return { isValid: false, models: [], configPath }
  }
}

/**
 * 📖 Parse Amp config for amp.model
 */
function parseAmpConfig(paths = getToolConfigPaths()) {
  const configPath = paths.amp
  if (!existsSync(configPath)) {
    return { isValid: false, models: [], configPath }
  }

  try {
    const content = readFileSync(configPath, 'utf8')
    const config = JSON.parse(content)

    const models = []
    if (config['amp.model']) {
      models.push({
        modelId: config['amp.model'],
        label: config['amp.model'],
        tier: '-',
        sweScore: '-',
        providerKey: 'external',
        isExternal: true,
        canLaunch: true,
      })
    }

    return {
      isValid: true,
      hasManagedMarker: config['amp.url']?.includes('build.nvidia.com') || false,
      models,
      configPath,
    }
  } catch (err) {
    return { isValid: false, models: [], configPath }
  }
}

/**
 * 📖 Parse ZCode config.json + bots-model-cache.v2.json for installed models.
 * 📖 Uses a Map keyed by "providerId::modelId" to deduplicate across both files.
 */
function parseZCodeConfig(paths = getToolConfigPaths()) {
  const configPath = paths.zcodeConfig
  const cachePath = paths.zcodeCache

  if (!existsSync(configPath)) {
    return { isValid: false, models: [], configPath }
  }

  try {
    /** @type {Map<string, object>} */
    const modelMap = new Map()

    const configContent = readFileSync(configPath, 'utf8')
    const config = JSON.parse(configContent)

    // ── 1. Source of truth: config.json provider.models ─────────────────────
    if (config.provider && typeof config.provider === 'object') {
      for (const [providerId, provider] of Object.entries(config.provider)) {
        if (!provider.models || typeof provider.models !== 'object') continue

        const isManaged = providerId.startsWith('fcm-')
        const sourceKey = isManaged ? providerId.replace('fcm-', '') : providerId

        for (const [modelId, modelConfig] of Object.entries(provider.models)) {
          const ctx = modelConfig?.limit?.context || 0
          const key = `${providerId}::${modelId}`
          modelMap.set(key, {
            modelId,
            label: modelId,
            tier: '-',
            sweScore: '-',
            providerKey: sourceKey,
            isExternal: !isManaged,
            canLaunch: true,
            contextWindow: ctx,
            enabled: provider.enabled !== false,
            zcodeProviderId: providerId,
          })
        }
      }
    }

    // ── 2. Cache enrichment: use cache names only (no duplicates) ────────────
    if (existsSync(cachePath)) {
      try {
        const cacheContent = readFileSync(cachePath, 'utf8')
        const cache = JSON.parse(cacheContent)

        if (Array.isArray(cache.providers)) {
          for (const cachedProvider of cache.providers) {
            if (!cachedProvider?.models) continue
            const providerId = cachedProvider.id || 'unknown'

            for (const cachedModel of cachedProvider.models) {
              const key = `${providerId}::${cachedModel.id}`
              const existing = modelMap.get(key)

              if (existing) {
                // 📖 Upgrade label from cache (prettier name) + fill context if missing
                if (cachedModel.name) existing.label = cachedModel.name
                if (cachedModel.contextWindow && !existing.contextWindow) {
                  existing.contextWindow = cachedModel.contextWindow
                }
              } else {
                // 📖 Model only in cache (edge case — provider.models missing it)
                const isManaged = providerId.startsWith('fcm-')
                const sourceKey = isManaged ? providerId.replace('fcm-', '') : providerId
                modelMap.set(key, {
                  modelId: cachedModel.id,
                  label: cachedModel.name || cachedModel.id,
                  tier: '-',
                  sweScore: '-',
                  providerKey: sourceKey,
                  isExternal: !isManaged,
                  canLaunch: true,
                  contextWindow: cachedModel.contextWindow || 0,
                  enabled: cachedProvider.enabled !== false,
                  zcodeProviderId: providerId,
                })
              }
            }
          }
        }
      } catch {
        // 📖 Cache file is optional — silently ignore errors
      }
    }

    const models = Array.from(modelMap.values())

    return {
      isValid: models.length > 0,
      hasManagedMarker: Object.keys(config.provider || {}).some((id) => id.startsWith('fcm-')),
      models,
      configPath,
    }
  } catch (err) {
    return { isValid: false, models: [], configPath }
  }
}

/**
 * 📖 Enhance model with metadata from sources.js
 */
function enhanceModelMetadata(model) {
  const modelId = model.modelId

  for (const providerKey in sources) {
    const provider = sources[providerKey]
    for (const m of provider.models) {
      if (m[0] === modelId) {
        return {
          ...model,
          label: m[1],
          tier: m[2],
          sweScore: m[3],
          providerKey,
          isExternal: false,
        }
      }
    }
  }

  return model
}

/**
 * 📖 Parse a specific tool's config
 */
export function parseToolConfig(toolMode, paths = getToolConfigPaths()) {
  switch (toolMode) {
    case 'goose':
      return parseGooseConfig(paths)
    case 'crush':
      return parseCrushConfig(paths)
    case 'aider':
      return parseAiderConfig(paths)
    case 'kilo':
      return parseKiloConfig(paths)
    case 'qwen':
      return parseQwenConfig(paths)
    case 'pi':
      return parsePiConfig(paths)
    case 'openhands':
      return parseOpenHandsConfig(paths)
	    case 'zcode':
	      return parseZCodeConfig(paths)
	    case 'amp':
	      return parseAmpConfig(paths)
	    default:
      return { isValid: false, models: [], configPath: '' }
  }
}

/**
 * 📖 Scan all tool configs and return structured results
 */
export function scanAllToolConfigs(paths = getToolConfigPaths()) {
	  const toolModes = ['goose', 'crush', 'aider', 'kilo', 'qwen', 'pi', 'openhands', 'amp', 'zcode']

  return toolModes.map((toolMode) => {
    const result = parseToolConfig(toolMode, paths)

    return {
      toolMode,
      toolLabel: toolMode.charAt(0).toUpperCase() + toolMode.slice(1),
      toolEmoji: getToolEmoji(toolMode),
      ...result,
      models: result.models.map(enhanceModelMetadata),
    }
  })
}

/**
 * 📖 Get tool emoji
 */
function getToolEmoji(toolMode) {
	  const emojis = {
	    goose: '🪿',
	    crush: '💘',
	    aider: '🛠',
	    kilo: '⚡️',
	    qwen: '🐉',
	    pi: 'π',
	    openhands: '🤲',
	    amp: '⚡',
	    zcode: '🧊',
	  }
	  return emojis[toolMode] || '🧰'
}

/**
 * 📖 Load backups from ~/.free-coding-models-backups.json
 */
function loadBackups() {
  if (!existsSync(BACKUP_PATH)) {
    return { disabledModels: [] }
  }
  try {
    const content = readFileSync(BACKUP_PATH, 'utf8')
    return JSON.parse(content)
  } catch (err) {
    return { disabledModels: [] }
  }
}

/**
 * 📖 Save backups to ~/.free-coding-models-backups.json
 * 📖 Written 0600 (snapshots may contain tool config content) with a chmod after
 * 📖 write so pre-existing wide-permission files get tightened too.
 */
function saveBackups(backups) {
  const dir = dirname(BACKUP_PATH)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(BACKUP_PATH, JSON.stringify(backups, null, 2), { mode: 0o600 })
  chmodSync(BACKUP_PATH, 0o600)
}

// 📖 Backups keep a copy of the original tool config so deletions can be
// 📖 inspected later. Key-like fields are stripped recursively (and by line for
// 📖 non-JSON configs) so plaintext API keys never land in the backups file.
const BACKUP_SENSITIVE_KEYS = new Set(['api_key', 'apiKey', 'keys', 'token'])

function stripSensitiveFields(value) {
  if (Array.isArray(value)) return value.map(stripSensitiveFields)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, val] of Object.entries(value)) {
      if (BACKUP_SENSITIVE_KEYS.has(key)) continue
      out[key] = stripSensitiveFields(val)
    }
    return out
  }
  return value
}

function sanitizeBackupConfig(content) {
  try {
    return JSON.stringify(stripSensitiveFields(JSON.parse(content)), null, 2)
  } catch {
    // 📖 Non-JSON config (goose/aider YAML etc.): drop whole key-bearing lines.
    return content
      .split('\n')
      .filter((line) => !/^(#|\s)*(export\s+)?[\w-]*(api[_-]?key|token|keys)[\w-]*\s*[:=]/i.test(line))
      .join('\n')
  }
}

/**
 * 📖 Soft-delete a model from tool config with backup
 */
export function softDeleteModel(toolMode, modelId, paths = getToolConfigPaths()) {
	  const pathKey = toolMode === 'pi' ? 'piSettings'
	    : toolMode === 'zcode' ? 'zcodeConfig'
	    : toolMode
	  const configPath = paths[pathKey]
  if (!existsSync(configPath)) {
    return { success: false, error: 'Config file not found' }
  }

  try {
    let originalContent = readFileSync(configPath, 'utf8')
    let newContent = originalContent
    let modified = false

    switch (toolMode) {
      case 'goose':
        if (originalContent.includes(`GOOSE_MODEL: ${modelId}`)) {
          newContent = originalContent.replace(/^GOOSE_MODEL:.*$/m, '# GOOSE_MODEL: (disabled by FCM)\n# GOOSE_MODEL: ' + modelId)
          modified = true
        }
        break

      case 'crush':
        const crushConfig = JSON.parse(originalContent)
        if (crushConfig.models?.large?.model === modelId || crushConfig.models?.small?.model === modelId) {
          if (crushConfig.models?.large?.model === modelId) {
            delete crushConfig.models.large
          }
          if (crushConfig.models?.small?.model === modelId) {
            delete crushConfig.models.small
          }
          newContent = JSON.stringify(crushConfig, null, 2)
          modified = true
        }
        break

      case 'aider':
        if (originalContent.includes(`model: openai/${modelId}`)) {
          newContent = originalContent.replace(/^model:.*$/m, '# model: (disabled by FCM)\n# model: openai/' + modelId)
          modified = true
        }
        break

      case 'kilo':
        const kiloConfig = JSON.parse(originalContent)
        if (kiloConfig.model === modelId) {
          delete kiloConfig.model
          newContent = JSON.stringify(kiloConfig, null, 2)
          modified = true
        }
        break

      case 'qwen':
        const qwenConfig = JSON.parse(originalContent)
        if (qwenConfig.model === modelId) {
          delete qwenConfig.model
          newContent = JSON.stringify(qwenConfig, null, 2)
          modified = true
        }
        break

      case 'pi':
        const piConfig = JSON.parse(originalContent)
        if (piConfig.defaultModel === modelId) {
          delete piConfig.defaultModel
          newContent = JSON.stringify(piConfig, null, 2)
          modified = true
        }
        break

      case 'openhands':
        if (originalContent.includes(`export LLM_MODEL="${modelId}"`) || originalContent.includes(`export LLM_MODEL='${modelId}'`)) {
          newContent = originalContent.replace(/^export LLM_MODEL=.*$/m, '# export LLM_MODEL: (disabled by FCM)\n# export LLM_MODEL="' + modelId + '"')
          modified = true
        }
        break

	      case 'zcode': {
	        const zconfig = JSON.parse(originalContent)
	        // 📖 Find the provider entry that contains this modelId
	        let foundProviderId = null
	        if (zconfig.provider && typeof zconfig.provider === 'object') {
	          for (const [provId, prov] of Object.entries(zconfig.provider)) {
	            if (prov.models && typeof prov.models === 'object' && modelId in prov.models) {
	              foundProviderId = provId
	              break
	            }
	          }
	        }
	        if (foundProviderId) {
	          delete zconfig.provider[foundProviderId].models[modelId]
	          // 📖 If no models left, keep the empty provider (don't remove it — user may want to re-add)
	          newContent = JSON.stringify(zconfig, null, 2)
	          modified = true

	          // 📖 Also remove from cache file if it exists
	          const cachePath = paths.zcodeCache
	          if (existsSync(cachePath)) {
	            try {
	              const cacheContent = readFileSync(cachePath, 'utf8')
	              const cache = JSON.parse(cacheContent)
	              if (Array.isArray(cache.providers)) {
	                const cacheProv = cache.providers.find((p) => p.id === foundProviderId)
	                if (cacheProv && Array.isArray(cacheProv.models)) {
	                  const before = cacheProv.models.length
	                  cacheProv.models = cacheProv.models.filter((m) => m.id !== modelId)
	                  if (cacheProv.models.length !== before) {
	                    cacheProv.updatedAt = Date.now()
	                    writeFileSync(cachePath, JSON.stringify(cache, null, 2))
	                  }
	                }
	              }
	            } catch {
	              // 📖 Cache file is optional
	            }
	          }
	        }
	        break
	      }

	      case 'amp':
	        const ampConfig = JSON.parse(originalContent)
	        if (ampConfig['amp.model'] === modelId) {
	          delete ampConfig['amp.model']
	          newContent = JSON.stringify(ampConfig, null, 2)
	          modified = true
	        }
	        break
	    }

    if (!modified) {
      return { success: false, error: 'Model not found in config' }
    }

    writeFileSync(configPath, newContent)

    const backups = loadBackups()
    backups.disabledModels.push({
      id: `${toolMode}-${modelId}-${new Date().toISOString()}`,
      toolMode,
      modelId,
      originalConfig: sanitizeBackupConfig(originalContent),
      configPath,
      disabledAt: new Date().toISOString(),
      reason: 'user_deleted',
    })
    // 📖 Keep the backup list bounded: only the 20 most recent deletions survive.
    if (backups.disabledModels.length > 20) {
      backups.disabledModels = backups.disabledModels.slice(-20)
    }
    saveBackups(backups)

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

/**
 * @file src/legacy-proxy-cleanup.js
 * @description Best-effort cleanup for discontinued proxy-era config leftovers.
 *
 * @details
 *   📖 The old global proxy/daemon stack has been removed from the product, but
 *   📖 some users may still have persisted `fcm-proxy` entries, env files, or
 *   📖 runtime artifacts from earlier versions.
 *
 *   📖 This module removes only the legacy proxy markers that are now obsolete:
 *   - `fcm-proxy` providers inside tool configs
 *   - proxy-only env files for removed tools
 *   - daemon/log artifacts from the old bridge
 *   - stale proxy fields in `~/.free-coding-models.json`
 *
 *   📖 It intentionally preserves current direct-provider installs such as
 *   📖 `fcm-nvidia`, `fcm-groq`, or the current OpenHands env file when it is
 *   📖 clearly configured for direct provider usage instead of the removed proxy.
 *
 * @functions
 *   → `cleanupLegacyProxyArtifacts` — remove discontinued proxy-era config files and entries
 *
 * @exports cleanupLegacyProxyArtifacts
 */

import { chmodSync, existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LEGACY_TOOL_MODES = new Set(['claude-code', 'codex'])
const LEGACY_RUNTIME_FILES = ['daemon.json', 'daemon-stdout.log', 'daemon-stderr.log', 'request-log.jsonl']
const LEGACY_ENV_FILES = ['.fcm-claude-code-env', '.fcm-codex-env']

function getDefaultPaths(homeDir) {
  return {
    configPath: join(homeDir, '.free-coding-models.json'),
    dataDir: join(homeDir, '.free-coding-models'),
    opencodeConfigPath: join(homeDir, '.config', 'opencode', 'opencode.json'),
    openclawConfigPath: join(homeDir, '.openclaw', 'openclaw.json'),
    crushConfigPath: join(homeDir, '.config', 'crush', 'crush.json'),
    gooseProvidersDir: join(homeDir, '.config', 'goose', 'custom_providers'),
    gooseSecretsPath: join(homeDir, '.config', 'goose', 'secrets.yaml'),
    gooseConfigPath: join(homeDir, '.config', 'goose', 'config.yaml'),
    piModelsPath: join(homeDir, '.pi', 'agent', 'models.json'),
    piSettingsPath: join(homeDir, '.pi', 'agent', 'settings.json'),
    aiderConfigPath: join(homeDir, '.aider.conf.yml'),
    ampConfigPath: join(homeDir, '.config', 'amp', 'settings.json'),
    qwenConfigPath: join(homeDir, '.qwen', 'settings.json'),
    launchAgentPath: join(homeDir, 'Library', 'LaunchAgents', 'com.fcm.proxy.plist'),
    systemdServicePath: join(homeDir, '.config', 'systemd', 'user', 'fcm-proxy.service'),
    shellProfilePaths: [
      join(homeDir, '.zshrc'),
      join(homeDir, '.bashrc'),
      join(homeDir, '.bash_profile'),
    ],
  }
}

function createSummary() {
  return {
    changed: false,
    removedFiles: [],
    updatedFiles: [],
    removedEntries: 0,
    errors: [],
  }
}

function noteRemovedFile(summary, filePath) {
  summary.changed = true
  summary.removedFiles.push(filePath)
}

function noteUpdatedFile(summary, filePath, removedEntries = 1) {
  summary.changed = true
  summary.updatedFiles.push(filePath)
  summary.removedEntries += removedEntries
}

function noteError(summary, filePath, error) {
  summary.errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`)
}

// 📖 Thin wrappers: readJsonFile propagates parse errors (callers have try/catch).
// 📖 writeJsonFile appends a trailing newline for clean diffs. These configs can
// 📖 carry plaintext API keys, so tighten permissions after every write (chmod
// 📖 also fixes pre-existing files that were created wide-permission).
function readJsonFile(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function writeJsonFile(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
  chmodSync(filePath, 0o600)
}

function deleteFileIfExists(filePath, summary) {
  if (!existsSync(filePath)) return false
  try {
    unlinkSync(filePath)
    noteRemovedFile(summary, filePath)
    return true
  } catch (error) {
    noteError(summary, filePath, error)
    return false
  }
}

function updateJsonFile(filePath, mutate, summary) {
  if (!existsSync(filePath)) return
  try {
    const data = readJsonFile(filePath, {})
    const removedEntries = mutate(data)
    if (removedEntries > 0) {
      writeJsonFile(filePath, data)
      noteUpdatedFile(summary, filePath, removedEntries)
    }
  } catch (error) {
    noteError(summary, filePath, error)
  }
}

function cleanupMainConfig(filePath, summary) {
  if (!existsSync(filePath)) return
  try {
    const config = readJsonFile(filePath, {})
    let removedEntries = 0

    if (config.settings && typeof config.settings === 'object' && 'proxy' in config.settings) {
      delete config.settings.proxy
      removedEntries += 1
    }

    if ('proxySettings' in config) {
      delete config.proxySettings
      removedEntries += 1
    }

    if (Array.isArray(config.endpointInstalls)) {
      const before = config.endpointInstalls.length
      config.endpointInstalls = config.endpointInstalls.filter(
        (entry) => !LEGACY_TOOL_MODES.has(entry?.toolMode)
      )
      removedEntries += before - config.endpointInstalls.length
    }

    if (config.settings?.preferredToolMode && LEGACY_TOOL_MODES.has(config.settings.preferredToolMode)) {
      config.settings.preferredToolMode = 'opencode'
      removedEntries += 1
    }

    if (removedEntries > 0) {
      writeJsonFile(filePath, config)
      noteUpdatedFile(summary, filePath, removedEntries)
    }
  } catch (error) {
    noteError(summary, filePath, error)
  }
}

function cleanupRuntimeFiles(dataDir, summary) {
  for (const fileName of LEGACY_RUNTIME_FILES) {
    deleteFileIfExists(join(dataDir, fileName), summary)
  }
}

function cleanupLegacyEnvFiles(homeDir, summary) {
  for (const fileName of LEGACY_ENV_FILES) {
    deleteFileIfExists(join(homeDir, fileName), summary)
    deleteFileIfExists(join(homeDir, `${fileName}.bak`), summary)
  }
}

function cleanupShellProfiles(profilePaths, summary) {
  const patterns = [
    /# 📖 FCM Proxy — Claude Code env vars/,
    /\.fcm-claude-code-env/,
  ]

  for (const profilePath of profilePaths) {
    if (!existsSync(profilePath)) continue
    try {
      const raw = readFileSync(profilePath, 'utf8')
      const lines = raw.split(/\r?\n/)
      const filtered = lines.filter((line) => !patterns.some((pattern) => pattern.test(line)))
      if (filtered.join('\n') !== lines.join('\n')) {
        writeFileSync(profilePath, filtered.join('\n'))
        noteUpdatedFile(summary, profilePath, 1)
      }
    } catch (error) {
      noteError(summary, profilePath, error)
    }
  }
}

function cleanupOpenCode(filePath, summary) {
  updateJsonFile(filePath, (config) => {
    let removedEntries = 0
    if (config.provider?.['fcm-proxy']) {
      delete config.provider['fcm-proxy']
      removedEntries += 1
      if (Object.keys(config.provider).length === 0) delete config.provider
    }
    if (typeof config.model === 'string' && config.model.startsWith('fcm-proxy/')) {
      delete config.model
      removedEntries += 1
    }
    return removedEntries
  }, summary)
}

function cleanupOpenClaw(filePath, summary) {
  updateJsonFile(filePath, (config) => {
    let removedEntries = 0
    if (config.models?.providers?.['fcm-proxy']) {
      delete config.models.providers['fcm-proxy']
      removedEntries += 1
    }
    if (config.agents?.defaults?.models && typeof config.agents.defaults.models === 'object') {
      for (const key of Object.keys(config.agents.defaults.models)) {
        if (key.startsWith('fcm-proxy/')) {
          delete config.agents.defaults.models[key]
          removedEntries += 1
        }
      }
    }
    return removedEntries
  }, summary)
}

function cleanupCrush(filePath, summary) {
  updateJsonFile(filePath, (config) => {
    let removedEntries = 0
    if (config.providers?.['fcm-proxy']) {
      delete config.providers['fcm-proxy']
      removedEntries += 1
    }
    if (config.models?.large?.provider === 'fcm-proxy') {
      delete config.models.large
      removedEntries += 1
    }
    if (config.models?.small?.provider === 'fcm-proxy') {
      delete config.models.small
      removedEntries += 1
    }
    return removedEntries
  }, summary)
}

function readSimpleYamlMap(filePath) {
  if (!existsSync(filePath)) return {}
  const output = {}
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (!match) continue
    output[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return output
}

function writeSimpleYamlMap(filePath, entries) {
  const lines = Object.keys(entries)
    .sort()
    .map((key) => `${key}: ${JSON.stringify(String(entries[key] ?? ''))}`)
  writeFileSync(filePath, lines.join('\n') + '\n', { mode: 0o600 })
  chmodSync(filePath, 0o600)
}

function cleanupGoose(paths, summary) {
  deleteFileIfExists(join(paths.gooseProvidersDir, 'fcm-proxy.json'), summary)

  if (existsSync(paths.gooseSecretsPath)) {
    try {
      const secrets = readSimpleYamlMap(paths.gooseSecretsPath)
      if ('FCM_PROXY_API_KEY' in secrets) {
        delete secrets.FCM_PROXY_API_KEY
        writeSimpleYamlMap(paths.gooseSecretsPath, secrets)
        noteUpdatedFile(summary, paths.gooseSecretsPath, 1)
      }
    } catch (error) {
      noteError(summary, paths.gooseSecretsPath, error)
    }
  }

  if (existsSync(paths.gooseConfigPath)) {
    try {
      const lines = readFileSync(paths.gooseConfigPath, 'utf8').split(/\r?\n/)
      const hadLegacyProvider = lines.some((line) => /^GOOSE_PROVIDER:\s*fcm-proxy\s*$/.test(line))
      if (hadLegacyProvider) {
        const filtered = lines.filter((line) => {
          if (/^GOOSE_PROVIDER:\s*fcm-proxy\s*$/.test(line)) return false
          if (/^GOOSE_MODEL:\s*/.test(line)) return false
          return true
        })
        writeFileSync(paths.gooseConfigPath, filtered.join('\n'))
        noteUpdatedFile(summary, paths.gooseConfigPath, 2)
      }
    } catch (error) {
      noteError(summary, paths.gooseConfigPath, error)
    }
  }
}

function cleanupPi(paths, summary) {
  updateJsonFile(paths.piModelsPath, (config) => {
    let removedEntries = 0
    if (config.providers?.['fcm-proxy']) {
      delete config.providers['fcm-proxy']
      removedEntries += 1
    }
    return removedEntries
  }, summary)

  updateJsonFile(paths.piSettingsPath, (config) => {
    let removedEntries = 0
    if (config.defaultProvider === 'fcm-proxy') {
      delete config.defaultProvider
      removedEntries += 1
    }
    if (typeof config.defaultModel === 'string' && config.defaultModel.startsWith('fcm-proxy/')) {
      delete config.defaultModel
      removedEntries += 1
    }
    return removedEntries
  }, summary)
}

function cleanupAider(filePath, summary) {
  if (!existsSync(filePath)) return
  try {
    const content = readFileSync(filePath, 'utf8')
    // 📖 Only treat the file as proxy-era when BOTH signals hold: the FCM proxy
    // 📖 banner we used to write AND a loopback openai-api-base. Matching on the
    // 📖 loopback base alone deleted unrelated local setups (e.g. ollama) wholesale.
    const isLegacyProxyConfig = content.includes('FCM Proxy V2')
      && /openai-api-base:\s*http:\/\/127\.0\.0\.1:/i.test(content)
    if (isLegacyProxyConfig) {
      // 📖 Back up before any unlink: the file may contain user edits we cannot
      // 📖 reconstruct.
      const backupPath = `${filePath}.backup-${Date.now()}`
      try { writeFileSync(backupPath, content, { mode: 0o600 }) } catch { /* best-effort */ }
      unlinkSync(filePath)
      noteRemovedFile(summary, filePath)
    }
  } catch (error) {
    noteError(summary, filePath, error)
  }
}

function cleanupAmp(filePath, summary) {
  updateJsonFile(filePath, (config) => {
    let removedEntries = 0
    // 📖 The old proxy wrote its identity into the URL. Only loopback URLs that
    // 📖 are actually FCM proxy artifacts (banner value in the URL) are removed;
    // 📖 a user's own localhost amp.url (ollama, llama.cpp, ...) stays untouched.
    const usesLegacyLocalhost = typeof config['amp.url'] === 'string'
      && /127\.0\.0\.1|localhost/.test(config['amp.url'])
      && /fcm|free-coding-models/i.test(config['amp.url'])
    if (usesLegacyLocalhost) {
      delete config['amp.url']
      removedEntries += 1
      if (typeof config['amp.model'] === 'string') {
        delete config['amp.model']
        removedEntries += 1
      }
    }
    return removedEntries
  }, summary)
}

function cleanupQwen(filePath, summary) {
  updateJsonFile(filePath, (config) => {
    let removedEntries = 0
    const removedIds = new Set()
    if (Array.isArray(config.modelProviders?.openai)) {
      const next = []
      for (const entry of config.modelProviders.openai) {
        const isLegacyEntry = entry?.envKey === 'FCM_PROXY_API_KEY'
          || (typeof entry?.baseUrl === 'string' && /127\.0\.0\.1|localhost/.test(entry.baseUrl))
          || (typeof entry?.id === 'string' && entry.id.startsWith('fcm-proxy/'))
        if (isLegacyEntry) {
          if (typeof entry?.id === 'string') removedIds.add(entry.id)
          removedEntries += 1
          continue
        }
        next.push(entry)
      }
      config.modelProviders.openai = next
    }
    if (typeof config.model === 'string' && (config.model.startsWith('fcm-proxy/') || removedIds.has(config.model))) {
      delete config.model
      removedEntries += 1
    }
    return removedEntries
  }, summary)
}

function cleanupOpenHandsEnv(homeDir, summary) {
  const filePath = join(homeDir, '.fcm-openhands-env')
  if (!existsSync(filePath)) return
  try {
    const content = readFileSync(filePath, 'utf8')
    const isLegacyProxyEnv = content.includes('FCM Proxy V2') || /127\.0\.0\.1|localhost/.test(content)
    if (isLegacyProxyEnv) {
      unlinkSync(filePath)
      noteRemovedFile(summary, filePath)
    }
  } catch (error) {
    noteError(summary, filePath, error)
  }
}

/**
 * 📖 cleanupLegacyProxyArtifacts removes stale proxy-era artifacts from older
 * 📖 releases. It is safe to run multiple times.
 *
 * @param {{
 *   homeDir?: string,
 *   paths?: Partial<ReturnType<typeof getDefaultPaths>>
 * }} [options]
 * @returns {{ changed: boolean, removedFiles: string[], updatedFiles: string[], removedEntries: number, errors: string[] }}
 */
export function cleanupLegacyProxyArtifacts(options = {}) {
  const homeDir = options.homeDir || homedir()
  const paths = {
    ...getDefaultPaths(homeDir),
    ...(options.paths || {}),
  }
  const summary = createSummary()

  cleanupMainConfig(paths.configPath, summary)
  cleanupRuntimeFiles(paths.dataDir, summary)
  cleanupLegacyEnvFiles(homeDir, summary)
  cleanupShellProfiles(paths.shellProfilePaths || [], summary)
  cleanupOpenCode(paths.opencodeConfigPath, summary)
  cleanupOpenClaw(paths.openclawConfigPath, summary)
  cleanupCrush(paths.crushConfigPath, summary)
  cleanupGoose(paths, summary)
  cleanupPi(paths, summary)
  cleanupAider(paths.aiderConfigPath, summary)
  cleanupAmp(paths.ampConfigPath, summary)
  cleanupQwen(paths.qwenConfigPath, summary)
  cleanupOpenHandsEnv(homeDir, summary)
  deleteFileIfExists(paths.launchAgentPath, summary)
  deleteFileIfExists(paths.systemdServicePath, summary)

  return summary
}

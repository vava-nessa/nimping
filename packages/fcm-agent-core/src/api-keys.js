/**
 * @file api-keys.js
 * @description API key loader and resolver shared by all FCM agent adapters.
 *
 * @details
 *   Resolves the effective API key for a provider from two sources, in priority
 *   order: the matching process.env variable first, then the
 *   `~/.free-coding-models.json` config file written by the FCM TUI/CLI.
 *   This module is deliberately free of any host-agent (Pi/OpenCode) concerns
 *   so both adapters share identical key resolution.
 *
 * @functions
 *   - getKeyForProvider → Resolve one provider's API key (env wins over config)
 *   - loadAllApiKeys → Build a providerKey → apiKey map for the whole catalog
 */

// 📖 Relative imports into the repo root (see direct-scanner.js): the package
// 📖 is only consumed in-repo via file: dependency, never from npm.
import { loadConfig, getApiKey } from '../../../src/core/config.js'
import { ENV_VAR_NAMES } from '../../../src/core/provider-metadata.js'
import { sources } from '../../../sources.js'

/**
 * 📖 Resolve the effective API key for a given provider key.
 * 📖 Env overrides take precedence over the ~/.free-coding-models.json config file.
 *
 * @param {string} providerKey - Key of the provider (e.g., 'groq', 'nvidia')
 * @returns {string|null} The resolved API key, or null if none found
 */
export function getKeyForProvider(providerKey) {
  // 📖 Check environment variables first
  const envVarName = ENV_VAR_NAMES[providerKey]
  if (envVarName && process.env[envVarName]) {
    const key = process.env[envVarName].trim()
    if (key) return key
  }

  // 📖 Fall back to configuration file
  try {
    const config = loadConfig()
    if (config) {
      const key = getApiKey(config, providerKey)
      if (key) return key
    }
  } catch (err) {
    // 📖 Silently catch load errors to avoid disrupting session startup
  }

  return null
}

/**
 * 📖 Load all available API keys across all cataloged providers.
 *
 * @returns {Map<string, string>} A map of providerKey -> apiKey
 */
export function loadAllApiKeys() {
  const keyMap = new Map()

  for (const providerKey of Object.keys(sources)) {
    const key = getKeyForProvider(providerKey)
    if (key) {
      keyMap.set(providerKey, key)
    }
  }

  return keyMap
}

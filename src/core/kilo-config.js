/**
 * @file src/kilo-config.js
 * @description Small filesystem helpers for the shared Kilo config file (OpenCode fork).
 *
 * @details
 *   📖 Kilo is a fork of OpenCode and uses the same config structure,
 *   📖 but stored in a different directory: ~/.config/kilo/opencode.json
 *
 *   📖 Data-loss guard (mirrors opencode-config.js): an existing config that
 *   📖 fails to parse returns null from `loadKiloConfig`, and `saveKiloConfig`
 *   📖 refuses to write over an unreadable file instead of replacing the
 *   📖 user's config with an empty base.
 *
 * @functions
 *   → `loadKiloConfig` - read `~/.config/kilo/opencode.json` safely (null when unreadable)
 *   → `saveKiloConfig` - write `opencode.json` atomically with a simple backup
 *
 * @exports loadKiloConfig, saveKiloConfig
 */

import { readFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWriteJson } from './shared-helpers.js'

const KILO_CONFIG_DIR = join(homedir(), '.config', 'kilo')
const KILO_CONFIG_PATH = join(KILO_CONFIG_DIR, 'opencode.json')
const KILO_BACKUP_PATH = join(KILO_CONFIG_DIR, 'opencode.json.bak')

const UNREADABLE_CONFIG_HINT = `  ⚠ ${KILO_CONFIG_PATH} contains invalid JSON and was NOT modified. Fix or remove the file, then retry.`

/**
 * 📖 True when the file exists, is non-empty, and does not parse as JSON.
 */
function isExistingFileUnreadable(configPath) {
  if (!existsSync(configPath)) return false
  try {
    const raw = readFileSync(configPath, 'utf8')
    if (!raw.trim()) return false
    JSON.parse(raw)
    return false
  } catch {
    return true
  }
}

export function loadKiloConfig() {
  try {
    if (existsSync(KILO_CONFIG_PATH)) {
      const raw = readFileSync(KILO_CONFIG_PATH, 'utf8')
      if (!raw.trim()) return {}
      try {
        return JSON.parse(raw)
      } catch {
        // 📖 Existing non-empty file with broken JSON: signal "unreadable" so
        // 📖 callers never build a save on an empty base and wipe the file.
        return null
      }
    }
  } catch {}
  return {}
}

/**
 * 📖 Save kilo opencode.json atomically (tmp + rename) with a one-shot backup.
 * 📖 Returns false and aborts instead of overwriting an unreadable file.
 * @param {object|null} config
 * @returns {boolean} true when written
 */
export function saveKiloConfig(config) {
  if (config === null || config === undefined) {
    console.error(UNREADABLE_CONFIG_HINT)
    return false
  }
  if (isExistingFileUnreadable(KILO_CONFIG_PATH)) {
    console.error(UNREADABLE_CONFIG_HINT)
    return false
  }
  mkdirSync(KILO_CONFIG_DIR, { recursive: true })
  if (existsSync(KILO_CONFIG_PATH)) {
    copyFileSync(KILO_CONFIG_PATH, KILO_BACKUP_PATH)
  }
  atomicWriteJson(KILO_CONFIG_PATH, config, 0o600)
  return true
}

export function getKiloConfigPath() {
  return KILO_CONFIG_PATH
}

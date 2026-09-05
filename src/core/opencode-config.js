/**
 * @file src/opencode-config.js
 * @description Small filesystem helpers for the shared OpenCode config file.
 *
 * @details
 *   📖 The app still needs a stable way to read and write `opencode.json`
 *   📖 for direct OpenCode CLI and Desktop launches.
 *   📖 This module deliberately stays tiny so OpenCode launch code is not
 *   📖 coupled to old bridge-specific sync behavior anymore.
 *
 *   📖 Data-loss guard: an existing opencode.json that fails to parse returns
 *   📖 null from `loadOpenCodeConfig`, and `saveOpenCodeConfig` refuses to write
 *   📖 over an unreadable file. Saving from the empty `{}` base would otherwise
 *   📖 silently replace the user's whole config with a near-empty one.
 *
 * @functions
 *   → `loadOpenCodeConfig` - read `~/.config/opencode/opencode.json` safely (null when unreadable)
 *   → `saveOpenCodeConfig` - write `opencode.json` atomically with a simple backup
 *   → `restoreOpenCodeBackup` — restore the last `.bak` copy if needed
 *
 * @exports loadOpenCodeConfig, saveOpenCodeConfig, restoreOpenCodeBackup
 */

import { readFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWriteJson } from './shared-helpers.js'

const OPENCODE_CONFIG_DIR = join(homedir(), '.config', 'opencode')
const OPENCODE_CONFIG_PATH = join(OPENCODE_CONFIG_DIR, 'opencode.json')
const OPENCODE_BACKUP_PATH = join(OPENCODE_CONFIG_DIR, 'opencode.json.bak')

const UNREADABLE_CONFIG_HINT = `  ⚠ ${OPENCODE_CONFIG_PATH} contains invalid JSON and was NOT modified. Fix or remove the file, then retry.`

/**
 * 📖 True when the file exists, is non-empty, and does not parse as JSON.
 * 📖 Missing and empty files are considered readable (nothing to lose).
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

export function loadOpenCodeConfig() {
  try {
    if (existsSync(OPENCODE_CONFIG_PATH)) {
      const raw = readFileSync(OPENCODE_CONFIG_PATH, 'utf8')
      // 📖 Missing file and empty file behave as before: fresh empty base.
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
 * 📖 Save opencode.json atomically (tmp + rename) with a one-shot backup.
 * 📖 Returns false and aborts (with a clear message) instead of overwriting
 * 📖 when the config is null or the on-disk file is unreadable.
 * @param {object|null} config
 * @returns {boolean} true when written
 */
export function saveOpenCodeConfig(config) {
  if (config === null || config === undefined) {
    console.error(UNREADABLE_CONFIG_HINT)
    return false
  }
  // 📖 Belt-and-suspenders for callers that normalized null to {}: never let a
  // 📖 stale in-memory copy clobber a file we cannot read.
  if (isExistingFileUnreadable(OPENCODE_CONFIG_PATH)) {
    console.error(UNREADABLE_CONFIG_HINT)
    return false
  }
  mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true })
  if (existsSync(OPENCODE_CONFIG_PATH)) {
    copyFileSync(OPENCODE_CONFIG_PATH, OPENCODE_BACKUP_PATH)
  }
  // 📖 Atomic write: a crash mid-write must never truncate the shared config.
  atomicWriteJson(OPENCODE_CONFIG_PATH, config, 0o600)
  return true
}

export function restoreOpenCodeBackup() {
  if (!existsSync(OPENCODE_BACKUP_PATH)) return false
  copyFileSync(OPENCODE_BACKUP_PATH, OPENCODE_CONFIG_PATH)
  return true
}

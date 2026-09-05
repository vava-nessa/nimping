/**
 * @file shared-helpers.js
 * @description Shared utility functions used across multiple modules.
 *
 * @details
 *   📖 DRY helpers extracted from router-daemon.js, tool-launchers.js,
 *   📖 endpoint-installer.js, and legacy-proxy-cleanup.js to eliminate
 *   duplicate implementations of the same patterns.
 *
 * @functions
 *   → sleep — Promise-based setTimeout
 *   → ensureDir — Create parent directory if missing
 *   → readJson — Read and parse JSON file with fallback
 *   → writeJson — Write JSON file with directory creation
 *   → atomicWriteJson — Atomic write via temp file + rename
 *   → safeJsonParse — JSON.parse with fallback
 *   → maskApiKey — Mask API key for display (show last 4 chars)
 *
 * @exports sleep, ensureDir, readJson, writeJson, atomicWriteJson, safeJsonParse, shellSingleQuote, maskApiKey
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 📖 Promise-based sleep. Used by daemon probe staggering, TUI animations, etc.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 📖 Create parent directory of `filePath` if it doesn't exist.
 * @param {string} filePath
 */
export function ensureDir(filePath) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/**
 * 📖 Read and parse a JSON file. Returns `fallback` on any error.
 * @param {string} filePath
 * @param {*} [fallback=null]
 * @returns {*}
 */
export function readJson(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 📖 Write JSON to file, creating parent directories as needed.
 * @param {string} filePath
 * @param {*} value
 * @param {object} [options]
 * @param {boolean} [options.backup=false] — Not implemented here; callers handle it
 */
export function writeJson(filePath, value) {
  ensureDir(filePath)
  writeFileSync(filePath, JSON.stringify(value, null, 2))
}

/**
 * 📖 Atomic JSON write: writes to a temp file, then renames over the target.
 * Prevents partial writes from corrupting the file on crash.
 * @param {string} path
 * @param {*} data
 * @param {number} [mode=0o600]
 */
export function atomicWriteJson(path, data, mode = 0o600) {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode })
  renameSync(tempPath, path)
}

/**
 * 📖 JSON.parse with fallback. Returns `fallback` on parse failure.
 * @param {string} raw
 * @param {*} [fallback=null]
 * @returns {*}
 */
export function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * 📖 Single-quote shell escaping for values interpolated into sourced env files.
 * 📖 Wraps the value in single quotes and escapes embedded single quotes the
 * 📖 POSIX way (`'` -> `'\''`) so quotes, `$`, and backticks stay literal.
 * @param {string} value
 * @returns {string}
 */
export function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * 📖 Mask an API key for display. Shows last 4 chars, rest as bullets.
 * @param {string} key
 * @returns {string}
 */
/**
 * 📖 Check if a provider supports routing (has chat/completions URL, not CLI-only).
 * @param {string} providerKey
 * @param {Record<string, {url?: string, cliOnly?: boolean}>} sources — provider catalog
 * @returns {boolean}
 */
export function isRouteableProvider(providerKey, sources) {
  const source = sources[providerKey]
  return Boolean(source?.url && !source.cliOnly && source.url.includes('/chat/completions'))
}

export function maskApiKey(key) {
  if (!key || typeof key !== 'string') return ''
  if (key.length <= 8) return '••••••••'
  return '••••••••' + key.slice(-4)
}

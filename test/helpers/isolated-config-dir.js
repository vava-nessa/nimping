/**
 * @file test/helpers/isolated-config-dir.js
 * @description Test bootstrap: point FCM_CONFIG_DIR at a throwaway temp dir so
 * config.js (CONFIG_PATH, loadConfig, saveConfig) never touches the real
 * ~/.free-coding-models.json during tests that need config isolation.
 *
 * MUST be the first import of a test file: ESM evaluates imported modules in
 * declaration order, and src/core/config.js resolves CONFIG_PATH once at module
 * load. Setting the env var here guarantees it is in place before that happens.
 *
 * The directory is removed on process exit. One temp dir per test-file process
 * (node --test runs every file in its own process), so files cannot interfere.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'fcm-qpcfg-'))
process.env.FCM_CONFIG_DIR = dir

process.on('exit', () => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
})

export const isolatedConfigDir = dir

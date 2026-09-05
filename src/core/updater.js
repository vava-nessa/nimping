/**
 * @file updater.js
 * @description Update detection and installation helpers, extracted from bin/free-coding-models.js.
 *
 * @details
 *   This module handles all npm version-check and auto-update logic:
 *
 *   - `checkForUpdateDetailed()` — hits the npm registry to compare the published version
 *     against the locally installed one.  Returns `{ latestVersion, error }` so callers
 *     can surface meaningful status text in the Settings overlay.
 *
 *   - `checkForUpdate()` — thin backward-compatible wrapper used at startup for the
 *     auto-update guard.  Returns `latestVersion` (string) or `null`.
 *
 *   - `runUpdate(latestVersion)` — detects the active package manager (npm/bun/pnpm/yarn),
 *     runs the correct global install command, retrying with `sudo` on EACCES/EPERM.
 *     On success, relaunches the process with the same argv.  On failure, prints manual
 *     instructions (using the correct PM command) and exits with code 1.
 *
 *   ⚙️ Notes:
 *   - `LOCAL_VERSION` is resolved from package.json via `createRequire` so this module
 *     can be imported independently from the bin entry point.
 *   - The auto-update flow in `main()` skips update if `isDevMode` is detected (presence of
 *     a `.git` directory next to the package root) to avoid an infinite update loop in dev.
 *   - `detectPackageManager()` checks the install path, script path, and runtime binary
 *     to determine which package manager (npm/bun/pnpm/yarn) owns the installation.
 *     All install commands, permission probes, and error messages use the detected PM.
 *
 * @functions
 *   → detectPackageManager()             — Detect which PM owns the current installation
 *   → resolveCurrentNpmInstallTarget()   — Detect the npm prefix that owns the active package
 *   → getInstallArgs(pm, version)        — Build correct { bin, args } per package manager
 *   → getManualInstallCmd(pm, version)   — Human-readable install command string for error messages
 *   → isNewerVersion(remote, local)      - Semver compare: true only when remote is greater
 *   → checkForUpdateDetailed()           — Fetch npm latest with explicit error info
 *   → checkForUpdate()                   — Startup wrapper, returns version string or null
 *   → isPackageDevMode()                 — Detect git/dev checkouts that must not self-update
 *   → enforceMandatoryStartupUpdate()    — Mandatory startup self-update with two-failure fallback
 *   → runUpdate(latestVersion)           — Install new version via detected PM + relaunch
 * @exports
 *   detectPackageManager, resolveCurrentNpmInstallTarget, getInstallArgs, getManualInstallCmd,
 *   isNewerVersion, checkForUpdateDetailed, checkForUpdate, isPackageDevMode,
 *   enforceMandatoryStartupUpdate, runUpdate, fetchLastReleaseDate
 *
 * @see bin/free-coding-models.js — calls checkForUpdate() at startup and runUpdate() on confirm
 */

import chalk from 'chalk'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { accessSync, constants, existsSync, readFileSync } from 'fs'

const require = createRequire(import.meta.url)
const readline = require('readline')
const pkg = require('../../package.json')
const LOCAL_VERSION = pkg.version
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACKAGE_NAME = 'free-coding-models'
export const UPDATE_FAILURE_THRESHOLD = 2

/**
 * 📖 resolveCurrentNpmInstallTarget: detect the npm prefix that owns this exact
 * 📖 running package, not just the first `npm` found in PATH. Users can run FCM
 * 📖 from one global install while another Node manager shadows `npm`; updating
 * 📖 the shadow prefix leaves the active binary stale and creates an update loop.
 * @param {string} [packageRoot]
 * @returns {{ packageRoot: string, prefix: string, bin: string } | null}
 */
export function resolveCurrentNpmInstallTarget(packageRoot = PACKAGE_ROOT) {
  const normalizedRoot = String(packageRoot || '').replace(/\\/g, '/')
  const suffix = `/lib/node_modules/${PACKAGE_NAME}`
  if (!normalizedRoot.endsWith(suffix)) return null

  const prefix = packageRoot.slice(0, packageRoot.length - suffix.length)
  if (!prefix) return null

  const npmBinName = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const npmBin = join(prefix, 'bin', npmBinName)

  return {
    packageRoot,
    prefix,
    bin: existsSync(npmBin) ? npmBin : 'npm',
  }
}

/**
 * 📖 detectPackageManager: figure out which package manager owns the current installation.
 * 📖 Checks import.meta.url (package install path), process.argv[1] (script entry),
 * 📖 and process.execPath (runtime binary) for signatures of bun, pnpm, or yarn.
 * 📖 Falls back to 'npm' when no other signature is found.
 * @returns {'npm' | 'bun' | 'pnpm' | 'yarn'}
 */
export function detectPackageManager() {
  const sources = [import.meta.url, process.argv[1] || '', process.execPath || '']
  const combined = sources.join(' ').toLowerCase()
  if (combined.includes('.bun')) return 'bun'
  if (combined.includes('pnpm')) return 'pnpm'
  if (combined.includes('yarn')) return 'yarn'
  return 'npm'
}

/**
 * 📖 isPackageDevMode: true for repo checkouts and explicit --dev runs.
 * 📖 Self-updating a git checkout creates noisy loops during local development,
 * 📖 while published npm installs do not ship a .git directory and can update safely.
 * @returns {boolean}
 */
export function isPackageDevMode() {
  return process.env.FCM_DEV === '1' || existsSync(join(PACKAGE_ROOT, '.git'))
}

/**
 * 📖 isRunningInDocker: detect Docker/container environment where global npm writes fail.
 * In Docker the app lives at /app (not /usr/local/lib/node_modules) and runs as non-root `fcm`.
 * Mandatory updates would always EACCES, so we skip them gracefully.
 * @returns {boolean}
 */
export function isRunningInDocker() {
  // 📖 Standard Docker marker file, plus explicit env override for testing
  if (process.env.FCM_DOCKER === '1' || process.env.DOCKER_CONTAINER === '1') return true
  try {
    if (existsSync('/.dockerenv')) return true
  } catch {}
  // 📖 Fallback: check if package is at /app (Docker COPY) vs global prefix
  try {
    if (String(PACKAGE_ROOT) === '/app' || String(PACKAGE_ROOT).startsWith('/app/')) return true
  } catch {}
  return false
}

/**
 * 📖 getUpdateInstallFailureCount: sanitized persistent failure counter.
 * @param {object} config
 * @returns {number}
 */
export function getUpdateInstallFailureCount(config) {
  const raw = Number(config?.settings?.updateInstallFailures || 0)
  if (!Number.isFinite(raw) || raw < 0) return 0
  return Math.floor(raw)
}

function ensureUpdateSettings(config) {
  if (!config.settings || typeof config.settings !== 'object') config.settings = {}
  return config.settings
}

function persistUpdateSettings(config, saveConfig) {
  if (typeof saveConfig !== 'function') return
  try { saveConfig(config) } catch {}
}

function resetUpdateInstallFailures(config, saveConfig) {
  const settings = ensureUpdateSettings(config)
  if (!settings.updateInstallFailures && !settings.updateLastFailureAt && !settings.updateLastFailureMessage) return
  settings.updateInstallFailures = 0
  delete settings.updateLastFailureAt
  delete settings.updateLastFailureMessage
  delete settings.updateInstallFailureVersion
  persistUpdateSettings(config, saveConfig)
}

function recordUpdateInstallFailure(config, latestVersion, error, saveConfig) {
  const settings = ensureUpdateSettings(config)
  const nextFailures = Math.min(getUpdateInstallFailureCount(config) + 1, UPDATE_FAILURE_THRESHOLD)
  settings.updateInstallFailures = nextFailures
  settings.updateInstallFailureVersion = latestVersion
  settings.updateLastFailureAt = new Date().toISOString()
  settings.updateLastFailureMessage = error instanceof Error ? error.message : String(error || 'Unknown update error')
  persistUpdateSettings(config, saveConfig)
  return nextFailures
}

/**
 * 📖 buildOutdatedWarningMessage: one-line message shown when mandatory updates
 * 📖 failed twice and FCM must let the UI start instead of trapping the user.
 * @param {string|null} latestVersion
 * @param {number} failures
 * @returns {string}
 */
export function buildOutdatedWarningMessage(latestVersion, failures = UPDATE_FAILURE_THRESHOLD) {
  const target = latestVersion ? `v${LOCAL_VERSION} → v${latestVersion}` : `v${LOCAL_VERSION}`
  return `⚠️ OUTDATED VERSION (${target}) — automatic update failed ${failures} times. Models and free quotas change often; update as soon as possible for the freshest catalog.`
}

/**
 * 📖 getInstallArgs: return the correct binary and argument list for a given PM.
 * 📖 Each PM has different syntax for global install — this normalises them.
 * @param {'npm' | 'bun' | 'pnpm' | 'yarn'} pm
 * @param {string} version
 * @param {{ prefix?: string, bin?: string }} [options]
 * @returns {{ bin: string, args: string[] }}
 */
export function getInstallArgs(pm, version, options = {}) {
  const pkg = `${PACKAGE_NAME}@${version}`
  switch (pm) {
    case 'bun':   return { bin: 'bun',   args: ['add', '-g', pkg] }
    case 'pnpm':  return { bin: 'pnpm',  args: ['add', '-g', pkg] }
    case 'yarn':  return { bin: 'yarn',  args: ['global', 'add', pkg] }
    default: {
      const args = ['i', '-g']
      if (options.prefix) args.push('--prefix', options.prefix)
      args.push(pkg, '--prefer-online')
      return { bin: options.bin || 'npm', args }
    }
  }
}

function shellQuoteArg(arg) {
  const value = String(arg)
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

function getCurrentInstallOptions(pm = detectPackageManager()) {
  const installTarget = pm === 'npm' ? resolveCurrentNpmInstallTarget() : null
  return pm === 'npm' && installTarget ? {
    prefix: installTarget.prefix,
    bin: installTarget.bin,
  } : {}
}

/**
 * 📖 getManualInstallCmd: human-readable command string for error / fallback messages.
 * @param {'npm' | 'bun' | 'pnpm' | 'yarn'} pm
 * @param {string} version
 * @param {{ prefix?: string, bin?: string }} [options]
 * @returns {string}
 */
export function getManualInstallCmd(pm, version, options = {}) {
  const { bin, args } = getInstallArgs(pm, version, options)
  return [bin, ...args].map(shellQuoteArg).join(' ')
}

/**
 * 📖 isNewerVersion: dependency-free semver comparison of dotted numeric versions.
 * 📖 Update availability used to be a string inequality, so a dist-tag rollback
 * 📖 (remote < local) triggered a pointless "downgrade" install. Only a strictly
 * 📖 GREATER remote version counts as an update now.
 * @param {string} remoteVersion
 * @param {string} localVersion
 * @returns {boolean} true only when remoteVersion > localVersion
 */
export function isNewerVersion(remoteVersion, localVersion) {
  const parseParts = (v) => String(v ?? '')
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map(part => parseInt(part, 10) || 0)
  const remote = parseParts(remoteVersion)
  const local = parseParts(localVersion)
  const len = Math.max(remote.length, local.length)
  for (let i = 0; i < len; i++) {
    const diff = (remote[i] || 0) - (local[i] || 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

/**
 * 📖 checkForUpdateDetailed: Fetch npm latest version with explicit error details.
 * 📖 Used by settings manual-check flow to display meaningful status in the UI.
 * @returns {Promise<{ latestVersion: string|null, error: string|null }>}
 */
export async function checkForUpdateDetailed() {
  try {
    const res = await fetch('https://registry.npmjs.org/free-coding-models/latest', { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return { latestVersion: null, error: `HTTP ${res.status}` }
    const data = await res.json()
    if (data.version && isNewerVersion(data.version, LOCAL_VERSION)) return { latestVersion: data.version, error: null }
    return { latestVersion: null, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { latestVersion: null, error: message }
  }
}

/**
 * 📖 checkForUpdate: Backward-compatible wrapper for startup update prompt.
 * @returns {Promise<string|null>}
 */
export async function checkForUpdate() {
  const { latestVersion } = await checkForUpdateDetailed()
  return latestVersion
}

/**
 * 📖 enforceMandatoryStartupUpdate: startup policy for every user-facing surface.
 * 📖 If npm has a newer release, FCM installs it immediately without asking.
 * 📖 The first failed install blocks startup so the next launch retries. After two
 * 📖 consecutive install failures, startup is allowed with a loud outdated warning
 * 📖 so offline/proxy/permission users are not permanently locked out.
 *
 * @param {object} config
 * @param {{ saveConfig?: Function, isDevMode?: boolean, surface?: string }} [options]
 * @returns {Promise<{ latestVersion: string|null, allowedOutdated: boolean, warningMessage: string|null, failures: number, checked: boolean, updated: boolean, blocked: boolean }>}
 */
export async function enforceMandatoryStartupUpdate(config, options = {}) {
  const { saveConfig, surface = 'app' } = options
  const devMode = typeof options.isDevMode === 'boolean' ? options.isDevMode : isPackageDevMode()
  const base = {
    latestVersion: null,
    allowedOutdated: false,
    warningMessage: null,
    failures: getUpdateInstallFailureCount(config),
    checked: false,
    updated: false,
    blocked: false,
  }

  if (devMode) return base
  if (isRunningInDocker()) {
    // 📖 In Docker, global npm install as non-root always EACCES. Skip mandatory update
    // 📖 and let the container run with the baked-in version. User can rebuild image for updates.
    return base
  }

  const { latestVersion, error } = await checkForUpdateDetailed()
  base.checked = true

  if (error) {
    const settings = ensureUpdateSettings(config)
    settings.updateCheckFailures = Math.min(Number(settings.updateCheckFailures || 0) + 1, UPDATE_FAILURE_THRESHOLD)
    persistUpdateSettings(config, saveConfig)
    return base
  }

  const settings = ensureUpdateSettings(config)
  if (settings.updateCheckFailures) {
    settings.updateCheckFailures = 0
    persistUpdateSettings(config, saveConfig)
  }

  if (!latestVersion) {
    resetUpdateInstallFailures(config, saveConfig)
    return base
  }

  base.latestVersion = latestVersion
  const failuresBeforeInstall = getUpdateInstallFailureCount(config)
  if (failuresBeforeInstall >= UPDATE_FAILURE_THRESHOLD) {
    base.allowedOutdated = true
    base.failures = failuresBeforeInstall
    base.warningMessage = buildOutdatedWarningMessage(latestVersion, failuresBeforeInstall)
    return base
  }

  console.log(chalk.dim(`  ⬆ New version v${latestVersion} detected for ${surface}; updating automatically...`))
  const updateResult = runUpdate(latestVersion, { exitOnFailure: false })
  if (updateResult?.ok) {
    resetUpdateInstallFailures(config, saveConfig)
    base.updated = true
    return base
  }

  const failures = recordUpdateInstallFailure(config, latestVersion, updateResult?.error, saveConfig)
  base.failures = failures

  if (failures >= UPDATE_FAILURE_THRESHOLD) {
    base.allowedOutdated = true
    base.warningMessage = buildOutdatedWarningMessage(latestVersion, failures)
    console.log(chalk.red(`  ${base.warningMessage}`))
    const pm = detectPackageManager()
    console.log(chalk.dim(`  Manual update: ${getManualInstallCmd(pm, latestVersion, getCurrentInstallOptions(pm))}`))
    console.log()
    return base
  }

  base.blocked = true
  console.log(chalk.red('  ✖ Mandatory update failed. FCM will retry on the next launch.'))
  const pm = detectPackageManager()
  console.log(chalk.dim(`  Attempt ${failures}/${UPDATE_FAILURE_THRESHOLD}. Manual update: ${getManualInstallCmd(pm, latestVersion, getCurrentInstallOptions(pm))}`))
  console.log()
  return base
}

/**
 * 📖 fetchLastReleaseDate: Get the human-readable publish date of the latest npm release.
 * 📖 Used in the TUI footer to show users how fresh the package is.
 * @returns {Promise<string|null>} e.g. "Mar 27, 2026, 09:42 PM" or null on failure
 */
export async function fetchLastReleaseDate() {
  try {
    const res = await fetch('https://registry.npmjs.org/free-coding-models', { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const data = await res.json()
    const timeMap = data?.time
    if (!timeMap) return null
    const latestKey = data?.['dist-tags']?.latest
    if (!latestKey || !timeMap[latestKey]) return null
    const d = new Date(timeMap[latestKey])
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const hh = d.getHours()
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ampm = hh >= 12 ? 'PM' : 'AM'
    const h12 = hh % 12 || 12
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${h12}:${mm} ${ampm}`
  } catch {
    return null
  }
}

/**
 * 📖 detectGlobalInstallPermission: check whether the detected PM's global install paths are writable.
 * 📖 Bun installs to ~/.bun/install/global/ (always user-writable) so sudo is never needed.
 * 📖 For npm/pnpm/yarn we probe their global root/prefix paths and check writability.
 * @param {'npm' | 'bun' | 'pnpm' | 'yarn'} pm
 * @param {{ packageRoot: string, prefix: string, bin: string } | null} [installTarget]
 * @returns {{ needsSudo: boolean, checkedPath: string|null }}
 */
function detectGlobalInstallPermission(pm, installTarget = null) {
  if (pm === 'bun') {
    return { needsSudo: false, checkedPath: null }
  }

  const { execFileSync } = require('child_process')
  const candidates = []

  if (pm === 'pnpm') {
    try {
      const root = execFileSync('pnpm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (root) candidates.push(root)
    } catch {}
  } else if (pm === 'yarn') {
    try {
      const dir = execFileSync('yarn', ['global', 'dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (dir) candidates.push(dir)
    } catch {}
  } else {
    if (installTarget?.prefix) {
      candidates.push(join(installTarget.prefix, 'lib', 'node_modules'))
      candidates.push(installTarget.prefix)
    }

    const npmBin = installTarget?.bin || 'npm'

    try {
      const npmRoot = execFileSync(npmBin, ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (npmRoot) candidates.push(npmRoot)
    } catch {}

    try {
      const npmPrefix = execFileSync(npmBin, ['prefix', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (npmPrefix) candidates.push(npmPrefix)
    } catch {}
  }

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.W_OK)
    } catch {
      return { needsSudo: true, checkedPath: candidate }
    }
  }

  return { needsSudo: false, checkedPath: candidates[0] || null }
}

function readCurrentPackageVersion() {
  try {
    const data = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return typeof data.version === 'string' ? data.version : null
  } catch {
    return null
  }
}

function verifyCurrentInstallUpdated(latestVersion, installTarget) {
  if (!installTarget) return

  const installedVersion = readCurrentPackageVersion()
  if (installedVersion === latestVersion) return

  const actual = installedVersion ? `v${installedVersion}` : 'an unknown version'
  throw new Error(
    `Update command completed, but the active install at ${installTarget.packageRoot} still reports ${actual}. ` +
    'The package manager likely installed into another global prefix.'
  )
}

/**
 * 📖 hasSudoCommand: lightweight guard so we don't suggest sudo on systems where it does not exist.
 * @returns {boolean}
 */
function hasSudoCommand() {
  const { spawnSync } = require('child_process')
  const result = spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore', shell: false })
  return result.status === 0 || result.status === 1
}

/**
 * 📖 isPermissionError: normalize npm permission failures across platforms and child-process APIs.
 * @param {unknown} err
 * @returns {boolean}
 */
function isPermissionError(err) {
  const message = err instanceof Error ? err.message : String(err || '')
  const stderr = typeof err?.stderr === 'string' ? err.stderr : ''
  const combined = `${message}\n${stderr}`.toLowerCase()
  return (
    err?.code === 'EACCES' ||
    err?.code === 'EPERM' ||
    combined.includes('eacces') ||
    combined.includes('eperm') ||
    combined.includes('permission denied') ||
    combined.includes('operation not permitted')
  )
}

/**
 * 📖 relaunchCurrentProcess: restart free-coding-models with the same user arguments.
 * 📖 Uses spawn with inherited stdio so the new process is interactive and does not require shell escaping.
 */
function relaunchCurrentProcess() {
  const { spawn } = require('child_process')
  console.log(chalk.dim('  🔄 Restarting with new version...'))
  console.log()

  const args = process.argv.slice(1)
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    detached: false,
    shell: false,
    env: process.env,
  })

  child.on('exit', (code) => process.exit(code ?? 0))
  child.on('error', () => process.exit(0))
}

/**
 * 📖 installUpdateCommand: run global install using the detected package manager, optionally prefixed with sudo.
 * @param {string} latestVersion
 * @param {boolean} useSudo
 * @param {{ packageRoot: string, prefix: string, bin: string } | null} [installTarget]
 */
function installUpdateCommand(latestVersion, useSudo, installTarget = null) {
  const { execFileSync } = require('child_process')
  const pm = detectPackageManager()
  const installOptions = pm === 'npm' && installTarget ? {
    prefix: installTarget.prefix,
    bin: installTarget.bin,
  } : {}
  const { bin, args } = getInstallArgs(pm, latestVersion, installOptions)

  if (useSudo) {
    execFileSync('sudo', [bin, ...args], { stdio: 'inherit', shell: false })
    return
  }

  execFileSync(bin, args, { stdio: 'inherit', shell: false })
}

/**
 * 📖 runUpdate: Run npm global install to update to latestVersion.
 * 📖 Retries with sudo on permission errors.
 * 📖 Relaunches the process on success. Manual update actions keep the historic
 * 📖 behavior and exit on failure; mandatory startup checks pass exitOnFailure=false
 * 📖 so they can persist failure counters and decide whether to let the UI start.
 * @param {string} latestVersion
 * @param {{ exitOnFailure?: boolean, relaunchOnSuccess?: boolean }} [options]
 * @returns {{ ok: boolean, error?: unknown }}
 */
export function runUpdate(latestVersion, options = {}) {
  const { exitOnFailure = true, relaunchOnSuccess = true } = options
  console.log()
  console.log(chalk.bold.cyan('  ⬆ Updating free-coding-models to v' + latestVersion + '...'))
  console.log()

  const pm = detectPackageManager()
  const installTarget = pm === 'npm' ? resolveCurrentNpmInstallTarget() : null
  const installOptions = pm === 'npm' && installTarget ? {
    prefix: installTarget.prefix,
    bin: installTarget.bin,
  } : {}
  const { needsSudo, checkedPath } = detectGlobalInstallPermission(pm, installTarget)
  const sudoAvailable = process.platform !== 'win32' && hasSudoCommand()
  let lastError = null

  if (needsSudo && checkedPath && sudoAvailable) {
    console.log(chalk.yellow(`  ⚠ Global ${pm} path is not writable: ${checkedPath}`))
    console.log(chalk.dim('  Re-running update with sudo so you can enter your password once.'))
    console.log()
  }

  try {
    installUpdateCommand(latestVersion, needsSudo && sudoAvailable, installTarget)
    verifyCurrentInstallUpdated(latestVersion, installTarget)
    console.log()
    console.log(chalk.green(`  ✅ Update complete! Version ${latestVersion} installed.`))
    console.log()
    if (relaunchOnSuccess) relaunchCurrentProcess()
    return { ok: true }
  } catch (err) {
    lastError = err
    const manualCmd = getManualInstallCmd(pm, latestVersion, installOptions)
    console.log()
    if (isPermissionError(err) && !needsSudo && sudoAvailable) {
      console.log(chalk.yellow(`  ⚠ Permission denied during ${pm} global install. Retrying with sudo...`))
      console.log()
      try {
        installUpdateCommand(latestVersion, true, installTarget)
        verifyCurrentInstallUpdated(latestVersion, installTarget)
        console.log()
        console.log(chalk.green(`  ✅ Update complete with sudo! Version ${latestVersion} installed.`))
        console.log()
        if (relaunchOnSuccess) relaunchCurrentProcess()
        return { ok: true }
      } catch (sudoErr) {
        lastError = sudoErr
        console.log()
        console.log(chalk.red('  ✖ Update failed even with sudo. Try manually:'))
        console.log(chalk.dim(`    sudo ${manualCmd}`))
        console.log()
      }
    } else if (isPermissionError(err) && !sudoAvailable && process.platform !== 'win32') {
      console.log(chalk.red('  ✖ Update failed due to permissions and `sudo` is not available in PATH.'))
      console.log(chalk.dim(`    Try manually: ${manualCmd}`))
      console.log()
    } else {
      console.log(chalk.red(`  ✖ Update failed. Try manually: ${manualCmd}`))
      console.log()
    }
  }

  if (exitOnFailure) process.exit(1)
  return { ok: false, error: lastError }
}

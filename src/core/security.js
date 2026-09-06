/**
 * @file security.js
 * @description Security checks and auto-fix for config file permissions.
 *
 * 📖 Problem: API keys stored in ~/.free-coding-models.json must be protected.
 *    If the file has incorrect permissions (e.g., 644 = world-readable), keys can leak.
 *
 * 📖 This module:
 *    - Checks config file permissions on startup
 *    - Warns user if permissions are too open
 *    - Offers auto-fix option with user confirmation (interactive TTY only)
 *    - Fixes permissions securely (chmod 600 = user read/write only)
 *
 * 📖 Issue #173: this check used to run un-awaited inside runApp, so the TUI
 *    entered raw mode / the alternate screen while the prompt was still pending.
 *    On Windows the warning + prompt were invisible and the app looked frozen.
 *    Now checkConfigSecurity() is async, awaited by the bin entry BEFORE the TUI
 *    starts, and it never prompts on non-TTY stdin or daemon/web/JSON surfaces.
 *
 * 📖 Issue #173 follow-up (rutexd): on Windows the "fix" never persisted and the
 *    warning re-fired on every launch. Root cause: Node maps win32 modes to only
 *    0666 (writable) or 0444 (read-only), so 0600 is unreachable and
 *    `(mode & 0o777) === 0o600` was always false; chmod 600 on win32 just clears
 *    the read-only bit. The real fix:
 *    - the Windows verdict now comes from the NTFS ACL via `icacls <file>`
 *    - fixing on Windows runs `icacls /inheritance:r /grant:r <user>:F` and is
 *      verified by re-reading the ACL before claiming success
 *    - when the fix cannot be applied or verified, an ack marker file
 *      (<config>.securityack) keeps the warning quiet for 30 days instead of
 *      nagging on every launch (--fix-permissions bypasses the marker)
 *    POSIX behaviour (chmod 600) is unchanged on macOS/Linux.
 *
 * 📖 Secure permissions:
 *    - POSIX: 0o600 (octal 600) = user:rw, group:---, world:---
 *    - Windows: NTFS inheritance disabled, grants only for the current user
 *      (SYSTEM/Administrators whitelisted) - see parseIcaclsOutput in utils.js
 *
 * @functions
 *   → checkConfigSecurity() - Async main security check; awaited before the TUI starts
 *   → resolveSecurityAction() - Pure gate deciding auto-fix / prompt / warn-only (in utils.js)
 *   → parseIcaclsOutput() - Pure parser for icacls output (in utils.js)
 *   → shouldSkipSecurityWarn() - Pure anti-nag gate for repeat warnings (in utils.js)
 *   → getConfigPermissions() - Returns file mode object for config
 *   → isConfigSecure() - Boolean check if permissions are correct (POSIX modes)
 *   → fixConfigPermissions() - Applies chmod 600 to config file (POSIX)
 *   → getWindowsAclStatus() - Async icacls read + parse → is the ACL secure?
 *   → fixWindowsAcl() - Async icacls fix + ACL re-verify
 *   → promptSecurityFix() - Interactive prompt asking user to fix permissions
 *
 * @exports checkConfigSecurity, isConfigSecure, fixConfigPermissions, formatMode, formatModeRwx
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG_PATH } from './config.js'
import { resolveSecurityAction, parseIcaclsOutput, shouldSkipSecurityWarn } from './utils.js'

const execFileAsync = promisify(execFile)

// 📖 Config file path - matches the path used in config.js (honours the
// 📖 --config-dir / FCM_CONFIG_DIR override when set).
function getConfigPath() {
  return CONFIG_PATH
}

// 📖 Secure file permissions: user read/write only (0o600 = 384 in decimal)
// 📖 This means: owner can read+write, group and others have no permissions
const SECURE_MODE = 0o600

// 📖 True on Windows, where chmod is best-effort (read-only bit only) and the
// 📖 manual fix hint should point at icacls instead of chmod.
const IS_WINDOWS = process.platform === 'win32'

// 📖 Get file stats including permissions for the config file
// 📖 Returns null if file doesn't exist
function getConfigPermissions() {
  const configPath = getConfigPath()

  try {
    if (!fs.existsSync(configPath)) {
      return null
    }

    const stats = fs.statSync(configPath)
    return {
      mode: stats.mode,
      isSecure: (stats.mode & 0o777) === SECURE_MODE,
      path: configPath
    }
  } catch (err) {
    return null
  }
}

// 📖 Check if config file has secure permissions
// 📖 Returns true if file doesn't exist (nothing to secure) or if permissions are correct
export function isConfigSecure() {
  const perms = getConfigPermissions()

  // 📖 No file = nothing to secure
  if (!perms) return true

  return perms.isSecure
}

// 📖 Fix config file permissions to secure mode (chmod 600)
// 📖 POSIX path; on Windows this is NOT the real fix (see fixWindowsAcl) and is
// 📖 kept only as a harmless last-ditch fallback. Returns true if successful.
export function fixConfigPermissions() {
  const configPath = getConfigPath()

  try {
    if (!fs.existsSync(configPath)) {
      return false
    }

    fs.chmodSync(configPath, SECURE_MODE)
    return true
  } catch (err) {
    return false
  }
}

// 📖 Current Windows user name, used both for icacls grants and for matching
// 📖 ACE lines when parsing the ACL (os.userInfo works on win32 too).
function getWindowsUserName() {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USERNAME || ''
  }
}

// 📖 Read the real NTFS ACL via icacls and decide if it is secure:
// 📖 inheritance disabled + grants only for the current user (and trusted
// 📖 SYSTEM/Administrators entries). Returns { checked, secure, ...parsed };
// 📖 checked=false when icacls is missing or failed (caller falls back to the
// 📖 ack-gated warning path instead of trusting useless mode bits).
async function getWindowsAclStatus(configPath) {
  try {
    const { stdout } = await execFileAsync('icacls', [configPath], {
      timeout: 5000,
      windowsHide: true,
    })
    const parsed = parseIcaclsOutput({ output: stdout, userName: getWindowsUserName(), filePath: configPath })
    const secure = !parsed.inheritanceEnabled && !parsed.othersHaveAccess && parsed.ownerHasAccess
    return { checked: true, secure, ...parsed }
  } catch (err) {
    return { checked: false, secure: false, grants: [], otherNames: [] }
  }
}

// 📖 Fix the NTFS ACL for real: drop inherited ACEs, grant only the current
// 📖 user full control, then VERIFY by re-reading the ACL (never claim success
// 📖 without proof - that lie was the core of the issue #173 follow-up).
// 📖 execFile (no shell) keeps the path injection-safe even with spaces.
async function fixWindowsAcl(configPath) {
  const userName = getWindowsUserName()
  if (!userName) return false

  try {
    await execFileAsync(
      'icacls',
      [configPath, '/inheritance:r', '/grant:r', `${userName}:F`],
      { timeout: 5000, windowsHide: true }
    )
    const status = await getWindowsAclStatus(configPath)
    return status.checked && status.secure
  } catch (err) {
    return false
  }
}

// 📖 Anti-nag marker: written when we warned but could not fix/verify, so the
// 📖 same warning does not re-fire on every launch (see shouldSkipSecurityWarn).
// 📖 Lives next to the config so --config-dir / FCM_CONFIG_DIR stays coherent.
function getAckPath() {
  return `${getConfigPath()}.securityack`
}

function readSecurityAck() {
  try {
    return fs.readFileSync(getAckPath(), 'utf8').trim()
  } catch {
    return null
  }
}

function writeSecurityAck() {
  try {
    fs.writeFileSync(getAckPath(), new Date().toISOString(), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

function clearSecurityAck() {
  try {
    fs.unlinkSync(getAckPath())
  } catch {
    // 📖 Nothing to clean up is fine.
  }
}

// 📖 Format permission mode in octal (e.g., 0o644 → "644")
// 📖 Exported for unit tests
export function formatMode(mode) {
  return (mode & 0o777).toString(8).padStart(3, '0')
}

// 📖 Format permission mode in human-readable rwx format (e.g., 0o644 → "rw-r--r--")
// 📖 Walks bits 8..0 in groups of three: owner rwx, group rwx, others rwx.
// 📖 Bit 8 = owner read, bit 7 = owner write, bit 6 = owner exec, and so on.
// 📖 Exported for unit tests
export function formatModeRwx(mode) {
  const types = ['r', 'w', 'x']
  const perms = []

  for (let i = 8; i >= 0; i--) {
    perms.push(mode & (1 << i) ? types[(8 - i) % 3] : '-')
  }

  return [
    perms.slice(0, 3).join(''),  // Owner permissions
    perms.slice(3, 6).join(''),  // Group permissions
    perms.slice(6, 9).join('')   // Others permissions
  ].join(' / ')
}

// 📖 Print the insecure-permissions warning (stderr, so --json stdout stays clean)
// 📖 On Windows, mode bits are meaningless (always 0666/0444), so when the ACL
// 📖 was read we show WHAT actually grants access instead of a fake octal story.
function printSecurityWarning(perms, aclStatus = { checked: false }) {
  const currentMode = formatMode(perms.mode)
  const currentRwx = formatModeRwx(perms.mode)

  console.error('')
  console.error('⚠️  SECURITY WARNING ⚠️')
  console.error('')
  console.error(`Your config file has insecure permissions: ${currentMode} (${currentRwx})`)
  console.error(`File: ${perms.path}`)
  console.error('')
  console.error('This means other users on this system may be able to read your API keys.')
  console.error('')

  if (aclStatus.checked) {
    if (aclStatus.inheritanceEnabled) {
      console.error('NTFS: this file inherits access permissions from your user folder.')
    }
    if (aclStatus.othersHaveAccess) {
      const names = (aclStatus.otherNames || []).slice(0, 3).join(', ')
      console.error(`NTFS: access is also granted to: ${names}`)
    }
    console.error('')
  }

  console.error('Recommended: restrict access to your user account only')
}

// 📖 Print the manual fix hint. Platform-matched command: icacls on Windows
// 📖 (NTFS ACLs), chmod elsewhere.
function printManualFixHint() {
  console.error('')
  if (IS_WINDOWS) {
    const user = getWindowsUserName() || '$env:USERNAME'
    console.error('To fix manually (PowerShell), run:')
    console.error(`  icacls "${getConfigPath()}" /inheritance:r /grant:r "${user}:F"`)
  } else {
    console.error('To fix manually, run:')
    console.error(`  chmod 600 ${getConfigPath()}`)
  }
  console.error('')
}

// 📖 Apply the fix and report the outcome. Shared by the prompt path (user said
// 📖 yes) and the auto-fix path (--fix-permissions / --yes / -y).
// 📖 Windows: icacls ACL fix, verified by re-reading the ACL.
// 📖 POSIX: chmod 600, verified by re-statting the file.
// 📖 If the fix cannot be verified, write the anti-nag ack so the warning does
// 📖 not re-fire on every launch, and point at the manual command.
async function applyFixAndReport() {
  const configPath = getConfigPath()
  let success = false

  if (IS_WINDOWS) {
    success = await fixWindowsAcl(configPath)
  } else {
    success = fixConfigPermissions() && getConfigPermissions()?.isSecure === true
  }

  if (success) {
    clearSecurityAck()
    console.error('')
    console.error('✅ Permissions fixed! Your API keys are now secure.')
    console.error('')
    if (IS_WINDOWS) {
      console.error(`NTFS access is now restricted to "${getWindowsUserName()}".`)
      console.error('')
    }
    return { wasSecure: false, wasFixed: true }
  }

  writeSecurityAck()
  console.error('')
  console.error('❌ Failed to fix permissions automatically.')
  printManualFixHint()
  return { wasSecure: false, wasFixed: false, error: 'fix_failed' }
}

// 📖 Check security and handle the fix flow if needed
// 📖 Await this BEFORE starting any terminal UI (issue #173) so the warning and
// 📖 the confirmation prompt are visible and fully resolved before raw mode /
// 📖 the alternate screen take over.
//
// 📖 Windows verdict (issue #173 follow-up): mode bits on win32 are only ever
// 📖 0666 or 0444, so the POSIX 0600 check would nag forever. The real verdict
// 📖 comes from the NTFS ACL (icacls). If icacls is unavailable, fall through to
// 📖 the warning path but let the anti-nag ack keep it to once per 30 days.
//
// 📖 Options:
//   autoFix       - true when --fix-permissions / --yes / -y was passed: apply the
//                   fix without asking (also bypasses the anti-nag ack)
//   promptAllowed - false on daemon/web/JSON surfaces: never prompt there, at most
//                   warn on stderr
//   stdinIsTTY    - override the stdin TTY detection (tests); defaults to real detection
//
// 📖 Returns: { wasSecure: boolean, wasFixed: boolean, error?: string }
export async function checkConfigSecurity(options = {}) {
  const perms = getConfigPermissions()

  // 📖 No file yet = nothing to check
  if (!perms) {
    return { wasSecure: true, wasFixed: false }
  }

  // 📖 Security verdict, platform-aware.
  let aclStatus = { checked: false, secure: false, grants: [], otherNames: [] }
  if (IS_WINDOWS) {
    aclStatus = await getWindowsAclStatus(perms.path)
    if (aclStatus.checked && aclStatus.secure) {
      return { wasSecure: true, wasFixed: false }
    }
  } else if (perms.isSecure) {
    return { wasSecure: true, wasFixed: false }
  }

  // 📖 Anti-nag gate: if we already warned recently and the fix did not stick,
  // 📖 stay quiet instead of nagging on every launch. --fix-permissions bypasses.
  if (options.autoFix !== true && shouldSkipSecurityWarn({ ackedAt: readSecurityAck() })) {
    return { wasSecure: false, wasFixed: false, error: 'warned_recently' }
  }

  // 📖 Pure gate (see utils.js): decides auto-fix vs prompt vs warn-only.
  const action = resolveSecurityAction({
    configExists: true,
    isSecure: false,
    autoFixRequested: options.autoFix === true,
    stdinIsTTY: options.stdinIsTTY ?? (process.stdin?.isTTY === true),
    promptAllowed: options.promptAllowed !== false,
  })

  if (action === 'none') {
    return { wasSecure: true, wasFixed: false }
  }

  // 📖 Security issue detected! Print the warning first so it is on screen
  // 📖 no matter which path follows.
  printSecurityWarning(perms, aclStatus)

  if (action === 'auto-fix') {
    return applyFixAndReport()
  }

  if (action === 'warn-only') {
    console.error('Running non-interactively (piped stdin or daemon/web mode), so skipping the prompt.')
    printManualFixHint()
    writeSecurityAck()
    return { wasSecure: false, wasFixed: false, error: 'non_interactive' }
  }

  return promptSecurityFix()
}

// 📖 Interactive prompt asking user if they want to auto-fix
// 📖 Only reached on a real interactive TTY (gated in checkConfigSecurity)
// 📖 Returns: { wasSecure: boolean, wasFixed: boolean, error?: string }
async function promptSecurityFix() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  try {
    const rawAnswer = await new Promise((resolve) => {
      rl.question('Fix permissions automatically? (Y/n): ', resolve)
    })

    rl.close()

    // 📖 Normalise: readline can resolve with undefined when stdin closes mid-prompt
    const answer = String(rawAnswer ?? '').trim().toLowerCase()

    // 📖 Default to yes if user just presses Enter
    if (answer === 'y' || answer === '') {
      return applyFixAndReport()
    } else {
      console.error('')
      console.error('⚠️  Permissions not fixed. Your API keys may be at risk.')
      printManualFixHint()
      return { wasSecure: false, wasFixed: false, error: 'user_declined' }
    }
  } catch (err) {
    rl.close()
    // 📖 If we can't prompt (e.g., non-interactive TTY), just warn and continue
    console.error('')
    console.error('⚠️  Unable to prompt for permission fix (non-interactive terminal?)')
    printManualFixHint()
    return { wasSecure: false, wasFixed: false, error: 'no_tty' }
  }
}

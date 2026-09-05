/**
 * @file telemetry.js
 * @description Anonymous usage telemetry and Discord feedback webhooks.
 *              Extracted from bin/free-coding-models.js to keep the main entry point lean.
 *
 * @details
 *   All telemetry is strictly opt-in-by-default, fire-and-forget, and anonymous:
 *   - A stable `anonymousId` (UUID prefixed with "anon_") is generated once and stored
 *     in ~/.free-coding-models.json.  No personal data is ever collected.
 *   - PostHog is used for product analytics (`app_start`, `app_use`, and lightweight
 *     `app_action` events covering launches and key product actions).
 *   - Discord webhooks carry anonymous feature requests (J key) and bug reports (I key).
 *   - `isTelemetryEnabled()` checks: CLI flag → env var → config opt-out → default (enabled).
 *   - `telemetryDebug()` writes to stderr only when FREE_CODING_MODELS_TELEMETRY_DEBUG=1.
 *   - `sendUsageTelemetry()` has a hard 1.2 s timeout so it never blocks startup.
 *
 *   ⚙️ Configuration (env vars, all optional):
 *   - FREE_CODING_MODELS_TELEMETRY=0|false|off  — disable telemetry globally
 *   - FREE_CODING_MODELS_TELEMETRY_DEBUG=1       — print debug traces to stderr
 *   - FREE_CODING_MODELS_POSTHOG_KEY             — override the PostHog project key
 *   - FREE_CODING_MODELS_POSTHOG_HOST            — override the PostHog host
 *   - POSTHOG_PROJECT_API_KEY / POSTHOG_HOST     — standard PostHog env vars (fallback)
 *   - FCM_DISCORD_FEATURE_WEBHOOK                - feature request webhook URL
 *   - FCM_DISCORD_BUG_WEBHOOK                    - bug report webhook URL
 *
 * @functions
 *   → parseTelemetryEnv(value)                    — Convert env string to boolean or null
 *   → isTelemetryDebugEnabled()                   — Check debug flag from env
 *   → telemetryDebug(message, meta)               — Conditional debug trace to stderr
 *   → ensureTelemetryConfig(config)               — Ensure telemetry shape in config object
 *   → getTelemetryDistinctId(config)              — Get/create stable anonymous ID
 *   → getTelemetrySystem()                        — Convert platform to human label
 *   → getTelemetryTerminal()                      — Infer terminal family from env hints
 *   → isTelemetryEnabled(config, cliArgs)         — Resolve effective enabled state
 *   → buildTelemetryProperties(payload)           — Build sanitized PostHog event properties
 *   → sendUsageTelemetry(config, cliArgs, payload)— Fire-and-forget PostHog ping
 *   → sendFeatureRequest(message)                 — Post anonymous feature request to Discord
 *   → sendBugReport(message)                      — Post anonymous bug report to Discord
 *
 * @exports
 *   parseTelemetryEnv, isTelemetryDebugEnabled, telemetryDebug,
 *   ensureTelemetryConfig, getTelemetryDistinctId,
 *   getTelemetrySystem, getTelemetryTerminal,
 *   isTelemetryEnabled, buildTelemetryProperties, sendUsageTelemetry,
 *   sendFeatureRequest, sendBugReport
 *
 * @see src/config.js  — saveConfig is imported here to persist the generated anonymousId
 * @see bin/free-coding-models.js — calls sendUsageTelemetry on startup and on key events
 */

import { randomUUID } from 'crypto'
import { createRequire } from 'module'
import { saveConfig } from './config.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json')
const LOCAL_VERSION = pkg.version

// 📖 PostHog capture endpoint and defaults.
// 📖 These are public ingest tokens — safe to publish in open-source code.
const TELEMETRY_TIMEOUT          = 1_200
const POSTHOG_CAPTURE_PATH       = '/i/v0/e/'
const POSTHOG_DEFAULT_HOST       = 'https://eu.i.posthog.com'
const POSTHOG_PROJECT_KEY_DEFAULT = 'phc_5P1n8HaLof6nHM0tKJYt4bV5pj2XPb272fLVigwf1YQ'
const POSTHOG_HOST_DEFAULT       = 'https://eu.i.posthog.com'

// 📖 Discord feature request webhook configuration (anonymous feedback system).
// 📖 FCM_DISCORD_FEATURE_WEBHOOK: env var holding the feature-request webhook URL.
// 📖 When unset, the feature request action reports "not configured" instead of posting.
const DISCORD_WEBHOOK_URL   = (process.env.FCM_DISCORD_FEATURE_WEBHOOK || '').trim()
const DISCORD_BOT_NAME      = 'TUI - Feature Requests'
const DISCORD_EMBED_COLOR   = 0x39FF14  // Vert fluo (RGB: 57, 255, 20)

// 📖 Discord bug report webhook configuration (anonymous bug reports).
// 📖 FCM_DISCORD_BUG_WEBHOOK: env var holding the bug report webhook URL.
const DISCORD_BUG_WEBHOOK_URL  = (process.env.FCM_DISCORD_BUG_WEBHOOK || '').trim()
const DISCORD_BUG_BOT_NAME     = 'TUI Bug Report'
const DISCORD_BUG_EMBED_COLOR  = 0xFF5733  // Rouge (RGB: 255, 87, 51)

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * 📖 parseTelemetryEnv: Convert env var strings into booleans.
 * 📖 Returns true/false when value is recognized, otherwise null.
 * @param {unknown} value
 * @returns {boolean|null}
 */
export function parseTelemetryEnv(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

/**
 * 📖 Optional debug switch for telemetry troubleshooting (disabled by default).
 * @returns {boolean}
 */
export function isTelemetryDebugEnabled() {
  return parseTelemetryEnv(process.env.FREE_CODING_MODELS_TELEMETRY_DEBUG) === true
}

/**
 * 📖 Writes telemetry debug traces to stderr only when explicitly enabled.
 * @param {string} message
 * @param {unknown} [meta]
 */
export function telemetryDebug(message, meta = null) {
  if (!isTelemetryDebugEnabled()) return
  const prefix = '[telemetry-debug]'
  if (meta === null) {
    process.stderr.write(`${prefix} ${message}\n`)
    return
  }
  try {
    process.stderr.write(`${prefix} ${message} ${JSON.stringify(meta)}\n`)
  } catch {
    process.stderr.write(`${prefix} ${message}\n`)
  }
}

/**
 * 📖 Ensure telemetry config shape exists even on old config files.
 * @param {Record<string, unknown>} config
 */
export function ensureTelemetryConfig(config) {
  if (!config.telemetry || typeof config.telemetry !== 'object') {
    config.telemetry = { enabled: true, anonymousId: null }
  }
  // 📖 Only default enabled when unset; do not override a user's explicit opt-out
  if (typeof config.telemetry.enabled !== 'boolean') {
    config.telemetry.enabled = true
  }
  if (typeof config.telemetry.anonymousId !== 'string' || !config.telemetry.anonymousId.trim()) {
    config.telemetry.anonymousId = null
  }
}

/**
 * 📖 Create or reuse a persistent anonymous distinct_id for PostHog.
 * 📖 Stored locally in config so one user is stable over time without personal data.
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
export function getTelemetryDistinctId(config) {
  ensureTelemetryConfig(config)
  if (config.telemetry.anonymousId) return config.telemetry.anonymousId

  config.telemetry.anonymousId = `anon_${randomUUID()}`
  saveConfig(config)
  return config.telemetry.anonymousId
}

/**
 * 📖 Convert Node platform to human-readable system name for analytics segmentation.
 * @returns {string}
 */
export function getTelemetrySystem() {
  if (process.platform === 'darwin') return 'macOS'
  if (process.platform === 'win32') return 'Windows'
  if (process.platform === 'linux') return 'Linux'
  return process.platform
}

/**
 * 📖 Infer terminal family from environment hints for coarse usage segmentation.
 * 📖 Never sends full env dumps; only a normalized terminal label is emitted.
 * @returns {string}
 */
export function getTelemetryTerminal() {
  const termProgramRaw = (process.env.TERM_PROGRAM || '').trim()
  const termProgram = termProgramRaw.toLowerCase()
  const term = (process.env.TERM || '').toLowerCase()

  if (termProgram === 'apple_terminal') return 'Terminal.app'
  if (termProgram === 'iterm.app') return 'iTerm2'
  if (termProgram === 'warpterminal' || process.env.WARP_IS_LOCAL_SHELL_SESSION) return 'Warp'
  if (process.env.WT_SESSION) return 'Windows Terminal'
  if (process.env.KITTY_WINDOW_ID || term.includes('kitty')) return 'kitty'
  if (process.env.GHOSTTY_RESOURCES_DIR || term.includes('ghostty')) return 'Ghostty'
  if (process.env.WEZTERM_PANE || termProgram === 'wezterm') return 'WezTerm'
  if (process.env.KONSOLE_VERSION || termProgram === 'konsole') return 'Konsole'
  if (process.env.GNOME_TERMINAL_SCREEN || termProgram === 'gnome-terminal') return 'GNOME Terminal'
  if (process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') return 'JetBrains Terminal'
  if (process.env.TABBY_CONFIG_DIRECTORY || termProgram === 'tabby') return 'Tabby'
  if (termProgram === 'vscode' || process.env.VSCODE_GIT_IPC_HANDLE) return 'VS Code Terminal'
  if (process.env.ALACRITTY_SOCKET || term.includes('alacritty') || termProgram === 'alacritty') return 'Alacritty'
  if (term.includes('foot') || termProgram === 'foot') return 'foot'
  if (termProgram === 'hyper' || process.env.HYPER) return 'Hyper'
  if (process.env.TMUX) return 'tmux'
  if (process.env.STY) return 'screen'
  // 📖 Generic fallback for many terminals exposing TERM_PROGRAM (e.g., Rio, Contour, etc.).
  if (termProgramRaw) return termProgramRaw
  if (term) return term

  return 'unknown'
}

/**
 * 📖 Resolve telemetry effective state with clear precedence:
 * 📖 CLI flag > env var > config opt-out > enabled by default.
 * @param {Record<string, unknown>} config
 * @param {{ noTelemetry?: boolean }} cliArgs
 * @returns {boolean}
 */
export function isTelemetryEnabled(config, cliArgs) {
  if (cliArgs.noTelemetry) return false
  const envTelemetry = parseTelemetryEnv(process.env.FREE_CODING_MODELS_TELEMETRY)
  if (envTelemetry !== null) return envTelemetry
  ensureTelemetryConfig(config)
  // 📖 Honor a persisted opt-out (config telemetry.enabled=false) set from the UI;
  // 📖 CLI flags and FREE_CODING_MODELS_TELEMETRY still override it above.
  return config.telemetry.enabled !== false
}

/**
 * 📖 Build the final analytics properties object while keeping the base schema
 * 📖 stable and stripping undefined values from optional action-specific fields.
 * @param {{ version?: string, mode?: string, properties?: Record<string, unknown> } | undefined} payload
 * @returns {Record<string, unknown>}
 */
export function buildTelemetryProperties(payload) {
  const extraProperties = payload?.properties && typeof payload.properties === 'object' && !Array.isArray(payload.properties)
    ? payload.properties
    : {}

  const merged = {
    ...extraProperties,
    $process_person_profile: false,
    source: 'cli',
    app: 'free-coding-models',
    version: payload?.version || LOCAL_VERSION,
    app_version: payload?.version || LOCAL_VERSION,
    mode: payload?.mode || 'opencode',
    system: getTelemetrySystem(),
    terminal: getTelemetryTerminal(),
  }

  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined))
}

/**
 * 📖 Fire-and-forget analytics ping: never blocks UX, never throws.
 * @param {Record<string, unknown>} config
 * @param {{ noTelemetry?: boolean }} cliArgs
 * @param {{ event?: string, version?: string, mode?: string, ts?: string, properties?: Record<string, unknown> }} payload
 */
export async function sendUsageTelemetry(config, cliArgs, payload) {
  if (!isTelemetryEnabled(config, cliArgs)) {
    telemetryDebug('skip: telemetry disabled', {
      cliNoTelemetry: cliArgs.noTelemetry === true,
      envTelemetry: process.env.FREE_CODING_MODELS_TELEMETRY || null,
      configEnabled: config?.telemetry?.enabled ?? null,
    })
    return
  }

  const apiKey = (
    process.env.FREE_CODING_MODELS_POSTHOG_KEY ||
    process.env.POSTHOG_PROJECT_API_KEY ||
    POSTHOG_PROJECT_KEY_DEFAULT ||
    ''
  ).trim()
  if (!apiKey) {
    telemetryDebug('skip: missing api key')
    return
  }

  const host = (
    process.env.FREE_CODING_MODELS_POSTHOG_HOST ||
    process.env.POSTHOG_HOST ||
    POSTHOG_HOST_DEFAULT ||
    POSTHOG_DEFAULT_HOST
  ).trim().replace(/\/+$/, '')
  if (!host) {
    telemetryDebug('skip: missing host')
    return
  }

  try {
    const endpoint = `${host}${POSTHOG_CAPTURE_PATH}`
    const distinctId = getTelemetryDistinctId(config)
    const timestamp = typeof payload?.ts === 'string' ? payload.ts : new Date().toISOString()
    const signal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
      ? AbortSignal.timeout(TELEMETRY_TIMEOUT)
      : undefined

    const posthogBody = {
      api_key: apiKey,
      event: payload?.event || 'app_start',
      distinct_id: distinctId,
      timestamp,
      properties: buildTelemetryProperties(payload),
    }

    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(posthogBody),
      signal,
    })
    telemetryDebug('sent', {
      event: posthogBody.event,
      endpoint,
      mode: posthogBody.properties.mode,
      system: posthogBody.properties.system,
      terminal: posthogBody.properties.terminal,
    })
  } catch {
    // 📖 Ignore failures silently: analytics must never break the CLI.
    telemetryDebug('error: send failed')
  }
}

/**
 * 📖 sendFeatureRequest: Send anonymous feature request to Discord via webhook.
 * 📖 Called when user presses J key, types message, and presses Enter.
 * 📖 Returns success/error status for UI feedback.
 * @param {string} message
 * @returns {Promise<{ success: boolean, error: string|null }>}
 */
export async function sendFeatureRequest(message) {
  if (!DISCORD_WEBHOOK_URL) {
    return { success: false, error: 'feedback webhook not configured (set FCM_DISCORD_FEATURE_WEBHOOK)' }
  }
  try {
    // 📖 Collect anonymous telemetry for context (no personal data)
    const system = getTelemetrySystem()
    const terminal = getTelemetryTerminal()
    const nodeVersion = process.version
    const arch = process.arch
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'

    // 📖 Build Discord embed with rich metadata in footer (compact format)
    const embed = {
      description: message,
      color: DISCORD_EMBED_COLOR,
      timestamp: new Date().toISOString(),
      footer: {
        text: `v${LOCAL_VERSION} • ${system} • ${terminal} • ${nodeVersion} • ${arch} • ${timezone}`
      }
    }

    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: DISCORD_BOT_NAME,
        embeds: [embed]
      }),
      signal: AbortSignal.timeout(10000) // 📖 10s timeout for webhook
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    return { success: true, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
}

/**
 * 📖 sendBugReport: Send anonymous bug report to Discord via webhook.
 * 📖 Called when user presses I key, types message, and presses Enter.
 * 📖 Returns success/error status for UI feedback.
 * @param {string} message
 * @returns {Promise<{ success: boolean, error: string|null }>}
 */
export async function sendBugReport(message) {
  if (!DISCORD_BUG_WEBHOOK_URL) {
    return { success: false, error: 'feedback webhook not configured (set FCM_DISCORD_BUG_WEBHOOK)' }
  }
  try {
    // 📖 Collect anonymous telemetry for context (no personal data)
    const system = getTelemetrySystem()
    const terminal = getTelemetryTerminal()
    const nodeVersion = process.version
    const arch = process.arch
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'

    // 📖 Build Discord embed with rich metadata in footer (compact format)
    const embed = {
      description: message,
      color: DISCORD_BUG_EMBED_COLOR,
      timestamp: new Date().toISOString(),
      footer: {
        text: `v${LOCAL_VERSION} • ${system} • ${terminal} • ${nodeVersion} • ${arch} • ${timezone}`
      }
    }

    const response = await fetch(DISCORD_BUG_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: DISCORD_BUG_BOT_NAME,
        embeds: [embed]
      }),
      signal: AbortSignal.timeout(10000) // 📖 10s timeout for webhook
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    return { success: true, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
}

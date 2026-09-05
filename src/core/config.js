/**
 * @file lib/config.js
 * @description JSON config management for free-coding-models multi-provider support.
 *
 * 📖 This module manages ~/.free-coding-models.json, the new config file that
 *    stores API keys and per-provider enabled/disabled state for all providers
 *    (NVIDIA NIM, Groq, Cerebras, etc.).
 *
 * 📖 Config file location: ~/.free-coding-models.json
 * 📖 File permissions: 0o600 (user read/write only — contains API keys)
 *
 * 📖 Config JSON structure:
 *   {
 *     "apiKeys": {
 *       "nvidia":     "nvapi-xxx",
 *       "groq":       "gsk_xxx",
 *       "cerebras":   "csk_xxx",
 *       "sambanova":  "sn-xxx",
 *       "openrouter": "sk-or-xxx",
 *       "github-models": "github_pat_xxx",
 *       "mistral":    "mistral-xxx",
 *       "codestral":  "mistral-xxx",
 *       "scaleway":   "scw-xxx",
 *       "googleai":   "AIza...",
 *       "cloudflare": "cf-xxx",
 *       "zai":        "zai-xxx"
 *     },
 *     "providers": {
 *       "nvidia":     { "enabled": true },
 *       "groq":       { "enabled": true },
 *       "cerebras":   { "enabled": true },
 *       "sambanova":  { "enabled": true },
 *       "openrouter": { "enabled": true },
 *       "github-models": { "enabled": true },
 *       "mistral":    { "enabled": true },
 *       "codestral":  { "enabled": true },
 *       "scaleway":   { "enabled": true },
 *       "googleai":   { "enabled": true },
 *       "cloudflare": { "enabled": true },
 *       "zai":        { "enabled": true }
 *     },
 *     "favorites": [
 *       "nvidia/deepseek-ai/deepseek-v4-flash"
 *     ],
 *     "telemetry": {
 *       "enabled": true,
 *       "consentVersion": 1,
 *       "anonymousId": "anon_550e8400-e29b-41d4-a716-446655440000"
 *     },

 *     "profiles": {
 *       "work":     { "apiKeys": {...}, "providers": {...}, "favorites": [...], "settings": {...} },
 *       "personal": { "apiKeys": {...}, "providers": {...}, "favorites": [...], "settings": {...} },
 *       "fast":     { "apiKeys": {...}, "providers": {...}, "favorites": [...], "settings": {...} }
 *     },
 *     "endpointInstalls": [
 *       { "providerKey": "nvidia", "toolMode": "opencode", "scope": "all", "modelIds": [], "lastSyncedAt": "2026-03-09T10:00:00.000Z" }
 *     ],
 *     "router": {
 *       "enabled": true,
 *       "activeSet": "fast-coding",
 *       "probeMode": "balanced",
 *       "sets": {
 *         "fast-coding": {
 *           "name": "fast-coding",
 *           "models": [{ "provider": "groq", "model": "llama-3.3-70b-versatile", "priority": 1 }],
 *           "created": "2026-04-22T10:00:00.000Z"
 *         }
 *       }
 *     }
 *   }
 *

 *
 * 📖 Migration: On first run, if the old plain-text ~/.free-coding-models exists
 *    and the new JSON file does not, the old key is auto-migrated as the nvidia key.
 *    The old file is left in place (not deleted) for safety.
 *
 * @functions
 *   → loadConfig() — Read ~/.free-coding-models.json; auto-migrate old plain-text config if needed
 *   → saveConfig(config, options?) — Write config to ~/.free-coding-models.json with atomic replace + merge safeguards
 *   → getApiKey(config, providerKey) — Get effective API key (env var override > config > null)
 *   → addApiKey(config, providerKey, key) — Append a key (string→array); ignores empty/duplicate
 *   → removeApiKey(config, providerKey, index?) — Remove key at index (or last); collapses array-of-1 to string; deletes when empty
 *   → listApiKeys(config, providerKey) — Return all keys for a provider as normalized array
 *   → isProviderEnabled(config, providerKey) — Check if provider is enabled (defaults true)
 *   → buildPersistedConfig(incomingConfig, diskConfig, options?) — Merge a live snapshot with the latest disk state safely
 *   → replaceConfigContents(targetConfig, nextConfig) — Refresh an in-memory config object from a normalized snapshot
 *   → persistApiKeysForProvider(config, providerKey) — Persist one provider's API keys without clobbering the rest of the file
 *   → normalizeEndpointInstalls(endpointInstalls) — Keep tracked endpoint installs stable across app versions
 *   → normalizeRouterConfig(router) — Keep Smart Router sets and daemon tuning safe to persist
 *
 * @exports loadConfig, saveConfig, validateConfigFile, getApiKey, isProviderEnabled
 * @exports addApiKey, removeApiKey, listApiKeys — multi-key management helpers
 * @exports normalizeEndpointInstalls, normalizeRouterConfig, normalizeRouterPrePrompt
 * @exports defaultRouterPrePromptText, DEFAULT_ROUTER_SETTINGS
 * @exports buildPersistedConfig, replaceConfigContents, persistApiKeysForProvider
 * @exports CONFIG_PATH — path to the JSON config file
 *
 * @see bin/free-coding-models.js — main CLI that uses these functions
 * @see sources.js — provider keys come from Object.keys(sources)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { syncShellEnv } from './shell-env.js'

// 📖 Expand leading ~/ or bare ~ to homedir so --config-dir ~/.config/... works.
// 📖 resolve() alone does NOT expand tilde, it would treat ~ as a literal folder.
function expandTilde(input) {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return join(homedir(), input.slice(2))
  return input
}

// 📖 Resolve a raw config dir string to an absolute path with tilde support.
function resolveConfigDir(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const expanded = expandTilde(raw.trim())
  return resolve(expanded)
}

// 📖 getConfigDir: Resolve the user-chosen config directory — set via the
// 📖 `--config-dir <dir>` CLI flag or via FCM_CONFIG_DIR directly (Docker).
// 📖 The CLI flag wins over the env var, and the env var wins over nothing.
// 📖 Returns null so the default dotfile layout in $HOME keeps working unchanged.
// 📖 NOTE: scanning process.argv here (rather than only trusting the env var)
// 📖 matters because ESM static imports are hoisted — the bin entry's flag
// 📖 handling runs after config.js is evaluated, so CONFIG_PATH must be able
// 📖 to see `--config-dir` on its own.
export function getConfigDir() {
  const fromArgv = configDirFromArgv()
  if (fromArgv) return fromArgv
  return resolveConfigDir(process.env.FCM_CONFIG_DIR)
}

// 📖 Scan process.argv for `--config-dir <dir>` — the raw value before any
// 📖 other arg parsing so module-load-time constants like CONFIG_PATH pick it up.
function configDirFromArgv() {
  const argv = process.argv || []
  const idx = argv.indexOf('--config-dir')
  if (idx === -1) return null
  const raw = argv[idx + 1]
  if (typeof raw !== 'string' || !raw.trim() || raw.startsWith('--')) return null
  return resolveConfigDir(raw)
}

// 📖 New JSON config path — stores all providers' API keys + enabled state.
// 📖 Overridable via `--config-dir <dir>`: config.json lives inside the chosen
// 📖 directory (e.g. the XDG layout ~/.config/free-coding-models).
export const CONFIG_PATH = getConfigDir()
  ? join(getConfigDir(), 'config.json')
  : join(homedir(), '.free-coding-models.json')
export { ENV_VARS }

// 📖 Runtime data directory — backups and local snapshots live here.
export const DAEMON_DATA_DIR = join(homedir(), '.free-coding-models')

// 📖 Old plain-text config path — used only for migration
const LEGACY_CONFIG_PATH = join(homedir(), '.free-coding-models')

// 📖 Environment variable names per provider
// 📖 These allow users to override config via env vars (useful for CI/headless setups)
const ENV_VARS = {
  nvidia:     'NVIDIA_API_KEY',
  groq:       'GROQ_API_KEY',
  cerebras:   'CEREBRAS_API_KEY',
  sambanova:  'SAMBANOVA_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'github-models': ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_MODELS_TOKEN'],
  mistral:    'MISTRAL_API_KEY',
  codestral:  ['MISTRAL_API_KEY', 'CODESTRAL_API_KEY'],
  scaleway:   'SCALEWAY_API_KEY',
  googleai:   'GOOGLE_API_KEY',
  cloudflare: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY'],
  qwen:       'DASHSCOPE_API_KEY',
  zai:        'ZAI_API_KEY',
  ovhcloud:   'OVH_AI_ENDPOINTS_ACCESS_TOKEN',
  'opencode-zen': 'OPENCODE_ZEN_API_KEY',
  kilo:       ['KILO_API_KEY', 'KILO_TOKEN'],
  llm7:       'LLM7_API_KEY',
  routeway:   'ROUTEWAY_API_KEY',
  novita:     'NOVITA_API_KEY',
  'ollama-cloud': 'OLLAMA_API_KEY',
  pollinations: ['POLLINATIONS_API_KEY', 'POLLINATIONS_TOKEN'],
  siliconflow: 'SILICONFLOW_API_KEY',
  requesty:   'REQUESTY_API_KEY',
  orcarouter: 'ORCAROUTER_API_KEY',
  'vercel-gateway': ['VERCEL_AI_GATEWAY_API_KEY', 'AI_GATEWAY_API_KEY'],
}

// 📖 Smart Router defaults are intentionally conservative: balanced probing,
// 📖 three-request failover, and short local port range discovery.
export const DEFAULT_ROUTER_SETTINGS = Object.freeze({
  enabled: false,
  onboardingSeen: false,
  autoStartOnBoot: false,
  port: 19280,
  activeSet: 'fast-coding',
  probeMode: 'balanced',
  probeIntervals: Object.freeze({
    eco: 120000,
    balanced: 30000,
    aggressive: 10000,
  }),
  circuitBreaker: Object.freeze({
    failureThreshold: 3,
    initialCooldownMs: 30000,
    maxCooldownMs: 300000,
    backoffMultiplier: 2,
  }),
  failover: Object.freeze({
    maxRetries: 3,
    streamStallTimeoutMs: 8000,
    requestTimeoutMs: 15000,
  }),
  scoring: Object.freeze({
    latencyWeight: 0.5,
    uptimeWeight: 0.5,
    // 📖 priorityWeight is preserved for back-compat with user configs that
    // 📖 set a custom value, but is no longer mixed into the routing score
    // 📖 (issue #120 fix, v0.5.37). Priority is now enforced authoritatively
    // 📖 by the comparator in getRoutingCandidates; folding it into score
    // 📖 could only mislead tiebreakers and dashboards. The remaining
    // 📖 latency+uptime weights are rebalanced to 0.5/0.5 so the score stays
    // 📖 in [0, 1] after priority is removed (previously 0.4/0.4/0.2).
    priorityWeight: 0.2,
  }),
  logLevel: 'info',
  // 📖 autoHeal — when true (default), the daemon replaces broken models
  // 📖 in the active set on startup (AUTH_ERROR / TIMEOUT / 5xx) with
  // 📖 working alternatives from the same provider. Disabled the moment
  // 📖 the user manually edits the set (reorder/add/remove), so the
  // 📖 user always has the final say.
  autoHeal: true,
  // 📖 Default pre-prompt injected as the first system message on every
  // 📖 /v1/chat/completions request the router proxies. Frames the assistant
  // 📖 as the FCM routing agent. Users can disable it or replace it from the
  // 📖 Settings page on every surface (TUI / Web / Desktop).
  prePrompt: Object.freeze({
    enabled: true,
    text: 'You are free-coding-models, a free coding-model routing agent. The user is talking to you through a local router at http://localhost:19280/v1 that picks the best free coding model in real time across Groq, Cerebras, NVIDIA NIM, GitHub Models, OpenRouter, Mistral, Cloudflare, SambaNova, and more.\n\nBe concise, code-first, and direct. Prefer minimal patches over rewrites. When you show code, make it runnable. When you explain, keep it short. If the user asks which model served them, say you were routed through the local FCM router and point them at the dashboard for the live model list.',
  }),
})

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cloneConfigValue(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeFavoriteList(favorites) {
  if (!Array.isArray(favorites)) return []
  const normalized = []
  const seen = new Set()
  for (const entry of favorites) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

// 📖 normalizeStringSet: Convert an array (from JSON) or existing Set into a Set<string>.
// 📖 Used for hiddenModels and similar set-shaped config fields.
function normalizeStringSet(value) {
  if (value instanceof Set) return value
  if (!Array.isArray(value)) return new Set()
  const result = new Set()
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) result.add(entry.trim())
  }
  return result
}

function normalizeApiKeyValue(value) {
  if (Array.isArray(value)) {
    const normalized = []
    const seen = new Set()
    for (const item of value) {
      if (typeof item !== 'string') continue
      const trimmed = item.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      normalized.push(trimmed)
    }
    if (normalized.length === 0) return null
    if (normalized.length === 1) return normalized[0]
    return normalized
  }

  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function normalizeApiKeysSection(apiKeys) {
  if (!isPlainObject(apiKeys)) return {}
  const normalized = {}
  for (const [providerKey, value] of Object.entries(apiKeys)) {
    const normalizedValue = normalizeApiKeyValue(value)
    if (normalizedValue !== null) normalized[providerKey] = normalizedValue
  }
  return normalized
}

function normalizeProvidersSection(providers) {
  if (!isPlainObject(providers)) return {}
  const normalized = {}
  for (const [providerKey, value] of Object.entries(providers)) {
    if (typeof value === 'boolean') {
      normalized[providerKey] = { enabled: value !== false }
      continue
    }
    if (!isPlainObject(value)) continue
    normalized[providerKey] = { ...value, enabled: value.enabled !== false }
  }
  return normalized
}

function normalizeSettingsSection(settings) {
  const safeSettings = isPlainObject(settings) ? { ...settings } : {}
  delete safeSettings.footerHidden
  return {
    ...safeSettings,
    hideUnconfiguredModels: typeof safeSettings.hideUnconfiguredModels === 'boolean' ? safeSettings.hideUnconfiguredModels : true,
    favoritesPinnedAndSticky: typeof safeSettings.favoritesPinnedAndSticky === 'boolean' ? safeSettings.favoritesPinnedAndSticky : false,
    runAiSpeedTestOnStartup: typeof safeSettings.runAiSpeedTestOnStartup === 'boolean' ? safeSettings.runAiSpeedTestOnStartup : false,
    autoHideBrokenModels: typeof safeSettings.autoHideBrokenModels === 'boolean' ? safeSettings.autoHideBrokenModels : true,
    theme: ['dark', 'light', 'auto'].includes(safeSettings.theme) ? safeSettings.theme : 'auto',
  }
}

function normalizeTelemetrySection(telemetry) {
  const safeTelemetry = isPlainObject(telemetry) ? { ...telemetry } : {}
  return {
    enabled: typeof safeTelemetry.enabled === 'boolean' ? safeTelemetry.enabled : null,
    consentVersion: typeof safeTelemetry.consentVersion === 'number' ? safeTelemetry.consentVersion : 0,
    anonymousId: typeof safeTelemetry.anonymousId === 'string' && safeTelemetry.anonymousId.trim()
      ? safeTelemetry.anonymousId
      : null,
  }
}

function normalizeSyncSection(sync) {
  const safeSync = isPlainObject(sync) ? { ...sync } : {}
  return {
    enabled: typeof safeSync.enabled === 'boolean' ? safeSync.enabled : false,
    lastSyncedAt: typeof safeSync.lastSyncedAt === 'string' ? safeSync.lastSyncedAt : null,
  }
}

function normalizeUpdaterSection(updater) {
  const safeUpdater = isPlainObject(updater) ? { ...updater } : {}
  return {
    lastCheckedAt: typeof safeUpdater.lastCheckedAt === 'string' ? safeUpdater.lastCheckedAt : null,
    lastNotificationAt: typeof safeUpdater.lastNotificationAt === 'string' ? safeUpdater.lastNotificationAt : null,
    skippedVersions: Array.isArray(safeUpdater.skippedVersions) ? safeUpdater.skippedVersions.filter(v => typeof v === 'string') : [],
  }
}

function normalizeRouterName(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  return value.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64) || fallback
}

function normalizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.round(numeric)))
}

function normalizeRouterSetModels(models) {
  if (!Array.isArray(models)) return []
  const seen = new Set()
  const normalized = []
  for (const entry of models) {
    if (!isPlainObject(entry)) continue
    const provider = normalizeRouterName(entry.provider)
    const model = typeof entry.model === 'string' ? entry.model.trim() : ''
    if (!provider || !model) continue
    const key = `${provider}/${model}`
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push({
      provider,
      model,
      priority: normalizePositiveInteger(entry.priority, normalized.length + 1, { min: 1, max: 999 }),
    })
  }
  return normalized
    .sort((a, b) => a.priority - b.priority)
    .map((entry, index) => ({ ...entry, priority: index + 1 }))
}

function normalizeRouterSets(sets) {
  if (!isPlainObject(sets)) return {}
  const normalized = {}
  for (const [rawName, rawSet] of Object.entries(sets)) {
    if (!isPlainObject(rawSet)) continue
    const name = normalizeRouterName(rawSet.name, normalizeRouterName(rawName))
    if (!name) continue
    normalized[name] = {
      name,
      models: normalizeRouterSetModels(rawSet.models),
      created: typeof rawSet.created === 'string' && rawSet.created.trim()
        ? rawSet.created
        : new Date().toISOString(),
      // 📖 familyFailover (t8): when true (default), a failed request first
      // retries the SAME model family on another provider before falling back
      // to plain set order. See src/core/model-family.js.
      familyFailover: rawSet.familyFailover !== false,
    }
  }
  return normalized
}

function normalizeRouterIntervals(intervals) {
  const safeIntervals = isPlainObject(intervals) ? intervals : {}
  return {
    eco: normalizePositiveInteger(safeIntervals.eco, DEFAULT_ROUTER_SETTINGS.probeIntervals.eco, { min: 5000, max: 3600000 }),
    balanced: normalizePositiveInteger(safeIntervals.balanced, DEFAULT_ROUTER_SETTINGS.probeIntervals.balanced, { min: 5000, max: 3600000 }),
    aggressive: normalizePositiveInteger(safeIntervals.aggressive, DEFAULT_ROUTER_SETTINGS.probeIntervals.aggressive, { min: 5000, max: 3600000 }),
  }
}

function normalizeRouterCircuitBreaker(circuitBreaker) {
  const safeBreaker = isPlainObject(circuitBreaker) ? circuitBreaker : {}
  return {
    failureThreshold: normalizePositiveInteger(safeBreaker.failureThreshold, DEFAULT_ROUTER_SETTINGS.circuitBreaker.failureThreshold, { min: 1, max: 20 }),
    initialCooldownMs: normalizePositiveInteger(safeBreaker.initialCooldownMs, DEFAULT_ROUTER_SETTINGS.circuitBreaker.initialCooldownMs, { min: 1000, max: 3600000 }),
    maxCooldownMs: normalizePositiveInteger(safeBreaker.maxCooldownMs, DEFAULT_ROUTER_SETTINGS.circuitBreaker.maxCooldownMs, { min: 1000, max: 3600000 }),
    backoffMultiplier: normalizePositiveInteger(safeBreaker.backoffMultiplier, DEFAULT_ROUTER_SETTINGS.circuitBreaker.backoffMultiplier, { min: 1, max: 10 }),
  }
}

function normalizeRouterFailover(failover, routerFallback = {}) {
  const safeFailover = isPlainObject(failover) ? failover : {}
  const numberOrNull = (val) => {
    const n = Number(val)
    return (val !== null && val !== '' && Number.isFinite(n)) ? n : null
  }

  const rawMaxRetries = numberOrNull(safeFailover.maxRetries) ?? numberOrNull(routerFallback.maxRetries)
  const rawStreamStall = numberOrNull(safeFailover.streamStallTimeoutMs) ?? numberOrNull(routerFallback.streamStallTimeoutMs)
  const rawRequestTimeout = numberOrNull(safeFailover.requestTimeoutMs) ?? numberOrNull(routerFallback.requestTimeoutMs)

  return {
    maxRetries: normalizePositiveInteger(rawMaxRetries, DEFAULT_ROUTER_SETTINGS.failover.maxRetries, { min: 1, max: 20 }),
    streamStallTimeoutMs: normalizePositiveInteger(rawStreamStall, DEFAULT_ROUTER_SETTINGS.failover.streamStallTimeoutMs, { min: 1000, max: 120000 }),
    requestTimeoutMs: normalizePositiveInteger(rawRequestTimeout, DEFAULT_ROUTER_SETTINGS.failover.requestTimeoutMs, { min: 1000, max: 300000 }),
  }
}

function normalizeRouterScoring(scoring) {
  const safeScoring = isPlainObject(scoring) ? scoring : {}
  const numberOrDefault = (value, fallback) => {
    const numeric = Number(value)
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback
  }
  // 📖 priorityWeight is normalized but currently IGNORED by the runtime
  // 📖 scoreCandidates() (issue #120, v0.5.37). Kept here so existing user
  // 📖 configs that customize this field round-trip cleanly and don't lose
  // 📖 their setting on next save. Will be removed in a future major bump.
  return {
    latencyWeight: numberOrDefault(safeScoring.latencyWeight, DEFAULT_ROUTER_SETTINGS.scoring.latencyWeight),
    uptimeWeight: numberOrDefault(safeScoring.uptimeWeight, DEFAULT_ROUTER_SETTINGS.scoring.uptimeWeight),
    priorityWeight: numberOrDefault(safeScoring.priorityWeight, DEFAULT_ROUTER_SETTINGS.scoring.priorityWeight),
  }
}

/**
 * 📖 normalizeRouterConfig preserves the Smart Router subtree without trusting
 * 📖 arbitrary JSON shapes from disk. It keeps model sets ordered, clamps timing
 * 📖 knobs, and leaves the router absent when no router key exists so upgrades can
 * 📖 still distinguish "not onboarded yet" from "explicitly disabled".
 *
 * @param {unknown} router
 * @returns {object|null}
 */
export function normalizeRouterConfig(router) {
  if (!isPlainObject(router)) return null
  const sets = normalizeRouterSets(router.sets)
  const activeSet = normalizeRouterName(router.activeSet, DEFAULT_ROUTER_SETTINGS.activeSet)
  const safeActiveSet = sets[activeSet] ? activeSet : (Object.keys(sets)[0] || activeSet)
  const probeMode = ['eco', 'balanced', 'aggressive'].includes(router.probeMode)
    ? router.probeMode
    : DEFAULT_ROUTER_SETTINGS.probeMode
  const logLevel = ['error', 'warn', 'info', 'debug'].includes(router.logLevel)
    ? router.logLevel
    : DEFAULT_ROUTER_SETTINGS.logLevel

  return {
    enabled: router.enabled === true,
    onboardingSeen: router.onboardingSeen === true,
    autoStartOnBoot: router.autoStartOnBoot === true,
    port: normalizePositiveInteger(router.port, DEFAULT_ROUTER_SETTINGS.port, { min: 1, max: 65535 }),
    activeSet: safeActiveSet,
    sets,
    probeMode,
    probeIntervals: normalizeRouterIntervals(router.probeIntervals),
    circuitBreaker: normalizeRouterCircuitBreaker(router.circuitBreaker),
    failover: normalizeRouterFailover(router.failover, router),
    scoring: normalizeRouterScoring(router.scoring),
    logLevel,
    prePrompt: normalizeRouterPrePrompt(router.prePrompt),
    // 📖 autoHeal defaults to true. Once the user explicitly edits a set
    // 📖 (reorder/add/remove/sync) the daemon flips this to false so the
    // 📖 user's manual choices are not undone on the next start.
    autoHeal: router.autoHeal !== false,
    // 📖 userCustomized marks the active set as "edited by the user".
    // 📖 It is set the first time any write to the active set goes
    // 📖 through and disables auto-heal for that set. Cleared if the
    // 📖 user explicitly resets the set.
    userCustomized: router.userCustomized === true,
  }
}

/**
 * 📖 Normalize the pre-prompt sub-tree. The text is capped at 4000 chars to
 * 📖 keep the per-request overhead sane and to make sure the pre-prompt is
 * 📖 always smaller than a typical user message. A disabled pre-prompt
 * 📖 (`enabled: false`) still preserves the text so toggling back on is a
 * 📖 no-op rather than a destructive replace.
 *
 * @param {unknown} prePrompt
 * @returns {{ enabled: boolean, text: string }}
 */
export function normalizeRouterPrePrompt(prePrompt) {
  const fallback = DEFAULT_ROUTER_SETTINGS.prePrompt
  if (!isPlainObject(prePrompt)) {
    return { enabled: fallback.enabled, text: fallback.text }
  }
  const rawText = typeof prePrompt.text === 'string' ? prePrompt.text : ''
  const trimmedText = rawText.slice(0, 4000)
  return {
    enabled: prePrompt.enabled === true,
    text: trimmedText,
  }
}

/**
 * 📖 Returns the default pre-prompt text. Surfaced by the Settings UI so the
 * 📖 user can hit "Restore default" without retyping the whole persona.
 *
 * @returns {string}
 */
export function defaultRouterPrePromptText() {
  return DEFAULT_ROUTER_SETTINGS.prePrompt.text
}


function normalizeConfigShape(config) {
  const safeConfig = isPlainObject(config) ? config : {}
  const normalized = {
    apiKeys: normalizeApiKeysSection(safeConfig.apiKeys),
    providers: normalizeProvidersSection(safeConfig.providers),
    settings: normalizeSettingsSection(safeConfig.settings),
    favorites: normalizeFavoriteList(safeConfig.favorites),
    telemetry: normalizeTelemetrySection(safeConfig.telemetry),
    sync: normalizeSyncSection(safeConfig.sync),
    updater: normalizeUpdaterSection(safeConfig.updater),
    endpointInstalls: normalizeEndpointInstalls(safeConfig.endpointInstalls),
    // 📖 hiddenModels: Set of "provider/modelId" keys auto-hidden by the 404 probe (Ctrl+Shift+P).
    // 📖 Only populated when settings.autoHideBrokenModels is true (default).
    hiddenModels: normalizeStringSet(safeConfig.hiddenModels),
  }
  const normalizedRouter = normalizeRouterConfig(safeConfig.router)
  if (normalizedRouter) normalized.router = normalizedRouter
  return normalized
}

function readStoredConfigSnapshot() {
  if (!existsSync(CONFIG_PATH)) return _emptyConfig()

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8').trim()
    if (!raw) return _emptyConfig()
    return normalizeConfigShape(JSON.parse(raw))
  } catch {
    return _emptyConfig()
  }
}

function mergeOrderedUniqueStrings(primaryEntries, fallbackEntries) {
  const merged = []
  const seen = new Set()
  for (const entry of [...normalizeFavoriteList(primaryEntries), ...normalizeFavoriteList(fallbackEntries)]) {
    if (seen.has(entry)) continue
    seen.add(entry)
    merged.push(entry)
  }
  return merged
}

function mergeEndpointInstalls(diskEndpointInstalls, incomingEndpointInstalls) {
  const merged = new Map()
  for (const entry of normalizeEndpointInstalls(diskEndpointInstalls)) {
    merged.set(`${entry.providerKey}::${entry.toolMode}`, entry)
  }
  for (const entry of normalizeEndpointInstalls(incomingEndpointInstalls)) {
    merged.set(`${entry.providerKey}::${entry.toolMode}`, entry)
  }
  return [...merged.values()]
}



/**
 * 📖 buildPersistedConfig merges the latest disk snapshot with the in-memory config so
 * 📖 stale writers do not accidentally wipe secrets or favorites they did not touch.
 *
 * @param {object} incomingConfig
 * @param {object} [diskConfig=_emptyConfig()]
 * @param {{ replaceApiKeys?: boolean, replaceFavorites?: boolean, replaceEndpointInstalls?: boolean, replaceProfileNames?: string[], removedProfileNames?: string[] }} [options]
 * @returns {object}
 */
export function buildPersistedConfig(incomingConfig, diskConfig = _emptyConfig(), options = {}) {
  const normalizedIncoming = normalizeConfigShape(incomingConfig)
  const normalizedDisk = normalizeConfigShape(diskConfig)
  const merged = {
    apiKeys: options.replaceApiKeys === true
      ? cloneConfigValue(normalizedIncoming.apiKeys)
      : { ...normalizedDisk.apiKeys, ...normalizedIncoming.apiKeys },
    providers: { ...normalizedDisk.providers, ...normalizedIncoming.providers },
    settings: cloneConfigValue(normalizedIncoming.settings),
    favorites: options.replaceFavorites === true
      ? [...normalizedIncoming.favorites]
      : mergeOrderedUniqueStrings(normalizedIncoming.favorites, normalizedDisk.favorites),
    telemetry: isPlainObject(incomingConfig.telemetry)
      ? { ...normalizedDisk.telemetry, ...normalizedIncoming.telemetry }
      : cloneConfigValue(normalizedDisk.telemetry),
    sync: isPlainObject(incomingConfig.sync)
      ? { ...normalizedDisk.sync, ...normalizedIncoming.sync }
      : cloneConfigValue(normalizedDisk.sync),
    updater: isPlainObject(incomingConfig.updater)
      ? { ...normalizedDisk.updater, ...normalizedIncoming.updater }
      : cloneConfigValue(normalizedDisk.updater),
    // 📖 Managed endpoint installs sometimes need an exact snapshot so stale disk
    // 📖 records do not come back after a fresh install/refresh pass.
    endpointInstalls: options.replaceEndpointInstalls === true
      ? cloneConfigValue(normalizedIncoming.endpointInstalls)
      : mergeEndpointInstalls(normalizedDisk.endpointInstalls, normalizedIncoming.endpointInstalls),
    // 📖 Profile system removed - always null
  }
  if (isPlainObject(incomingConfig.router) && isPlainObject(normalizedDisk.router)) {
    // 📖 Deep merge router settings so partial updates (e.g. from telemetry auto-save)
    // 📖 do not reset custom failover/scoring/intervals to defaults.
    merged.router = {
      ...normalizedDisk.router,
      ...normalizedIncoming.router,
      failover: {
        ...normalizedDisk.router.failover,
        ...(isPlainObject(incomingConfig.router.failover) ? normalizedIncoming.router.failover : {}),
        // 📖 Also support top-level maxRetries/timeout overrides from incoming RAW config
        ...(typeof incomingConfig.router.maxRetries === 'number' ? { maxRetries: incomingConfig.router.maxRetries } : {}),
      },
      probeIntervals: {
        ...normalizedDisk.router.probeIntervals,
        ...(isPlainObject(incomingConfig.router.probeIntervals) ? normalizedIncoming.router.probeIntervals : {}),
      },
      circuitBreaker: {
        ...normalizedDisk.router.circuitBreaker,
        ...(isPlainObject(incomingConfig.router.circuitBreaker) ? normalizedIncoming.router.circuitBreaker : {}),
      },
      scoring: {
        ...normalizedDisk.router.scoring,
        ...(isPlainObject(incomingConfig.router.scoring) ? normalizedIncoming.router.scoring : {}),
      },
    }
  } else if (Object.prototype.hasOwnProperty.call(incomingConfig, 'router')) {
    merged.router = cloneConfigValue(normalizedIncoming.router)
  } else if (Object.prototype.hasOwnProperty.call(normalizedDisk, 'router')) {
    merged.router = cloneConfigValue(normalizedDisk.router)
  }

  return normalizeConfigShape(merged)
}

/**
 * 📖 replaceConfigContents keeps long-lived in-memory config references fresh after a save.
 * 📖 The TUI stores `state.config` by reference, so we mutate it in-place instead of swapping it.
 *
 * @param {object} targetConfig
 * @param {object} nextConfig
 * @returns {object}
 */
export function replaceConfigContents(targetConfig, nextConfig) {
  const normalizedNextConfig = cloneConfigValue(normalizeConfigShape(nextConfig))

  if (!isPlainObject(targetConfig)) return normalizedNextConfig

  for (const key of Object.keys(targetConfig)) {
    delete targetConfig[key]
  }
  Object.assign(targetConfig, normalizedNextConfig)
  return targetConfig
}

/**
 * 📖 persistApiKeysForProvider writes exactly one provider's key set back to disk using the
 * 📖 latest config snapshot first, so editing one provider cannot erase favorites or other keys.
 *
 * @param {object} config
 * @param {string} providerKey
 * @returns {{ success: boolean, error?: string, backupCreated?: boolean }}
 */
export function persistApiKeysForProvider(config, providerKey) {
  const latestConfig = readStoredConfigSnapshot()
  const normalizedProviderValue = normalizeApiKeyValue(config?.apiKeys?.[providerKey])

  if (normalizedProviderValue === null) delete latestConfig.apiKeys[providerKey]
  else latestConfig.apiKeys[providerKey] = cloneConfigValue(normalizedProviderValue)

  const saveResult = saveConfig(latestConfig, {
    replaceApiKeys: true,
    replaceProfileNames: [],
  })

  if (saveResult.success) replaceConfigContents(config, latestConfig)
  return saveResult
}

/**
 * 📖 loadConfig: Read the JSON config from disk.
 *
 * 📖 Fallback chain:
 *   1. Try to read ~/.free-coding-models.json (new format)
 *   2. If missing, check if ~/.free-coding-models (old plain-text) exists → migrate
 *   3. If neither, return an empty default config
 *
 * 📖 Now includes automatic validation and repair from backups if config is corrupted.
 *
 * @returns {{ apiKeys: Record<string,string>, providers: Record<string,{enabled:boolean}>, favorites: string[], telemetry: { enabled: boolean | null, consentVersion: number, anonymousId: string | null } }}
 */
export function loadConfig() {
  // 📖 Try new JSON config first
  if (existsSync(CONFIG_PATH)) {
    // 📖 Validate the config file first, try auto-repair if corrupted
    const validation = validateConfigFile({ autoRepair: true })
    
    if (!validation.valid && !validation.repaired) {
      // 📖 Config is corrupted and repair failed - warn user but continue with empty config
      console.error(`⚠️  Warning: Config file is corrupted and could not be repaired: ${validation.error}`)
      console.error('⚠️  Starting with fresh config. Your backups are in ~/.free-coding-models.backups/')
    }

    if (validation.repaired) {
      console.log('✅ Config file was corrupted but has been restored from backup.')
    }

    try {
      const raw = readFileSync(CONFIG_PATH, 'utf8').trim()
      return normalizeConfigShape(JSON.parse(raw))
    } catch {
      // 📖 Corrupted JSON — return empty config (user will re-enter keys)
      return _emptyConfig()
    }
  }

  // 📖 Migration path: old plain-text file exists, new JSON doesn't
  if (existsSync(LEGACY_CONFIG_PATH)) {
    try {
      const oldKey = readFileSync(LEGACY_CONFIG_PATH, 'utf8').trim()
      if (oldKey) {
        const config = _emptyConfig()
        config.apiKeys.nvidia = oldKey
        // 📖 Auto-save migrated config so next launch is fast
        const result = saveConfig(config)
        if (!result.success) {
          console.error(`⚠️  Warning: Failed to save migrated config: ${result.error}`)
        }
        return config
      }
    } catch {
      // 📖 Can't read old file — proceed with empty config
    }
  }

  return _emptyConfig()
}

/**
 * 📖 saveConfig: Write the config object to ~/.free-coding-models.json.
 *
 * 📖 Uses mode 0o600 so the file is only readable by the owning user (API keys!).
 * 📖 Pretty-prints JSON for human readability.
 * 📖 Now includes:
 *   - Automatic backup before overwriting (keeps last 5 versions)
 *   - Verification that write succeeded
 *   - Explicit error handling (no silent failures)
 *   - Post-write validation to ensure file is valid JSON
 *
 * @param {{ apiKeys: Record<string,string>, providers: Record<string,{enabled:boolean}>, favorites?: string[], telemetry?: { enabled?: boolean | null, consentVersion?: number, anonymousId?: string | null } }} config
 * @param {{ replaceApiKeys?: boolean, replaceFavorites?: boolean, replaceEndpointInstalls?: boolean, replaceProfileNames?: string[], removedProfileNames?: string[] }} [options]
 * @returns {{ success: boolean, error?: string, backupCreated?: boolean }}
 */
export function saveConfig(config, options = {}) {
  // 📖 Ensure the config directory exists before first write (XDG first-run would otherwise ENOENT)
  try {
    const parentDir = dirname(CONFIG_PATH)
    if (!existsSync(parentDir)) mkdirSync(parentDir, { mode: 0o700, recursive: true })
  } catch { /* best-effort, write will surface the error */ }
  // 📖 Create backup of existing config before overwriting
  const backupCreated = createBackup()
  const tempPath = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`

  try {
    const persistedConfig = buildPersistedConfig(config, readStoredConfigSnapshot(), options)
    // 📖 Serialize Sets to arrays for JSON compatibility (e.g. hiddenModels)
    const jsonSafe = JSON.stringify(persistedConfig, (key, value) => {
      if (value instanceof Set) return [...value]
      return value
    }, 2)
    writeFileSync(tempPath, jsonSafe, { mode: 0o600 })
    renameSync(tempPath, CONFIG_PATH)

    // 📖 Verify the write succeeded by reading back and validating
    try {
      const parsed = readStoredConfigSnapshot()

      // 📖 Basic sanity check - ensure apiKeys object exists
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Written config is not a valid object')
      }

      // 📖 Verify critical data wasn't lost - check ALL keys are preserved
      if (persistedConfig.apiKeys && Object.keys(persistedConfig.apiKeys).length > 0) {
        if (!parsed.apiKeys) {
          throw new Error('apiKeys object missing after write')
        }
        const originalKeys = Object.keys(persistedConfig.apiKeys).sort()
        const writtenKeys = Object.keys(parsed.apiKeys).sort()
        if (originalKeys.length > writtenKeys.length) {
          const lostKeys = originalKeys.filter(k => !writtenKeys.includes(k))
          throw new Error(`API keys lost during write: ${lostKeys.join(', ')}`)
        }
        // 📖 Also verify each key's value is not empty
        for (const key of originalKeys) {
          if (!parsed.apiKeys[key] || parsed.apiKeys[key].length === 0) {
            throw new Error(`API key for ${key} is empty after write`)
          }
        }
      }

      replaceConfigContents(config, persistedConfig)

      // 📖 Keep shell env file in sync when enabled
      if (persistedConfig.settings?.shellEnvEnabled) {
        try { syncShellEnv(persistedConfig) } catch { /* non-critical */ }
      }

      return { success: true, backupCreated }
    } catch (verifyError) {
      // 📖 Verification failed - this is critical!
      let errorMsg = `Config verification failed: ${verifyError.message}`
      
      // 📖 Try to restore from backup if we have one
      if (backupCreated) {
        try {
          restoreFromBackup()
          errorMsg += ' (Restored from backup)'
        } catch (restoreError) {
          errorMsg += ` (Backup restoration failed: ${restoreError.message})`
        }
      }

      return { success: false, error: errorMsg, backupCreated }
    }
  } catch (writeError) {
    // 📖 Write failed - explicit error instead of silent failure
    let errorMsg = `Failed to write config: ${writeError.message}`
    try { unlinkSync(tempPath) } catch { /* ignore temp cleanup failures */ }

    // 📖 Detect permission errors and surface a Docker-specific hint. This
    // 📖 happens when a volume was created with files owned by another UID
    // 📖 (e.g. older images running as root, or a host bind-mount where the
    // 📖 directory is owned by a different user). chmod 777 does NOT fix this
    // 📖 because Linux checks file ownership, not mode bits, for write access.
    if (writeError?.code === 'EACCES' || writeError?.code === 'EPERM') {
      errorMsg += formatPermissionHint(writeError)
    }

    // 📖 Try to restore from backup if we have one
    if (backupCreated) {
      try {
        restoreFromBackup()
        errorMsg += ' (Restored from backup)'
      } catch (restoreError) {
        errorMsg += ` (Backup restoration failed: ${restoreError.message})`
      }
    }

    return { success: false, error: errorMsg, backupCreated }
  }
}

/**
 * 📖 formatPermissionHint — build a friendly hint for the most common Docker
 * 📖 permission failure (config file owned by a different UID than the running
 * 📖 process). Returns an empty string for non-permission errors.
 *
 * 📖 Common symptom (issue #119): "Tool mode save failed" in the web dashboard
 * 📖 even after `chmod -R 777`, because chmod doesn't change ownership.
 */
export function formatPermissionHint(writeError) {
  // 📖 Only emit the hint for actual permission errors — silently no-op for
  // 📖 anything else so the caller can safely concatenate the result.
  if (writeError?.code !== 'EACCES' && writeError?.code !== 'EPERM') return ''
  const lines = []
  lines.push('')
  lines.push('  💡 This is almost always a file-ownership issue, not a chmod issue.')
  lines.push('     The config file is owned by a different user than the one running FCM.')
  try {
    const stat = statSync(CONFIG_PATH)
    lines.push(`     File owner UID: ${stat.uid}, current process UID: ${process.getuid?.() ?? 'n/a'}`)
  } catch { /* stat may also fail */ }
  lines.push('')
  lines.push('  Fix in Docker:')
  lines.push('     docker compose down')
  lines.push('     docker volume rm <project>_fcm-data   # or the volume name from `docker volume ls`')
  lines.push('     docker compose up                    # recreates the volume with the right UID')
  lines.push('')
  lines.push('  Fix on host (bind mount):')
  lines.push('     sudo chown $(id -u):$(id -g) ~/.free-coding-models.json')
  return '\n' + lines.join('\n')
}

// 📖 getBackupsDir: Backup directory for config snapshots. Follows the chosen
// 📖 config dir (`--config-dir` / FCM_CONFIG_DIR) so backups stay next to the
// 📖 config file they protect; falls back to ~/.free-coding-models.backups.
function getBackupsDir() {
  return getConfigDir()
    ? join(getConfigDir(), 'backups')
    : join(homedir(), '.free-coding-models.backups')
}

/**
 * 📖 createBackup: Creates a timestamped backup of the current config file.
 * 📖 Keeps only the 5 most recent backups to avoid disk space issues.
 * 📖 Backup files are stored in ~/.free-coding-models.backups/
 * 
 * @returns {boolean} true if backup was created, false otherwise
 */
function createBackup() {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return false // No file to backup
    }

    // 📖 Create backup directory if it doesn't exist
    const backupDir = getBackupsDir()
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { mode: 0o700, recursive: true })
    }

    // 📖 Create timestamped backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, -5) + 'Z'
    const backupPath = join(backupDir, `config.${timestamp}.json`)
    const backupContent = readFileSync(CONFIG_PATH, 'utf8')
    writeFileSync(backupPath, backupContent, { mode: 0o600 })

    // 📖 Clean up old backups (keep only 5 most recent)
    const backups = readdirSync(backupDir)
      .filter(f => f.startsWith('config.') && f.endsWith('.json'))
      .map(f => ({
        name: f,
        path: join(backupDir, f),
        time: statSync(join(backupDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time)

    // 📖 Delete old backups beyond the 5 most recent
    if (backups.length > 5) {
      for (const oldBackup of backups.slice(5)) {
        try {
          unlinkSync(oldBackup.path)
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    return true
  } catch (error) {
    // 📖 Log but don't fail if backup creation fails
    console.error(`Warning: Backup creation failed: ${error.message}`)
    return false
  }
}

/**
 * 📖 restoreFromBackup: Restores the most recent backup.
 * 📖 Used when config write or verification fails.
 * 
 * @throws {Error} if no backup exists or restoration fails
 */
function restoreFromBackup() {
  const backupDir = getBackupsDir()
  
  if (!existsSync(backupDir)) {
    throw new Error('No backup directory found')
  }

  // 📖 Find the most recent backup
  const backups = readdirSync(backupDir)
    .filter(f => f.startsWith('config.') && f.endsWith('.json'))
    .map(f => ({
      name: f,
      path: join(backupDir, f),
      time: statSync(join(backupDir, f)).mtime.getTime()
    }))
    .sort((a, b) => b.time - a.time)

  if (backups.length === 0) {
    throw new Error('No backups available')
  }

  const latestBackup = backups[0]
  const backupContent = readFileSync(latestBackup.path, 'utf8')
  
  // 📖 Verify backup is valid JSON before restoring
  JSON.parse(backupContent)
  
  // 📖 Restore the backup
  writeFileSync(CONFIG_PATH, backupContent, { mode: 0o600 })
}

/**
 * 📖 validateConfigFile: Checks if the config file is valid JSON.
 * 📖 Returns validation result and can auto-repair from backups if needed.
 * 
 * @param {{ autoRepair?: boolean }} options - If true, attempts to repair using backups
 * @returns {{ valid: boolean, error?: string, repaired?: boolean }}
 */
export function validateConfigFile(options = {}) {
  const { autoRepair = false } = options

  try {
    if (!existsSync(CONFIG_PATH)) {
      return { valid: true } // No config file is valid (will be created)
    }

    const content = readFileSync(CONFIG_PATH, 'utf8')
    
    // 📖 Check if file is empty
    if (!content.trim()) {
      throw new Error('Config file is empty')
    }

    // 📖 Try to parse JSON
    const parsed = JSON.parse(content)

    // 📖 Basic structure validation
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Config is not a valid object')
    }

    // 📖 Check for critical corruption (apiKeys should be an object if it exists).
    // 📖 Treat this as recoverable — loadConfig() will normalize the value safely.
    if (parsed.apiKeys !== null && parsed.apiKeys !== undefined
      && (typeof parsed.apiKeys !== 'object' || Array.isArray(parsed.apiKeys))) {
      console.warn('⚠️  apiKeys field malformed; it will be normalized on load')
    }

    return { valid: true }
  } catch (error) {
    const errorMsg = `Config validation failed: ${error.message}`

    // 📖 Attempt auto-repair from backup if requested
    if (autoRepair) {
      try {
        restoreFromBackup()
        return { valid: false, error: errorMsg, repaired: true }
      } catch (repairError) {
        return { valid: false, error: `${errorMsg} (Repair failed: ${repairError.message})`, repaired: false }
      }
    }

    return { valid: false, error: errorMsg, repaired: false }
  }
}

/**
 * 📖 getApiKey: Get the effective API key for a provider.
 *
 * 📖 Priority order (first non-empty wins):
 *   1. Environment variable (e.g. NVIDIA_API_KEY) — for CI/headless
 *   2. Config file value — from ~/.free-coding-models.json
 *   3. null — no key configured
 *
 * @param {{ apiKeys: Record<string,string> }} config
 * @param {string} providerKey — e.g. 'nvidia', 'groq', 'cerebras'
 * @returns {string|null}
 */
export function getApiKey(config, providerKey) {
  // 📖 Env var override — takes precedence over everything
  const envVar = ENV_VARS[providerKey]
  const envCandidates = Array.isArray(envVar) ? envVar : [envVar]
  for (const candidate of envCandidates) {
    if (candidate && process.env[candidate]) return process.env[candidate]
  }

  // 📖 Config file value
  const key = config?.apiKeys?.[providerKey]
  if (key) return key

  return null
}

/**
 * addApiKey: Append a new API key for a provider.
 *
 * - If the provider has no key yet, sets it as a plain string.
 * - If the provider already has one string key, converts to array [existing, new].
 * - If the provider already has an array, pushes the new key.
 * - Ignores empty/whitespace keys.
 * - Ignores exact duplicates (same string already present).
 *
 * @param {object} config — Live config object (will be mutated)
 * @param {string} providerKey — Provider identifier (e.g. 'groq')
 * @param {string} key — New API key to add
 * @returns {boolean} true if added, false if ignored (empty or duplicate)
 */
export function addApiKey(config, providerKey, key) {
  const trimmed = typeof key === 'string' ? key.trim() : ''
  if (!trimmed) return false
  if (!config.apiKeys) config.apiKeys = {}
  const current = config.apiKeys[providerKey]
  if (!current) {
    config.apiKeys[providerKey] = trimmed
    return true
  }
  if (typeof current === 'string') {
    if (current === trimmed) return false // duplicate
    config.apiKeys[providerKey] = [current, trimmed]
    return true
  }
  if (Array.isArray(current)) {
    if (current.includes(trimmed)) return false // duplicate
    current.push(trimmed)
    return true
  }
  // unknown shape — replace
  config.apiKeys[providerKey] = trimmed
  return true
}

/**
 * removeApiKey: Remove an API key for a provider by index, or remove the last one.
 *
 * - Removes the key at `index` if provided, else removes the last key.
 * - If only one key remains after removal, collapses array to string.
 * - If the last key is removed, deletes the provider entry entirely.
 *
 * @param {object} config — Live config object (will be mutated)
 * @param {string} providerKey — Provider identifier (e.g. 'groq')
 * @param {number} [index] — 0-based index to remove; omit to remove last
 * @returns {boolean} true if a key was removed, false if nothing to remove
 */
export function removeApiKey(config, providerKey, index) {
  if (!config.apiKeys) return false
  const current = config.apiKeys[providerKey]
  if (!current) return false

  if (typeof current === 'string') {
    // Only one key — remove it
    delete config.apiKeys[providerKey]
    return true
  }

  if (Array.isArray(current)) {
    const idx = (index !== undefined && index >= 0 && index < current.length) ? index : current.length - 1
    current.splice(idx, 1)
    if (current.length === 0) {
      delete config.apiKeys[providerKey]
    } else if (current.length === 1) {
      config.apiKeys[providerKey] = current[0] // collapse array-of-1 to string
    }
    return true
  }

  return false
}

/**
 * listApiKeys: Return all configured API keys for a provider as a normalized array.
 * Empty when no key is configured.
 *
 * @param {object} config
 * @param {string} providerKey
 * @returns {string[]}
 */
export function listApiKeys(config, providerKey) {
  return resolveApiKeys(config, providerKey)
}

/**
 * Resolve all API keys for a provider as an array.
 * Handles: string → [string], string[] → string[], missing → []
 * Filters empty strings. Falls back to envVarName if no config key.
 */
export function resolveApiKeys(config, providerKey, envVarName) {
  const raw = config?.apiKeys?.[providerKey]
  let keys = []
  if (Array.isArray(raw)) {
    keys = raw
  } else if (typeof raw === 'string' && raw.length > 0) {
    keys = [raw]
  } else if (envVarName && process.env[envVarName]) {
    keys = [process.env[envVarName]]
  }
  return keys.filter(k => typeof k === 'string' && k.length > 0)
}

/**
 * Normalize config for disk persistence.
 * Single-element arrays collapse to string. Multi-element arrays stay.
 */
export function normalizeApiKeyConfig(config) {
  if (!config?.apiKeys) return
  for (const [key, val] of Object.entries(config.apiKeys)) {
    if (Array.isArray(val) && val.length === 1) {
      config.apiKeys[key] = val[0]
    }
  }
}

/**
 * 📖 isProviderEnabled: Check if a provider is enabled in config.
 *
 * 📖 Providers are enabled by default if not explicitly set to false.
 * 📖 A provider without an API key should still appear in settings (just can't ping).
 *
 * @param {{ providers: Record<string,{enabled:boolean}> }} config
 * @param {string} providerKey
 * @returns {boolean}
 */
export function isProviderEnabled(config, providerKey) {
  const providerConfig = config?.providers?.[providerKey]
  if (!providerConfig) return true // 📖 Default: enabled
  return providerConfig.enabled !== false
}



/**
 * 📖 _emptyProfileSettings: Default TUI settings.
 *
 * @returns {{ tierFilter: string|null, sortColumn: string, sortAsc: boolean, pingInterval: number, hideUnconfiguredModels: boolean, favoritesPinnedAndSticky: boolean, runAiSpeedTestOnStartup: boolean, preferredToolMode: string, theme: string }}
 */
export function _emptyProfileSettings() {
  return {
    tierFilter: null,     // 📖 null = show all tiers, or 'S'|'A'|'B'|'C'|'D'
    sortColumn: 'avg',    // 📖 default sort column
    sortAsc: true,        // 📖 true = ascending (fastest first for latency)
    pingInterval: 10000,  // 📖 default ms between pings in the steady "normal" mode
    hideUnconfiguredModels: true, // 📖 true = default to providers that are actually configured
    favoritesPinnedAndSticky: false, // 📖 default mode keeps favorites as normal starred rows; press Y to pin+stick them.
    runAiSpeedTestOnStartup: false, // 📖 opt-in: automatically fire the Ctrl+U global AI Speed Test after startup.
    autoHideBrokenModels: true, // 📖 opt-out: auto-hide models that return 404/410 from probe (Ctrl+Shift+P).
    preferredToolMode: 'opencode', // 📖 remember the last Z-selected launcher across app restarts
    theme: 'auto',        // 📖 'auto' follows the terminal/OS theme, override with 'dark' or 'light' if needed
  }
}

/**
 * 📖 normalizeEndpointInstalls keeps the endpoint-install tracking list safe to replay.
 *
 * 📖 Each entry represents one managed catalog install performed through Install Endpoints:
 *   - `providerKey`: FCM provider identifier (`nvidia`, `groq`, ...)
 *   - `toolMode`: canonical tool id (`opencode`, `openclaw`, `crush`, `goose`)
 *   - `scope`: `all` or `selected`
 *   - `modelIds`: only used when `scope === 'selected'`
 *   - `lastSyncedAt`: informational timestamp updated on successful refresh
 *
 * @param {unknown} endpointInstalls
 * @returns {{ providerKey: string, toolMode: string, scope: 'all'|'selected', modelIds: string[], lastSyncedAt: string | null }[]}
 */
export function normalizeEndpointInstalls(endpointInstalls) {
  if (!Array.isArray(endpointInstalls)) return []
  return endpointInstalls
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const providerKey = typeof entry.providerKey === 'string' ? entry.providerKey.trim() : ''
      const toolMode = typeof entry.toolMode === 'string' ? entry.toolMode.trim() : ''
      if (!providerKey || !toolMode) return null
      const scope = entry.scope === 'selected' ? 'selected' : 'all'
      const modelIds = Array.isArray(entry.modelIds)
        ? [...new Set(entry.modelIds.filter((modelId) => typeof modelId === 'string' && modelId.trim().length > 0))]
        : []
      const lastSyncedAt = typeof entry.lastSyncedAt === 'string' && entry.lastSyncedAt.trim().length > 0
        ? entry.lastSyncedAt
        : null
      return { providerKey, toolMode, scope, modelIds, lastSyncedAt }
    })
    .filter(Boolean)
}

// 📖 Profile system removed - API keys now persist permanently across all sessions

// 📖 Internal helper: create a blank config with the right shape
function _emptyConfig() {
  return {
    apiKeys: {},
    providers: {},
    favorites: [],
    telemetry: { enabled: null, consentVersion: 0, anonymousId: null },
    sync: { enabled: false, lastSyncedAt: null },
    updater: { lastCheckedAt: null, lastNotificationAt: null, skippedVersions: [] },
    endpointInstalls: [],
    settings: _emptyProfileSettings(),
    hiddenModels: new Set(),
  }
}

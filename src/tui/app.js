#!/usr/bin/env node
/**
 * @file free-coding-models.js
 * @description Live terminal availability checker for coding LLM models with OpenCode & OpenClaw integration.
 *
 * @details
 *   This CLI tool discovers and benchmarks language models optimized for coding.
 *   It runs in an alternate screen buffer, pings all models in parallel, re-pings successful ones
 *   multiple times for reliable latency measurements, and prints a clean final table.
 *   During benchmarking, users can navigate with arrow keys and press Enter to act on the selected model.
 *
 *   🎯 Key features:
 *   - Parallel pings across all models with animated real-time updates (multi-provider)
 *   - Continuous monitoring with 60-second ping intervals (never stops)
 *   - Rolling averages calculated from ALL successful pings since start
 *   - Best-per-tier highlighting with medals (🥇🥈🥉)
 *   - Interactive navigation with arrow keys directly in the table
 *   - Instant OpenCode / OpenClaw / external-tool action on Enter key press
 *   - Direct mode flags plus an in-app Z-cycle for the public launcher set
 *   - Automatic config detection and model setup for both tools
 *   - JSON config stored in ~/.free-coding-models.json (auto-migrates from old plain-text)
 *   - Multi-provider support via sources.js (NIM/Groq/Cerebras/GitHub Models/Mistral/OpenRouter/... — extensible)
 *   - Settings screen (P key) to manage API keys, provider toggles, manual updates, and provider-key diagnostics
 *   - Install Endpoints flow (Settings / Command Palette) to push provider catalogs into OpenCode, OpenClaw, Crush, and Goose
 *   - Favorites system: toggle with F, switch pinning mode with Y, persist between sessions
 *   - Uptime percentage tracking (successful pings / total pings)
 *   - Sortable columns (R/O/M/L/A/S/C/H/V/B/U/G keys)
 *   - Tier filtering via T key (cycles S+→S→A+→A→A-→B+→B→C→All)
 *
 *   → Functions:
 *   - `loadConfig` / `saveConfig` / `getApiKey`: Multi-provider JSON config via lib/config.js
 *   - `getTelemetryDistinctId`: Generate/reuse a stable anonymous ID for telemetry
 *   - `getTelemetryTerminal`: Infer terminal family (Terminal.app, iTerm2, kitty, etc.)
 *   - `isTelemetryDebugEnabled` / `telemetryDebug`: Optional runtime telemetry diagnostics via env
 *   - `sendUsageTelemetry`: Fire-and-forget anonymous app-start, launch, and action events
 *   - `ensureFavoritesConfig` / `toggleFavoriteModel`: Persist and toggle pinned favorites
 *   - `promptApiKey`: Interactive wizard for first-time multi-provider API key setup
 *   - `buildPingRequest` / `ping`: Build provider-specific probe requests and measure latency
 *   - `renderTable`: Generate ASCII table with colored latency indicators and status emojis
 *   - `getAvg`: Calculate average latency from all successful pings
 *   - `getVerdict`: Determine verdict string based on average latency (Overloaded for 429)
 *   - `getUptime`: Calculate uptime percentage from ping history
 *   - `sortResults`: Sort models by various columns
 *   - `checkNvidiaNimConfig`: Check if NVIDIA NIM provider is configured in OpenCode
 *   - `isTcpPortAvailable` / `resolveOpenCodeTmuxPort`: Pick a safe OpenCode port when running in tmux
 *   - `startOpenCode`: Launch OpenCode CLI with selected model (configures if needed)
 *   - `startOpenCodeDesktop`: Set model in shared config & open OpenCode Desktop app
 *   - `loadOpenClawConfig` / `saveOpenClawConfig`: Manage ~/.openclaw/openclaw.json
 *   - `startOpenClaw`: Set selected model as default in OpenClaw config (remote, no launch)
 *   - `filterByTier`: Filter models by tier letter prefix (S, A, B, C)
 *   - `main`: Orchestrates CLI flow, wizard, ping loops, animation, and output
 *
 *   📦 Dependencies:
 *   - Node.js 18+ (native fetch)
 *   - chalk: Terminal styling and colors
 *   - readline: Interactive input handling
 *   - sources.js: Model definitions from all providers
 *
 *   ⚙️ Configuration:
 *   - API keys stored per-provider in ~/.free-coding-models.json (0600 perms)
 *   - Old ~/.free-coding-models plain-text auto-migrated as nvidia key on first run
 *   - Env vars override config: NVIDIA_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY, GITHUB_TOKEN, MISTRAL_API_KEY, SCALEWAY_API_KEY, GOOGLE_API_KEY, CLOUDFLARE_API_TOKEN, DASHSCOPE_API_KEY, ZAI_API_KEY, LLM7_API_KEY, ROUTEWAY_API_KEY, NOVITA_API_KEY, OLLAMA_API_KEY, etc.
 *   - ZAI (z.ai) uses a non-standard base path; cloudflare needs CLOUDFLARE_ACCOUNT_ID in env.
 *   - Cloudflare Workers AI requires both CLOUDFLARE_API_TOKEN (or CLOUDFLARE_API_KEY) and CLOUDFLARE_ACCOUNT_ID
 *   - Models loaded from sources.js — all provider/model definitions are centralized there
 *   - OpenCode config: ~/.config/opencode/opencode.json
 *   - OpenClaw config: ~/.openclaw/openclaw.json
 *   - Ping timeout: 15s per attempt
 *   - Ping cadence: 2s startup burst for 60s, 10s steady state, 30s after 5m idle, forced 4s via `W`
 *   - Animation: 12 FPS with braille spinners
 *
 *   🚀 CLI flags:
 *   - (no flag): Start in OpenCode CLI mode
 *   - --opencode: OpenCode CLI mode (launch CLI with selected model)
 *   - --opencode-desktop: OpenCode Desktop mode (set model & open Desktop app)
 *   - --openclaw: OpenClaw mode (set selected model as default in OpenClaw)
 *   - --crush / --goose / --pi: launch the currently selected model in the supported external CLI
 *   - --best: Show only top-tier models (A+, S, S+)
 *   - --fiable: Analyze 10s and output the most reliable model
 *   - --json: Output results as JSON (for scripting/automation)
 *   - --recommend: Open Smart Recommend immediately on startup
 *   - --profile <name>: Load a saved config profile before entering the TUI
 *   - --no-telemetry: Disable anonymous usage analytics for this run
 *   - --help / -h: Print the full CLI help and exit
 *   - --tier S/A/B/C: Filter models by tier letter (S=S+/S, A=A+/A/A-, B=B+/B, C=C)
 *
 *   @see {@link https://build.nvidia.com} NVIDIA API key generation
 *   @see {@link https://github.com/opencode-ai/opencode} OpenCode repository
 *   @see {@link https://openclaw.ai} OpenClaw documentation
 */

import chalk from 'chalk'
import { createRequire } from 'module'
import { randomUUID } from 'crypto'
import { MODELS, sources } from '../../sources.js'
import { getAvg, getVerdict, getUptime, getP95, getJitter, getStabilityScore, sortResults, filterByTier, parseArgs, TIER_ORDER, VERDICT_ORDER, TIER_LETTER_MAP, scoreModelForTask, getTopRecommendations, TASK_TYPES, PRIORITY_TYPES, CONTEXT_BUDGETS, formatResultsAsJSON } from '../core/utils.js'
import { loadConfig, saveConfig, getApiKey, resolveApiKeys, addApiKey, removeApiKey, isProviderEnabled, persistApiKeysForProvider } from '../core/config.js'
import { buildMergedModels } from '../core/model-merger.js'
import { loadOpenCodeConfig, saveOpenCodeConfig } from '../core/opencode-config.js'
import { usageForRow as _usageForRow } from '../core/usage-reader.js'
import { buildProviderModelTokenKey, loadTokenUsageByProviderModel } from '../core/token-usage-reader.js'
import { parseOpenRouterResponse, fetchProviderQuota as _fetchProviderQuotaFromModule, getAllQuotas as _getAllPassiveQuotasFromModule } from '../core/provider-quota-fetchers.js'
import { isKnownQuotaTelemetry } from '../core/quota-capabilities.js'
import { ALT_ENTER, ALT_LEAVE, ALT_HOME, PING_TIMEOUT, PING_INTERVAL, FPS, FRAMES, TIER_CYCLE, VERDICT_CYCLE, HEALTH_CYCLE, SETTINGS_OVERLAY_BG, HELP_OVERLAY_BG, RECOMMEND_OVERLAY_BG, OVERLAY_PANEL_WIDTH, TABLE_HEADER_LINES, TABLE_FOOTER_LINES, TABLE_FIXED_LINES, WIDTH_WARNING_MIN_COLS } from '../core/constants.js'
import { TIER_COLOR } from './tier-colors.js'
import { resolveCloudflareUrl, buildPingRequest, ping, extractQuotaPercent, getProviderQuotaPercentCached, usagePlaceholderForProvider } from '../core/ping.js'
import { runFiableMode, filterByTierOrExit, fetchOpenRouterFreeModels } from '../core/analysis.js'
import { PROVIDER_METADATA, ENV_VAR_NAMES, isWindows, isMac } from '../core/provider-metadata.js'
import { parseTelemetryEnv, isTelemetryDebugEnabled, telemetryDebug, ensureTelemetryConfig, getTelemetryDistinctId, getTelemetrySystem, getTelemetryTerminal, isTelemetryEnabled, sendUsageTelemetry } from '../core/telemetry.js'
import { ensureFavoritesConfig, toFavoriteKey, syncFavoriteFlags, toggleFavoriteModel, reorderFavorite, pruneOrphanedFavorites } from '../core/favorites.js'
import { checkForUpdateDetailed, checkForUpdate, runUpdate, fetchLastReleaseDate } from '../core/updater.js'
import { createTuiState, PING_MODE_INTERVALS, PING_MODE_CYCLE, SPEED_MODE_DURATION_MS, IDLE_SLOW_AFTER_MS, PING_HISTORY_CAP, intervalToPingMode } from './tui-state.js'
import { createPingLoop } from '../core/ping-loop.js'
import { createTuiFilters } from './tui-filters.js'
import { promptApiKey } from '../core/setup.js'
import { syncShellEnv, ensureShellRcSource, removeShellEnv } from '../core/shell-env.js'
import { displayWidth, padEndDisplay, tintOverlayLines, keepOverlayTargetVisible, sliceOverlayLines, sortResultsWithPinnedFavorites, adjustScrollOffset, runWithConcurrency } from './render-helpers.js'
import { renderTable, PROVIDER_COLOR } from './render-table.js'
import { setOpenCodeModelData, startOpenCode, startOpenCodeDesktop, startOpenCodeWeb } from '../core/opencode.js'
import { startKilo } from '../core/kilo.js'
import { startOpenClaw } from '../core/openclaw.js'
import { createOverlayRenderers } from './overlays.js'
import { createKeyHandler, createMouseEventHandler } from './key-handler.js'
import { createMouseHandler, containsMouseSequence } from './mouse.js'
import { stopRouterDashboardClient } from '../core/router-dashboard.js'
import { stopRouterV2DashboardClient } from '../core/router-v2/tui-dashboard.js'
import { getToolModeOrder, getToolMeta } from '../core/tool-metadata.js'
import { startExternalTool } from '../core/tool-launchers.js'
import { getToolInstallPlan, installToolWithPlan, isToolInstalled } from '../core/tool-bootstrap.js'
import { getConfiguredInstallableProviders, installProviderEndpoints, refreshInstalledEndpoints, getInstallTargetModes, getProviderCatalogModels } from '../core/endpoint-installer.js'
import { loadCache, saveCache, clearCache, getCacheAge } from '../core/cache.js'
import {
  loadCache as loadProbeCache,
  flushCache as flushProbeCache,
  clearCache as clearProbeCache,
  getModelsDueForProbe,
  isCacheFresh,
  recordProbeResults,
  getCacheStats as getProbeCacheStats,
  pruneStaleEntries as pruneProbeCacheStaleEntries,
  DEFAULT_PROBE_TTL_MS,
} from '../core/probe-cache.js'
import {
  isProviderQuotaPaused,
  listPausedProviders,
} from '../core/provider-cooldown.js'
import { buildCliHelpText } from './cli-help.js'
import { detectActiveTheme, THEME_BG_RGB, getTheme, patchThemeBg } from './theme.js'

// 📖 mergedModels: cross-provider grouped model list (one entry per label, N providers each)
// 📖 mergedModelByLabel: fast lookup map from display label → merged model entry
const mergedModels = buildMergedModels(MODELS)
const mergedModelByLabel = new Map(mergedModels.map(m => [m.label, m]))
setOpenCodeModelData(mergedModels, mergedModelByLabel)

// 📖 Enrichment (t4 + t5): module-level state. The sync part (extended
// 📖 benchmark catalog stats) is computed lazily on first read via the
// 📖 getter, so we don't block module load. The async part (models.dev
// 📖 fetch) runs inside runApp as a background task — never at module load,
// 📖 never blocking the TUI from rendering.
// 📖
// 📖 The TUI reads from this object on every render to update the footer chips.
const moduleEnrichmentStats = {
  bench: { total: 0, lastUpdated: 'unknown', source: 'unknown' },
  modelsDev: { 'sources.js': 0, 'models.dev': 0, cached: false },
}
let _benchStatsLoaded = false
function ensureBenchStatsLoaded() {
  if (_benchStatsLoaded) return
  _benchStatsLoaded = true
  try {
    // 📖 require() works synchronously and is safe at module load because
    // 📖 model-merger.js has no top-level await side effects.
    const { getEnrichmentStats } = require('../core/model-merger.js')
    moduleEnrichmentStats.bench = getEnrichmentStats().extendedBench
  } catch (err) {
    if (process.env.FCM_BENCH_DEBUG) console.warn('[t4] enrichment stats failed:', err?.message ?? err)
  }
}

// 📖 Background enrichment: fetch models.dev and update moduleEnrichmentStats
// 📖 when it resolves. Fully decoupled from runApp — even if the fetch hangs
// 📖 for 30s+, the TUI keeps rendering. The chip is updated by the next render
// 📖 after resolution.
function runModelsDevEnrichmentInBackground(merged) {
  // 📖 Fire-and-forget; never awaited. If it throws, the catch swallows it.
  ;(async () => {
    try {
      // 📖 Bound the total wait to 12s (worst case 3×4s retries). If the
      // 📖 network is truly down, the chip stays at "0 live" and the TUI
      // 📖 is unaffected. Callers can still trigger a refresh via the
      // 📖 settings panel (future work).
      const timeout = new Promise(resolve => setTimeout(() => resolve(null), 12_000))
      const { overlayModelsDevMetadata } = await import('../core/model-merger.js')
      const result = await Promise.race([
        overlayModelsDevMetadata(merged, { mutate: true }),
        timeout,
      ])
      if (!result) {
        if (process.env.FCM_BENCH_DEBUG) console.warn('[t5] models.dev fetch timed out (12s)')
        return
      }
      let live = 0, curated = 0
      for (const m of result) {
        if (m.metaSource === 'models.dev') live++
        else if (m.metaSource === 'sources.js') curated++
      }
      moduleEnrichmentStats.modelsDev = { 'sources.js': curated, 'models.dev': live, cached: true }
      // 📖 Note: state is owned by runApp — we don't have a direct ref here.
      // 📖 The footer reads moduleEnrichmentStats lazily on each render, so
      // 📖 the next render will pick up the new counts. We do NOT trigger a
      // 📖 render from here (we're not in the render context).
    } catch (err) {
      if (process.env.FCM_BENCH_DEBUG) console.warn('[t5] models.dev overlay failed:', err?.message ?? err)
    }
  })()
}

// 📖 Provider quota cache is managed by lib/provider-quota-fetchers.js (TTL + backoff).
// 📖 Usage placeholder logic uses isKnownQuotaTelemetry() from lib/quota-capabilities.js.

const require = createRequire(import.meta.url)
const readline = require('readline')

// ─── Version check ────────────────────────────────────────────────────────────
const pkg = require('../../package.json')
const LOCAL_VERSION = pkg.version

// 📖 sendBugReport → imported from ../src/telemetry.js

// 📖 parseTelemetryEnv, isTelemetryDebugEnabled, telemetryDebug, ensureTelemetryConfig → imported from ../src/telemetry.js

// 📖 ensureFavoritesConfig, toFavoriteKey, syncFavoriteFlags, toggleFavoriteModel → imported from ../src/favorites.js

// ─── Alternate screen control ─────────────────────────────────────────────────
// 📖 \x1b[?1049h = enter alt screen  \x1b[?1049l = leave alt screen
// 📖 \x1b[?25l   = hide cursor       \x1b[?25h   = show cursor
// 📖 \x1b[H      = cursor to top
// 📖 NOTE: We avoid \x1b[2J (clear screen) because Ghostty scrolls cleared
// 📖 content into the scrollback on the alt screen, pushing the header off-screen.
// 📖 Instead we overwrite in place: cursor home, then \x1b[K (erase to EOL) per line.
// 📖 \x1b[?7l disables auto-wrap so wide rows clip at the right edge instead of
// 📖 wrapping to the next line (which would double the row height and overflow).
// NOTE: All constants (ALT_ENTER, PING_TIMEOUT, etc.) are imported from ../src/constants.js

// ─── Styling ──────────────────────────────────────────────────────────────────
// 📖 Tier colors (TIER_COLOR) are imported from ../src/tier-colors.js
// 📖 All TUI constants (ALT_ENTER, PING_TIMEOUT, etc.) are imported from ../src/constants.js

// 📖 renderTable is now extracted to ../src/render-table.js

// ─── OpenCode integration ──────────────────────────────────────────────────────
// 📖 OpenCode helpers are imported from ../src/opencode.js

// ─── OpenCode integration ──────────────────────────────────────────────────────
// 📖 OpenCode helpers are imported from ../src/opencode.js

export async function runApp(cliArgs, config, startupOptions = {}) {
  // 📖 t4: prime the sync extended-benchmark stats so the footer chip is
  // 📖 accurate on the first render (no async, no network — just a sync read).
  ensureBenchStatsLoaded()

  // 📖 t5: kick off the async models.dev enrichment in the background. This
  // 📖 does NOT block runApp — the TUI starts rendering immediately with
  // 📖 curated values, then re-renders when the models.dev fetch resolves.
  // 📖 If the network is unreachable, the chip just stays at "0 live" forever
  // 📖 (no user-visible freeze). The background task is bounded to 12s.
  runModelsDevEnrichmentInBackground(mergedModels)

  // 📖 Detect user active terminal theme
  detectActiveTheme(config.settings?.theme || 'auto')

  // 📖 Check config file security — warn and offer auto-fix if permissions are too open
  // 📖 (issue #173): this moved to bin/free-coding-models.js BEFORE runApp so the
  // 📖 warning + prompt are visible and resolved before the alternate screen / raw
  // 📖 mode take over. Do not call checkConfigSecurity() here again.

  // 📖 Apply CLI overrides for settings
  if (cliArgs.sortColumn) config.settings.sortColumn = cliArgs.sortColumn
  if (cliArgs.sortDirection) config.settings.sortAsc = cliArgs.sortDirection === 'asc'
  if (cliArgs.originFilter) config.settings.originFilter = cliArgs.originFilter
  if (cliArgs.pingInterval) config.settings.pingInterval = cliArgs.pingInterval
  if (cliArgs.hideUnconfigured) config.settings.hideUnconfiguredModels = true
  if (cliArgs.showUnconfigured) config.settings.hideUnconfiguredModels = false

  // 📖 Apply premium mode as an initial, user-resettable view preset.
  if (cliArgs.premiumMode) {
    config.settings.tierFilter = 'S'
    config.settings.sortColumn = 'verdict'
    config.settings.sortAsc = true
  }

  // 📖 Profile system removed - API keys now persist permanently across all sessions

  // 📖 Check if any provider has a key — if not, run the first-time setup wizard.
  // 📖 Keyless providers (Kilo/LLM7) can still run immediately, so they also count as usable.
  const hasAnyUsableProvider = Object.keys(sources).some(pk => !!getApiKey(config, pk) || PROVIDER_METADATA[pk]?.noKeyNeeded)

  if (!hasAnyUsableProvider) {
    const result = await promptApiKey(config)
    if (!result) {
      console.log()
      console.log(chalk.red('  ✖ No API key provided.'))
      console.log(chalk.dim('  Run `free-coding-models` again or set NVIDIA_API_KEY / GROQ_API_KEY / CEREBRAS_API_KEY.'))
      console.log()
      process.exit(1)
    }
    // 📖 New users get shell env enabled by default
    if (config.settings.shellEnvEnabled === undefined) {
      config.settings.shellEnvEnabled = true
      saveConfig(config)
      syncShellEnv(config)
      ensureShellRcSource()
    }
  }

  // 📖 Default mode: use the last persisted launcher choice when valid,
  // 📖 otherwise fall back to OpenCode CLI.
  let mode = getToolModeOrder().includes(config.settings?.preferredToolMode)
    ? config.settings.preferredToolMode
    : 'opencode'
  const requestedMode = getToolModeOrder().find((toolMode) => {
    const flagByMode = {
      opencode: cliArgs.openCodeMode,
      'opencode-desktop': cliArgs.openCodeDesktopMode,
      'opencode-web': cliArgs.openCodeWebMode,
      openclaw: cliArgs.openClawMode,
      aider: cliArgs.aiderMode,
      crush: cliArgs.crushMode,
      goose: cliArgs.gooseMode,
      kilo: cliArgs.kiloMode,
      qwen: cliArgs.qwenMode,
      openhands: cliArgs.openHandsMode,
      amp: cliArgs.ampMode,
      hermes: cliArgs.hermesMode,
      'continue': cliArgs.continueMode,
      cline: cliArgs.clineMode,
      xcode: cliArgs.xcodeMode,
      pi: cliArgs.piMode,
	      caveman: cliArgs.cavemanMode,
	      copilot: cliArgs.copilotMode,
	      forgecode: cliArgs.forgecodeMode,
	      zcode: cliArgs.zcodeMode,
	    }
    return flagByMode[toolMode] === true
  })
  if (requestedMode) mode = requestedMode

  const sessionId = `session_${randomUUID()}`

  // 📖 Track app opening early so fast exits are still counted.
  // 📖 Must run before update checks because npm registry lookups can add startup delay.
  void sendUsageTelemetry(config, cliArgs, {
    event: 'app_start',
    version: LOCAL_VERSION,
    mode,
    ts: new Date().toISOString(),
    properties: {
      session_id: sessionId,
      event_version: 1,
    },
  })

  // 📖 Mandatory startup update is enforced in the bin entry before any user-facing
  // 📖 surface starts. runApp receives the result so the TUI can display the
  // 📖 two-failure fallback warning without repeating npm registry/install work.
  const startupUpdate = startupOptions.startupUpdate || {}
  const latestVersion = startupUpdate.latestVersion || null
  const isDevMode = startupOptions.isDevMode === true

  // 📖 Dynamic OpenRouter free model discovery — fetch live free models from API
  // 📖 Replaces static openrouter entries in MODELS with fresh data.
  // 📖 Fallback: if fetch fails, the static list from sources.js stays intact + warning shown.
  const lastReleaseDate = await fetchLastReleaseDate()
  const dynamicModels = await fetchOpenRouterFreeModels()
  if (dynamicModels) {
    // 📖 Remove all existing openrouter entries from MODELS
    for (let i = MODELS.length - 1; i >= 0; i--) {
      if (MODELS[i][5] === 'openrouter') MODELS.splice(i, 1)
    }
    // 📖 Push fresh entries with 'openrouter' providerKey
    for (const [modelId, label, tier, swe, ctx] of dynamicModels) {
      MODELS.push([modelId, label, tier, swe, ctx, 'openrouter'])
    }
  } else {
    console.log(chalk.yellow('  OpenRouter: using cached model list (live fetch failed)'))
  }

  // 📖 Re-sync tracked external-tool catalogs after the live provider catalog has settled.
  // 📖 This keeps prior endpoint installs aligned with the current FCM model list.
  refreshInstalledEndpoints(config)

  // 📖 Build results from MODELS — only include enabled providers
  // 📖 Each result gets providerKey so ping() knows which URL + API key to use

  let results = MODELS
    .filter(([,,,,,providerKey]) => isProviderEnabled(config, providerKey))
    .map(([modelId, label, tier, sweScore, ctx, providerKey, addedDate], i) => ({
      idx: i + 1, modelId, label, tier, sweScore, ctx, providerKey, addedDate: addedDate || null,
      status: 'pending',
      pings: [],  // 📖 All ping results (ms or 'TIMEOUT')
      httpCode: null,
      hasApiKey: !!getApiKey(config, providerKey),
      isPinging: false, // 📖 Per-row live flag so Last Ping can keep last value and show a spinner during refresh.
      hidden: false,  // 📖 Simple flag to hide/show models
    }))

  // 📖 Auto-hide models that were previously marked broken by the 404 probe.
  // 📖 Only applies when autoHideBrokenModels setting is enabled (default).
  if (config.settings?.autoHideBrokenModels !== false && config.hiddenModels instanceof Set) {
    for (const r of results) {
      const modelKey = `${r.providerKey}/${r.modelId}`
      if (config.hiddenModels.has(modelKey)) {
        r.hidden = true
      }
    }
  }

  syncFavoriteFlags(results, config)
  // 📖 Garbage-collect favorites that reference models no longer in sources.js,
  // 📖 so the router dashboard only shows real, launchable models.
  pruneOrphanedFavorites(results, config)

  // 📖 Load usage data from token-stats.json and attach usagePercent to each result row.
  // 📖 usagePercent is the quota percent remaining (0–100). undefined = no data available.
  // 📖 Freshness-aware: snapshots older than 30 minutes are excluded (shown as N/A in UI).
  const tokenTotalsByProviderModel = loadTokenUsageByProviderModel()
  for (const r of results) {
    const pct = _usageForRow(r.providerKey, r.modelId)
    r.usagePercent = typeof pct === 'number' ? pct : undefined
    r.totalTokens = tokenTotalsByProviderModel[buildProviderModelTokenKey(r.providerKey, r.modelId)] || 0
  }

  // 📖 Build TUI state via factory — keeps runApp() focused on orchestration, not initialization
  const state = createTuiState({
    results,
    config,
    mode,
    sessionId,
    latestVersion,
    isDevMode,
    updateWarningMessage: startupUpdate.warningMessage || null,
    updateInstallFailures: startupUpdate.failures || 0,
  })

  // 📖 `--playground` / `playground` subcommand: open the in-TUI chat
  // 📖 overlay on first render so the user lands directly in the chat.
  if (startupOptions.wantPlayground === true) {
    state.playgroundOpen = true
  }

  // 📖 Apply the pre-fetched last release date now that state is initialized
  state.lastReleaseDate = lastReleaseDate

  // 📖 Create ping loop controller and filter engine
  const { setPingMode, refreshAutoPingMode, noteUserActivity } = createPingLoop(state)
  const { applyTierFilter, buildOriginCycle } = createTuiFilters(state, { sources, getApiKey, PROVIDER_METADATA })
  const ORIGIN_CYCLE = buildOriginCycle()

  // 📖 Re-clamp viewport on terminal resize
  process.stdout.on('resize', () => {
    const prevCols = state.terminalCols
    state.terminalRows = process.stdout.rows || 24
    state.terminalCols = process.stdout.columns || 80
    if (state.terminalCols < WIDTH_WARNING_MIN_COLS) {
      if (prevCols >= WIDTH_WARNING_MIN_COLS || state.widthWarningDismissed) {
        state.widthWarningStartedAt = Date.now()
        state.widthWarningDismissed = false
      } else if (!state.widthWarningStartedAt) {
        state.widthWarningStartedAt = Date.now()
      }
    } else {
      state.widthWarningStartedAt = null
      state.widthWarningDismissed = false
    }
    adjustScrollOffset(state)
  })

  let ticker = null
  let onKeyPress = null
  let onMouseData = null  // 📖 Mouse data listener — set after createMouseEventHandler
  // 📖 The variables above hold raw handler functions, but what actually gets
  // 📖 registered on process.stdin are the WRAPPERS below. stopUi used to remove
  // 📖 the raw functions (a silent no-op) - it now removes these tracked
  // 📖 wrappers so launch/update paths really detach the listeners.
  let keypressWrapper = null
  let mouseDataWrapper = null
  let pingModel = null

  // 📖 scheduleNextPing: wrapper that defers to the factory version, passing the current runPingCycle.
  // 📖 Defined here because runPingCycle is created later in runApp() and can't be moved earlier.
  const scheduleNextPing = () => {
    clearTimeout(state.pingIntervalObj)
    const elapsed = Date.now() - state.lastPingTime
    const interval = state.routerDashboardOpen ? 1000 : state.pingInterval
    const delay = Math.max(0, interval - elapsed)
    state.pingIntervalObj = setTimeout(runPingCycle, delay)
  }

  // 📖 Load cache if available (for faster startup with cached ping results)
  const cached = loadCache()
  if (cached && cached.models) {
    // 📖 Apply cached values to results
    for (const r of state.results) {
      const cachedModel = cached.models[r.modelId]
      if (cachedModel) {
        r.avg = cachedModel.avg
        r.p95 = cachedModel.p95
        r.jitter = cachedModel.jitter
        r.stability = cachedModel.stability
        r.uptime = cachedModel.uptime
        r.verdict = cachedModel.verdict
        r.status = cachedModel.status
        r.httpCode = cachedModel.httpCode
        // 📖 Trim restored history to PING_HISTORY_CAP so an oversized cache
        // 📖 file cannot instantly reintroduce the unbounded-growth problem.
        r.pings = (cachedModel.pings || []).slice(-PING_HISTORY_CAP)
      }
    }
  }

  // 📖 Probe-cache (t1): persistent per-provider health cache with TTL + auto-hide broken.
  // 📖 Lives at ~/.free-coding-models/probe-cache.json, shared with daemon + Tauri surfaces.
  // 📖 Honors CLI flags: --reprobe (force clear), --probe-ttl <ms>, --show-broken (don't hide).
  if (cliArgs.reprobeMode) {
    // 📖 --reprobe / --no-cache: nuke the cache so this run pings everything fresh.
    clearProbeCache()
  }
  const probeCacheTtlMs = cliArgs.probeTtlMs ?? DEFAULT_PROBE_TTL_MS
  state.probeCacheTtlMs = probeCacheTtlMs
  state.showBrokenMode = !!cliArgs.showBrokenMode
  const probeCache = loadProbeCache()

  // 📖 Prune entries whose modelId is no longer in the catalog (one-time per boot).
  for (const providerKey of new Set(state.results.map(r => r.providerKey))) {
    const liveIds = state.results.filter(r => r.providerKey === providerKey).map(r => r.modelId)
    pruneProbeCacheStaleEntries(providerKey, liveIds)
  }

  // 📖 Apply probe-cache to results: auto-hide broken, pre-fill fresh ok stats.
  let probeCacheHits = 0
  let probeCacheMisses = 0
  for (const r of state.results) {
    const entry = probeCache?.providers?.[r.providerKey]?.models?.[r.modelId]
    if (!entry) {
      probeCacheMisses++
      continue
    }
    if (entry.status === 'broken') {
      probeCacheHits++
      r.cachedBroken = true
      r.lastProbedAt = entry.lastProbedAt
      r.lastError = entry.lastError ?? null
      // 📖 Auto-hide broken models (unless --show-broken or feature disabled).
      const autoHideEnabled = config.settings?.autoHideBrokenModels !== false
      if (!state.showBrokenMode && autoHideEnabled) {
        r.hidden = true
        r.status = 'down'
      }
      continue
    }
    if (entry.status !== 'ok') {
      probeCacheMisses++
      continue
    }
    if (entry.probeVersion !== 2) {
      // 📖 Stale version — count as miss, force re-probe this run.
      probeCacheMisses++
      continue
    }
    if (Date.now() - entry.lastProbedAt < probeCacheTtlMs) {
      // 📖 Fresh ok entry — pre-fill the row so the TUI has data on frame 1.
      probeCacheHits++
      r.fromProbeCache = true
      r.lastProbedAt = entry.lastProbedAt
      const cachedLatency = typeof entry.latencyMs === 'number' ? entry.latencyMs : 0
      r.avg = cachedLatency
      r.p95 = cachedLatency
      r.jitter = 0
      r.stability = 100
      r.uptime = 100
      r.verdict = 'Cached'
      r.status = 'up'
      r.httpCode = '200'
      r.pings = [{ ms: cachedLatency, code: '200' }]
    } else {
      probeCacheMisses++
    }
  }
  state.probeCacheHits = probeCacheHits
  state.probeCacheMisses = probeCacheMisses
  // 📖 Enrichment (t4 + t5): pulled fresh on every render from moduleEnrichmentStats
  // 📖 (see the tableOpts construction below). No need to mirror into state here.
  state.probeCacheBrokenHidden = state.results.filter(r => r.cachedBroken && r.hidden).length

  // 📖 Runtime telemetry (t3): load the per-model metrics file + compute the
  // 📖 real-world score for each result so the table can sort/display it.
  // 📖 The file may not exist yet (no daemon traffic) — that's fine, every
  // 📖 r.realWorldScore stays null and we fall back to SWE-bench.
  try {
    const { loadRuntimeTelemetry, getRealWorldScore } = await import('../core/runtime-telemetry.js')
    loadRuntimeTelemetry()  // 📖 populate module-level cache
    for (const r of state.results) {
      const score = getRealWorldScore(r.providerKey, r.modelId)
      r.realWorldScore = score  // null when below MIN_CALLS_FOR_SCORE
    }
    state.runtimeTelemetryLoaded = true
  } catch (err) {
    state.runtimeTelemetryLoaded = false
    state.runtimeTelemetryError = err?.message || String(err)
  }

  // 📖 Define pingModel before JSON mode so `--json` can reuse the same provider-aware
  // 📖 ping path as the interactive TUI without waiting for the PTY/render loop setup.
  pingModel = async (r) => {
    state.pendingPings += 1
    r.isPinging = true

    try {
      const providerApiKey = getApiKey(state.config, r.providerKey) ?? null
      r.hasApiKey = !!providerApiKey
      const providerUrl = sources[r.providerKey]?.url ?? sources.nvidia.url
      let { code, ms, quotaPercent } = await ping(providerApiKey, r.modelId, r.providerKey, providerUrl)

      if ((quotaPercent === null || quotaPercent === undefined) && providerApiKey) {
        const providerQuota = await getProviderQuotaPercentCached(r.providerKey, providerApiKey)
        if (typeof providerQuota === 'number' && Number.isFinite(providerQuota)) {
          quotaPercent = providerQuota
        }
      }

      r.pings.push({ ms, code })
      // 📖 Cap ping history (PING_HISTORY_CAP = 300): r.pings used to grow
      // 📖 unbounded and getAvg/getP95/getVerdict/getStabilityScore rescan it
      // 📖 per row at ~12 FPS. Stats (uptime, avg) now roll over the last
      // 📖 300 pings instead of the entire session; the oldest entries shift out.
      if (r.pings.length > PING_HISTORY_CAP) {
        r.pings.splice(0, r.pings.length - PING_HISTORY_CAP)
      }

      // 📖 Probe-cache (t1): record the result so future runs can skip healthy models
      // 📖 and auto-hide broken ones. Uses the module-level in-memory cache; flushed
      // 📖 on exit (see exit()) and on graceful shutdown.
      const probeStatus = code === '200' ? 'ok' : 'broken'
      recordProbeResults(r.providerKey, [{
        modelId: r.modelId,
        status: probeStatus,
        latencyMs: typeof ms === 'number' ? ms : null,
        lastError: probeStatus === 'broken' ? String(code) : null,
      }])
      // 📖 If a previously-broken model comes back ok, un-hide it automatically so the
      // 📖 user sees the recovery without a restart. (Skip when --show-broken keeps them visible.)
      if (probeStatus === 'ok' && r.cachedBroken && !state.showBrokenMode) {
        r.cachedBroken = false
        r.hidden = false
        r.lastError = null
        // 📖 Re-evaluate the broken-hidden counter for the footer chip.
        state.probeCacheBrokenHidden = state.results.filter(x => x.cachedBroken && x.hidden).length
      }

      if (code === '200') {
        r.status = 'up'
      } else if (code === '000') {
        r.status = 'timeout'
      } else if (code === '401' || code === '403') {
        r.status = providerApiKey ? 'auth_error' : 'noauth'
        r.httpCode = code
      } else {
        r.status = 'down'
        r.httpCode = code
      }

      if (typeof quotaPercent === 'number' && Number.isFinite(quotaPercent)) {
        r.usagePercent = quotaPercent
        for (const sibling of state.results) {
          if (sibling.providerKey === r.providerKey && (sibling.usagePercent === undefined || sibling.usagePercent === null)) {
            sibling.usagePercent = quotaPercent
          }
        }
      }
    } finally {
      r.isPinging = false
      state.pendingPings = Math.max(0, state.pendingPings - 1)
    }
  }

  // 📖 JSON output mode: skip TUI, output results as JSON after initial pings
  if (cliArgs.jsonMode) {
    console.log(chalk.cyan('  ⚡ Pinging models for JSON output...'))
    console.log()

    // 📖 Run initial pings
    const initialPing = Promise.all(state.results.map(r => pingModel(r)))
    await initialPing

    // 📖 Calculate final stats
    state.results.forEach(r => {
      r.avg = getAvg(r)
      r.p95 = getP95(r)
      r.jitter = getJitter(r)
      r.stability = getStabilityScore(r)
      r.uptime = getUptime(r)
      r.verdict = getVerdict(r)
    })

    // 📖 Apply tier filter if specified
    let outputResults = state.results
    if (cliArgs.tierFilter) {
      const filteredTier = TIER_LETTER_MAP[cliArgs.tierFilter]
      if (filteredTier) {
        outputResults = state.results.filter(r => filteredTier.includes(r.tier))
      }
    }

    // 📖 Apply best mode filter if specified
    if (cliArgs.bestMode) {
      outputResults = outputResults.filter(r => ['S+', 'S', 'A+'].includes(r.tier))
    }

    // 📖 Apply premium mode as a preselected tier family in JSON mode as well.
    if (cliArgs.premiumMode) {
      const premiumTiers = TIER_LETTER_MAP.S || ['S+', 'S']
      outputResults = outputResults.filter(r => premiumTiers.includes(r.tier))
    }

    // 📖 Sort by avg ping (ascending)
    outputResults = sortResults(outputResults, 'avg', 'asc')

    // 📖 Output JSON
    console.log(formatResultsAsJSON(outputResults))

    // 📖 Save cache before exiting
    saveCache(state.results, state.pingMode)

    process.exit(0)
  }

  // 📖 Enter alternate screen — animation runs here, zero scrollback pollution
  process.stdout.write(ALT_ENTER)

  // 📖 Force the entire alt-screen background to match the active theme so
  // 📖 light mode is pure-white and dark mode is deep-dark, regardless of the
  // 📖 terminal's native colour scheme. We paint every row + erase below.
  const initBg = THEME_BG_RGB[getTheme()] ?? THEME_BG_RGB.dark
  const bgFill = `\x1b[48;2;${initBg[0]};${initBg[1]};${initBg[2]}m`
  const row = bgFill + ' '.repeat(state.terminalCols || 80) + '\x1b[K'
  const initScreen = Array.from({ length: state.terminalRows || 24 }, () => row).join('\n')
  process.stdout.write('\x1b[H' + initScreen + bgFill + '\x1b[J' + '\x1b[H')

  if (process.stdout.isTTY) {
    process.stdout.flush && process.stdout.flush()
  }

  // 📖 Ensure we always leave alt screen cleanly (Ctrl+C, crash, normal exit)
  const exit = (code = 0) => {
    saveCache(state.results, state.pingMode)
    flushProbeCache()
    clearInterval(ticker)
    clearTimeout(state.pingIntervalObj)
    clearInterval(state.versionRecheckTimer)
    stopRouterDashboardClient(state)
    stopRouterV2DashboardClient(state)
    process.stdout.write(ALT_LEAVE)
    if (process.stdout.isTTY) {
      process.stdout.flush && process.stdout.flush()
    }
    process.exit(code)
  }
  process.on('SIGINT',  () => exit(0))
  process.on('SIGTERM', () => exit(0))

  // 📖 originFilterMode: index into ORIGIN_CYCLE, 0=All, then each provider key in order
  const resolvedTierFilter = config.settings?.tierFilter
  state.tierFilterMode = resolvedTierFilter ? Math.max(0, TIER_CYCLE.indexOf(resolvedTierFilter)) : 0
  const resolvedOriginFilter = config.settings?.originFilter
  state.originFilterMode = resolvedOriginFilter ? Math.max(0, ORIGIN_CYCLE.indexOf(resolvedOriginFilter)) : 0

  // 📖 Apply initial filters so configured-only mode works on first render
  applyTierFilter()

  // ─── Overlay renderers + key handler ─────────────────────────────────────
  const stopUi = ({ resetRawMode = false } = {}) => {
    if (ticker) clearInterval(ticker)
    clearTimeout(state.pingIntervalObj)
    clearInterval(state.versionRecheckTimer)
    stopRouterDashboardClient(state)
    stopRouterV2DashboardClient(state)
    // 📖 Remove the actual registered wrappers (see keypressWrapper/mouseDataWrapper).
    if (keypressWrapper) process.stdin.removeListener('keypress', keypressWrapper)
    if (mouseDataWrapper) process.stdin.removeListener('data', mouseDataWrapper)
    if (process.stdin.isTTY && resetRawMode) process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdout.write(ALT_LEAVE)
    if (process.stdout.isTTY) {
      process.stdout.flush && process.stdout.flush()
    }
  }

  const overlays = createOverlayRenderers(state, {
    chalk,
    sources,
    PROVIDER_METADATA,
    PROVIDER_COLOR,
    LOCAL_VERSION,
    getApiKey,
    resolveApiKeys,
    isProviderEnabled,
    TIER_CYCLE,
    SETTINGS_OVERLAY_BG,
    HELP_OVERLAY_BG,
    RECOMMEND_OVERLAY_BG,
    OVERLAY_PANEL_WIDTH,
    keepOverlayTargetVisible,
    sliceOverlayLines,
    tintOverlayLines,
    TASK_TYPES,
    PRIORITY_TYPES,
    CONTEXT_BUDGETS,
    FRAMES,
    TIER_COLOR,
    getAvg,
    getStabilityScore,
    toFavoriteKey,
    getTopRecommendations,
    adjustScrollOffset,
    getPingModel: () => pingModel,
    getConfiguredInstallableProviders,
    getInstallTargetModes,
    getProviderCatalogModels,
    getToolMeta,
    getToolInstallPlan,
    padEndDisplay,
    displayWidth,
  })

  onKeyPress = createKeyHandler({
    state,
    exit,
    cliArgs,
    MODELS,
    sources,
    getApiKey,
    resolveApiKeys,
    addApiKey,
    removeApiKey,
    persistApiKeysForProvider,
    isProviderEnabled,
    saveConfig,
    getConfiguredInstallableProviders,
    getInstallTargetModes,
    getProviderCatalogModels,
    installProviderEndpoints,
    syncFavoriteFlags,
    toggleFavoriteModel,
    reorderFavorite,
    sortResultsWithPinnedFavorites,
    adjustScrollOffset,
    applyTierFilter,
    getPingModel: () => pingModel,
    PING_INTERVAL,
    TIER_CYCLE,
    ORIGIN_CYCLE,
    ENV_VAR_NAMES,
    checkForUpdateDetailed,
    runUpdate,
    startOpenClaw,
    startOpenCodeDesktop,
    startOpenCodeWeb,
    startKilo,
    startOpenCode,
    startExternalTool,
    getToolModeOrder,
    getToolMeta,
    getToolInstallPlan,
    isToolInstalled,
    installToolWithPlan,
    sendUsageTelemetry,
    startRecommendAnalysis: overlays.startRecommendAnalysis,
    stopRecommendAnalysis: overlays.stopRecommendAnalysis,
    stopUi,
    ping,
    TASK_TYPES,
    PRIORITY_TYPES,
    CONTEXT_BUDGETS,
    toFavoriteKey,
    mergedModels,
    chalk,
    setPingMode,
    noteUserActivity,
    intervalToPingMode,
    PING_MODE_CYCLE,
    setResults: (next) => { results = next },
    readline,
  })

  // 📖 Mouse event handler: translates parsed mouse events into TUI actions (sort, cursor, scroll).
  const onMouseEvent = createMouseEventHandler({
    state,
    adjustScrollOffset,
    applyTierFilter,
    TIER_CYCLE,
    ORIGIN_CYCLE,
    noteUserActivity,
    sortResultsWithPinnedFavorites,
    saveConfig,
    overlayLayout: overlays.overlayLayout, // 📖 Overlay cursor-to-line maps for click handling
    // 📖 Favorite toggle — right-click on model rows
    toggleFavoriteModel,
    syncFavoriteFlags,
    toFavoriteKey,
    // 📖 Tool mode cycling — compat header click
    cycleToolMode: () => {
      // 📖 Inline cycle matching the Z-key handler in createKeyHandler
      const modeOrder = getToolModeOrder()
      const currentIndex = modeOrder.indexOf(state.mode)
      const nextIndex = (currentIndex + 1) % modeOrder.length
      state.mode = modeOrder[nextIndex]
      if (!state.config.settings || typeof state.config.settings !== 'object') state.config.settings = {}
      state.config.settings.preferredToolMode = state.mode
      saveConfig(state.config)
    },
  })

  // 📖 Wire the raw stdin data listener for mouse events.
  // 📖 createMouseHandler returns a function that parses SGR sequences and calls onMouseEvent.
  onMouseData = createMouseHandler({ onMouseEvent })

  // Apply CLI --tier filter if provided
  if (cliArgs.tierFilter) {
    const allowed = TIER_LETTER_MAP[cliArgs.tierFilter]
    state.results.forEach(r => {
      r.hidden = (state.favoritesPinnedAndSticky && r.isFavorite) ? false : !allowed.includes(r.tier)
    })
  }

  // 📖 Setup keyboard input for interactive selection during pings
  // 📖 Use readline with keypress event for arrow key handling
  process.stdin.setEncoding('utf8')
  process.stdin.resume()

  let userSelected = null

  // 📖 Enable keypress events on stdin
  readline.emitKeypressEvents(process.stdin)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }

  // 📖 Mouse sequence suppression: readline.emitKeypressEvents() registers its own
  // 📖 internal `data` listener that parses bytes and fires `keypress` events.
  // 📖 When a mouse SGR sequence like \x1b[<0;35;20m arrives, readline fragments it
  // 📖 and emits individual keypress events for chars like 'm', '0', ';' etc.
  // 📖 The 'm' at the end of a release event maps to the Model sort hotkey!
  // 📖
  // 📖 Fix: use prependListener to register a `data` handler BEFORE readline's,
  // 📖 so we can set a suppression flag before any keypress events fire.
  // 📖 The flag is cleared on the next tick via setImmediate after all synchronous
  // 📖 keypress emissions from readline have completed.
  let _suppressMouseKeypresses = false

  process.stdin.prependListener('data', (data) => {
    const str = typeof data === 'string' ? data : data.toString('utf8')
    if (str.includes('\x1b[<')) {
      _suppressMouseKeypresses = true
      // 📖 Reset after current tick — all synchronous keypress events from this data
      // 📖 chunk will have fired by then.
      setImmediate(() => { _suppressMouseKeypresses = false })
    }
  })

  keypressWrapper = async (str, key) => {
    try {
      // 📖 Skip keypress events that originate from mouse escape sequences.
      // 📖 readline may partially parse SGR mouse sequences as garbage keypresses.
      if (str && containsMouseSequence(str)) return
      // 📖 Suppress fragmented mouse bytes that readline emits as individual keypresses.
      if (_suppressMouseKeypresses) return
      await onKeyPress(str, key);
    } catch (err) {
      process.stdout.write(ALT_LEAVE);
      console.error(chalk.red('\n[TUI Error] An error occurred while handling a keypress.'));
      console.error(err);
      console.error(chalk.yellow('\nPlease file an issue at https://github.com/vava-nessa/free-coding-models/issues or join the Discord to report this to the author.'));
      process.exit(1);
    }
  }
  process.stdin.on('keypress', keypressWrapper)

  // 📖 Mouse data listener: parses SGR mouse escape sequences from raw stdin
  // 📖 and dispatches structured events (click, scroll, double-click) to the mouse handler.
  mouseDataWrapper = (data) => {
    try {
      if (onMouseData) onMouseData(data)
    } catch (err) {
      // 📖 Mouse errors are non-fatal — log and continue so the TUI doesn't crash.
      // 📖 This could happen on terminals that send unexpected mouse sequences.
    }
  }
  process.stdin.on('data', mouseDataWrapper)

  process.on('SIGCONT', noteUserActivity)

  // 📖 Animation loop: render settings overlay, recommend overlay, help overlay, feature request overlay, bug report overlay, changelog overlay, OR main table
  ticker = setInterval(() => {
    try {
    refreshAutoPingMode()
    state.frame++
    // 📖 Re-apply live health filters each frame so "Usable only" truly means
    // 📖 usable right now: models enter/leave as soon as ping status changes.
    applyTierFilter()
    // 📖 Cache visible+sorted models each frame so Enter handler always matches the display
    if (!state.settingsOpen && !state.installEndpointsOpen && !state.toolInstallPromptOpen && !state.incompatibleFallbackOpen && !state.recommendOpen && !state.changelogOpen && !state.installedModelsOpen && !state.routerDashboardOpen && !state.playgroundOpen && !state.commandPaletteOpen) {
      const visible = state.results.filter(r => !r.hidden)
      state.visibleSorted = sortResultsWithPinnedFavorites(visible, state.sortColumn, state.sortDirection, {
        pinFavorites: state.favoritesPinnedAndSticky,
        benchmarkResults: state.benchmarkResults,
      })
      if (state.cursor >= state.visibleSorted.length) state.cursor = Math.max(0, state.visibleSorted.length - 1)
      adjustScrollOffset(state)
    }
    const tableTerminalRows = state.terminalRows

    let tableContent = null
    // 📖 Clear expired header flash animation
    if (state.headerFlashColumn && state.frame >= state.headerFlashUntilFrame) {
      state.headerFlashColumn = null
    }

    // 📖 Build renderTable options once per frame — keeps all call sites in sync
    const tableOpts = {
      results: state.results,
      pendingPings: state.pendingPings,
      frame: state.frame,
      cursor: state.cursor,
      sortColumn: state.sortColumn,
      sortDirection: state.sortDirection,
      pingInterval: state.pingInterval,
      lastPingTime: state.lastPingTime,
      mode: state.mode,
      tierFilterMode: state.tierFilterMode,
      scrollOffset: state.scrollOffset,
      terminalRows: tableTerminalRows,
      terminalCols: state.terminalCols,
      originFilterMode: state.originFilterMode,
      pingMode: state.pingMode,
      pingModeSource: state.pingModeSource,
      hideUnconfiguredModels: state.hideUnconfiguredModels,
      widthWarningStartedAt: state.widthWarningStartedAt,
      widthWarningDismissed: state.widthWarningDismissed,
      settingsUpdateState: state.settingsUpdateState,
      settingsUpdateLatestVersion: state.settingsUpdateLatestVersion,
      startupLatestVersion: state.startupLatestVersion,
      versionAlertsEnabled: state.versionAlertsEnabled,
      updateWarningMessage: state.updateWarningMessage,
      favoritesPinnedAndSticky: state.favoritesPinnedAndSticky,
      customTextFilter: state.customTextFilter,
      lastReleaseDate: state.lastReleaseDate,
      verdictFilterMode: state.verdictFilterMode,
      healthFilterMode: state.healthFilterMode,
      bestModeOnly: state.bestModeOnly,
      benchmarkResults: state.benchmarkResults,
      benchmarkRunning: state.benchmarkRunning,
      headerFlashColumn: state.headerFlashColumn,
      probeRunning: state.probeRunning,
      probeTotal: state.probeTotal,
      probeCompleted: state.probeCompleted,
      probeHiddenCount: state.probeHiddenCount,
      // 📖 Space-expanded row (issue #168): "providerKey/modelId" or null
      expandedRowKey: state.expandedRowKey ?? null,
      // 📖 Non-fatal action error chip (issue #168): only shown while fresh
      actionErrorMsg: (state.actionErrorMsgUntil || 0) > Date.now() ? state.actionErrorMsg : null,
      // 📖 Probe-cache (t1): footer chip stats
      probeCacheHits: state.probeCacheHits || 0,
      probeCacheMisses: state.probeCacheMisses || 0,
      probeCacheBrokenHidden: state.probeCacheBrokenHidden || 0,
      showBrokenMode: !!state.showBrokenMode,
      // 📖 Provider circuit-breaker (issue #146): footer chip for paused providers
      pausedProviders: state.pausedProviders || {},
      // 📖 Enrichment chips (t4 + t5): benchmark catalog + models.dev provenance
      // 📖 Read fresh from moduleEnrichmentStats on every render so the async
      // 📖 models.dev fetch (background, never blocks the TUI) is reflected as
      // 📖 soon as it resolves — even if the user isn't pressing keys.
      enrichmentBenchCount: moduleEnrichmentStats.bench.total || 0,
      enrichmentBenchLastUpdated: moduleEnrichmentStats.bench.lastUpdated || null,
      metaSourceCounts: {
        'sources.js': moduleEnrichmentStats.modelsDev['sources.js'] || 0,
        'models.dev': moduleEnrichmentStats.modelsDev['models.dev'] || 0,
      },
      modelsDevCacheCached: moduleEnrichmentStats.modelsDev.cached === true,
      // 📖 Passive quota (t2): live snapshots from response headers, populated
      // 📖 by pings (every ping pre-warms quota for its provider). See
      // 📖 src/core/provider-quota-fetchers.js for getAllPassiveQuotas().
      quota: Object.fromEntries(_getAllPassiveQuotasFromModule()),
    }
    if (state.commandPaletteOpen) {
      if (!state.commandPaletteFrozenTable) {
        // 📖 Freeze the full table (including countdown and spinner glyphs) while
        // 📖 the command palette is open so the background remains perfectly static.
        state.commandPaletteFrozenTable = renderTable(tableOpts)
        tableContent = state.commandPaletteFrozenTable
      } else {
        // 📖 The frozen table is already on screen and cannot change while the
        // 📖 palette is open, so repaint the palette alone. Repainting the full
        // table every frame made large terminals flicker: the write gets split
        // into chunks, so the terminal showed the bare table for a moment
        // before the palette overlay painted over it, 30 times per second.
        tableContent = null
      }
    } else {
      state.commandPaletteFrozenTable = null
      tableContent = renderTable(tableOpts)
    }

    const content = state.settingsOpen
      ? overlays.renderSettings()
      : state.installEndpointsOpen
        ? overlays.renderInstallEndpoints()
      : state.toolInstallPromptOpen
        ? overlays.renderToolInstallPrompt()
      : state.installedModelsOpen
        ? overlays.renderInstalledModels()
      : state.routerDashboardOpen
        ? overlays.renderRouterDashboard()
      : state.routerV2DashboardOpen
        ? overlays.renderRouterV2Dashboard()
      : state.playgroundOpen
        ? overlays.renderPlayground()
      : state.tokenUsageOpen
        ? overlays.renderTokenUsage()
      : state.incompatibleFallbackOpen
        ? overlays.renderIncompatibleFallback()
      : state.commandPaletteOpen
        ? (tableContent || '') + overlays.renderCommandPalette()
      : state.recommendOpen
        ? overlays.renderRecommend()
        : state.helpVisible
                ? overlays.renderHelp()
              : state.changelogOpen
                ? overlays.renderChangelog()
                 : tableContent
    // 📖 Strip stale bg resets emitted by chalk across ALL renderers (table + overlays).
    const patched = patchThemeBg(content)
    process.stdout.write(ALT_HOME + patched)
    if (process.stdout.isTTY) {
      process.stdout.flush && process.stdout.flush()
    }
    } catch (err) {
      process.stdout.write(ALT_LEAVE);
      console.error(chalk.red('\n[TUI Render Error] An error occurred during UI rendering.'));
      console.error(err);
      console.error(chalk.yellow('\nPlease file an issue at https://github.com/vava-nessa/free-coding-models/issues or join the Discord to report this to the author.'));
      process.exit(1);
    }
  }, Math.round(1000 / FPS))

  // 📖 Populate visibleSorted before the first frame so Enter works immediately
  const initialVisible = state.results.filter(r => !r.hidden)
  state.visibleSorted = sortResultsWithPinnedFavorites(initialVisible, state.sortColumn, state.sortDirection, {
    pinFavorites: state.favoritesPinnedAndSticky,
    benchmarkResults: state.benchmarkResults,
  })

  process.stdout.write(ALT_HOME + patchThemeBg(renderTable({
    results: state.results,
    pendingPings: state.pendingPings,
    frame: state.frame,
    cursor: state.cursor,
    sortColumn: state.sortColumn,
    sortDirection: state.sortDirection,
    pingInterval: state.pingInterval,
    lastPingTime: state.lastPingTime,
    mode: state.mode,
    tierFilterMode: state.tierFilterMode,
    scrollOffset: state.scrollOffset,
    terminalRows: state.terminalRows,
    terminalCols: state.terminalCols,
    originFilterMode: state.originFilterMode,
    pingMode: state.pingMode,
    pingModeSource: state.pingModeSource,
    hideUnconfiguredModels: state.hideUnconfiguredModels,
    widthWarningStartedAt: state.widthWarningStartedAt,
    widthWarningDismissed: state.widthWarningDismissed,
    settingsUpdateState: state.settingsUpdateState,
    settingsUpdateLatestVersion: state.settingsUpdateLatestVersion,
    startupLatestVersion: state.startupLatestVersion,
    versionAlertsEnabled: state.versionAlertsEnabled,
    updateWarningMessage: state.updateWarningMessage,
    favoritesPinnedAndSticky: state.favoritesPinnedAndSticky,
    customTextFilter: state.customTextFilter,
    lastReleaseDate: state.lastReleaseDate,
    verdictFilterMode: state.verdictFilterMode,
    healthFilterMode: state.healthFilterMode,
    bestModeOnly: state.bestModeOnly,
    benchmarkResults: state.benchmarkResults,
    benchmarkRunning: state.benchmarkRunning,
  })))
  if (process.stdout.isTTY) {
    process.stdout.flush && process.stdout.flush()
  }

  // 📖 If --recommend was passed, auto-open the Smart Recommend overlay on start
  if (cliArgs.recommendMode) {
    state.recommendOpen = true
    state.recommendPhase = 'questionnaire'
    state.recommendCursor = 0
    state.recommendQuestion = 0
    state.recommendAnswers = { taskType: null, priority: null, contextBudget: null }
    state.recommendProgress = 0
    state.recommendResults = []
    state.recommendScrollOffset = 0
  }

  // 📖 Startup AI Speed Scan: opt-in setting that reuses the Ctrl+U path so the
  // 📖 automatic launch stays identical to the manual global benchmark behavior.
  // 📖 1.5s delay ensures the TUI has rendered at least one full frame and the
  // 📖 keypress handler pipeline is live before we simulate Ctrl+U.
  const scheduleAiSpeedScanOnStartup = () => {
    if (state.config.settings?.runAiSpeedTestOnStartup !== true) return
    setTimeout(() => {
      onKeyPress?.('\x15', { name: 'u', ctrl: true, meta: false, shift: false })?.catch(() => {})
    }, 1500)
  }

  // ── Continuous ping loop — ping all models every N seconds forever ──────────

  // 📖 Initial ping: skip models that are still fresh in the probe-cache (t1).
  // 📖 They already have valid data pre-filled and will be re-probed when their TTL expires.
  // 📖 Broken models are always re-probed so recovery is detected.
  const initialDueModels = state.results.filter(r => !isCacheFresh(r.providerKey, r.modelId, {
    ttlMs: state.probeCacheTtlMs,
  }))
  // 📖 Startup burst runs through runWithConcurrency(…, 5) - the same bounded
  // 📖 helper the 404 probe uses. The old Promise.all fired up to ~226
  // 📖 simultaneous pings at once, a guaranteed 429 storm on rate-limited
  // 📖 providers (and per-task errors are captured instead of rejecting the batch).
  const initialPing = runWithConcurrency(
    initialDueModels.map(r => () => pingModel(r)),
    5
  )

  // 📖 Continuous ping loop with mode-driven cadence.
  const runPingCycle = async () => {
    try {
    refreshAutoPingMode()

    // 📖 Command palette intentionally pauses background ping bursts to avoid
    // 📖 visible row jitter while users type and navigate commands.
    if (state.commandPaletteOpen) {
      state.lastPingTime = Date.now()
      scheduleNextPing()
      return
    }

    state.lastPingTime = Date.now()

    // 📖 Refresh persisted usage snapshots each cycle so background usage data appears live in table.
    // 📖 Freshness-aware: stale snapshots (>30m) are excluded and row reverts to undefined.
    for (const r of state.results) {
      const pct = _usageForRow(r.providerKey, r.modelId)
      if (typeof pct === 'number' && Number.isFinite(pct)) {
        r.usagePercent = pct
      } else {
        // If snapshot is now stale or gone, clear the cached value so UI shows N/A.
        r.usagePercent = undefined
      }
    }

    state.results.forEach(r => {
      // 📖 When a router dashboard is open, ONLY ping favorites every second
      // 📖 to prevent massive rate limiting across the entire 90+ model catalog.
      if (state.routerDashboardOpen || state.routerV2DashboardOpen) {
        const favKey = `${r.providerKey}/${r.modelId}`
        if (!state.config.favorites.includes(favKey)) return
      }

      // 📖 Per-provider circuit-breaker (issue #146): if the provider's quota is
      // 📖 paused (e.g. openrouter returned 429 "try again 50680s later"), skip
      // 📖 every model of that provider until the Retry-After window expires.
      // 📖 Without this, broken/overloaded models are re-pinged every cycle,
      // 📖 burning the user's daily quota in minutes.
      if (isProviderQuotaPaused(r.providerKey)) return

      // 📖 Probe-cache (t1): skip models that are still fresh + ok in the cache.
      // 📖 Broken models always pass through isCacheFresh() (it returns false for them),
      // 📖 which gives us automatic recovery detection for free.
      if (isCacheFresh(r.providerKey, r.modelId, { ttlMs: state.probeCacheTtlMs })) {
        return
      }

      pingModel(r).catch(() => {
        // Individual ping failures don't crash the loop
      })
    })

    // 📖 Take a snapshot of currently paused providers so the TUI footer can
    // 📖 surface a "⏸ openrouter (14h)" chip while we wait out a Retry-After.
    // 📖 Updates every cycle so the remaining-time ticks down live.
    state.pausedProviders = listPausedProviders()

    refreshAutoPingMode()
    scheduleNextPing()
    } catch (err) {
      process.stdout.write(ALT_LEAVE);
      console.error(chalk.red('\n[TUI Error] An error occurred in the ping loop.'));
      console.error(err);
      console.error(chalk.yellow('\nPlease file an issue at https://github.com/vava-nessa/free-coding-models/issues or join the Discord to report this to the author.'));
      process.exit(1);
    }
  }

  // 📖 Start the ping loop
  state.pingIntervalObj = null
  scheduleNextPing()

  await initialPing
  scheduleAiSpeedScanOnStartup()

  // 📖 Save caches after initial pings complete for faster next startup.
  // 📖 Both caches live side-by-side: the old per-session cache for instant frame-1
  // 📖 data, and the new persistent probe-cache for cross-session skip + auto-hide.
  saveCache(state.results, state.pingMode)
  flushProbeCache()

  // 📖 Background version re-check: poll npm registry every 5 minutes.
  // 📖 If a new version appears (wasn't there at startup), update the banner live.
  const VERSION_RECHECK_INTERVAL_MS = 5 * 60 * 1000
  state.versionRecheckTimer = setInterval(async () => {
    if (isDevMode || !state.versionAlertsEnabled) return
    try {
      const fresh = await checkForUpdate()
      if (fresh) {
        state.startupLatestVersion = fresh
      }
    } catch {}
  }, VERSION_RECHECK_INTERVAL_MS)

  // 📖 Router ON by default — no onboarding prompt, just auto-enable silently.
  const routerCfg = state.config?.router
  if (!routerCfg || routerCfg.onboardingSeen !== true || routerCfg.enabled !== true) {
    if (!state.config.router) state.config.router = {}
    state.config.router.enabled = true
    state.config.router.onboardingSeen = true
    saveConfig(state.config)
  }

  // 📖 Keep interface running forever - user can select anytime or Ctrl+C to exit
  // 📖 The pings continue running in background with dynamic interval
  // 📖 User can press W to decrease interval (faster pings) or = to increase (slower)
  // 📖 Current interval shown in header: "next ping Xs"
}

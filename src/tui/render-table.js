/**
 * @file render-table.js
 * @description Master table renderer for the main TUI list.
 *
 * @details
 *   This module contains the full renderTable implementation used by the CLI.
 *   It renders the header, model rows, status indicators, and footer hints
 *   with consistent alignment, colorization, and viewport clipping.
 *
 *   🎯 Key features:
 *   - Full table layout with micro verdict indicator, tier, latency, stability, uptime, token totals, and usage columns
 *   - Hotkey-aware header lettering so highlighted letters always match live sort/filter keys
 *   - Emoji-aware padding via padEndDisplay for aligned verdict/status cells
 *   - Viewport clipping with above/below indicators
 *   - Smart badges (mode, tier filter, origin filter)
 *   - Favorites mode hint surfaced directly in footer hints (`Y`)
 *   - High-visibility active text-filter banner with one-key clear action (`X`)
 *   - Full-width red outdated-version banner when a newer npm release is known
 *   - Distinct auth-failure vs missing-key health labels so configured providers stay honest
 *   - 80%-opacity row fade for "unusable" models (NO KEY / AUTH FAIL) so the user can spot at a glance
 *     which rows are not actually reachable, even when the cursor is parked elsewhere
 *
 *   → Functions:
 *   - `renderTable` — Render the full TUI table as a string (no side effects)
 *
 *   📦 Dependencies:
 *   - ../sources.js: sources provider metadata
 *   - ../src/constants.js: PING_INTERVAL, FRAMES
 *   - ../src/tier-colors.js: TIER_COLOR
 *   - ../src/utils.js: getAvg, getVerdict, getUptime, getStabilityScore
 *   - ../src/quota-capabilities.js: supportsUsagePercent
 *   - ../src/render-helpers.js: calculateViewport, sortResultsWithPinnedFavorites, padEndDisplay, fadedRow
 *
 *   @see bin/free-coding-models.js — main entry point that calls renderTable
 */

import chalk from 'chalk'
import { createRequire } from 'module'
import { sources } from '../../sources.js'
import {
  COL_MODEL,
  TIER_CYCLE,
  msCell,
  spinCell,
  PING_INTERVAL,
  WIDTH_WARNING_MIN_COLS,
  TABLE_FOOTER_LINES,
  FRAMES
} from '../core/constants.js'
import { themeColors, currentPalette, getProviderRgb, getTierRgb, getReadableTextRgb, getTheme, THEME_BG_RGB } from './theme.js'
import { TIER_COLOR } from './tier-colors.js'
import { getAvg, getVerdict, getUptime, getStabilityScore, getVersionStatusInfo, isNewModel } from '../core/utils.js'
import { supportsUsagePercent } from '../core/quota-capabilities.js'
import { formatBenchmarkLatency, formatBenchmarkTps } from '../core/benchmark.js'
import { calculateViewport, sortResultsWithPinnedFavorites, padEndDisplay, displayWidth, stripAnsi, fadedRow } from './render-helpers.js'
import { getToolMeta, TOOL_METADATA, TOOL_MODE_ORDER, isModelCompatibleWithTool } from '../core/tool-metadata.js'
import { getColumnSpacing } from './ui-config.js'
import { detectPackageManager, getManualInstallCmd } from '../core/updater.js'

const require = createRequire(import.meta.url)
const { version: LOCAL_VERSION } = require('../../package.json')

// 📖 Mouse support: column boundary map updated every frame by renderTable().
// 📖 Each entry maps a column name to its display X-start and X-end (1-based, inclusive).
// 📖 headerRow is the 1-based terminal row of the column header line.
// 📖 firstModelRow/lastModelRow are the 1-based terminal rows of the first/last visible model row.
// 📖 Exported so the mouse handler can translate click coordinates into column/row targets.
let _lastLayout = {
  columns: [],       // 📖 Array of { name, xStart, xEnd } in display order
  headerRow: 0,      // 📖 1-based terminal row of the column headers
  firstModelRow: 0,  // 📖 1-based terminal row of the first visible model
  lastModelRow: 0,   // 📖 1-based terminal row of the last visible model
  viewportStartIdx: 0, // 📖 index into sorted[] of the first visible model
  viewportEndIdx: 0,   // 📖 index into sorted[] past the last visible model
  hasAboveIndicator: false, // 📖 whether "... N more above ..." is shown
  hasBelowIndicator: false, // 📖 whether "... N more below ..." is shown
  footerHotkeys: [],  // 📖 Array of { key, row, xStart, xEnd } for footer click zones
  updateBannerRow: 0, // 📖 1-based terminal row of the fluorescent update banner (0 = none)
}
export function getLastLayout() { return _lastLayout }

// 📖 Column name → sort key mapping for mouse click-to-sort on header row
const COLUMN_SORT_MAP = {
  mood: 'verdict',
  rank: 'rank',
  tier: null, // 📖 Tier column click cycles tier filter rather than sorting
  swe: 'swe',
  ctx: 'ctx',
  model: 'model',
  source: 'origin',
  ping: 'ping',
  avg: 'avg',
  health: 'condition',
  verdict: 'verdict',
  stability: 'stability',
  uptime: 'uptime',
  aiLatency: 'aiLatency',
  tps: 'tps',
  quota: 'usage',
}
export { COLUMN_SORT_MAP }

// 📖 Provider column palette: soft pastel rainbow so each provider stays easy
// 📖 to spot without turning the table into a harsh neon wall.
// 📖 Exported for use in overlays (settings screen) and logs.
export const PROVIDER_COLOR = new Proxy({}, {
  get(_target, providerKey) {
    if (typeof providerKey !== 'string') return undefined
    return getProviderRgb(providerKey)
  },
})

/**
 * 📖 renderTable: Render the full TUI table as a string (no side effects).
 * 📖 Accepts a single options object so adding/removing params never silently breaks call sites.
 * 📖 `mode` controls footer hint text (opencode vs openclaw).
 *
 * @param {{
 *   results: Array,
 *   pendingPings: number,
 *   frame: number,
 *   cursor: number|null,
 *   sortColumn: string,
 *   sortDirection: string,
 *   pingInterval: number,
 *   lastPingTime: number,
 *   mode: string,
 *   tierFilterMode: number,
 *   scrollOffset: number,
 *   terminalRows: number,
 *   terminalCols: number,
 *   originFilterMode: number,
 *   pingMode: string,
 *   pingModeSource: string,
 *   hideUnconfiguredModels: boolean,
 *   widthWarningStartedAt: number|null,
 *   widthWarningDismissed: boolean,
 *   settingsUpdateState: string,
 *   settingsUpdateLatestVersion: string|null,
 *   startupLatestVersion: string|null,
 *   versionAlertsEnabled: boolean,
 *   updateWarningMessage?: string|null,
 *   favoritesPinnedAndSticky: boolean,
 *   customTextFilter: string|null,
 *   lastReleaseDate: string|null,
 *   verdictFilterMode: number,
 *   healthFilterMode: number,
 *   bestModeOnly: boolean,
 *   routerFooterRunning?: boolean,
 *   routerFooterActiveSet?: string|null,
 *   routerFooterTodayTokens?: number,
 *   routerFooterAllTimeTokens?: number,
 *   routerFooterRequests?: number,
 *   probeCacheHits?: number,         // t1: number of fresh ok entries served from probe-cache
 *   probeCacheMisses?: number,       // t1: number of models that needed a live probe
 *   probeCacheBrokenHidden?: number, // t1: number of broken models auto-hidden this session
 *   showBrokenMode?: boolean,        // t1: true when Shift+B has un-hidden broken models
 *   enrichmentBenchCount?: number,   // t4: extended benchmark catalog size (committed JSON)
 *   enrichmentBenchLastUpdated?: string, // t4: lastUpdated field from the catalog _meta
 *   metaSourceCounts?: {             // t5: count of models per metadata source
 *     'sources.js': number,
 *     'models.dev': number,
 *   },
 *   modelsDevCacheCached?: boolean,  // t5: whether the models.dev cache is still within TTL
 *   expandedRowKey?: string|null,    // 📖 issue #168: Space-expanded row ("provider/modelId"), renders a 2-line detail card under the cursor row
 *   actionErrorMsg?: string|null,    // 📖 issue #168: non-fatal command/probe failure shown as a footer chip instead of crashing
 *   quota?: Record<string, {         // t2: live quota from response headers
 *     remaining: number, limit: number, percent: number,
 *     source: 'header'|'endpoint', lastUpdated: number, windowType?: string,
 *   }>,
 * }} opts
 * @returns {string}
 */
export function renderTable({
  results = [],
  pendingPings = 0,
  frame = 0,
  cursor = null,
  sortColumn = 'avg',
  sortDirection = 'asc',
  pingInterval = PING_INTERVAL,
  lastPingTime = Date.now(),
  mode = 'opencode',
  tierFilterMode = 0,
  scrollOffset = 0,
  terminalRows = 0,
  terminalCols = 0,
  originFilterMode = 0,
  pingMode = 'normal',
  pingModeSource = 'auto',
  hideUnconfiguredModels = false,
  widthWarningStartedAt = null,
  widthWarningDismissed = false,
  settingsUpdateState = 'idle',
  settingsUpdateLatestVersion = null,
  startupLatestVersion = null,
  versionAlertsEnabled = true,
  updateWarningMessage = null,
  favoritesPinnedAndSticky = false,
  customTextFilter = null,
  lastReleaseDate = null,
  verdictFilterMode = 0,
  healthFilterMode = 0,
  bestModeOnly = false,
  routerFooterRunning = false,
  routerFooterActiveSet = null,
  routerFooterTodayTokens = 0,
  routerFooterAllTimeTokens = 0,
  routerFooterRequests = 0,
  benchmarkResults = {},
  benchmarkRunning = new Set(),
  headerFlashColumn = null,
  probeRunning = false,
  probeTotal = 0,
  probeCompleted = 0,
  probeHiddenCount = 0,
  expandedRowKey = null,         // 📖 issue #168: "providerKey/modelId" of the Space-expanded row (null = collapsed)
  actionErrorMsg = null,         // 📖 issue #168: non-fatal command/probe failure for the footer chip
  probeCacheHits = 0,
  probeCacheMisses = 0,
  probeCacheBrokenHidden = 0,
  showBrokenMode = false,
  pausedProviders = {},          // 📖 issue #146: { openrouter: 50680000 } while a provider is paused
  enrichmentBenchCount = 0,
  enrichmentBenchLastUpdated = null,
  metaSourceCounts = null,
  modelsDevCacheCached = false,
  quota = {},
} = _) {
  // 📖 Filter out hidden models for display
  const visibleResults = results.filter(r => !r.hidden)

  const up      = visibleResults.filter(r => r.status === 'up').length
  const down    = visibleResults.filter(r => r.status === 'down').length
  const timeout = visibleResults.filter(r => r.status === 'timeout').length
  const pending = visibleResults.filter(r => r.status === 'pending').length
  const totalVisible = visibleResults.length
  const completedPings = Math.max(0, totalVisible - pending)

  // 📖 Calculate seconds until next ping
  const timeSinceLastPing = Date.now() - lastPingTime
  const timeUntilNextPing = Math.max(0, pingInterval - timeSinceLastPing)
  const secondsUntilNext = timeUntilNextPing / 1000
  const secondsUntilNextLabel = secondsUntilNext.toFixed(2)

  const intervalSec = Math.round(pingInterval / 1000)
  const pingModeMeta = {
    speed: { label: 'fast', color: themeColors.warningBold },
    normal: { label: 'normal', color: themeColors.accentBold },
    slow: { label: 'slow', color: themeColors.info },
    forced: { label: 'forced', color: themeColors.errorBold },
  }
  const activePingMode = pingModeMeta[pingMode] ?? pingModeMeta.normal
  const pingProgressText = `${completedPings}/${totalVisible}`
  const nextCountdownColor = secondsUntilNext > 8
    ? themeColors.errorBold
    : secondsUntilNext >= 4
      ? themeColors.warningBold
      : secondsUntilNext < 1
        ? themeColors.successBold
        : themeColors.success
  const pingControlBadge =
    activePingMode.color(' [ ') +
    themeColors.hotkey('W') +
    activePingMode.color(` Ping Interval : ${intervalSec}s (${activePingMode.label}) - ${pingProgressText} - next : `) +
    nextCountdownColor(`${secondsUntilNextLabel}s`) +
    activePingMode.color(' ]')

  // 📖 Tool badge keeps the active launch target visible in the header, so the
  // 📖 footer no longer needs a redundant Enter action or mode toggle reminder.
  // 📖 Tool name is colored with its unique tool color for quick recognition.
  const toolMeta = getToolMeta(mode)
  const toolBadgeColor = mode === 'openclaw' ? themeColors.warningBold : themeColors.accentBold
  const toolColor = toolMeta.color ? chalk.rgb(...toolMeta.color) : toolBadgeColor
  const modeBadge = toolBadgeColor(' [ ') + themeColors.hotkey('Z') + toolBadgeColor(' Tool : ') + toolColor.bold(`${toolMeta.emoji} ${toolMeta.label}`) + toolBadgeColor(' ]')

  const activeHeaderBadge = (text, bg) => themeColors.badge(text, bg, getReadableTextRgb(bg))
  const versionStatus = getVersionStatusInfo(settingsUpdateState, settingsUpdateLatestVersion, startupLatestVersion, versionAlertsEnabled)

  // 📖 Tier filter badge shown when filtering is active (shows exact tier name)
  const TIER_CYCLE_NAMES = [null, 'S+', 'S', 'A+', 'A', 'A-', 'B+', 'B', 'C']
  let tierBadge = ''
  let activeTierLabel = ''
  if (tierFilterMode > 0) {
    activeTierLabel = TIER_CYCLE_NAMES[tierFilterMode]
    const tierBg = getTierRgb(activeTierLabel)
    tierBadge = ` ${activeHeaderBadge(`TIER (${activeTierLabel})`, tierBg)}`
  }

  const normalizeOriginLabel = (name, key) => {
    if (key === 'qwen') return 'Alibaba'
    return name
  }

  // 📖 Origin filter badge — shown when filtering by provider is active
  let originBadge = ''
  let activeOriginLabel = ''
  if (originFilterMode > 0) {
    const originKeys = [null, ...Object.keys(sources)]
    const activeOriginKey = originKeys[originFilterMode]
    const activeOriginName = activeOriginKey ? sources[activeOriginKey]?.name ?? activeOriginKey : null
    if (activeOriginName) {
      activeOriginLabel = normalizeOriginLabel(activeOriginName, activeOriginKey)
      const providerRgb = PROVIDER_COLOR[activeOriginKey] || [255, 255, 255]
      originBadge = ` ${activeHeaderBadge(`PROVIDER (${activeOriginLabel})`, providerRgb)}`
    }
  }

  // 📖 Column widths (generous spacing with margins)
  const COL_SEP = getColumnSpacing()
  const SEP_W = 3  // ' │ ' display width
  const ROW_MARGIN = 2  // left margin '  '
  const W_MOOD = 2
  const W_RANK = 6
  const W_TIER = 5
  const W_CTX = 4
  const W_SOURCE = 15
  // 📖 Provider names are display-capped at MAX_PROVIDER_NAME_LEN chars so an
  // 📖 over-long label can never push the following cells and desalign the
  // 📖 whole row (Cloudflare AI at 13 chars overflowed the old 11-wide column).
  // 📖 Anything longer is cut to 13 chars + '…' = 14 visible chars. Keep new
  // 📖 provider names in sources.js at MAX_PROVIDER_NAME_LEN chars or less.
  const MAX_PROVIDER_NAME_LEN = 14
  const W_MODEL = 26
  const W_SWE = 5
  const W_STATUS = 17
  const W_VERDICT = 13
  const W_UPTIME = 6
  const W_AI_LATENCY = 17
  const W_TPS = 5
  const W_QUOTA = 6

  // const W_TOKENS = 7 // Used column removed
  const MIN_TABLE_WIDTH = WIDTH_WARNING_MIN_COLS

  // 📖 Responsive column visibility: progressively hide least-useful columns
  // 📖 and shorten header labels when terminal width is insufficient.
  // 📖 Hiding order (least useful first): Rank → AI Latency/TPS → Up% → Tier → Stability
  // 📖 Ping columns stay compact because the cell values are tiny numbers without a "ms" suffix.
  // 📖 Both ping columns use the same 9-char width so Last Ping and Avg Ping fit cleanly.
  // 📖 Compact mode also shrinks Stability→StaB. (8), Provider→4chars+… (7), Health→6chars+… (13).
  // 📖 Breakpoints are computed dynamically from active column widths.
  let wPing = 9
  let wAvg = 9
  let wStab = 11
  let wSource = W_SOURCE
  let wModel = W_MODEL
  let wStatus = W_STATUS
  let wAiLatency = W_AI_LATENCY
  let showRank = true
  let showBenchmarkColumns = true
  let showUptime = true
  let showTier = true
  let showStability = true
  let isCompact = false

  if (terminalCols > 0) {
    // 📖 Dynamically compute needed row width from visible columns
    const calcWidth = () => {
      const cols = []
      cols.push(W_MOOD)
      if (showRank) cols.push(W_RANK)
      if (showTier) cols.push(W_TIER)
      cols.push(W_SWE, W_CTX, wModel, wSource, wPing, wAvg, wStatus, W_VERDICT)
      if (showStability) cols.push(wStab)
      if (showUptime) cols.push(W_UPTIME)
      if (showBenchmarkColumns) cols.push(wAiLatency, W_TPS)
      cols.push(W_QUOTA)
      return ROW_MARGIN + cols.reduce((a, b) => a + b, 0) + (cols.length - 1) * SEP_W
    }

    // 📖 Step 1: Compact mode — shorten labels and reduce column widths
    if (calcWidth() > terminalCols) {
      isCompact = true
      wPing = 9      // 'Last Ping' stays compact and matches Avg Ping width
      wAvg = 9       // 'Avg Ping' stays aligned with Last Ping
      wStab = 8      // 'StaB.' instead of 'Stability'
      wSource = 7    // Provider truncated to 4 chars + '…', 7 cols total
      wModel = 21    // Keep compact tables wide enough for Rank + Quota
      wStatus = 13   // Health truncated after 6 chars + '…'
      wAiLatency = 9 // Keep compact tables wide enough for Rank + Quota
    }
    // 📖 Steps 2–6: Progressive column hiding (least useful first)
    if (calcWidth() > terminalCols) showRank = false
    if (calcWidth() > terminalCols) showBenchmarkColumns = false
    if (calcWidth() > terminalCols) showUptime = false
    if (calcWidth() > terminalCols) showTier = false
    if (calcWidth() > terminalCols) showStability = false
  }

  // 📖 Mouse support: compute column boundaries from the resolved responsive widths.
  // 📖 This builds an ordered array of { name, xStart, xEnd } (1-based display columns)
  // 📖 matching exactly what renderTable paints so click-to-sort hits the right column.
  {
    const colDefs = []
    colDefs.push({ name: 'mood', width: W_MOOD })
    if (showRank) colDefs.push({ name: 'rank', width: W_RANK })
    if (showTier) colDefs.push({ name: 'tier', width: W_TIER })
    colDefs.push({ name: 'swe', width: W_SWE })
    colDefs.push({ name: 'ctx', width: W_CTX })
    colDefs.push({ name: 'model', width: wModel })
    colDefs.push({ name: 'source', width: wSource })
    colDefs.push({ name: 'ping', width: wPing })
    colDefs.push({ name: 'avg', width: wAvg })
    colDefs.push({ name: 'health', width: wStatus })
    colDefs.push({ name: 'verdict', width: W_VERDICT })
    if (showStability) colDefs.push({ name: 'stability', width: wStab })
    if (showUptime) colDefs.push({ name: 'uptime', width: W_UPTIME })
    if (showBenchmarkColumns) {
      colDefs.push({ name: 'aiLatency', width: wAiLatency })
      colDefs.push({ name: 'tps', width: W_TPS })
    }
    colDefs.push({ name: 'quota', width: W_QUOTA })
    let x = ROW_MARGIN + 1 // 📖 1-based: first column starts after the 2-char left margin
    const columns = []
    for (let i = 0; i < colDefs.length; i++) {
      const { name, width } = colDefs[i]
      const xEnd = x + width - 1
      columns.push({ name, xStart: x, xEnd })
      x = xEnd + 1 + SEP_W // 📖 skip past the ' │ ' separator
    }
    _lastLayout.columns = columns
  }
  const warningDurationMs = 2_000
  const elapsed = widthWarningStartedAt ? Math.max(0, Date.now() - widthWarningStartedAt) : warningDurationMs
  const remainingMs = Math.max(0, warningDurationMs - elapsed)
  const showWidthWarning = terminalCols > 0 && terminalCols < MIN_TABLE_WIDTH && !widthWarningDismissed && remainingMs > 0

  if (showWidthWarning) {
    const lines = []
    const blankLines = Math.max(0, Math.floor(((terminalRows || 24) - 7) / 2))
    const warning = '🖥️  Please maximize your terminal for optimal use.'
    const warning2 = '⚠️  The current terminal is too small.'
    const warning3 = '📏  Reduce font size or maximize width of terminal.'
    const padLeft = Math.max(0, Math.floor((terminalCols - warning.length) / 2))
    const padLeft2 = Math.max(0, Math.floor((terminalCols - warning2.length) / 2))
    const padLeft3 = Math.max(0, Math.floor((terminalCols - warning3.length) / 2))
    for (let i = 0; i < blankLines; i++) lines.push('')
    lines.push(' '.repeat(padLeft) + themeColors.errorBold(warning))
    lines.push('')
    lines.push(' '.repeat(padLeft2) + themeColors.error(warning2))
    lines.push('')
    lines.push(' '.repeat(padLeft3) + themeColors.error(warning3))
    lines.push('')
    lines.push(' '.repeat(Math.max(0, Math.floor((terminalCols - 34) / 2))) + themeColors.warning(`this message will hide in ${(remainingMs / 1000).toFixed(1)}s`))
    const barTotal = Math.max(0, Math.min(terminalCols - 4, 30))
    const barFill = Math.round((elapsed / warningDurationMs) * barTotal)
    const barStr = themeColors.success('█'.repeat(barFill)) + themeColors.dim('░'.repeat(barTotal - barFill))
    lines.push(' '.repeat(Math.max(0, Math.floor((terminalCols - barTotal) / 2))) + barStr)
    lines.push(' '.repeat(Math.max(0, Math.floor((terminalCols - 20) / 2))) + themeColors.dim('press esc to dismiss'))
    while (terminalRows > 0 && lines.length < terminalRows) lines.push('')
    const EL = '\x1b[K'
    return lines.map(line => line + EL).join('\n')
  }

  // 📖 Sort models using the shared helper
  const sorted = sortResultsWithPinnedFavorites(visibleResults, sortColumn, sortDirection, {
    pinFavorites: favoritesPinnedAndSticky,
    benchmarkResults,
  })

  // 📖 Header logo colours — theme-aware bg/green/white
  const hB = currentPalette().headerLogoBg
  const hG = currentPalette().headerLogoGreen
  const hW = currentPalette().headerLogoWhite
  const hBold = (color, text) => chalk.rgb(...color).bgRgb(...hB).bold(text)

  const lines = [
    `  ${hBold(hG, ' > ')}${hBold(hG, 'free')}${hBold(hW, '-coding-models')}${hBold(hG, '_ ')} ${themeColors.dim(`v${LOCAL_VERSION}`)}${modeBadge}${pingControlBadge}${tierBadge}${originBadge}${chalk.reset('')}   ` +
      themeColors.dim('📦 ') + themeColors.accentBold(`${completedPings}/${totalVisible}`) + themeColors.dim('  ') +
      themeColors.success(`✅ ${up}`) + themeColors.dim(' up  ') +
      themeColors.warning(`⏳ ${timeout}`) + themeColors.dim(' timeout  ') +
      themeColors.error(`❌ ${down}`) + themeColors.dim(' down  ') +
      '',
  ]

  // 📖 Header row with sorting indicators
  // 📖 NOTE: padEnd on chalk strings counts ANSI codes, breaking alignment
  // 📖 Solution: build plain text first, then colorize
  const dir = sortDirection === 'asc' ? '↑' : '↓'

  // 📖 Plain header labels — arrows are appended dynamically below.
  const moodLabel    = '❔'
  const rankLabel    = 'Rank'
  const tierLabel    = 'Tier'
  const originLabel  = isCompact ? 'PrOD…' : 'Provider'
  const modelLabel   = 'Model'
  const sweLabel     = 'SWE%'
  const ctxLabel     = 'CTX'
  const pingLabel    = 'Last Ping'
  const avgLabel     = 'Avg Ping'
  const healthLabel  = 'Health'
  const verdictLabel = 'Verdict'
  const stabLabel    = isCompact ? 'StaB.' : 'Stability'
  const uptimeLabel  = 'Up%'

  // 📖 Helper to colorize first letter for keyboard shortcuts
  // 📖 IMPORTANT: Pad PLAIN TEXT first, then apply colors to avoid alignment issues
  const colorFirst = (text, width, colorFn = themeColors.hotkey) => {
    const first = text[0]
    const rest = text.slice(1)
    const plainText = first + rest
    const padding = ' '.repeat(Math.max(0, width - plainText.length))
    return colorFn(first) + themeColors.dim(rest + padding)
  }

  // 📖 Flash animation: when a column header is clicked, it briefly renders with
  // 📖 a vivid inverse style (bright accent bg + white bold fg) for ~250ms.
  // 📖 This gives satisfying visual feedback that the click was registered.
  const flashHeader = (plainText, width) => {
    const padded = plainText.length <= width ? plainText.padEnd(width) : plainText.slice(0, width)
    const bg = currentPalette().accentStrong
    const fg = getReadableTextRgb(bg)
    return chalk.bold.rgb(...fg).bgRgb(...bg)(padded)
  }

  // 📖 Sort-active header: renders the column header with a subtle background color
  // 📖 to visually indicate which column is currently sorted.
  // 📖 Includes the ↑/↓ arrow and bold white text on a tinted background.
  // 📖 If the arrow prefix doesn't fit, appends it: 'SWE↑' instead of '↑ SWE%'.
  const sortActiveHeader = (label, width) => {
    const arrow = dir
    const prefixed = arrow + ' ' + label
    const text = prefixed.length <= width ? prefixed : label + arrow
    const padded = text.padEnd(width).slice(0, width)
    // 📖 Subtle dark accent background — visible but not overwhelming.
    const bg = currentPalette().cursor.defaultBg
    const fg = getReadableTextRgb(bg)
    return chalk.bold.rgb(...fg).bgRgb(...bg)(padded)
  }

  // 📖 Now colorize each column header.
  // 📖 Three rendering states per column:
  // 📖   1. FLASH  — headerFlashColumn matches → vivid inverse style (click feedback)
  // 📖   2. ACTIVE — sortColumn matches → subtle bg + ↑/↓ arrow
  // 📖   3. DEFAULT — normal dim text with highlighted first letter

  // 📖 Helper: pick the right style for a standard column header.
  // 📖 colKey = sort key (e.g. 'rank', 'swe'), label = plain text, width = column width.
  const headerStyle = (colKey, label, width) => {
    const arrowText = dir + ' ' + label
    const flashText = arrowText.length <= width ? arrowText : label + dir
    if (headerFlashColumn === colKey) return flashHeader(flashText, width)
    if (sortColumn === colKey) return sortActiveHeader(label, width)
    return colorFirst(label, width)
  }

  const moodH_c    = (() => {
    // 📖 Tiny verdict indicator column: keep it emoji-only, no arrow, so it stays 2 cells wide.
    const padded = padEndDisplay(moodLabel, W_MOOD)
    if (headerFlashColumn === 'verdict') return chalk.bold.rgb(...getReadableTextRgb(currentPalette().accentStrong)).bgRgb(...currentPalette().accentStrong)(padded)
    if (sortColumn === 'verdict') return chalk.bold.rgb(...getReadableTextRgb(currentPalette().cursor.defaultBg)).bgRgb(...currentPalette().cursor.defaultBg)(padded)
    return themeColors.hotkey(padded)
  })()
  const rankH_c    = headerStyle('rank', rankLabel, W_RANK)
  const tierH_c    = (() => {
    if (headerFlashColumn === 'tier') return flashHeader(tierLabel, W_TIER)
    return colorFirst(tierLabel, W_TIER)
  })()
  const modelH_c   = headerStyle('model', modelLabel, wModel)
  const sweH_c     = headerStyle('swe', sweLabel, W_SWE)
  const ctxH_c     = headerStyle('ctx', ctxLabel, W_CTX)
  const pingH_c    = headerStyle('ping', pingLabel, wPing)
  const avgH_c     = headerStyle('avg', avgLabel, wAvg)
  const healthH_c  = headerStyle('condition', healthLabel, wStatus)
  const verdictH_c = headerStyle('verdict', verdictLabel, W_VERDICT)
  const stabH_c    = (() => {
    if (headerFlashColumn === 'stability') {
      const ft = (dir + ' ' + stabLabel).length <= wStab ? dir + ' ' + stabLabel : stabLabel + dir
      return flashHeader(ft, wStab)
    }
    if (sortColumn === 'stability') return sortActiveHeader(stabLabel, wStab)
    const plain = stabLabel
    const padding = ' '.repeat(Math.max(0, wStab - plain.length))
    return themeColors.dim('Sta') + themeColors.hotkey('B') + themeColors.dim((isCompact ? '.' : 'ility') + padding)
  })()
  const uptimeH_c  = (() => {
    if (headerFlashColumn === 'uptime') {
      const ft = (dir + ' ' + uptimeLabel).length <= W_UPTIME ? dir + ' ' + uptimeLabel : uptimeLabel + dir
      return flashHeader(ft, W_UPTIME)
    }
    if (sortColumn === 'uptime') return sortActiveHeader(uptimeLabel, W_UPTIME)
    const padding = ' '.repeat(Math.max(0, W_UPTIME - uptimeLabel.length))
    return themeColors.hotkey('U') + themeColors.dim('p%' + padding)
  })()
  const originH_c  = (() => {
    if (headerFlashColumn === 'origin') {
      const ft = (dir + ' ' + originLabel).length <= wSource ? dir + ' ' + originLabel : originLabel + dir
      return flashHeader(ft, wSource)
    }
    if (sortColumn === 'origin') return sortActiveHeader(originLabel, wSource)
    if (originFilterMode > 0) return themeColors.accentBold(originLabel.padEnd(wSource))
    const plain = isCompact ? 'PrOD…' : 'PrOviDer'
    const padding = ' '.repeat(Math.max(0, wSource - plain.length))
    if (isCompact) {
      return themeColors.dim('Pr') + themeColors.hotkey('O') + themeColors.hotkey('D') + themeColors.dim('…' + padding)
    }
    return themeColors.dim('Pr') + themeColors.hotkey('O') + themeColors.dim('vi') + themeColors.hotkey('D') + themeColors.dim('er' + padding)
  })()

  // 📖 Benchmark headers — split the old combined AI Speed field into latency + throughput.
  const aiLatencyLabel = isCompact ? 'AI Lat.' : 'AI Latency'
  const aiLatencyH_c = (() => {
    if (headerFlashColumn === 'aiLatency') {
      const ft = (dir + ' ' + aiLatencyLabel).length <= wAiLatency ? dir + ' ' + aiLatencyLabel : aiLatencyLabel + dir
      return flashHeader(ft, wAiLatency)
    }
    if (sortColumn === 'aiLatency') return sortActiveHeader(aiLatencyLabel, wAiLatency)
    const plain = aiLatencyLabel
    const padding = ' '.repeat(Math.max(0, wAiLatency - plain.length))
    return themeColors.dim(plain + padding)
  })()
  const tpsH_c = (() => {
    if (headerFlashColumn === 'tps') {
      const ft = (dir + ' ' + 'TPS').length <= W_TPS ? dir + ' ' + 'TPS' : 'TPS' + dir
      return flashHeader(ft, W_TPS)
    }
    if (sortColumn === 'tps') return sortActiveHeader('TPS', W_TPS)
    const plain = 'TPS'
    const padding = ' '.repeat(Math.max(0, W_TPS - plain.length))
    return themeColors.dim(plain + padding)
  })()
  const quotaH_c = (() => {
    if (headerFlashColumn === 'quota' || headerFlashColumn === 'usage') {
      const ft = (dir + ' Quota').length <= W_QUOTA ? dir + ' Quota' : 'Quota' + dir
      return flashHeader(ft, W_QUOTA)
    }
    if (sortColumn === 'usage') return sortActiveHeader('Quota', W_QUOTA)
    return themeColors.dim('Quota'.padEnd(W_QUOTA))
  })()

  // 📖 Header row: conditionally include columns based on responsive visibility
  const headerParts = [moodH_c]
  if (showRank) headerParts.push(rankH_c)
  if (showTier) headerParts.push(tierH_c)
  headerParts.push(sweH_c, ctxH_c, modelH_c, originH_c, pingH_c, avgH_c, healthH_c, verdictH_c)
  if (showStability) headerParts.push(stabH_c)
  if (showUptime) headerParts.push(uptimeH_c)
  if (showBenchmarkColumns) headerParts.push(aiLatencyH_c, tpsH_c)
  headerParts.push(quotaH_c)
  lines.push('  ' + headerParts.join(COL_SEP))

  // 📖 Mouse support: the column header row is the last line we just pushed.
  // 📖 Terminal rows are 1-based, so line index (lines.length-1) → terminal row lines.length.
  _lastLayout.headerRow = lines.length



  if (sorted.length === 0) {
    lines.push('')
    if (hideUnconfiguredModels) {
      lines.push(`  ${themeColors.errorBold('Press P to configure your API key.')}`)
      lines.push(`  ${themeColors.dim('No configured provider currently exposes visible models in the table.')}`)
    } else {
      lines.push(`  ${themeColors.warningBold('No models match the current filters.')}`)
    }
  }

  // 📖 Viewport clipping: only render models that fit on screen
  const hasCustomFilter = typeof customTextFilter === 'string' && customTextFilter.trim().length > 0
  const hasReleaseFooter = typeof lastReleaseDate === 'string' && lastReleaseDate.trim().length > 0
  const extraFooterLines = (versionStatus.isOutdated ? 1 : 0) + (hasCustomFilter ? 1 : 0) + (hasReleaseFooter ? 1 : 0)

  // 📖 Expanded row detail (issue #168): Space toggles a 2-line card under the
  // 📖 cursor row showing provider + model specifics that tight columns truncate.
  // 📖 The card only renders when the expanded key still matches the cursor row
  // 📖 (any cursor move clears state.expandedRowKey), and the viewport reserves
  // 📖 2 lines up front so the footer never gets pushed off-screen.
  const EXPANDED_DETAIL_LINES = 2
  const cursorRow = cursor !== null ? sorted[cursor] : null
  const expansionActive = !!expandedRowKey && !!cursorRow
    && `${cursorRow.providerKey}/${cursorRow.modelId}` === expandedRowKey
  const vp = calculateViewport(terminalRows, scrollOffset, sorted.length, {
    extraFixedLines: extraFooterLines + (expansionActive ? EXPANDED_DETAIL_LINES : 0),
  })

  // 📖 clipPlainWidth: Clip a PLAIN string (no ANSI codes) to a max display
  // 📖 width, appending an ellipsis when truncated. Used by the Space detail
  // 📖 card so long endpoint URLs and model IDs degrade gracefully on narrow
  // 📖 terminals instead of wrapping the table.
  const clipPlainWidth = (text, max) => {
    if (max <= 0) return ''
    const chars = [...String(text)]
    let w = 0
    let out = ''
    for (const ch of chars) {
      const cw = displayWidth(ch)
      if (w + cw > max - 1) return out + '…'
      out += ch
      w += cw
    }
    return out
  }
  const paintSweScore = (score, paddedText) => {
    if (score >= 70) return chalk.bold.rgb(...getTierRgb('S+'))(paddedText)
    if (score >= 60) return chalk.bold.rgb(...getTierRgb('S'))(paddedText)
    if (score >= 50) return chalk.bold.rgb(...getTierRgb('A+'))(paddedText)
    if (score >= 40) return chalk.rgb(...getTierRgb('A'))(paddedText)
    if (score >= 35) return chalk.rgb(...getTierRgb('A-'))(paddedText)
    if (score >= 30) return chalk.rgb(...getTierRgb('B+'))(paddedText)
    if (score >= 20) return chalk.rgb(...getTierRgb('B'))(paddedText)
    return chalk.rgb(...getTierRgb('C'))(paddedText)
  }

  if (vp.hasAbove) {
    lines.push(themeColors.dim(`  ... ${vp.startIdx} more above ...`))
  }

  // 📖 Mouse support: record where model rows begin in the terminal (1-based).
  // 📖 The next line pushed will be the first visible model row.
  const _firstModelLineIdx = lines.length  // 📖 0-based index into lines[]
  _lastLayout.viewportStartIdx = vp.startIdx
  _lastLayout.viewportEndIdx = vp.endIdx
  _lastLayout.hasAboveIndicator = vp.hasAbove
  _lastLayout.hasBelowIndicator = vp.hasBelow

  for (let i = vp.startIdx; i < vp.endIdx; i++) {
    const r = sorted[i]
    const tierFn = TIER_COLOR[r.tier] ?? ((text) => themeColors.text(text))

    const isCursor = cursor !== null && i === cursor

    // 📖 Left-aligned columns - pad plain text first, then colorize
    const num = themeColors.dim(String(r.idx).padEnd(W_RANK))
    const tier = tierFn(r.tier.padEnd(W_TIER))
    // 📖 Keep terminal view provider-specific so each row is monitorable per provider
    // 📖 In compact mode, truncate provider name to 4 chars + '…'
    // 📖 In normal mode, cap names at MAX_PROVIDER_NAME_LEN chars (13 + '…')
    // 📖 so an over-long label never shifts every cell to its right.
    const providerNameRaw = sources[r.providerKey]?.name ?? r.providerKey ?? 'NIM'
    const providerName = normalizeOriginLabel(providerNameRaw, r.providerKey)
    const providerDisplay = isCompact && providerName.length > 5
      ? providerName.slice(0, 4) + '…'
      : providerName.length > MAX_PROVIDER_NAME_LEN
        ? providerName.slice(0, MAX_PROVIDER_NAME_LEN - 1).trimEnd() + '…'
        : providerName
    const source = themeColors.provider(r.providerKey, providerDisplay.padEnd(wSource))
    // 📖 Prefix: ⭐ favorite > 🎯 recommended > 🆕 new — only one emoji, never shifts the line
    const modelIsNew = isNewModel(r.addedDate)
    let favoritePrefix = ''
    if (r.isRecommended) {
      favoritePrefix = '🎯 '
    } else if (r.isFavorite) {
      favoritePrefix = '⭐ '
    } else if (modelIsNew) {
      favoritePrefix = '🆕 '
    }
    const prefixDisplayWidth = displayWidth(favoritePrefix)
    const nameWidth = Math.max(0, wModel - prefixDisplayWidth)
    const name = favoritePrefix + r.label.slice(0, nameWidth).padEnd(nameWidth)
    const sweScore = r.sweScore ?? '—'
    // 📖 SWE% colorized on the same gradient as Tier:
    //   ≥70% bright neon green (S+), ≥60% green (S), ≥50% yellow-green (A+),
    //   ≥40% yellow (A), ≥35% amber (A-), ≥30% orange-red (B+),
    //   ≥20% red (B), <20% dark red (C), '—' dim
    let sweCell
    if (sweScore === '—') {
      sweCell = themeColors.dim(sweScore.padEnd(W_SWE))
    } else {
      const sweVal = parseFloat(sweScore)
      const swePadded = sweScore.padEnd(W_SWE)
      sweCell = paintSweScore(sweVal, swePadded)
    }
    
    // 📖 Context window column - colorized by size (larger = better), gradient from red→orange→yellow→green
    const ctxRaw = r.ctx ?? '—'
    let ctxCell
    if (ctxRaw === '—') {
      ctxCell = themeColors.dim(ctxRaw.padEnd(W_CTX))
    } else {
      const ctxMatch = ctxRaw.match(/^(\d+)k$|^(\d+)M$/)
      if (ctxMatch) {
        const numK = ctxMatch[1] ? parseInt(ctxMatch[1]) : parseInt(ctxMatch[2]) * 1024
        ctxCell = numK <= 32
          ? themeColors.metricBad(ctxRaw.padEnd(W_CTX))
          : numK <= 64
          ? themeColors.metricWarn(ctxRaw.padEnd(W_CTX))
          : numK <= 128
          ? chalk.rgb(...currentPalette().ctxGold).bold(ctxRaw.padEnd(W_CTX))
          : numK <= 256
          ? chalk.rgb(...currentPalette().ctxGreen).bold(ctxRaw.padEnd(W_CTX))
          : numK <= 400
          ? chalk.rgb(...currentPalette().ctxTeal).bold(ctxRaw.padEnd(W_CTX))
          : chalk.rgb(...currentPalette().ctxCyan).bold.underline(ctxRaw.padEnd(W_CTX))
      } else {
        ctxCell = themeColors.dim(ctxRaw.padEnd(W_CTX))
      }
    }

    // 📖 Keep the row-local spinner small and inline so users can still read the last measured latency.
    const buildLatestPingDisplay = (value) => {
      const spinner = r.isPinging ? ` ${FRAMES[frame % FRAMES.length]}` : ''
      return `${value}${spinner}`.padEnd(wPing)
    }

    // 📖 Latest ping - pings are objects: { ms, code }
    // 📖 Show response time for 200 (success) and 401 (no-auth but server is reachable)
    const latestPing = r.pings.length > 0 ? r.pings[r.pings.length - 1] : null
    let pingCell
    if (!latestPing) {
      const placeholder = r.isPinging ? buildLatestPingDisplay('———') : '———'.padEnd(wPing)
      pingCell = themeColors.dim(placeholder)
    } else if (latestPing.code === '200') {
      // 📖 Success - show response time
      const str = buildLatestPingDisplay(String(latestPing.ms))
      pingCell = latestPing.ms < 500 ? themeColors.metricGood(str) : latestPing.ms < 1500 ? themeColors.metricWarn(str) : themeColors.metricBad(str)
    } else if (latestPing.code === '401') {
      // 📖 401 = no API key but server IS reachable — still show latency in dim
      pingCell = themeColors.dim(buildLatestPingDisplay(String(latestPing.ms)))
    } else {
      // 📖 Error or timeout - show "———" (error code is already in Status column)
      const placeholder = r.isPinging ? buildLatestPingDisplay('———') : '———'.padEnd(wPing)
      pingCell = themeColors.dim(placeholder)
    }

    // 📖 Avg ping (just number, no "ms")
    const avg = getAvg(r)
    let avgCell
    if (avg !== Infinity) {
      const str = String(avg).padEnd(wAvg)
      avgCell = avg < 500 ? themeColors.metricGood(str) : avg < 1500 ? themeColors.metricWarn(str) : themeColors.metricBad(str)
    } else {
      avgCell = themeColors.dim('———'.padEnd(wAvg))
    }

    // 📖 Status column - build plain text with emoji, pad, then colorize
    // 📖 Different emojis for different error codes
    let statusText, statusColor
    if (r.status === 'noauth') {
      // 📖 Server responded but needs an API key — shown dimly since it IS reachable
      statusText = `🔑 NO KEY`
      statusColor = themeColors.dim
    } else if (r.status === 'auth_error') {
      // 📖 A key is configured but the provider rejected it — keep this distinct
      // 📖 from "no key" so configured-only mode does not look misleading.
      statusText = `🔐 AUTH FAIL`
      statusColor = themeColors.errorBold
    } else if (r.status === 'pending') {
      statusText = `${FRAMES[frame % FRAMES.length]} wait`
      statusColor = themeColors.warning
    } else if (r.status === 'up') {
      statusText = `✅ UP`
      statusColor = themeColors.success
    } else if (r.status === 'timeout') {
      statusText = `⏳ TIMEOUT`
      statusColor = themeColors.warning
    } else if (r.status === 'down') {
      const code = r.httpCode ?? 'ERR'
      // 📖 Different emojis for different error codes
      const errorEmojis = {
        '429': '🔥',  // Rate limited / overloaded
        '404': '🚫',  // Not found
        '500': '💥',  // Internal server error
        '502': '🔌',  // Bad gateway
        '503': '🔒',  // Service unavailable
        '504': '⏰',  // Gateway timeout
      }
      const errorLabels = {
        '404': '404 NOT FOUND',
        '410': '410 GONE',
        '429': '429 TRY LATER',
        '500': '500 ERROR',
      }
      const emoji = errorEmojis[code] || '❌'
      statusText = `${emoji} ${errorLabels[code] || code}`
      statusColor = themeColors.error
    } else {
      statusText = '?'
      statusColor = themeColors.dim
    }
    // 📖 In compact mode, truncate health text after 6 visible chars + '…' to fit wStatus
    const statusDisplayText = isCompact ? (() => {
      // 📖 Strip emoji prefix to measure text length, then truncate if needed
      const plainText = statusText.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*/u, '')
      if (plainText.length > 6) {
        const emojiMatch = statusText.match(/^([\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*)/u)
        const prefix = emojiMatch ? emojiMatch[1] : ''
        return prefix + plainText.slice(0, 6) + '…'
      }
      return statusText
    })() : statusText
    const status = statusColor(padEndDisplay(statusDisplayText, wStatus))

  // 📖 Verdict column - use getVerdict() for stability-aware verdicts, then render with emoji
  const verdict = getVerdict(r)
  let verdictText, verdictIcon, verdictColor
  // 📖 Verdict colors follow the same green→red gradient as TIER_COLOR / SWE%
  switch (verdict) {
    case 'Perfect':
      verdictIcon = '🟩'
      verdictText = `${verdictIcon} Perfect`
      verdictColor = themeColors.successBold
      break
    case 'Normal':
      verdictIcon = '🟢'
      verdictText = `${verdictIcon} Normal`
      verdictColor = themeColors.metricGood
      break
    case 'Spiky':
      verdictIcon = '🟡'
      verdictText = `${verdictIcon} Spiky`
      verdictColor = (text) => chalk.bold.rgb(...getTierRgb('A+'))(text)
      break
    case 'Slow':
      verdictIcon = '🟠'
      verdictText = `${verdictIcon} Slow`
      verdictColor = (text) => chalk.bold.rgb(...getTierRgb('A-'))(text)
      break
    case 'Very Slow':
      verdictIcon = '🔴'
      verdictText = `${verdictIcon} Very Slow`
      verdictColor = (text) => chalk.bold.rgb(...getTierRgb('B+'))(text)
      break
    case 'Overloaded':
      verdictIcon = '🔥'
      verdictText = `${verdictIcon} Overloaded`
      verdictColor = (text) => chalk.bold.rgb(...getTierRgb('B'))(text)
      break
    case 'Unstable':
      // 📖 Avoid ⚠️ here: its variation selector has inconsistent terminal width and shifts the tiny ❔ column.
      verdictIcon = '🟥'
      verdictText = `${verdictIcon} Unstable`
      verdictColor = themeColors.errorBold
      break
    case 'Not Active':
      verdictIcon = '⚫'
      verdictText = `${verdictIcon} Not Active`
      verdictColor = themeColors.dim
      break
    case 'Pending':
      verdictIcon = '⏳'
      verdictText = `${verdictIcon} Pending`
      verdictColor = themeColors.dim
      break
    default:
      verdictIcon = '💀'
      verdictText = `${verdictIcon} Unusable`
      verdictColor = (text) => chalk.bold.rgb(...getTierRgb('C'))(text)
      break
  }
  const speedCell = verdictColor(padEndDisplay(verdictText, W_VERDICT))
  const moodCell = padEndDisplay(verdictIcon, W_MOOD)

    // 📖 Stability column - composite score (0–100) from p95 + jitter + spikes + uptime
    // 📖 Left-aligned to sit flush under the column header
    const stabScore = getStabilityScore(r)
    let stabCell
    if (stabScore < 0) {
      stabCell = themeColors.dim('———'.padEnd(wStab))
    } else if (stabScore >= 80) {
      stabCell = themeColors.metricGood(String(stabScore).padEnd(wStab))
    } else if (stabScore >= 60) {
      stabCell = themeColors.metricOk(String(stabScore).padEnd(wStab))
    } else if (stabScore >= 40) {
      stabCell = themeColors.metricWarn(String(stabScore).padEnd(wStab))
    } else {
      stabCell = themeColors.metricBad(String(stabScore).padEnd(wStab))
    }

    // 📖 Uptime column - percentage of successful pings
    // 📖 Left-aligned to sit flush under the column header
    const uptimePercent = getUptime(r)
    const uptimeStr = uptimePercent + '%'
    let uptimeCell
    if (uptimePercent >= 90) {
      uptimeCell = themeColors.metricGood(uptimeStr.padEnd(W_UPTIME))
    } else if (uptimePercent >= 70) {
      uptimeCell = themeColors.metricWarn(uptimeStr.padEnd(W_UPTIME))
    } else if (uptimePercent >= 50) {
      uptimeCell = chalk.rgb(...getTierRgb('A-'))(uptimeStr.padEnd(W_UPTIME))
    } else {
      uptimeCell = themeColors.metricBad(uptimeStr.padEnd(W_UPTIME))
    }

    // 📖 Model text now mirrors the provider hue so provider affinity is visible
    // 📖 even before the eye reaches the Provider column.
    const nameCell = themeColors.provider(r.providerKey, name, { bold: isCursor })
    const sourceCursorText = providerDisplay.padEnd(wSource)
    const sourceCell = isCursor ? themeColors.provider(r.providerKey, sourceCursorText, { bold: true }) : source

    // 📖 Check if this model is incompatible with the active tool mode
    const isIncompatible = !isModelCompatibleWithTool(r.providerKey, mode)

    // 📖 Quota column: provider telemetry if available, N/A when impossible,
    // 📖 and '-' when the provider is not configured.
    let quotaCell
    if (!r.hasApiKey) {
      quotaCell = themeColors.dim('-'.padEnd(W_QUOTA))
    } else if (!supportsUsagePercent(r.providerKey)) {
      quotaCell = themeColors.dim('N/A'.padEnd(W_QUOTA))
    } else if (typeof r.usagePercent === 'number' && Number.isFinite(r.usagePercent)) {
      const quotaText = `${Math.round(r.usagePercent)}%`.padEnd(W_QUOTA)
      quotaCell = r.usagePercent >= 50
        ? themeColors.metricGood(quotaText)
        : r.usagePercent >= 20
          ? themeColors.metricWarn(quotaText)
          : themeColors.metricBad(quotaText)
    } else {
      quotaCell = themeColors.dim('…'.padEnd(W_QUOTA))
    }

    // 📖 AI Latency + TPS columns — same benchmark result, split into two readable metrics.
    // 📖 Benchmark results are shown regardless of health status (up/timeout/down/429/noauth).
    // 📖 If benchmark failed → red dash. Error details live in the Health column.
    // 📖 If no benchmark has been run yet, show dim dash.
    // 📖 Retry badge (↻N) is colored blue and spaced from the main value.
    const benchmarkKey = `${r.providerKey}/${r.modelId}`
    const benchmarkResult = benchmarkResults[benchmarkKey]
    const isBenchmarkRunning = benchmarkRunning.has(benchmarkKey)
    const hasBenchmark = benchmarkResult || isBenchmarkRunning
    const benchmarkOk = benchmarkResult && benchmarkResult.ok

    // 📖 Build latency cell: value + blue retry badge
    const latParsed = isBenchmarkRunning
      ? formatBenchmarkLatency(benchmarkResult, { running: true, frame })
      : benchmarkOk
        ? formatBenchmarkLatency(benchmarkResult)
        : { text: '—', retryBadge: '' }
    const latValue = benchmarkOk
      ? themeColors.metricGood(latParsed.text)
      : hasBenchmark
        ? themeColors.metricBad(latParsed.text)
        : themeColors.dim(latParsed.text)
    const latBadge = latParsed.retryBadge
      ? themeColors.info(' ' + latParsed.retryBadge)
      : ''
    const latBadgeWidth = latParsed.retryBadge ? displayWidth(' ' + latParsed.retryBadge) : 0
    const latPad = wAiLatency - displayWidth(latParsed.text) - latBadgeWidth
    const latencyCell = latValue + latBadge + themeColors.dim(''.padEnd(Math.max(0, latPad)))

    // 📖 Build TPS cell: value + blue retry badge
    const tpsParsed = isBenchmarkRunning
      ? formatBenchmarkTps(benchmarkResult, { running: true, frame })
      : benchmarkOk
        ? formatBenchmarkTps(benchmarkResult)
        : { text: '—', retryBadge: '' }
    const tpsValue = benchmarkOk || isBenchmarkRunning
      ? themeColors.metricGood(tpsParsed.text)
      : hasBenchmark
        ? themeColors.metricBad(tpsParsed.text)
        : themeColors.dim(tpsParsed.text)
    const tpsBadge = tpsParsed.retryBadge
      ? themeColors.info(' ' + tpsParsed.retryBadge)
      : ''
    const tpsBadgeWidth = tpsParsed.retryBadge ? displayWidth(' ' + tpsParsed.retryBadge) : 0
    const tpsPad = W_TPS - displayWidth(tpsParsed.text) - tpsBadgeWidth
    const tpsCell = tpsValue + tpsBadge + themeColors.dim(''.padEnd(Math.max(0, tpsPad)))

    // 📖 Build row: conditionally include columns based on responsive visibility
    const rowParts = [moodCell]
    if (showRank) rowParts.push(num)
    if (showTier) rowParts.push(tier)
    rowParts.push(sweCell, ctxCell, nameCell, sourceCell, pingCell, avgCell, status, speedCell)
    if (showStability) rowParts.push(stabCell)
    if (showUptime) rowParts.push(uptimeCell)
    if (showBenchmarkColumns) rowParts.push(latencyCell, tpsCell)
    rowParts.push(quotaCell)
    const row = '  ' + rowParts.join(COL_SEP)

    // 📖 "Unusable" models (no key / bad key) are visually de-emphasized at the
    // 📖 row level. The user cannot actually send a request to these models, so
    // 📖 we drop the whole line to 80% opacity (20% less opaque) so it stands
    // 📖 out from working rows at a glance, even if the cursor is parked on a
    // 📖 different model. The cursor always wins so the user never loses track
    // 📖 of their active selection. fadedRow multiplies every 24-bit RGB
    // 📖 channel by 0.8 so the result works on every terminal that supports
    // 📖 truecolor (no reliance on the SGR 2 "faint" code, which is ignored by
    // 📖 some terminals).
    const isUnusable = r.status === 'noauth' || r.status === 'auth_error'

    let renderedRow
    if (isCursor) {
      renderedRow = themeColors.bgModelCursor(row)
    } else if (isIncompatible) {
      // 📖 Dark red background for models incompatible with the active tool mode.
      // 📖 This visually warns the user that selecting this model won't work with their current tool.
      renderedRow = chalk.bgRgb(...currentPalette().rowDimBg).rgb(...currentPalette().rowDimFg)(row)
    } else if (r.isRecommended) {
      // 📖 Medium green background for recommended models (distinguishable from favorites)
      renderedRow = themeColors.bgModelRecommended(row)
    } else if (r.isFavorite) {
      renderedRow = themeColors.bgModelFavorite(row)
    } else {
      renderedRow = row
    }
    lines.push(isUnusable ? fadedRow(renderedRow, 0.8) : renderedRow)

    // 📖 Expanded detail card (issue #168): 2 lines under the selected row so
    // 📖 provider and model specifics stay readable even when tight columns
    // 📖 truncate them. Plain text is built first, clipped to the terminal
    // 📖 width, then colorized (same pattern as the table header).
    if (isCursor && expansionActive) {
      const maxDetailWidth = Math.max(0, (terminalCols || 80) - 4)
      const keyText = r.hasApiKey ? 'key configured' : 'no key'
      const endpoint = sources[r.providerKey]?.url ?? 'unknown endpoint'
      const detailProvider = clipPlainWidth(
        `  ↳ ${providerName} (${r.providerKey}) · ${keyText} · ${endpoint}`,
        maxDetailWidth
      )
      const lastMsText = latestPing
        ? (typeof latestPing.ms === 'number' ? `${latestPing.ms}ms` : String(latestPing.ms))
        : 'no ping yet'
      const lastCodeText = latestPing ? `HTTP ${latestPing.code}` : ''
      const detailModel = clipPlainWidth(
        `  ↳ ${r.modelId} · tier ${r.tier} · SWE ${r.sweScore ?? '-'} · ctx ${r.ctx ?? '-'} · last ${lastMsText}${lastCodeText ? ` ${lastCodeText}` : ''} · added ${r.addedDate ?? '-'}`,
        maxDetailWidth
      )
      lines.push(themeColors.provider(r.providerKey, detailProvider))
      lines.push(themeColors.dim(detailModel))
    }
  }

  // 📖 Mouse support: record the 1-based terminal row range of model data rows.
  // 📖 _firstModelLineIdx was captured before the loop; lines.length is now past the last model row.
  _lastLayout.firstModelRow = _firstModelLineIdx + 1  // 📖 convert 0-based line index → 1-based terminal row
  _lastLayout.lastModelRow = lines.length              // 📖 last pushed line is at lines.length (1-based)

  if (vp.hasBelow) {
    lines.push(themeColors.dim(`  ... ${sorted.length - vp.endIdx} more below ...`))
  }

  // 📖 Blank lines keep the footer glued to the bottom without touching the sticky header.
  if (terminalRows > 0) {
    const footerLineCount = TABLE_FOOTER_LINES + extraFooterLines
    const blankCount = Math.max(0, terminalRows - lines.length - footerLineCount)
    for (let i = 0; i < blankCount; i++) lines.push('')
  }

  // 📖 Footer hints keep only navigation and secondary actions now that the
  // 📖 active tool target is already visible in the header badge.
  const hotkey = (keyLabel, text) => themeColors.hotkey(keyLabel) + themeColors.dim(text)
  // 📖 Active filter pills use a loud green background so tier/provider/configured-only
  // 📖 states are obvious even when the user misses the smaller header badges.
  const configuredBadgeBg = getTheme() === 'dark' ? [52, 120, 88] : [195, 234, 206]

  const configuredFilterActive = hideUnconfiguredModels || bestModeOnly
  const configuredFilterText = bestModeOnly ? 'Usable only' : (hideUnconfiguredModels ? 'Configured only' : 'Active only')
  const activeHotkey = (keyLabel, text, bg) => themeColors.badge(`${keyLabel}${text}`, bg, getReadableTextRgb(bg))
  const activeFilterHotkey = (keyLabel, text, bg) => themeColors.hotkey(keyLabel) + themeColors.badge(text, bg, getReadableTextRgb(bg))

  // 📖 Mouse support: build footer hotkey zones alongside the footer lines.
  // 📖 Each zone records { key, row (1-based terminal row), xStart, xEnd (1-based display cols) }.
  // 📖 We accumulate display position as we build each footer line's parts.
  const footerHotkeys = []

  // 📖 Line 1: core navigation + filtering shortcuts
  // 📖 Build as parts array so we can compute click zones and still join for display.
  {
    const parts = [
      { text: '  ', key: null },
      { text: 'F Favorite', key: 'f' },
      { text: '  •  ', key: null },
      { text: 'Y  Fav Mode', key: 'y' },
      { text: '  •  ', key: null },
      { text: tierFilterMode > 0 ? `T Tier (${activeTierLabel})` : 'T Tier', key: 't' },
      { text: '  •  ', key: null },
      { text: originFilterMode > 0 ? `D Provider (${activeOriginLabel})` : 'D Provider', key: 'd' },
      { text: '  •  ', key: null },
      { text: `E ${configuredFilterText}`, key: 'e' },
      { text: '  •  ', key: null },
      { text: 'P Settings', key: 'p' },
      { text: '  •  ', key: null },
      { text: 'I Help', key: 'i' },
      { text: '  •  ', key: null },
      { text: 'N Reset', key: 'n' },
      { text: '  •  ', key: null },
      { text: 'G Theme', key: 'g' },
    ]
    const footerRow1 = lines.length + 1 // 📖 1-based terminal row (line hasn't been pushed yet)
    let xPos = 1
    for (const part of parts) {
      const w = displayWidth(part.text)
      if (part.key) footerHotkeys.push({ key: part.key, row: footerRow1, xStart: xPos, xEnd: xPos + w - 1 })
      xPos += w
    }
  }

  lines.push(
    '  ' + hotkey('F', ' Favorite') +
    themeColors.dim(`  •  `) +
    hotkey('Y', ' Fav Mode') +
    themeColors.dim(`  •  `) +
    (tierFilterMode > 0
      ? activeHotkey('T', ` Tier (${activeTierLabel})`, getTierRgb(activeTierLabel))
      : hotkey('T', ' Tier')) +
    themeColors.dim(`  •  `) +
    (originFilterMode > 0
      ? activeHotkey('D', ` Provider (${activeOriginLabel})`, PROVIDER_COLOR[[null, ...Object.keys(sources)][originFilterMode]] || [255, 255, 255])
      : hotkey('D', ' Provider')) +
    themeColors.dim(`  •  `) +
    (configuredFilterActive
      ? activeFilterHotkey('E', configuredFilterText, configuredBadgeBg)
      : hotkey('E', ' Active only')) +
    themeColors.dim(`  •  `) +
    hotkey('P', ' Settings') +
    themeColors.dim(`  •  `) +
    hotkey('I', ' Help') +
    themeColors.dim(`  •  `) +
    hotkey('N', ' Reset') +
    themeColors.dim(`  •  `) +
    themeColors.hotkey('G') + themeColors.infoBold(' Theme')
  )

  // 📖 Line 2: command palette + GitHub
  {
    const cpText = ' Ctrl+P Cmd Palette '
    const parts = [
      { text: '  ', key: null },
      { text: cpText, key: 'ctrl+p' },
      { text: '  ', key: null },
    ]
    const footerRow2 = lines.length + 1
    let xPos = 1
    for (const part of parts) {
      const w = displayWidth(part.text)
      if (part.key) footerHotkeys.push({ key: part.key, row: footerRow2, xStart: xPos, xEnd: xPos + w - 1 })
      xPos += w
    }
  }

  // 📖 Line 2: command palette (simple color, no background) + GitHub link.
  const paletteLabel = chalk.rgb(...currentPalette().cmdPalette).bold('Ctrl+P Cmd Palette')
  const starLink = '⭐ ' + themeColors.link('\x1b]8;;https://github.com/vava-nessa/free-coding-models\x1b\\GitHub\x1b]8;;\x1b\\')
  lines.push(
    '  ' + paletteLabel + themeColors.dim(`  •  `) + starLink + themeColors.dim(`  •  `) +
    chalk.rgb(...currentPalette().twitterLink).bold('\x1b]8;;https://x.com/vavanessadev\x1b\\Follow @vavanessadev on X for updates and support\x1b]8;;\x1b\\')
  )

  if (versionStatus.isOutdated) {
    const updateMsg = updateWarningMessage
      ? `  ${updateWarningMessage}  •  Press Shift+U to retry update  `
      : `  🚀⬆️ UPDATE AVAILABLE — v${LOCAL_VERSION} → v${versionStatus.latestVersion}  •  Click here or press Shift+U to update  🚀⬆️  `
    const paddedBanner = terminalCols > 0
      ? updateMsg + ' '.repeat(Math.max(0, terminalCols - displayWidth(updateMsg)))
      : updateMsg
    const updateBanner = updateWarningMessage
      ? chalk.bgRgb(...currentPalette().updateBannerErrorBg).rgb(...currentPalette().updateBannerErrorFg).bold(paddedBanner)
      : chalk.bgRgb(...currentPalette().updateBannerBg).rgb(...currentPalette().updateBannerFg).bold(paddedBanner)
    const updateBannerRow = lines.length + 1
    _lastLayout.updateBannerRow = updateBannerRow
    footerHotkeys.push({ key: 'update-click', row: updateBannerRow, xStart: 1, xEnd: Math.max(terminalCols, displayWidth(updateMsg)) })
    lines.push(updateBanner)
  } else {
    _lastLayout.updateBannerRow = 0
  }

  // 📖 Optional active text-filter badge — surfaced inline if a custom filter is active.
  // 📖 Changelog moved to Settings (P), Ctrl+C Exit moved to Help (Ctrl+H), Discord
  // 📖 moved to onboarding + Settings — no more orphan hint lines down here.
  let filterBadge = ''
  if (hasCustomFilter) {
    const normalizedFilter = customTextFilter.trim().replace(/\s+/g, ' ')
    const filterPrefix = 'X Disable filter: "'
    const filterSuffix = '"'
    const baseBadgeWidth = displayWidth(` ${filterPrefix}${filterSuffix} `)
    const availableFilterWidth = terminalCols > 0
      ? Math.max(8, terminalCols - 4 - baseBadgeWidth)
      : normalizedFilter.length
    const visibleFilter = normalizedFilter.length > availableFilterWidth
      ? `${normalizedFilter.slice(0, Math.max(3, availableFilterWidth - 3))}...`
      : normalizedFilter
    filterBadge = chalk.bgYellow.black.bold(` ${filterPrefix}${visibleFilter}${filterSuffix} `)
  }

  if (hasCustomFilter) {
    // 📖 Mouse support: register click zone for the X-clear filter badge
    const lastFooterRow = lines.length + 1
    const badgePlain = `X Disable filter: "${customTextFilter.trim().replace(/\s+/g, ' ')}"`
    const fullText = '  ' + ` ${badgePlain} `
    const xStart = 3 // 📖 after the leading 2 spaces
    const xEnd = xStart + displayWidth(` ${badgePlain} `) - 1
    footerHotkeys.push({ key: 'x', row: lastFooterRow, xStart, xEnd })
    void fullText
    lines.push('  ' + filterBadge)
  }

  const releaseLabel = lastReleaseDate
    ? chalk.rgb(...currentPalette().releaseDate)(`Last release: ${lastReleaseDate}`)
    : ''
  const speedTestLabel = chalk.bgRgb(...currentPalette().badgeSpeedTestBg).rgb(...currentPalette().badgeSpeedTestFg).bold(' NEW ⭐️ Ctrl+A 🤖 AI Speed Test ')
  const globalBenchmarkLabel = chalk.bgRgb(...currentPalette().badgeBenchmarkBg).rgb(...currentPalette().badgeBenchmarkFg).bold(' NEW Ctrl+U : Global AI Speed Test (Uses a lot of requests!) ')

  // 📖 Probe badge: show progress when 404 probe is running or recently completed.
  // 📖 Bar width is clamped to 0-20 cells (issue #168 kick-out fix): a transient
  // 📖 counter hiccup must never reach String.repeat with a negative count - a
  // 📖 RangeError here crashes the render interval and kills the whole TUI.
  let probeLabel = ''
  if (probeRunning) {
    const pct = probeTotal > 0 ? Math.round((probeCompleted / probeTotal) * 100) : 0
    const filled = Math.max(0, Math.min(20, Math.floor(pct / 5)))
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled)
    probeLabel = chalk.bgRgb(180, 40, 40).rgb(255, 255, 255).bold(` 🔍 Probe ${bar} ${probeCompleted}/${probeTotal} `)
  } else if (probeHiddenCount > 0 && probeTotal > 0) {
    probeLabel = chalk.bgRgb(120, 60, 60).rgb(255, 200, 200).bold(` 🔍 Probe done: ${probeHiddenCount} broken model${probeHiddenCount > 1 ? 's' : ''} hidden `)
  }

  // 📖 Probe-cache chip (t1): `⚡ N cached · 🔴 M broken (Shift+B)`
  // 📖 Always shown once any probe-cache state exists — gives the user a hint that
  // 📖 cache hits are happening (and that broken models are being hidden for them).
  let probeCacheLabel = ''
  if (probeCacheHits > 0 || probeCacheBrokenHidden > 0 || showBrokenMode) {
    const cachedTxt = `⚡ ${probeCacheHits} cached`
    const brokenTxt = probeCacheBrokenHidden > 0
      ? ` 🔴 ${probeCacheBrokenHidden} broken${showBrokenMode ? ' (visible)' : ' (Shift+B)'}`
      : ''
    probeCacheLabel = chalk.bgRgb(40, 90, 140).rgb(220, 235, 255).bold(` ${cachedTxt}${brokenTxt} `)
  }

  // 📖 Provider circuit-breaker chip (issue #146): surfaces any provider that the
  // 📖 health-ping loop has paused because it returned a 429 quota response.
  // 📖 Format: `⏸ openrouter 14h · ⏸ mistral 5m`. The live duration auto-rolls
  // 📖 to s/m/h/d so users see a real countdown and don't get surprised later
  // 📖 when their requests stop working ("wait, why is everything 429-ing?").
  let pausedProvidersLabel = ''
  if (pausedProviders && typeof pausedProviders === 'object') {
    const fmtRemaining = (ms) => {
      if (!Number.isFinite(ms) || ms <= 0) return '0s'
      const totalSec = Math.round(ms / 1000)
      const day = Math.floor(totalSec / 86400)
      const hr = Math.floor((totalSec % 86400) / 3600)
      const min = Math.floor((totalSec % 3600) / 60)
      const sec = totalSec % 60
      if (day > 0) return `${day}d${hr}h`
      if (hr > 0) return `${hr}h${min}m`
      if (min > 0) return `${min}m${sec}s`
      return `${sec}s`
    }
    const entries = Object.entries(pausedProviders)
      .filter(([, ms]) => Number.isFinite(ms) && ms > 0)
      .sort(([a], [b]) => a.localeCompare(b))
    if (entries.length > 0) {
      const txt = entries.map(([k, ms]) => `⏸ ${k} ${fmtRemaining(ms)}`).join(' \u00b7 ')
      // 📖 Warm amber background — distinct from the blue probe-cache chip so the
      // 📖 user can spot it at a glance and understand "these providers are resting".
      pausedProvidersLabel = chalk.bgRgb(140, 80, 30).rgb(255, 230, 200).bold(` ${txt} `)
    }
  }

  // 📖 Enrichment chips (t4 + t5):
  // 📖 `📊 bench N (date) · 📡 live K / 📦 cached M`
  // 📖 Always shown when any enrichment state exists.
  let enrichmentLabel = ''
  if ((enrichmentBenchCount && enrichmentBenchCount > 0) || metaSourceCounts) {
    const parts = []
    if (enrichmentBenchCount && enrichmentBenchCount > 0) {
      const dateTxt = enrichmentBenchLastUpdated && enrichmentBenchLastUpdated !== 'unknown'
        ? ` (${enrichmentBenchLastUpdated})`
        : ''
      parts.push(`📊 bench ${enrichmentBenchCount}${dateTxt}`)
    }
    if (metaSourceCounts && (metaSourceCounts['models.dev'] > 0 || metaSourceCounts['sources.js'] > 0)) {
      const liveTxt = metaSourceCounts['models.dev'] ?? 0
      const cachedTxt = metaSourceCounts['sources.js'] ?? 0
      const liveIcon = modelsDevCacheCached ? '📡' : '📦'
      parts.push(`${liveIcon} ${liveTxt} live · ${cachedTxt} curated`)
    }
    if (parts.length > 0) {
      enrichmentLabel = chalk.bgRgb(80, 50, 110).rgb(230, 220, 245).bold(` ${parts.join(' · ')} `)
    }
  }

  // 📖 Passive quota chip (t2): `📊 groq 78% · sambanova 41%` (top-N depleted first).
  // 📖 Shows live rate-limit headers that the daemon / pings collected from upstream
  // 📖 responses. Zero extra network requests — see provider-quota-fetchers.js.
  // 📖 Cap at 5 providers to avoid footer bloat; pick most-depleted first.
  let quotaLabel = ''
  if (quota && typeof quota === 'object') {
    const entries = Object.entries(quota)
      .filter(([, s]) => s && typeof s.percent === 'number')
      .sort((a, b) => a[1].percent - b[1].percent)  // 📖 most depleted first
      .slice(0, 5)
    if (entries.length > 0) {
      const parts = entries.map(([providerKey, snap]) => {
        const icon = snap.percent <= 10 ? '🚨' : snap.percent <= 25 ? '⚠️ ' : '📊'
        return `${icon} ${providerKey} ${snap.percent}%`
      })
      quotaLabel = chalk.bgRgb(60, 100, 60).rgb(220, 255, 220).bold(` ${parts.join(' · ')} `)
    }
  }

  // 📖 Action error chip (issue #168): non-fatal failures from command palette
  // 📖 actions or the 404 probe land here instead of crashing the TUI. Red chip
  // 📖 so it reads as an error, auto-expires (app.js passes null when stale).
  let actionErrorLabel = ''
  if (actionErrorMsg) {
    actionErrorLabel = chalk.bgRgb(170, 30, 30).rgb(255, 220, 220).bold(` ⚠ ${actionErrorMsg} `)
  }

  // 📖 Line 3: Speed Test + Global Benchmark + Probe + Probe-cache + Paused-providers + Enrichment + Quota + Last release
  if (releaseLabel || speedTestLabel || globalBenchmarkLabel || probeLabel || probeCacheLabel || pausedProvidersLabel || enrichmentLabel || quotaLabel || actionErrorLabel) {
    const parts = [
      { text: '  ', key: null },
      { text: speedTestLabel, key: 'a' },
      { text: '  ', key: null },
      { text: globalBenchmarkLabel, key: 'u' },
      { text: probeLabel ? '  ' : '', key: null },
      { text: probeLabel, key: null },
      { text: actionErrorLabel ? '  ' : '', key: null },
      { text: actionErrorLabel, key: null },
      { text: probeCacheLabel ? '  ' : '', key: null },
      { text: probeCacheLabel, key: null },
      { text: pausedProvidersLabel ? '  ' : '', key: null },
      { text: pausedProvidersLabel, key: null },
      { text: enrichmentLabel ? '  ' : '', key: null },
      { text: enrichmentLabel, key: null },
      { text: quotaLabel ? '  ' : '', key: null },
      { text: quotaLabel, key: null },
      { text: '  ', key: null },
      { text: releaseLabel, key: null },
    ]
    const footerRow3 = lines.length + 1
    let xPos = 1
    for (const part of parts) {
      const w = displayWidth(part.text)
      if (part.key) footerHotkeys.push({ key: part.key, row: footerRow3, xStart: xPos, xEnd: xPos + w - 1 })
      xPos += w
    }
    const line = parts.map(p => p.text).join('')
    lines.push(line)
  }
  _lastLayout.footerHotkeys = footerHotkeys

  // 📖 Force the theme's background colour on every line so light/dark mode
  // 📖 is respected even when the terminal's native theme doesn't match.
  // 📖 
  // 📖 Each line is prefixed with \x1b[48;2;R;G;Bm so the content always renders
  // 📖 on the correct background, then \x1b[K fills to end-of-line.
  // 📖 No \x1b[49m (bg reset) is ever emitted — the theme bg persists across frames.
  const bgRgb = THEME_BG_RGB[getTheme()] ?? THEME_BG_RGB.dark
  const BG_SET = `\x1b[48;2;${bgRgb[0]};${bgRgb[1]};${bgRgb[2]}m`
  // 📖 Each line: set bg → render content → erase to EOL (fills with theme bg)
  const cleared = lines.map(l => BG_SET + l + '\x1b[K')
  if (cleared.length > 0) cleared[cleared.length - 1] += '\x1b[J'
  // 📖 Every line is prefixed with the theme bg so content always renders on
  // 📖 the correct background. \x1b[K fills to end-of-line. The app-level render
  // 📖 loop applies patchThemeBg() to undo chalk's \x1b[49m resets globally.
  return cleared.join('\n')
}

/**
 * @file command-palette.js
 * @description Command palette registry and fuzzy search helpers for the main TUI.
 *          Now supports hierarchical categories with expandable/collapsible groups.
 *
 * @functions
 *   → `buildCommandPaletteTree` — builds the hierarchical command tree with categories and subcategories
 *   → `flattenCommandTree` — converts tree to flat list for filtering (respects expansion state)
 *   → `fuzzyMatchCommand` — scores a query against one string and returns match positions
 *   → `filterCommandPaletteEntries` — returns sorted command matches for a query
 *
 * @exports { buildCommandPaletteTree, flattenCommandTree, fuzzyMatchCommand, filterCommandPaletteEntries, COMMAND_PALETTE_MAX_RESULTS, clampPaletteCursor }
 *
 * @see src/key-handler.js
 * @see src/overlays.js
 */

import { TOOL_METADATA, TOOL_MODE_ORDER } from '../core/tool-metadata.js'
import { sources } from '../../sources.js'
import { sanitizePingInterval } from './tui-state.js'

// 📖 Max result rows the palette renders (overlays.js slices to this). The
// 📖 cursor must never point past the rendered slice, so key-handler clamps
// 📖 with clampPaletteCursor() against the same constant.
export const COMMAND_PALETTE_MAX_RESULTS = 80

/**
 * 📖 clampPaletteCursor: Keep the palette cursor inside the RENDERED slice.
 * 📖 The overlay only paints the first COMMAND_PALETTE_MAX_RESULTS rows, so a
 * 📖 cursor clamped against the full result list could sit on an invisible row.
 * @param {number} cursor
 * @param {number} totalResults
 * @returns {number}
 */
export function clampPaletteCursor(cursor, totalResults) {
  const max = Math.max(0, Math.min(totalResults, COMMAND_PALETTE_MAX_RESULTS) - 1)
  return Math.min(Math.max(0, cursor), max)
}

const PROVIDER_FILTER_COMMANDS = Object.entries(sources).map(([providerKey, source]) => {
  const label = source?.name || providerKey
  return {
    id: `filter-provider-${providerKey.replace(/[^a-z0-9]+/gi, '-')}`,
    label,
    providerKey,
    description: `${label} models`,
    keywords: ['filter', 'provider', 'origin', providerKey, label.toLowerCase()],
  }
})

const TOOL_MODE_DESCRIPTIONS = {
  opencode: 'Launch in OpenCode CLI with the selected model.',
  'opencode-desktop': 'Set model in shared config, then open OpenCode Desktop.',
  'opencode-web': 'Set model in shared config, then open OpenCode WebUI.',
  openclaw: 'Set default model in OpenClaw and launch it.',
  crush: 'Launch Crush with this provider/model pair.',
  goose: 'Launch Goose and preselect the active model.',
  pi: 'Launch Pi with model/provider flags.',
  aider: 'Launch Aider configured on the selected model.',
  kilo: 'Set model in shared config, then launch Kilo CLI.',
  qwen: 'Launch Qwen Code using the selected provider model.',
  openhands: 'Launch OpenHands with the selected model endpoint.',
  amp: 'Launch Amp with this model as active target.',
  hermes: 'Launch Hermes Agent with the selected model.',
  'continue': 'Launch Continue CLI with the selected model.',
  cline: 'Launch Cline CLI with the selected model.',
  caveman: 'Caveman Code - token-efficient coding agent (launch with Caveman tool only).',
  jcode: 'Launch jcode coding agent with the selected model.',
}

const TOOL_MODE_COMMANDS = TOOL_MODE_ORDER.map((toolMode) => {
  const meta = TOOL_METADATA[toolMode] || { label: toolMode, emoji: '🧰' }
  return {
    id: `action-set-tool-${toolMode}`,
    label: meta.label,
    toolMode,
    icon: meta.emoji,
    description: TOOL_MODE_DESCRIPTIONS[toolMode] || 'Set this as the active launch target.',
    keywords: ['tool', 'target', 'mode', toolMode, meta.label.toLowerCase()],
  }
})

const PING_MODE_COMMANDS = [
  {
    id: 'action-cycle-ping-mode',
    label: 'Cycle ping mode',
    shortcut: 'W',
    icon: '⚡',
    description: 'Rotate speed → normal → slow → forced.',
    keywords: ['ping', 'mode', 'cycle', 'speed', 'normal', 'slow', 'forced'],
  },
  {
    id: 'action-set-ping-speed',
    label: 'Speed mode (2s)',
    pingMode: 'speed',
    description: 'Fast 2s bursts for short live checks.',
    keywords: ['ping', 'mode', 'speed', '2s', 'fast'],
  },
  {
    id: 'action-set-ping-normal',
    label: 'Normal mode (10s)',
    pingMode: 'normal',
    description: 'Balanced default cadence for daily use.',
    keywords: ['ping', 'mode', 'normal', '10s', 'default'],
  },
  {
    id: 'action-set-ping-slow',
    label: 'Slow mode (30s)',
    pingMode: 'slow',
    description: 'Lower refresh cost when you are mostly idle.',
    keywords: ['ping', 'mode', 'slow', '30s', 'idle'],
  },
  {
    id: 'action-set-ping-forced',
    label: 'Forced mode (4s)',
    pingMode: 'forced',
    description: 'Keeps 4s cadence until manually changed.',
    keywords: ['ping', 'mode', 'forced', '4s', 'manual'],
  },
]

// 📖 Base command tree template (will be enhanced with dynamic model list)
const BASE_COMMAND_TREE = [
  {
    id: 'filters',
    label: 'Filters',
    icon: '🔍',
    children: [
      {
        id: 'filter-tier',
        label: 'Filter by tier',
        icon: '📊',
        children: [
          { id: 'filter-tier-all', label: 'All tiers', tier: null, shortcut: 'T', description: 'Show all models', keywords: ['filter', 'tier', 'all'] },
          { id: 'filter-tier-splus', label: 'S+ tier', tier: 'S+', description: 'Best coding models', keywords: ['filter', 'tier', 's+'] },
          { id: 'filter-tier-s', label: 'S tier', tier: 'S', description: 'Excellent models', keywords: ['filter', 'tier', 's'] },
          { id: 'filter-tier-aplus', label: 'A+ tier', tier: 'A+', description: 'Very good models', keywords: ['filter', 'tier', 'a+'] },
          { id: 'filter-tier-a', label: 'A tier', tier: 'A', description: 'Good models', keywords: ['filter', 'tier', 'a'] },
          { id: 'filter-tier-aminus', label: 'A- tier', tier: 'A-', description: 'Solid models', keywords: ['filter', 'tier', 'a-'] },
          { id: 'filter-tier-bplus', label: 'B+ tier', tier: 'B+', description: 'Fair models', keywords: ['filter', 'tier', 'b+'] },
          { id: 'filter-tier-b', label: 'B tier', tier: 'B', description: 'Basic models', keywords: ['filter', 'tier', 'b'] },
          { id: 'filter-tier-c', label: 'C tier', tier: 'C', description: 'Limited models', keywords: ['filter', 'tier', 'c'] },
        ]
      },
      {
        id: 'filter-provider',
        label: 'Filter by provider',
        icon: '🏢',
        children: [
          { id: 'filter-provider-cycle', label: 'Cycle provider', shortcut: 'D', description: 'Switch between providers', keywords: ['filter', 'provider', 'origin'] },
          { id: 'filter-provider-all', label: 'All providers', providerKey: null, description: 'Show all providers', keywords: ['filter', 'provider', 'all'] },
          ...PROVIDER_FILTER_COMMANDS,
        ]
      },
      {
        id: 'filter-model',
        label: 'Filter by model',
        icon: '🤖',
        children: []
      },
      {
        id: 'filter-other',
        label: 'Other filters',
        icon: '⚙️',
        children: [
          { id: 'filter-configured-toggle', label: 'Show only configured & working', shortcut: 'E', description: 'Show only configured providers that are responding (not noauth/auth error)', keywords: ['filter', 'configured', 'keys', 'working', 'active'] },
        ]
      },
    ]
  },
  {
    id: 'sort',
    label: 'Sort',
    icon: '📶',
    children: [
      { id: 'sort-rank', label: 'Sort by rank', shortcut: 'R', description: 'Rank by SWE score', keywords: ['sort', 'rank'] },
      { id: 'sort-tier', label: 'Sort by tier', description: 'Group by quality tier', keywords: ['sort', 'tier'] },
      { id: 'sort-provider', label: 'Sort by provider', shortcut: 'O', description: 'Group by provider', keywords: ['sort', 'origin', 'provider'] },
      { id: 'sort-model', label: 'Sort by model', shortcut: 'M', description: 'Alphabetical order', keywords: ['sort', 'model', 'name'] },
      { id: 'sort-latest-ping', label: 'Sort by latest ping', shortcut: 'L', description: 'Recent response time', keywords: ['sort', 'latest', 'ping'] },
      { id: 'sort-avg-ping', label: 'Sort by avg ping', shortcut: 'A', description: 'Average response time', keywords: ['sort', 'avg', 'average', 'ping'] },
      { id: 'sort-swe', label: 'Sort by SWE score', shortcut: 'S', description: 'Coding ability score', keywords: ['sort', 'swe', 'score'] },
      { id: 'sort-ctx', label: 'Sort by context', shortcut: 'C', description: 'Context window size', keywords: ['sort', 'context', 'ctx'] },
      { id: 'sort-health', label: 'Sort by health', shortcut: 'H', description: 'Current model status', keywords: ['sort', 'health', 'condition'] },
      { id: 'sort-verdict', label: 'Sort by verdict', shortcut: 'V', description: 'Overall assessment', keywords: ['sort', 'verdict'] },
      { id: 'sort-stability', label: 'Sort by stability', shortcut: 'B', description: 'Reliability score', keywords: ['sort', 'stability'] },
      { id: 'sort-uptime', label: 'Sort by uptime', shortcut: 'U', description: 'Success rate', keywords: ['sort', 'uptime'] },
    ]
  },
  {
    id: 'actions',
    label: 'Actions',
    icon: '⚙️',
    children: [
      {
        id: 'action-target-tool',
        label: 'Target tool',
        icon: '🧰',
        children: [
          { id: 'action-cycle-tool-mode', label: 'Cycle target tool', shortcut: 'Z', icon: '🔄', description: 'Rotate through every launcher mode.', keywords: ['tool', 'mode', 'cycle', 'target'] },
          ...TOOL_MODE_COMMANDS,
        ],
      },
      {
        id: 'action-ping-mode',
        label: 'Ping mode',
        icon: '📶',
        children: PING_MODE_COMMANDS,
      },
      {
        id: 'action-favorites-mode',
        label: 'Favorites mode',
        icon: '⭐',
        children: [
          { id: 'action-toggle-favorite-mode', label: 'Toggle favorites mode', shortcut: 'Y', icon: '⭐', description: 'Switch pinned+sticky ↔ normal list behavior.', keywords: ['favorite', 'favorites', 'mode', 'toggle', 'y'] },
          { id: 'action-favorites-mode-pinned', label: 'Pinned + always visible', favoritesPinned: true, description: 'Favorites stay on top and bypass current filters.', keywords: ['favorite', 'favorites', 'pinned', 'sticky', 'always visible'] },
          { id: 'action-favorites-mode-normal', label: 'Normal rows (starred only)', favoritesPinned: false, description: 'Favorites keep ⭐ but follow active filters and sort.', keywords: ['favorite', 'favorites', 'normal', 'sort', 'filter'] },
          { id: 'action-toggle-favorite', label: 'Toggle favorite on selected row', shortcut: 'F', icon: '⭐', description: 'Star/unstar the highlighted model.', keywords: ['favorite', 'star', 'toggle'] },
        ],
      },
      { id: 'action-cycle-theme', label: 'Cycle theme', shortcut: 'G', icon: '🌗', description: 'Switch dark/light/auto', keywords: ['theme', 'dark', 'light', 'auto'] },
      { id: 'action-reset-view', label: 'Reset view', shortcut: 'N', icon: '\u{1F504}', description: 'Reset filters and sort', keywords: ['reset', 'view', 'sort', 'filters'] },
      { id: 'action-probe-failed', label: 'Re-probe Failed Models', shortcut: 'Shift+P', icon: '\u{1F50D}', description: 'Re-test only rows showing errors (auth fail / 429 / 404 / timeout) - not the whole list.', keywords: ['probe', 'failed', 'retry', '429', 'auth', 'error', 'broken', 'rescan', 'health'] },
      { id: 'action-probe-404', label: 'Probe All Models (404)', shortcut: 'Ctrl+Shift+P', icon: '\u{1F50D}', description: 'Test all configured models for 404/410 errors. Auto-hides broken models.', keywords: ['probe', '404', 'broken', 'dead', 'health', 'check', 'test', 'verify', 'all'] },
      { id: 'action-toggle-auto-hide-broken', label: 'Toggle Auto-hide Broken Models', icon: '\u{1F6A9}', description: 'Enable/disable auto-hiding of 404/410 models. Unhides all when disabled.', keywords: ['auto', 'hide', 'broken', '404', 'models', 'toggle', 'probe'] },
    ],
  },
  // 📖 Pages - directly at root level, not in submenu
  { id: 'open-settings', label: 'Settings', shortcut: 'P', icon: '⚙️', type: 'page', description: 'API keys and preferences', keywords: ['settings', 'config', 'api key'] },
  { id: 'open-help', label: 'Help', shortcut: 'K', icon: '❓', type: 'page', description: 'Show all shortcuts', keywords: ['help', 'shortcuts', 'hotkeys'] },
  { id: 'open-changelog', label: 'Changelog', icon: '📋', type: 'page', description: 'Version history', keywords: ['changelog', 'release'] },

  { id: 'open-recommend', label: 'Smart recommend', shortcut: 'Q', icon: '🎯', type: 'page', description: 'Find best model for task', keywords: ['recommend', 'best model'] },
  { id: 'open-playground', label: 'Playground', shortcut: ';', icon: '💬', type: 'page', description: 'Chat with the FCM router', keywords: ['playground', 'chat', 'try', 'prompt', 'router'] },
  { id: 'open-install-endpoints', label: 'Install endpoints', icon: '🔌', type: 'page', description: 'Install provider catalogs', keywords: ['install', 'endpoints', 'providers'] },
  { id: 'open-installed-models', label: 'Installed models', icon: '🗂️', type: 'page', description: 'View models configured in tools', keywords: ['installed', 'models', 'configured', 'tools', 'manager', 'goose', 'crush', 'aider'] },
]

/**
 * 📖 Build the command palette tree with dynamic model filters.
 * @param {Array} visibleModels - Optional list of visible models to create model filter entries
 * @param {object} config - Optional FCM config to customize dynamic labels
 * @returns {Array} The command tree with model filters added
 */
export function buildCommandPaletteTree(visibleModels = [], config = null) {
  // 📖 Clone the base tree
  const tree = JSON.parse(JSON.stringify(BASE_COMMAND_TREE))

  // 📖 Update Normal mode label if config is provided
  if (config) {
    // 📖 Guard against 0/negative/garbage pingInterval (same rule as tui-state).
    const normalInterval = sanitizePingInterval(config.settings?.pingInterval, 10000)
    const normalSec = Math.round(normalInterval / 1000)
    const actionsNode = tree.find(n => n.id === 'actions')
    const pingNode = actionsNode?.children.find(n => n.id === 'action-ping-mode')
    const normalCommand = pingNode?.children.find(n => n.id === 'action-set-ping-normal')
    if (normalCommand) {
      normalCommand.label = `Normal mode (${normalSec}s)`
      if (Array.isArray(normalCommand.keywords)) {
        normalCommand.keywords = normalCommand.keywords.filter(k => !k.endsWith('s'))
        normalCommand.keywords.push(`${normalSec}s`)
      }
    }
  }

  // 📖 Find the filter-model category and add dynamic model entries
  const filterModelCategory = tree.find(cat => cat.id === 'filters')
    ?.children.find(sub => sub.id === 'filter-model')
  
  if (filterModelCategory && Array.isArray(visibleModels) && visibleModels.length > 0) {
    // 📖 Add top 20 most-used or most relevant models
    const topModels = visibleModels
      .filter(m => !m.hidden && m.status !== 'noauth')
      .slice(0, 20)
    
    for (const model of topModels) {
      filterModelCategory.children.push({
        id: `filter-model-${model.providerKey}-${model.modelId}`,
        label: model.label,
        modelId: model.modelId,
        providerKey: model.providerKey,
        keywords: ['filter', 'model', model.label.toLowerCase(), model.modelId.toLowerCase()],
      })
    }
  }
  
  return tree
}

/**
 * 📖 Flatten the command tree into a list, respecting which nodes are expanded.
 * @param {Array} tree - The command tree
 * @param {Set} expandedIds - Set of IDs that are expanded
 * @returns {Array} Flat list with type markers ('category' | 'subcategory' | 'command' | 'page' | 'action')
 */
export function flattenCommandTree(tree, expandedIds = new Set()) {
  const result = []
  
  function traverse(nodes, depth = 0) {
    for (const node of nodes) {
      // 📖 Check if this is a direct page/action (not in a submenu)
      if (node.type === 'page' || node.type === 'action') {
        result.push({
          ...node,
          type: node.type,
          depth: 0,
          hasChildren: false,
          isExpanded: false,
        })
        continue
      }
      
      const isExpanded = expandedIds.has(node.id)
      const hasChildren = Array.isArray(node.children) && node.children.length > 0
      
      if (hasChildren) {
        result.push({
          ...node,
          type: depth === 0 ? 'category' : 'subcategory',
          depth,
          hasChildren,
          isExpanded,
        })
        
        if (isExpanded) {
          traverse(node.children, depth + 1)
        }
      } else {
        result.push({
          ...node,
          type: 'command',
          depth,
          hasChildren: false,
          isExpanded: false,
        })
      }
    }
  }
  
  traverse(tree)
  return result
}

const ID_TO_TIER = {
  'filter-tier-all': null,
  'filter-tier-splus': 'S+',
  'filter-tier-s': 'S',
  'filter-tier-aplus': 'A+',
  'filter-tier-a': 'A',
  'filter-tier-aminus': 'A-',
  'filter-tier-bplus': 'B+',
  'filter-tier-b': 'B',
  'filter-tier-c': 'C',
}

/**
 * 📖 Legacy function for backward compatibility - builds flat list from tree.
 * 📖 Expands all categories so every command is searchable by fuzzyMatchCommand.
 * @param {Array} visibleModels - Optional list of visible models for model filter entries
 */
export function buildCommandPaletteEntries(visibleModels = []) {
  const tree = buildCommandPaletteTree(visibleModels)
  // 📖 Collect every node id that has children so flattenCommandTree traverses into them.
  const allIds = new Set()
  function collectIds(nodes) {
    for (const n of nodes) {
      allIds.add(n.id)
      if (Array.isArray(n.children)) collectIds(n.children)
    }
  }
  collectIds(tree)
  const flat = flattenCommandTree(tree, allIds)
  return flat.map((entry) => {
    // 📖 Copy tier and providerKey properties to tierValue for backward compatibility
    const result = { ...entry }
    if (entry.tier !== undefined) {
      result.tierValue = entry.tier
    }
    return result
  })
}

/**
 * 📖 Fuzzy matching optimized for short command labels and keyboard aliases.
 * @param {string} query
 * @param {string} text
 * @returns {{ matched: boolean, score: number, positions: number[] }}
 */
export function fuzzyMatchCommand(query, text) {
  const q = (query || '').trim().toLowerCase()
  const t = (text || '').toLowerCase()

  if (!q) return { matched: true, score: 0, positions: [] }
  if (!t) return { matched: false, score: 0, positions: [] }

  let qIdx = 0
  const positions = []
  for (let i = 0; i < t.length && qIdx < q.length; i++) {
    if (q[qIdx] === t[i]) {
      positions.push(i)
      qIdx++
    }
  }

  if (qIdx !== q.length) return { matched: false, score: 0, positions: [] }

  let score = q.length * 10

  // 📖 Bonus when matches are contiguous.
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] === positions[i - 1] + 1) score += 5
  }

  // 📖 Bonus for word boundaries and prefix matches.
  for (const pos of positions) {
    if (pos === 0) score += 8
    else {
      const prev = t[pos - 1]
      if (prev === ' ' || prev === ':' || prev === '-' || prev === '/') score += 6
    }
  }

  // 📖 Small penalty for very long labels so focused labels float up.
  score -= Math.max(0, t.length - q.length)

  return { matched: true, score, positions }
}

/**
 * 📖 Filter and rank command palette entries by fuzzy score.
 * Now handles hierarchical structure with expandable categories.
 * @param {Array} flatEntries - Flattened command tree entries
 * @param {string} query
 * @returns {Array} Sorted and filtered entries with match scores
 */
export function filterCommandPaletteEntries(flatEntries, query) {
  const normalizedQuery = (query || '').trim()
  
  if (!normalizedQuery) {
    return flatEntries
  }

  const ranked = []
  for (const entry of flatEntries) {
    const labelMatch = fuzzyMatchCommand(normalizedQuery, entry.label)
    let bestScore = labelMatch.score
    let matchPositions = labelMatch.positions
    let matched = labelMatch.matched

    if (!matched && Array.isArray(entry.keywords)) {
      for (const keyword of entry.keywords) {
        const keywordMatch = fuzzyMatchCommand(normalizedQuery, keyword)
        if (!keywordMatch.matched) continue
        matched = true
        const keywordScore = Math.max(1, keywordMatch.score - 7)
        if (keywordScore > bestScore) {
          bestScore = keywordScore
          matchPositions = []
        }
      }
    }

    if (!matched) continue
    ranked.push({ ...entry, score: bestScore, matchPositions })
  }

  // Auto-expand categories that contain matches
  const result = []
  const idsToExpand = new Set()
  
  // First pass: mark all categories containing matched items
  for (const entry of ranked) {
    if (entry.type === 'command' && entry.matchPositions) {
      // Find parent categories
      let current = result.find(r => r.id === entry.id)
      if (current) {
        idsToExpand.add(entry.parentId)
      }
    }
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.depth !== b.depth) return a.depth - b.depth
    return a.label.localeCompare(b.label)
  })

  return ranked
}

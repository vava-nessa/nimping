/**
 * @file render-helpers.js
 * @description Rendering utility functions for TUI display and layout.
 *
 * @details
 *   This module provides helper functions for rendering the various UI elements:
 *   - String display width calculation for proper alignment (handles emojis)
 *   - ANSI code stripping for text width estimation
 *   - API key masking for security
 *   - Overlay viewport management (scrolling, clamping, visibility)
 *   - Table viewport calculation
 *   - Sorting with pinned favorites and recommendations
 *
 *   🎯 Key features:
 *   - Emoji-aware display width calculation without external dependencies
 *   - ANSI color/control sequence stripping
 *   - API key masking (keeps first 4 and last 3 chars visible)
 *   - Overlay viewport helpers (clamp, slice, scroll target visibility)
 *   - Table viewport calculation with scroll indicators
 *   - Sorting with pinned favorites/recommendations at top
 *
 *   → Functions:
 *   - `stripAnsi`: Remove ANSI color codes to estimate visible text width
 *   - `maskApiKey`: Mask API keys (first 4 + *** + last 3 chars)
 *   - `displayWidth`: Calculate display width of string with emoji support
 *   - `padEndDisplay`: Left-pad using display width for proper alignment
 *   - `tintOverlayLines`: Apply background color to overlay lines
 *   - `clampOverlayOffset`: Clamp scroll offset to valid bounds
 *   - `keepOverlayTargetVisible`: Ensure target line is visible in viewport
 *   - `sliceOverlayLines`: Slice lines to viewport and pad with blanks
 *   - `calculateViewport`: Compute visible slice of model rows
 *   - `sortResultsWithPinnedFavorites`: Sort with pinned items at top
 *   - `adjustScrollOffset`: Clamp scrollOffset so cursor stays visible
 *   - `runWithConcurrency`: Run async task factories with limited parallelism
 *   - `loadChangelogCached`: TTL-cached changelog reader for overlay renders
 *   - `fadedRow`: Multiply every 24-bit RGB channel by a factor to fade an
 *     entire ANSI-colored line uniformly — used for "unusable" rows.
 *
 *   📦 Dependencies:
 *   - chalk: Terminal colors and formatting
 *   - ../src/constants.js: OVERLAY_PANEL_WIDTH, TABLE_FIXED_LINES
 *   - ../src/utils.js: sortResults
 *   - ../src/tool-metadata.js: isModelCompatibleWithTool (for compatible-first partition)
 *
 *   ⚙️ Configuration:
 *   - OVERLAY_PANEL_WIDTH: Fixed width for overlay panels (from constants.js)
 *   - TABLE_FIXED_LINES: Fixed lines in table (header + footer, from constants.js)
 *
 *   @see {@link ../src/constants.js} Constants for overlay and table layout
 *   @see {@link ../src/utils.js} Core sorting functions
 */

import chalk from 'chalk'
import { OVERLAY_PANEL_WIDTH, TABLE_FIXED_LINES, TABLE_HEADER_LINES, TABLE_FOOTER_LINES } from '../core/constants.js'
import { sortResults } from '../core/utils.js'
import { loadChangelog } from '../core/changelog-loader.js'

// 📖 Shared ANSI escape pattern: CSI sequences (colors, \x1b[K, cursor moves),
// 📖 OSC sequences terminated by EITHER ST ("\x1b\\") or BEL ("\x07") so OSC 8
// 📖 hyperlinks never inflate width regardless of which terminator the emitter
// 📖 used, and any leftover escape pair. stripAnsi() and truncateAnsiWidth()
// 📖 both derive from this one source so width accounting can never disagree.
const ANSI_SEQUENCE_SOURCE = '\\x1b\\[[0-9;?]*[A-Za-z]|\\x1b\\][^\\x1b\\x07]*(?:\\x1b\\\\|\\x07)|\\x1b.'
const ANSI_SEQUENCE = new RegExp(ANSI_SEQUENCE_SOURCE, 'g')                  // 📖 match + drop
const ANSI_SEQUENCE_KEEP = new RegExp(`(${ANSI_SEQUENCE_SOURCE})`, 'g')      // 📖 split + keep tokens

// 📖 stripAnsi: Remove ANSI control sequences to estimate visible text width before padding.
// 📖 Strips ALL CSI sequences (SGR colors, \x1b[K clear, cursor moves) and OSC
// 📖 sequences (hyperlinks, BEL- or ST-terminated) - every escape is zero-width
// 📖 for measurement purposes.
export function stripAnsi(input) {
  return String(input).replace(ANSI_SEQUENCE, '')
}

// 📖 fadedRow: Multiply every 24-bit RGB channel inside an ANSI-colored string by `factor`
// 📖 (default 0.8 = 80% opacity, i.e. 20% less opaque) so the whole line reads as
// 📖 uniformly faded. Only foreground/background 24-bit SGR codes (38;2;R;G;B and
// 📖 48;2;R;G;B) are touched — bold, dim, reset codes, hyperlinks, and cursor SGRs
// 📖 pass through unchanged so the structural styling stays intact.
// 📖 Used to make "unusable" rows (NO KEY / AUTH FAIL) visually de-emphasized at
// 📖 the row level rather than dimming a single cell, which is easier to miss at
// 📖 a glance when scanning the table.
// 📖 Channels are clamped to 0–255 and rounded to integers so terminal parsers
// 📖 never receive an out-of-range byte. When `factor >= 1` the input is returned
// 📖 untouched (identity fast path) so callers can wire this in without paying
// 📖 the cost on every row.
export function fadedRow(input, factor = 0.8) {
  const text = String(input)
  if (factor >= 1) return text
  // 📖 Pre-clamp factor to [0, 1] to avoid negative channel values that would
  // 📖 confuse downstream regex replacements; we still respect very small values
  // 📖 so a caller can pass e.g. 0.1 to almost black-out a row.
  const safeFactor = Math.max(0, Math.min(1, factor))
  return text.replace(
    /\x1b\[(38|48);2;(\d+);(\d+);(\d+)m/g,
    (_match, kind, rStr, gStr, bStr) => {
      const r = parseInt(rStr, 10)
      const g = parseInt(gStr, 10)
      const b = parseInt(bStr, 10)
      const nr = Math.max(0, Math.min(255, Math.round(r * safeFactor)))
      const ng = Math.max(0, Math.min(255, Math.round(g * safeFactor)))
      const nb = Math.max(0, Math.min(255, Math.round(b * safeFactor)))
      return `\x1b[${kind};2;${nr};${ng};${nb}m`
    }
  )
}

// 📖 maskApiKey: Mask all but first 4 and last 3 characters of an API key.
// 📖 Prevents accidental disclosure of secrets in TUI display.
export function maskApiKey(key) {
  if (!key || key.length < 10) return '***'
  return key.slice(0, 4) + '***' + key.slice(-3)
}

// 📖 displayWidth: Calculate display width of a string in terminal columns.
// 📖 Emojis and other wide characters occupy 2 columns, variation selectors (U+FE0F) are zero-width.
// 📖 Keycap sequences (digit/# + FE0F + 20E3, e.g. 1️⃣) render as a single 2-cell glyph.
// 📖 This avoids pulling in a full `string-width` dependency for a lightweight CLI tool.
export function displayWidth(str) {
  const plain = stripAnsi(String(str))
  const codepoints = [...plain]
  let w = 0
  for (let i = 0; i < codepoints.length; i++) {
    const ch = codepoints[i]
    const cp = ch.codePointAt(0)

    // Keycap sequence detection: ASCII digit / # / * followed by optional FE0F then 20E3 → +2 (single emoji glyph)
    const isKeycapBase = (cp >= 0x30 && cp <= 0x39) || cp === 0x23 || cp === 0x2A
    if (isKeycapBase) {
      let j = i + 1
      let sawFe0f = false
      if (j < codepoints.length && codepoints[j].codePointAt(0) === 0xFE0F) { sawFe0f = true; j++ }
      if (j < codepoints.length && codepoints[j].codePointAt(0) === 0x20E3) {
        w += 2
        i = j // 📖 skip the consumed FE0F (if any) and the 20E3
        continue
      }
      // 📖 Not a keycap, fall through to normal handling
      void sawFe0f
    }

    // Zero-width: variation selectors (FE00-FE0F), zero-width joiner/non-joiner, lone combining keycap
    if ((cp >= 0xFE00 && cp <= 0xFE0F) || cp === 0x200D || cp === 0x200C || cp === 0x20E3) continue
    // Wide: CJK, emoji (most above U+1F000), fullwidth forms
    if (
      cp > 0x1F000 ||                              // emoji & symbols
      (cp >= 0x2600 && cp <= 0x27BF) ||             // misc symbols, dingbats
      (cp >= 0x2300 && cp <= 0x23FF) ||             // misc technical (⏳, ⏰, etc.)
      (cp >= 0x2700 && cp <= 0x27BF) ||             // dingbats
      (cp >= 0xFE10 && cp <= 0xFE19) ||             // vertical forms
      (cp >= 0xFF01 && cp <= 0xFF60) ||             // fullwidth ASCII
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||             // fullwidth signs
      (cp >= 0x4E00 && cp <= 0x9FFF) ||             // CJK unified
      (cp >= 0x3000 && cp <= 0x303F) ||             // CJK symbols
      (cp >= 0x2B50 && cp <= 0x2B55) ||             // stars, circles
      cp === 0x2705 || cp === 0x2714 || cp === 0x2716 || // check/cross marks
      cp === 0x26A0                                  // ⚠ warning sign
    ) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}

// 📖 padEndDisplay: Left-pad (padEnd equivalent) using display width instead of string length.
// 📖 Ensures columns with emoji text align correctly in the terminal.
export function padEndDisplay(str, width) {
  const dw = displayWidth(str)
  const need = Math.max(0, width - dw)
  return str + ' '.repeat(need)
}

// 📖 truncateAnsiWidth: Hard-clamp ANY string (plain or ANSI-styled) to a max
// 📖 display width, appending an ellipsis when content is cut. ANSI escape
// 📖 sequences are preserved (they cost 0 columns) so styled overlay rows can be
// 📖 clamped as a final safety pass without breaking colors. A reset (\x1b[0m) is
// 📖 inserted before the ellipsis so a cut inside a colored run cannot bleed the
// 📖 color into the ellipsis or the following cells.
export function truncateAnsiWidth(input, maxWidth, { ellipsis = '…' } = {}) {
  const text = String(input)
  const budget = Math.max(0, Math.floor(maxWidth) || 0)
  if (budget === 0) return ''
  if (displayWidth(text) <= budget) return text

  // 📖 Split into ANSI sequences and visible characters so escapes are kept verbatim.
  // 📖 Capturing group makes String.split keep the separators (ANSI tokens) in the result.
  const tokens = text.split(ANSI_SEQUENCE_KEEP).filter((t) => t !== '')
  let out = ''
  let w = 0
  const ellWidth = displayWidth(ellipsis)
  // 📖 Reserve room for the ellipsis, but never let the reserve swallow the whole budget.
  const cutBudget = Math.max(0, budget - Math.min(ellWidth, Math.max(0, budget - 1)))

  let cut = false
  for (const token of tokens) {
    const isAnsi = token.startsWith('\x1b')
    if (isAnsi) { out += token; continue }
    // 📖 Walk visible characters code point by code point (emoji are 2 columns).
    for (const ch of token) {
      const cw = displayWidth(ch)
      if (w + cw > cutBudget) { cut = true; break }
      out += ch
      w += cw
    }
    if (cut) break
  }
  return out + '\x1b[0m' + ellipsis
}

// 📖 tintOverlayLines: Tint overlay lines with a terminal width so the background is clearly visible.
// 📖 Applies bgColor to each line and pads to terminalCols for full-width panel look.
// 📖 If terminalCols is not provided, falls back to OVERLAY_PANEL_WIDTH for compatibility.
export function tintOverlayLines(lines, bgColor, terminalCols = null) {
  const panelWidth = terminalCols || OVERLAY_PANEL_WIDTH
  return lines.map((line) => {
    const text = String(line)
    const visibleWidth = displayWidth(text)
    const padding = ' '.repeat(Math.max(0, panelWidth - visibleWidth))
    return bgColor(text + padding)
  })
}

// 📖 clampOverlayOffset: Clamp overlay scroll to valid bounds for the current terminal height.
export function clampOverlayOffset(offset, totalLines, terminalRows) {
  const viewportRows = Math.max(1, terminalRows || 1)
  const maxOffset = Math.max(0, totalLines - viewportRows)
  return Math.max(0, Math.min(maxOffset, offset))
}

// 📖 keepOverlayTargetVisible: Ensure a target line is visible inside overlay viewport (used by Settings cursor).
// 📖 Adjusts offset so the target line is always visible, scrolling if needed.
export function keepOverlayTargetVisible(offset, targetLine, totalLines, terminalRows) {
  const viewportRows = Math.max(1, terminalRows || 1)
  let next = clampOverlayOffset(offset, totalLines, terminalRows)
  if (targetLine < next) next = targetLine
  else if (targetLine >= next + viewportRows) next = targetLine - viewportRows + 1
  return clampOverlayOffset(next, totalLines, terminalRows)
}

// 📖 sliceOverlayLines: Slice overlay lines to terminal viewport and pad with blanks to avoid stale frames.
// 📖 Returns { visible, offset } where visible is the sliced/padded lines array.
export function sliceOverlayLines(lines, offset, terminalRows) {
  const viewportRows = Math.max(1, terminalRows || 1)
  const nextOffset = clampOverlayOffset(offset, lines.length, terminalRows)
  const visible = lines.slice(nextOffset, nextOffset + viewportRows)
  while (visible.length < viewportRows) visible.push('')
  return { visible, offset: nextOffset }
}

// ─── Table viewport calculation ────────────────────────────────────────────────

// 📖 getTableFixedLines: Resolve the non-model line budget for the main table.
// 📖 Header and full footer are always visible in the main table, with optional
// 📖 extra fixed rows for temporary banners.
export function getTableFixedLines({ extraFixedLines = 0 } = {}) {
  return TABLE_HEADER_LINES + TABLE_FOOTER_LINES + Math.max(0, extraFixedLines)
}

// 📖 calculateViewport: Computes the visible slice of model rows that fits in the terminal.
// 📖 When scroll indicators are needed, they each consume 1 line from the model budget.
// 📖 `lineBudget` lets callers reserve temporary footer/header rows without shrinking
// 📖 the viewport permanently for the normal case.
// 📖 Returns { startIdx, endIdx, hasAbove, hasBelow } for rendering.
export function calculateViewport(terminalRows, scrollOffset, totalModels, lineBudget = 0) {
  if (terminalRows <= 0) return { startIdx: 0, endIdx: totalModels, hasAbove: false, hasBelow: false }
  const fixedLines = typeof lineBudget === 'number'
    ? TABLE_FIXED_LINES + Math.max(0, lineBudget)
    : getTableFixedLines(lineBudget)
  let maxSlots = terminalRows - fixedLines
  if (maxSlots < 1) maxSlots = 1
  if (totalModels <= maxSlots) return { startIdx: 0, endIdx: totalModels, hasAbove: false, hasBelow: false }

  const hasAbove = scrollOffset > 0
  const hasBelow = scrollOffset + maxSlots - (hasAbove ? 1 : 0) < totalModels
  // Recalculate with indicator lines accounted for
  const modelSlots = maxSlots - (hasAbove ? 1 : 0) - (hasBelow ? 1 : 0)
  const endIdx = Math.min(scrollOffset + modelSlots, totalModels)
  return { startIdx: scrollOffset, endIdx, hasAbove, hasBelow }
}

// ─── Sorting helpers ───────────────────────────────────────────────────────────

// 📖 sortResultsWithPinnedFavorites: Recommended models are pinned above favorites, favorites above non-favorites.
// 📖 Recommended: sorted by recommendation score (highest first).
// 📖 Favorites: keep insertion order (favoriteRank) when pinFavorites=true.
// 📖 Non-favorites: active sort column/direction.
// 📖 Models that are both recommended AND favorite — show in recommended section.
// 📖 pinFavorites=false keeps favorites highlighted but lets normal sort/filter order apply.
export function sortResultsWithPinnedFavorites(results, sortColumn, sortDirection, { pinFavorites = true, benchmarkResults = {} } = {}) {
  if (!pinFavorites) {
    const recommendedRows = results
      .filter((r) => r.isRecommended)
      .sort((a, b) => (b.recommendScore || 0) - (a.recommendScore || 0))
    const nonRecommendedRows = sortResults(
      results.filter((r) => !r.isRecommended),
      sortColumn,
      sortDirection,
      { benchmarkResults }
    )
    return [...recommendedRows, ...nonRecommendedRows]
  }
  const recommendedRows = results
    .filter((r) => r.isRecommended && !r.isFavorite)
    .sort((a, b) => (b.recommendScore || 0) - (a.recommendScore || 0))
  const favoriteRows = results
    .filter((r) => r.isFavorite && !r.isRecommended)
    .sort((a, b) => a.favoriteRank - b.favoriteRank)
  // 📖 Models that are both recommended AND favorite — show in recommended section
  const bothRows = results
    .filter((r) => r.isRecommended && r.isFavorite)
    .sort((a, b) => (b.recommendScore || 0) - (a.recommendScore || 0))
  const nonSpecialRows = sortResults(results.filter((r) => !r.isFavorite && !r.isRecommended), sortColumn, sortDirection, { benchmarkResults })
  return [...bothRows, ...recommendedRows, ...favoriteRows, ...nonSpecialRows]
}

// ─── Scroll offset adjustment ──────────────────────────────────────────────────

// 📖 adjustScrollOffset: Clamp scrollOffset so cursor is always within the visible viewport window.
// 📖 Called after every cursor move, sort change, and terminal resize.
// 📖 Modifies st.scrollOffset in-place, returns undefined.
export function adjustScrollOffset(st) {
  const total = st.visibleSorted ? st.visibleSorted.length : st.results.filter(r => !r.hidden).length
  const fixedLines = getTableFixedLines()
  let maxSlots = st.terminalRows - fixedLines
  if (maxSlots < 1) maxSlots = 1
  if (total <= maxSlots) { st.scrollOffset = 0; return }
  // Ensure cursor is not above the visible window
  if (st.cursor < st.scrollOffset) {
    st.scrollOffset = st.cursor
  }
  // Ensure cursor is not below the visible window
  // Account for indicator lines eating into model slots
  const hasAbove = st.scrollOffset > 0
  const tentativeBelow = st.scrollOffset + maxSlots - (hasAbove ? 1 : 0) < total
  const modelSlots = maxSlots - (hasAbove ? 1 : 0) - (tentativeBelow ? 1 : 0)
  if (st.cursor >= st.scrollOffset + modelSlots) {
    st.scrollOffset = st.cursor - modelSlots + 1
  }
  // Final clamp
  // 📖 Keep one extra scroll step when top indicator is visible,
  // 📖 otherwise the last rows become unreachable at the bottom.
  const maxOffset = Math.max(0, total - maxSlots + 1)
  if (st.scrollOffset > maxOffset) st.scrollOffset = maxOffset
  if (st.scrollOffset < 0) st.scrollOffset = 0
}

// ─── Shared TUI task utilities ────────────────────────────────────────────────

// 📖 runWithConcurrency: Execute async task factories with limited parallelism
// 📖 (max `maxConcurrent` simultaneous). Per-task rejections are captured as
// 📖 { error } in the results array so one failure never rejects the whole
// 📖 batch (the 404 probe and the startup ping burst both rely on that).
// 📖 Previously this lived inside key-handler.js only, so app.js's startup
// 📖 burst had to fall back to unbounded Promise.all (~226 simultaneous pings,
// 📖 a guaranteed 429 storm). Exported so every call site shares one impl.
export async function runWithConcurrency(tasks, maxConcurrent) {
  const results = new Array(tasks.length)
  let nextIndex = 0
  const workers = new Array(Math.max(1, maxConcurrent)).fill(null).map(async () => {
    while (true) {
      const index = nextIndex++
      if (index >= tasks.length) break
      try {
        results[index] = await tasks[index]()
      } catch (err) {
        results[index] = { error: err }
      }
    }
  })
  return Promise.all(workers).then(() => results)
}

// ─── Cached changelog loader ──────────────────────────────────────────────────

// 📖 loadChangelogCached: TTL-cached wrapper around core loadChangelog().
// 📖 The raw loader does readdirSync + readFileSync of every changelog/*.md on
// 📖 each call, and the TUI used to call it on EVERY keypress AND every render
// 📖 frame while the changelog overlay was open (~12 disk reads/sec). The
// 📖 parsed result is cached in module scope for a few seconds; the file set
// 📖 only changes on a release, so a short TTL is plenty fresh (and keeps the
// 📖 overlay correct across version bumps during development).
const CHANGELOG_CACHE_TTL_MS = 5000
let changelogCache = null
let changelogCacheAt = 0
export function loadChangelogCached() {
  const now = Date.now()
  if (changelogCache && (now - changelogCacheAt) < CHANGELOG_CACHE_TTL_MS) return changelogCache
  changelogCache = loadChangelog()
  changelogCacheAt = now
  return changelogCache
}

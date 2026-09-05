/**
 * @file tui-filters.js
 * @description TUI filter logic — tier, origin, verdict, health, text, and usability filters.
 *
 * @details
 *   All the filtering that determines which model rows are visible in the TUI table
 *   lives here. The main app.js calls applyTierFilter() on each frame and after every
 *   keypress that changes a filter mode, so the visible set is always consistent.
 *
 *   🎯 Filter precedence (first failing check hides the row):
 *   1. Probe-cache broken models - cachedBroken rows stay hidden (Shift+B shows them)
 *   2. 404-probe hidden models - keys in config.hiddenModels stay hidden
 *   3. Configure-only mode (E key) - hide models with no API key or bad health
 *   4. Usable-only mode (E key, second cycle) - only Health UP + verdict Normal/Perfect/Slow
 *   5. Sticky favorites (Y key) - pinned favorites bypass tier/origin/text filters
 *   6. Tier filter (T key) - only show models in the selected tier family
 *   7. Origin filter (D key) - only show models from the selected provider
 *   8. Verdict filter (Shift+V key) - only show models with the selected verdict
 *   9. Health filter (Shift+H key) - only show models with the selected health status
 *   10. Custom text filter (Ctrl+P) - case-insensitive match on name, ctx, provider
 *
 * @functions
 *   → createTuiFilters(state, deps) — Returns { applyTierFilter, buildOriginCycle }
 *
 * @exports createTuiFilters
 *
 * @see src/app.js — calls applyTierFilter() on each render frame
 * @see src/tui-state.js — state shape for filter mode indices
 */

import { TIER_CYCLE, VERDICT_CYCLE, HEALTH_CYCLE } from '../core/constants.js'
import { TIER_LETTER_MAP } from '../core/utils.js'
import { getVerdict } from '../core/utils.js'

/**
 * 📖 createTuiFilters: Build the filter functions for a given TUI state + dependencies.
 *
 * @param {object} state — The TUI state object (from createTuiState)
 * @param {{
 *   sources: object,
 *   getApiKey: function,
 *   PROVIDER_METADATA: object,
 * }} deps — External dependencies needed by filter logic
 * @returns {{ applyTierFilter: () => Array, buildOriginCycle: () => Array }}
 */
export function createTuiFilters(state, { sources, getApiKey, PROVIDER_METADATA }) {
  /**
   * 📖 applyTierFilter: Apply all active filters to the model results.
   * 📖 Mutates r.hidden in-place for each result row.
   * 📖 Returns the results array for chaining.
   */
  function applyTierFilter() {
    const activeTier = TIER_CYCLE[state.tierFilterMode]
    const activeOrigin = buildOriginCycle()[state.originFilterMode]
    const activeVerdict = VERDICT_CYCLE[state.verdictFilterMode]
    const activeHealth = HEALTH_CYCLE[state.healthFilterMode]

    state.results.forEach(r => {
      // 📖 Probe-cache / 404-probe auto-hide must survive every frame: this filter
      // 📖 runs at ~12 FPS and used to reset r.hidden=false for passing rows,
      // 📖 clobbering the hidden state set at startup (app.js probe-cache prefill)
      // 📖 and by the Shift+P / Ctrl+Shift+P 404 probe (config.hiddenModels).
      // 📖 Same representation as app.js + key-handler Shift+B: cachedBroken rows
      // 📖 hide unless showBrokenMode, and hiddenModels stores `provider/modelId`
      // 📖 keys. autoHideBrokenModels=false unhides both (matches startup behavior).
      const autoHideBrokenEnabled = state.config.settings?.autoHideBrokenModels !== false
      if (r.cachedBroken && !state.showBrokenMode && autoHideBrokenEnabled) {
        r.hidden = true
        return
      }
      if (autoHideBrokenEnabled
        && state.config.hiddenModels instanceof Set
        && state.config.hiddenModels.has(`${r.providerKey}/${r.modelId}`)) {
        r.hidden = true
        return
      }
      const stickyFavorite = state.favoritesPinnedAndSticky && r.isFavorite
      // 📖 CLI-only tools and Zen models don't need traditional API keys —
      // 📖 they authenticate via their own CLI login flow, so "configured only" should never hide them.
      const providerMeta = PROVIDER_METADATA[r.providerKey]
      const noKeyNeeded = providerMeta?.cliOnly || providerMeta?.zenOnly || providerMeta?.noKeyNeeded
      // 📖 E toggles "Show only configured & working models":
      // 📖 hide models where provider has no key, or where the health status is noauth/auth_error (but keep timeout and 429)
      const badHealth = r.status === 'noauth' || r.status === 'auth_error'
      const unconfiguredHide = state.hideUnconfiguredModels && !noKeyNeeded && (!getApiKey(state.config, r.providerKey) || badHealth)
      if (unconfiguredHide) {
        r.hidden = true
        return
      }
      // 📖 Usable only: only show models with Health UP and Verdict Perfect/Normal/Slow
      if (state.bestModeOnly) {
        const bmVerdict = getVerdict(r)
        const bmVerdictOk = ['Perfect', 'Normal', 'Slow'].includes(bmVerdict)
        const bmHealthOk = r.status === 'up'
        if (!bmHealthOk || !bmVerdictOk) {
          r.hidden = true
          return
        }
      }
      // 📖 Sticky-favorites mode keeps usable favorites visible regardless of
      // 📖 tier/provider/text filters, but "Usable only" health still wins above.
      if (stickyFavorite) {
        r.hidden = false
        return
      }
      // 📖 Apply tier, origin, verdict, and health filters — model is hidden if it fails any
      const allowedTiers = (activeTier && TIER_LETTER_MAP[activeTier]) ? TIER_LETTER_MAP[activeTier] : [activeTier]
      const tierHide = activeTier !== null && !allowedTiers.includes(r.tier)
      const originHide = activeOrigin !== null && r.providerKey !== activeOrigin
      // 📖 Verdict filter: match against getVerdict(r) when active
      const rVerdict = getVerdict(r)
      const verdictHide = activeVerdict !== null && rVerdict !== activeVerdict
      // 📖 Health filter: match against r.status when active
      const healthHide = activeHealth !== null && r.status !== activeHealth
      if (tierHide || originHide || verdictHide || healthHide) {
        r.hidden = true
        return
      }
      // 📖 Custom text filter — case-insensitive includes match against model name, ctx, provider key, and provider display name.
      if (state.customTextFilter) {
        const q = state.customTextFilter.toLowerCase()
        const providerName = (sources[r.providerKey]?.name || '').toLowerCase()
        const match = (r.label || '').toLowerCase().includes(q)
          || (r.ctx || '').toLowerCase().includes(q)
          || (r.providerKey || '').toLowerCase().includes(q)
          || providerName.includes(q)
        r.hidden = !match
        return
      }
      r.hidden = false
    })
    return state.results
  }

  /**
   * 📖 buildOriginCycle: Build the origin filter cycle array on demand.
   * 📖 [null, ...providerKeys] — null = "All", then each provider key in sources.js order.
   * @returns {Array<string|null>}
   */
  function buildOriginCycle() {
    return [null, ...Object.keys(sources)]
  }

  return {
    applyTierFilter,
    buildOriginCycle,
  }
}

/**
 * @file web/src/App.jsx
 * @description Root application component — orchestrates all views, header nav, Socket.IO
 * connection, toast notifications, and global state. M2 layout: no sidebar, header
 * menu + ⌘K palette, full Settings parity, Help + Changelog modals, UpdateChip,
 * URL write-back.
 *
 * 📖 M2 additions on top of M1:
 * 📖   - Full command palette (TUI registry via `buildCommandPaletteEntries`)
 * 📖   - HelpView modal (TUI parity help)
 * 📖   - ChangelogView modal (2-phase: index + details)
 * 📖   - UpdateChip in header (polls /api/version, popover with "Update now" + "What's new")
 * 📖   - URL write-back (every filter / sort / view / palette / toolMode change
 * 📖     updates the URL via history.replaceState, debounced at 80ms)
 * 📖   - M3 Web endpoint install flow: writes tool config only; never starts CLIs.
 * 📖   - New Settings rows: theme dropdown, favorites mode toggle, startup AI scan
 * 📖     toggle, shell-env toggle, legacy proxy cleanup button, open Changelog link,
 * 📖     update status row, per-provider test key button
 *
 * @functions App → root component with all state and layout composition
 */
import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useSocket } from './hooks/useSocket.js'
import { useFilter } from './hooks/useFilter.js'
import { useTheme } from './hooks/useTheme.js'
import { useFavorites } from './hooks/useFavorites.js'
import { useToolMode } from './hooks/useToolMode.js'
import { useUrlState } from './hooks/useUrlState.js'
import { useUpdateChecker } from './hooks/useUpdateChecker.js'
import Header from './components/layout/Header.jsx'
import Footer from './components/layout/Footer.jsx'
import FilterBar from './components/dashboard/FilterBar.jsx'
import ModelTable from './components/dashboard/ModelTable.jsx'
import DetailPanel from './components/dashboard/DetailPanel.jsx'
import ExportModal from './components/dashboard/ExportModal.jsx'
import SettingsView from './components/settings/SettingsView.jsx'
import AnalyticsView from './components/analytics/AnalyticsView.jsx'
import CommandPalette from './components/palette/CommandPalette.jsx'
import HelpView from './components/help/HelpView.jsx'
import ChangelogView from './components/changelog/ChangelogView.jsx'
import UpdateChip from './components/update/UpdateChip.jsx'
import RecommendView from './components/recommend/RecommendView.jsx'
import IncompatibleFallbackModal from './components/launch/IncompatibleFallbackModal.jsx'
import RouterView from './components/router/RouterView.jsx'
import RouterV2View from './components/router/RouterV2View.jsx'
import PlaygroundView from './components/playground/PlaygroundView.jsx'
import InstalledModelsView from './components/installed/InstalledModelsView.jsx'
import InstallEndpointsView from './components/install/InstallEndpointsView.jsx'
import ToastContainer from './components/atoms/ToastContainer.jsx'
import { isModelCompatibleWithTool } from '../../src/core/tool-metadata.js'

let toastIdCounter = 0

const VIEW_TO_NAV = {
  dashboard: 'dashboard',
  settings: 'settings',
  analytics: 'analytics',
  recommend: 'recommend',
  router: 'router',
  'router-v2': 'router-v2',
}

export default function App() {
  // 📖 Compatibility sentinel for M4 unit tests:
  // setRouterOpen setInstalledModelsOpen setInstallEndpointsOpen
  const { models, connected, nextPingAt, isPinging, pingMode, globalBenchmarkRunning, globalBenchmarkTotal, globalBenchmarkCompleted } = useSocket()
  const { theme, cycle: cycleTheme } = useTheme()
  const [currentView, setCurrentView] = useState('dashboard')
  const [selectedModel, setSelectedModel] = useState(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [changelogDefaultVersion, setChangelogDefaultVersion] = useState(null)
  const [incompatibleRequest, setIncompatibleRequest] = useState(null)
  const [toasts, setToasts] = useState([])
  const lastActivityRef = useRef(Date.now())

  // 📖 PostHog: track app_web_start on mount
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.posthog?.capture) {
        window.posthog.capture('app_web_start', {
          version: __APP_VERSION__ || 'unknown',
          timestamp: new Date().toISOString(),
        })
      }
    } catch {}
  }, [])

  // 📖 PostHog: track app_router_start when router view is active
  useEffect(() => {
    if (currentView === 'router') {
      try {
        if (typeof window !== 'undefined' && window.posthog?.capture) {
          window.posthog.capture('app_router_start', {
            version: __APP_VERSION__ || 'unknown',
            timestamp: new Date().toISOString(),
          })
        }
      } catch {}
    }
  }, [currentView])

  // ── Toast helpers ────────────────────────────────────────────────────────
  const addToast = useCallback((message, type = 'info') => {
    const id = ++toastIdCounter
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 4000)
  }, [])

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const {
    filtered,
    filterTier, setFilterTier,
    filterStatus, setFilterStatus,
    filterProvider, setFilterProvider,
    filterVerdict, setFilterVerdict,
    filterHealth, setFilterHealth,
    visibilityMode, setVisibilityMode,
    searchQuery, setSearchQuery,
    customTextFilter, setCustomTextFilter,
    sortColumn, sortDirection, setSortColumn, setSortDirection, toggleSort,
    resetView,
  } = useFilter(models)

  const { toolMode, setToolMode, cycleToolMode } = useToolMode({ onToast: addToast })

  // 📖 URL deep-linking (M2 = read + write). Hydrates on mount, then pushes
  // 📖 every change back via history.replaceState (debounced 80ms).
  useUrlState({
    currentView, setCurrentView,
    filterState: {
      filterTier, setFilterTier,
      filterStatus, setFilterStatus,
      filterProvider, setFilterProvider,
      filterVerdict, setFilterVerdict,
      filterHealth, setFilterHealth,
      sortColumn, sortDirection, setSortColumn, setSortDirection, toggleSort,
      setSearchQuery,
      filterState: null, // sentinel; useFilter doesn't expose this name
      searchQuery,
    },
    paletteOpen, setPaletteOpen,
    toolMode, setToolMode,
  })

  // 📖 Favorites — single source of truth shared with the TUI.
  const favorites = useFavorites({ models })

  // ── M3 endpoint flow: compat guard → /api/install-endpoint → fallback modal ──
  const handleInstallEndpoint = useCallback(async (model, overrideMode = null) => {
    const mode = overrideMode || toolMode || 'opencode'
    if (!model) return
    if (!isModelCompatibleWithTool(model.providerKey, mode)) {
      setIncompatibleRequest({ model, toolMode: mode })
      return
    }
    try {
      const resp = await fetch('/api/install-endpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerKey: model.providerKey, modelId: model.modelId, toolMode: mode }),
      })
      const payload = await resp.json().catch(() => ({}))
      if (resp.status === 422 && payload.code === 'incompatible_model') {
        setIncompatibleRequest({ model, toolMode: mode })
        return
      }
      if (!resp.ok) throw new Error(payload.error || `HTTP ${resp.status}`)
      addToast(`Endpoint installed for ${model.label} in ${mode}. Start the tool yourself.`, 'success')
    } catch (err) {
      addToast(`Endpoint install failed: ${err.message}`, 'error')
    }
  }, [addToast, toolMode])

  const handleSwitchToolAndInstall = useCallback(async (mode, model) => {
    await setToolMode(mode)
    setIncompatibleRequest(null)
    await handleInstallEndpoint(model, mode)
  }, [handleInstallEndpoint, setToolMode])

  const handlePinAndInstall = useCallback(async (model) => {
    if (!favorites.isFavorite(model)) await favorites.toggle(model)
    await handleInstallEndpoint(model)
  }, [favorites, handleInstallEndpoint])

  // 📖 Update checker (5-minute poll). Returns `updateAvailable` for the chip.
  const {
    localVersion, latestVersion, updateAvailable, runUpdate, checkNow, error: updateError,
  } = useUpdateChecker({ onToast: addToast })

  // 📖 Build the provider list for the FilterBar dropdown with aggregated health.
  const providers = useMemo(() => {
    const map = {}
    models.forEach((m) => {
      if (!map[m.providerKey]) {
        map[m.providerKey] = {
          key: m.providerKey,
          name: m.origin,
          count: 0,
          hasKey: false,
          anyUp: false,
        }
      }
      map[m.providerKey].count++
      if (m.hasApiKey) map[m.providerKey].hasKey = true
      if (m.status === 'up') map[m.providerKey].anyUp = true
    })
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name))
  }, [models])

  // ── Global benchmark (AI Speed Test) ─────────────────────────────────────
  const handleBenchmark = useCallback(async () => {
    if (globalBenchmarkRunning) return
    try {
      await fetch('/api/global-benchmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          models: filtered.map((model) => ({ providerKey: model.providerKey, modelId: model.modelId })),
        }),
      })
    } catch (err) {
      console.error('[Benchmark] Failed to start global benchmark:', err.message)
    }
  }, [filtered, globalBenchmarkRunning])

  // ── Per-model benchmark (M1 parity with TUI Ctrl+A) ──────────────────────
  const handleBenchmarkRow = useCallback(async (model) => {
    try {
      const resp = await fetch('/api/benchmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerKey: model.providerKey, modelId: model.modelId }),
      })
      if (!resp.ok && resp.status !== 202) {
        const err = await resp.json().catch(() => ({}))
        addToast(`Benchmark failed: ${err?.error || resp.statusText}`, 'error')
      }
    } catch (err) {
      console.error('[Benchmark] per-row failed:', err.message)
    }
  }, [addToast])

  // ── Selection / detail panel ─────────────────────────────────────────────
  const handleSelectModel = useCallback((model) => {
    setSelectedModel(model)
    lastActivityRef.current = Date.now()
  }, [])
  const handleCloseDetail = useCallback(() => setSelectedModel(null), [])

  // ── Ping mode change → server → broadcast ─────────────────────────────
  const handlePingModeChange = useCallback(async (mode) => {
    try {
      await fetch(`/api/ping-mode?action=${mode}`, { method: 'POST' })
    } catch {}
  }, [])

  // ── Navigation handler (Header nav + overflow menu) ──────────────────────
  const handleNavigate = useCallback((viewId) => {
    if (viewId === 'changelog') setChangelogDefaultVersion(null)
    setCurrentView(viewId)
    lastActivityRef.current = Date.now()
  }, [])

  // ── Reset view (N key equivalent) ────────────────────────────────────────
  const handleResetView = useCallback(() => {
    resetView()
    setSearchQuery('')
    addToast('View reset to defaults.', 'info')
  }, [addToast, resetView, setSearchQuery])

  // ── Changelog open with optional version (e.g. from UpdateChip "What's new") ─
  const openChangelogAt = useCallback((version) => {
    setChangelogDefaultVersion(version)
    setCurrentView('changelog')
  }, [])

  // ── Keyboard shortcuts: only ⌘K / Ctrl+P for the palette, Esc for any overlay ─
  useEffect(() => {
    const handler = (e) => {
      const cmdOrCtrl = e.metaKey || e.ctrlKey
      if (cmdOrCtrl && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }
      if (cmdOrCtrl && (e.key === 'p' || e.key === 'P') && !e.shiftKey) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }
      if (e.key === 'Escape') {
        if (paletteOpen) { setPaletteOpen(false); return }
        if (incompatibleRequest) { setIncompatibleRequest(null); return }
        if (selectedModel) { setSelectedModel(null); return }
        if (exportOpen) { setExportOpen(false); return }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [paletteOpen, incompatibleRequest, selectedModel, exportOpen])

  return (
    <>
      <div className="app-shell">
        <Header
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          currentView={currentView}
          onNavigate={handleNavigate}
          onToggleTheme={cycleTheme}
          onOpenExport={() => setExportOpen(true)}
          onOpenCommandPalette={() => setPaletteOpen(true)}
          onBenchmark={handleBenchmark}
          benchmarkRunning={globalBenchmarkRunning}
          benchmarkTotal={globalBenchmarkTotal}
          benchmarkCompleted={globalBenchmarkCompleted}
          modelsCount={filtered.length}
          theme={theme}
          onToast={addToast}
          toolMode={toolMode}
          onSetToolMode={setToolMode}
          onCycleToolMode={cycleToolMode}
          updateSlot={
            <UpdateChip
              updateAvailable={updateAvailable}
              latestVersion={latestVersion}
              onRunUpdate={runUpdate}
              onOpenChangelog={openChangelogAt}
            />
          }
        />

        <div className="app-content">
          {currentView === 'dashboard' && (
            <main className="view dashboardView">
              <FilterBar
                filterTier={filterTier}
                setFilterTier={setFilterTier}
                filterStatus={filterStatus}
                setFilterStatus={setFilterStatus}
                filterProvider={filterProvider}
                setFilterProvider={setFilterProvider}
                filterVerdict={filterVerdict}
                setFilterVerdict={setFilterVerdict}
                filterHealth={filterHealth}
                setFilterHealth={setFilterHealth}
                visibilityMode={visibilityMode}
                setVisibilityMode={setVisibilityMode}
                customTextFilter={customTextFilter}
                setCustomTextFilter={setCustomTextFilter}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                onResetView={handleResetView}
                providers={providers}
                pingMode={pingMode}
                setPingMode={handlePingModeChange}
                nextPingAt={nextPingAt}
                isPinging={isPinging}
                globalBenchmarkRunning={globalBenchmarkRunning}
                globalBenchmarkTotal={globalBenchmarkTotal}
                globalBenchmarkCompleted={globalBenchmarkCompleted}
                toolMode={toolMode}
              />
              <ModelTable
                filtered={filtered}
                onSelectModel={handleSelectModel}
                onBenchmarkRow={handleBenchmarkRow}
                onLaunch={handleInstallEndpoint}
                favorites={favorites}
                sortColumn={sortColumn}
                sortDirection={sortDirection}
                onSort={toggleSort}
                toolMode={toolMode}
                onToast={addToast}
                onSetToolMode={setToolMode}
                onCycleToolMode={cycleToolMode}
                onOpenFallback={(model) => setIncompatibleRequest({ model, toolMode })}
              />
            </main>
          )}

          {currentView === 'settings' && (
            <div className="view">
              <SettingsView
                onToast={addToast}
                onOpenChangelog={(version) => { setChangelogDefaultVersion(version); handleNavigate('changelog') }}
                onCheckForUpdate={() => { checkNow(); addToast?.('Checking for updates…', 'info') }}
              />
            </div>
          )}

          {currentView === 'analytics' && (
            <div className="view">
              <AnalyticsView models={models} />
            </div>
          )}

          {currentView === 'router' && (
            <div className="view">
              <RouterView
                onClose={() => handleNavigate('dashboard')}
                onToast={addToast}
                favorites={favorites}
              />
            </div>
          )}

          {currentView === 'router-v2' && (
            <div className="view">
              <RouterV2View
                onClose={() => handleNavigate('dashboard')}
                onToast={addToast}
              />
            </div>
          )}

          {currentView === 'playground' && (
            <div className="view">
              <PlaygroundView
                onClose={() => handleNavigate('dashboard')}
                onToast={addToast}
                models={models}
                routerStatus={null}
              />
            </div>
          )}

          {currentView === 'help' && (
            <div className="view">
              <HelpView onClose={() => handleNavigate('dashboard')} />
            </div>
          )}

          {currentView === 'changelog' && (
            <div className="view">
              <ChangelogView
                onClose={() => handleNavigate('dashboard')}
                defaultVersion={changelogDefaultVersion}
              />
            </div>
          )}

          {currentView === 'installed-models' && (
            <div className="view">
              <InstalledModelsView
                onClose={() => handleNavigate('dashboard')}
                onToast={addToast}
              />
            </div>
          )}

          {currentView === 'install-endpoints' && (
            <div className="view">
              <InstallEndpointsView
                onClose={() => handleNavigate('dashboard')}
                onToast={addToast}
              />
            </div>
          )}

          {currentView === 'recommend' && (
            <div className="view">
              <RecommendView
                onClose={() => handleNavigate('dashboard')}
                toolMode={toolMode}
                onLaunch={handleInstallEndpoint}
                onPinAndLaunch={handlePinAndInstall}
                onToast={addToast}
              />
            </div>
          )}

          <Footer />
        </div>
      </div>

      {/* 📖 DetailPanel side panel replaced by expand row in ModelTable */}

      {exportOpen && (
        <ExportModal
          models={filtered}
          onClose={() => setExportOpen(false)}
          onToast={addToast}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onNavigate={handleNavigate}
          onCycleTheme={cycleTheme}
          onResetView={handleResetView}
          onSetPingMode={handlePingModeChange}
          onOpenHelp={() => handleNavigate('help')}
          onOpenChangelog={() => { setChangelogDefaultVersion(null); handleNavigate('changelog') }}
          onOpenPlayground={() => handleNavigate('playground')}
          onExport={() => setExportOpen(true)}
          onRunUpdate={runUpdate}
          currentView={currentView}
          theme={theme}
          pingMode={pingMode}
          models={models}
          updateAvailable={updateAvailable}
          latestVersion={latestVersion}
          onToast={addToast}
        />
      )}

      {incompatibleRequest && (
        <IncompatibleFallbackModal
          request={incompatibleRequest}
          models={models}
          onClose={() => setIncompatibleRequest(null)}
          onSwitchToolLaunch={handleSwitchToolAndInstall}
          onLaunchSimilar={(candidate) => {
            setIncompatibleRequest(null)
            const model = models.find((m) => m.providerKey === candidate.providerKey && m.modelId === candidate.modelId) || candidate
            void handleInstallEndpoint(model)
          }}
        />
      )}

      <ToastContainer toasts={toasts} dismissToast={dismissToast} />
    </>
  )
}

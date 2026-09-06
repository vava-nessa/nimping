/**
 * @file web/src/components/layout/Header.jsx
 * @description Top header bar — global navigation + search + actions.
 * 📖 Layout refactor (M1): no more left sidebar. All navigation lives here.
 * 📖 - Always-visible nav buttons: Dashboard, Settings, Analytics, Recommend, Router
 * 📖 - Overflow menu (kebab): Help, Changelog, Install Endpoints, Installed Models
 * 📖 - Right side: ⌘K (command palette), AI Latency, theme, export
 * 📖 Each unimplemented feature shows a friendly "Coming in M2/M3/M4" toast so
 * 📖 the menu structure is honest and complete from day one.
 */
import { useEffect, useRef, useState } from 'react'
import {
  IconBolt, IconSearch, IconDownload, IconSettings, IconMoon, IconSun,
  IconPlayerPlay, IconCommand, IconLayoutDashboard, IconActivity,
  IconSparkles, IconRoute, IconDots, IconQuestionMark, IconHistory,
  IconPlug, IconFolders, IconMenu2, IconMessageChatbot,
} from '@tabler/icons-react'
import ToolPicker from '../tools/ToolPicker.jsx'
import styles from './Header.module.css'

// 📖 Top-level nav items — always visible as buttons. Inlined here so the
// 📖 order, icon, and "coming soon" milestone are colocated with the
// 📖 rendering code. When a view ships, remove the `comingIn` field.
const NAV_ITEMS = [
  { id: 'dashboard',         label: 'Dashboard',          icon: IconLayoutDashboard },
  { id: 'router',            label: 'Router',             icon: IconRoute },
  { id: 'router-v2',         label: 'Router v2',          icon: IconRoute, beta: true },
  { id: 'playground',        label: 'Playground',         icon: IconMessageChatbot },
  { id: 'help',              label: 'Help',               icon: IconQuestionMark },
  { id: 'install-endpoints', label: 'Install Endpoints',  icon: IconPlug },
]

// 📖 Overflow menu items
const MENU_ITEMS = [
  { id: 'analytics',         label: 'Analytics',          icon: IconActivity },
  { id: 'recommend',         label: 'Recommend',          icon: IconSparkles },
  { id: 'changelog',         label: 'Changelog',          icon: IconHistory },
  { id: 'installed-models',  label: 'Installed Models',   icon: IconFolders },
]

export default function Header({
  searchQuery, onSearchChange,
  currentView, onNavigate,
  onToggleTheme, onOpenExport, onOpenCommandPalette,
  onBenchmark, benchmarkRunning, benchmarkTotal, benchmarkCompleted,
  modelsCount, theme, onToast,
  toolMode = 'opencode', onSetToolMode, onCycleToolMode,
  updateSlot = null,
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const menuRef = useRef(null)

  // 📖 Close the overflow menu on outside click or Esc.
  useEffect(() => {
    if (!menuOpen && !mobileNavOpen) return
    const onClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { setMenuOpen(false); setMobileNavOpen(false) }
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen, mobileNavOpen])

  const handleNavClick = (item) => {
    if (item.comingIn) {
      onToast?.(`${item.label} arrives in milestone ${item.comingIn}.`, 'info')
      return
    }
    onNavigate(item.id)
    setMobileNavOpen(false)
  }

  const handleMenuClick = (item) => {
    setMenuOpen(false)
    if (item.comingIn) {
      onToast?.(`${item.label} arrives in milestone ${item.comingIn}.`, 'info')
      return
    }
    onNavigate(item.id)
  }

  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <div className={styles.logo} onClick={() => onNavigate('dashboard')} style={{ cursor: 'pointer' }}>
          <svg className={styles.logoIconSvg} width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 5L11 12L4 19" stroke="var(--color-brand)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M14 5V19M14 5H21M14 11H18" stroke="var(--color-brand)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span className={styles.logoText}>
            <span className={styles.logoTextHighlight}>free</span>
            <span>-coding-models</span>
            <span className={styles.logoTextHighlight}>_</span>
          </span>
        </div>
        <span className={styles.version}>v{__APP_VERSION__}</span>

        {/* 📖 M5: Hamburger for narrow viewports (never a sidebar). Shows a
           dropdown with all nav + overflow items on mobile. */}
        <button
          className={styles.hamburgerBtn}
          onClick={() => setMobileNavOpen((o) => !o)}
          aria-label="Navigation menu"
          aria-expanded={mobileNavOpen}
          aria-haspopup="true"
        >
          <IconMenu2 size={18} stroke={1.5} />
        </button>
        {mobileNavOpen && (
          <div className={styles.mobileNav} role="menu">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  className={`${styles.mobileNavItem} ${currentView === item.id ? styles.mobileNavActive : ''}`}
                  onClick={() => handleNavClick(item)}
                  role="menuitem"
                >
                  <Icon size={16} stroke={1.5} />
                  <span>{item.label}</span>
                  {item.beta && <span className={styles.betaBadge}>BETA</span>}
                </button>
              )
            })}
            <div className={styles.mobileNavDivider} />
            {MENU_ITEMS.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  className={styles.mobileNavItem}
                  onClick={() => handleMenuClick(item)}
                  role="menuitem"
                >
                  <Icon size={16} stroke={1.5} />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
        )}

        {/* Always-visible primary nav (replaces the old left sidebar) */}
        <nav className={styles.nav} aria-label="Primary">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const isActive = currentView === item.id
            return (
              <button
                key={item.id}
                className={`${styles.navBtn} ${isActive ? styles.navBtnActive : ''}`}
                onClick={() => handleNavClick(item)}
                title={item.comingIn ? `${item.label} — coming in ${item.comingIn}` : item.label}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon size={14} stroke={1.5} />
                <span>{item.label}</span>
                {item.beta && <span className={styles.betaBadge}>BETA</span>}
                {item.comingIn && <span className={styles.comingBadge}>{item.comingIn}</span>}
              </button>
            )
          })}

          {/* Overflow menu (kebab) — hidden features & occasional flows */}
          <div className={styles.menuWrap} ref={menuRef}>
            <button
              className={`${styles.navBtn} ${styles.menuTrigger} ${MENU_ITEMS.some((m) => m.id === currentView) ? styles.navBtnActive : ''}`}
              onClick={() => setMenuOpen((o) => !o)}
              title="More features"
              aria-label="More features"
              aria-haspopup="true"
              aria-expanded={menuOpen}
            >
              <IconDots size={16} stroke={1.5} />
            </button>
            {menuOpen && (
              <div className={styles.menuPopover} role="menu">
                {MENU_ITEMS.map((item) => {
                  const Icon = item.icon
                  const isActive = currentView === item.id
                  return (
                    <button
                      key={item.id}
                      className={`${styles.menuItem} ${isActive ? styles.menuItemActive : ''}`}
                      onClick={() => handleMenuClick(item)}
                      role="menuitem"
                      aria-current={isActive ? 'page' : undefined}
                    >
                      <Icon size={14} stroke={1.5} />
                      <span>{item.label}</span>
                      {item.comingIn && <span className={styles.comingBadge}>{item.comingIn}</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </nav>
      </div>

      <div className={styles.right}>
        <button
          className={`${styles.navBtn} ${currentView === 'settings' ? styles.navBtnActive : ''}`}
          onClick={() => onNavigate('settings')}
          title="Settings"
          aria-current={currentView === 'settings' ? 'page' : undefined}
          style={{ marginRight: '2px' }}
        >
          <IconSettings size={14} stroke={1.5} />
          <span>Settings</span>
        </button>

        <ToolPicker
          toolMode={toolMode}
          onSetToolMode={onSetToolMode}
          onCycleToolMode={onCycleToolMode}
        />

        {/* ⌘K — the only global keyboard shortcut, opens the command palette */}
        <button
          className={styles.cmdkBtn}
          onClick={onOpenCommandPalette}
          title="Command palette (⌘K / Ctrl+P)"
          aria-label="Open command palette (⌘K)"
        >
          <IconCommand size={14} stroke={1.5} />
          <span className={styles.cmdkLabel}>⌘K</span>
        </button>

        <button
          className={`${styles.benchmarkBtn} ${benchmarkRunning ? styles.benchmarkActive : ''}`}
          onClick={onBenchmark}
          disabled={benchmarkRunning}
          title={benchmarkRunning ? `AI Speed Test running — ${benchmarkCompleted}/${benchmarkTotal}` : `Run AI Latency benchmark on ${modelsCount} visible models`}
          aria-label={benchmarkRunning ? `AI Speed Test running — ${benchmarkCompleted} of ${benchmarkTotal} complete` : 'AI Latency benchmark'}
        >
          <IconPlayerPlay size={14} stroke={1.5} />
          {benchmarkRunning ? (
            <span className={styles.benchmarkRunning}>
              <span className={styles.spinner} />
              RUN {benchmarkCompleted}/{benchmarkTotal}
            </span>
          ) : (
            <span>AI Latency</span>
          )}
        </button>

        {/* 📖 M2: update chip slot. Hidden when no update is available. */}
        {updateSlot}

        <button className={styles.iconBtn} onClick={onToggleTheme} title={`Theme: ${theme} (click to cycle auto / dark / light)`} aria-label={`Theme: ${theme}. Click to cycle.`}>
          {theme === 'light' ? <IconMoon size={16} stroke={1.5} /> : <IconSun size={16} stroke={1.5} />}
        </button>
        <button className={styles.iconBtn} onClick={onOpenExport} title="Export Data" aria-label="Export model data">
          <IconDownload size={16} stroke={1.5} />
        </button>
      </div>
    </header>
  )
}

/**
 * @file web/src/components/settings/SettingsView.jsx
 * @description Full settings page — M2 parity with the TUI Settings overlay.
 * 📖 M1: API key management (per-provider cards: enable/disable, masked key,
 * 📖 reveal, save, delete, search filter). Keys are only ever shown masked:
 * 📖 the /api/key endpoint returns the masked value, never the raw secret.
 * 📖 M2: theme dropdown, favorites display mode toggle, startup AI speed scan
 * 📖 toggle, shell-env export toggle, legacy proxy cleanup button, per-provider
 * 📖 test key button (calls /api/key/:provider/test), open Changelog link,
 * 📖 update status row.
 * @functions SettingsView → main settings page component
 */
import { useState, useEffect, useCallback } from 'react'
import {
  IconSettings, IconPlug, IconCircleCheck, IconKey, IconEye, IconEyeOff,
  IconTrash, IconBolt, IconCircleCheckFilled, IconHistory, IconRefresh, IconDownload, IconSun, IconStar,
} from '@tabler/icons-react'
import styles from './SettingsView.module.css'
import { maskKey } from '../../utils/format.js'

const TEST_OUTCOME_META = {
  ok: { label: 'OK', icon: IconCircleCheckFilled, className: 'testOk' },
  auth_error: { label: 'Auth error', icon: IconKey, className: 'testErr' },
  rate_limited: { label: 'Rate limited', icon: IconRefresh, className: 'testWarn' },
  no_callable_model: { label: 'No callable model', icon: IconKey, className: 'testWarn' },
  fail: { label: 'Failed', icon: IconKey, className: 'testErr' },
  missing_key: { label: 'Missing key', icon: IconKey, className: 'testNeutral' },
}

export default function SettingsView({ onToast, onOpenChangelog, onCheckForUpdate }) {
  const [config, setConfig] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedCards, setExpandedCards] = useState(new Set())
  const [revealedKeys, setRevealedKeys] = useState(new Set())
  const [keyInputs, setKeyInputs] = useState({})
  const [testResults, setTestResults] = useState({}) // { providerKey: { outcome, code?, detail? } }
  const [testingKeys, setTestingKeys] = useState(new Set())
  const [legacyCleanupMsg, setLegacyCleanupMsg] = useState(null)

  const loadConfig = useCallback(async () => {
    try {
      const resp = await fetch('/api/config')
      const data = await resp.json()
      setConfig(data)
    } catch {
      onToast?.('Failed to load settings', 'error')
    }
  }, [onToast])

  useEffect(() => { loadConfig() }, [loadConfig])

  const toggleCard = (key) => {
    setExpandedCards((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const expandAll = () => {
    if (!config) return
    setExpandedCards(new Set(Object.keys(config.providers)))
  }

  const collapseAll = () => setExpandedCards(new Set())

  // 📖 Reveal is purely local: it flips between the fully-masked dots and the
  // 📖 masked key (last 4 chars) served by /api/config. The raw key is never
  // 📖 fetched or displayed - the server no longer returns it.
  const toggleRevealKey = (key) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const saveKey = async (key) => {
    const value = keyInputs[key]?.trim()
    if (!value) {
      onToast?.('Please enter an API key', 'warning')
      return
    }
    try {
      const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeys: { [key]: value } }),
      })
      const result = await resp.json()
      if (result.success) {
        onToast?.(`API key for ${key} saved successfully!`, 'success')
        setKeyInputs((prev) => ({ ...prev, [key]: '' }))
        setRevealedKeys((prev) => { const n = new Set(prev); n.delete(key); return n })
        await loadConfig()
        setExpandedCards((prev) => new Set(prev).add(key))
      } else {
        onToast?.(result.error || 'Failed to save', 'error')
      }
    } catch {
      onToast?.('Network error while saving', 'error')
    }
  }

  const deleteKey = async (key) => {
    if (!confirm(`Are you sure you want to delete the API key for "${key}"?`)) return
    try {
      const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeys: { [key]: '' } }),
      })
      const result = await resp.json()
      if (result.success) {
        onToast?.(`API key for ${key} deleted`, 'info')
        setRevealedKeys((prev) => { const n = new Set(prev); n.delete(key); return n })
        await loadConfig()
      } else {
        onToast?.(result.error || 'Failed to delete', 'error')
      }
    } catch {
      onToast?.('Network error while deleting', 'error')
    }
  }

  const toggleProvider = async (key, enabled) => {
    try {
      const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [key]: { enabled } } }),
      })
      const result = await resp.json()
      if (result.success) {
        onToast?.(`${key} ${enabled ? 'enabled' : 'disabled'}`, 'success')
      } else {
        onToast?.(result.error || 'Failed to toggle', 'error')
      }
    } catch {
      onToast?.('Network error', 'error')
    }
  }

  // 📖 M2: per-provider key test. Fires a parallel auth probe + chat ping
  // 📖 through /api/key/:provider/test and stores the outcome for badge display.
  const testKey = useCallback(async (key) => {
    if (testingKeys.has(key)) return
    setTestingKeys((prev) => new Set(prev).add(key))
    setTestResults((prev) => ({ ...prev, [key]: { outcome: 'pending' } }))
    try {
      const resp = await fetch(`/api/key/${encodeURIComponent(key)}/test`, { method: 'POST' })
      const data = await resp.json().catch(() => ({}))
      if (resp.ok) {
        setTestResults((prev) => ({ ...prev, [key]: data }))
        const meta = TEST_OUTCOME_META[data.outcome] || TEST_OUTCOME_META.fail
        onToast?.(`${key} test: ${meta.label}${data.code ? ` (HTTP ${data.code})` : ''}`, data.outcome === 'ok' ? 'success' : 'info')
      } else {
        setTestResults((prev) => ({ ...prev, [key]: { outcome: 'fail', detail: data.error || 'HTTP ' + resp.status } }))
        onToast?.(`${key} test failed: ${data.error || resp.statusText}`, 'error')
      }
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [key]: { outcome: 'fail', detail: err.message } }))
      onToast?.(`${key} test failed: ${err.message}`, 'error')
    } finally {
      setTestingKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [testingKeys, onToast])

  // 📖 M2: feature toggles (theme / favorites mode / startup AI scan / shell env)
  // 📖 go through /api/settings/feature which persists to the same config file
  // 📖 the TUI uses. Theme is a tri-state string, not a boolean.
  const toggleFeature = useCallback(async (feature, value) => {
    try {
      const body = value === undefined ? { feature } : { feature, value }
      const resp = await fetch('/api/settings/feature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await resp.json()
      if (data.success) {
        await loadConfig()
        onToast?.(`${feature} updated`, 'success')
      } else {
        onToast?.(data.error || 'Failed to update feature', 'error')
      }
    } catch {
      onToast?.('Network error', 'error')
    }
  }, [onToast])

  const setShellEnv = useCallback(async (enabled) => {
    try {
      const resp = await fetch('/api/shell-env/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const data = await resp.json()
      if (data.success) {
        await loadConfig()
        onToast?.(`Shell env export ${data.enabled ? 'enabled' : 'disabled'} — restart your shell to apply.`, 'success')
      } else {
        onToast?.(data.error || 'Failed to toggle shell env', 'error')
      }
    } catch {
      onToast?.('Network error', 'error')
    }
  }, [onToast])

  const runLegacyCleanup = useCallback(async () => {
    if (!confirm('Remove discontinued proxy config leftovers? This is safe to run.')) return
    try {
      const resp = await fetch('/api/legacy-cleanup', { method: 'POST' })
      const data = await resp.json()
      const cleaned = (data.removedFiles?.length || 0) + (data.updatedFiles?.length || 0)
      if (data.changed) {
        setLegacyCleanupMsg(`Cleaned ${cleaned} legacy file(s). ${data.errors.length} error(s).`)
        onToast?.(`Legacy proxy cleanup: ${cleaned} file(s) cleaned.`, 'success')
      } else {
        setLegacyCleanupMsg('No discontinued proxy config was found. You are on the stable direct-provider setup.')
        onToast?.('No legacy proxy config found — already on stable setup.', 'info')
      }
      await loadConfig()
    } catch (err) {
      onToast?.(`Legacy cleanup failed: ${err.message}`, 'error')
    }
  }, [onToast])

  const onCheckUpdatesClick = useCallback(() => {
    onCheckForUpdate?.()
  }, [onCheckForUpdate])

  if (!config) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading settings...</div>
      </div>
    )
  }

  const entries = Object.entries(config.providers)
    .filter(([, p]) => {
      if (!searchQuery) return true
      const q = searchQuery.toLowerCase()
      return `${p.name} ${p.displayName || ''} ${p.billingNote || ''}`.toLowerCase().includes(q)
    })
    .sort((a, b) => a[1].name.localeCompare(b[1].name))

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>
          <IconSettings size={24} stroke={1.5} style={{ marginRight: 8, verticalAlign: 'middle' }} />
          Settings
        </h1>
        <p className={styles.pageSubtitle}>
          API keys, theme, favorites mode, shell env, and update controls.
          All settings are stored locally in <code>~/.free-coding-models.json</code>
          and shared with the TUI.
        </p>
      </div>

      {/* ── M2: global feature toggles ────────────────────────────────────── */}
      {config && (
        <section className={styles.featureSection}>
          <h2 className={styles.sectionHeading}>⚙️ Global settings</h2>
          <div className={styles.featureGrid}>
            {/* Theme */}
            <div className={styles.featureRow}>
              <div className={styles.featureLabel}>
                <IconSun size={16} stroke={1.5} />
                <div>
                  <div className={styles.featureTitle}>Theme</div>
                  <div className={styles.featureDesc}>Tri-state cycle. Auto follows your OS.</div>
                </div>
              </div>
              <select
                className={styles.select}
                value={config.settings?.theme || 'auto'}
                onChange={(e) => toggleFeature('theme', e.target.value)}
              >
                <option value="auto">Auto (OS)</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>

            {/* Favorites display mode */}
            <div className={styles.featureRow}>
              <div className={styles.featureLabel}>
                <IconStar size={16} stroke={1.5} />
                <div>
                  <div className={styles.featureTitle}>Favorites pinned + always visible</div>
                  <div className={styles.featureDesc}>Favorites bypass filters and stay on top (TUI: Y key).</div>
                </div>
              </div>
              <label className={styles.toggleSwitch}>
                <input
                  type="checkbox"
                  checked={Boolean(config.settings?.favoritesPinnedAndSticky)}
                  onChange={(e) => toggleFeature('favoritesPinnedAndSticky', e.target.checked)}
                />
                <span className={styles.toggleSlider} />
              </label>
            </div>

            {/* Startup AI Speed Scan */}
            <div className={styles.featureRow}>
              <div className={styles.featureLabel}>
                <IconBolt size={16} stroke={1.5} />
                <div>
                  <div className={styles.featureTitle}>Run AI Speed Test on startup</div>
                  <div className={styles.featureDesc}>Auto-fire the global benchmark right after launch (TUI: U → 'Enable').</div>
                </div>
              </div>
              <label className={styles.toggleSwitch}>
                <input
                  type="checkbox"
                  checked={Boolean(config.settings?.runAiSpeedTestOnStartup)}
                  onChange={(e) => toggleFeature('runAiSpeedTestOnStartup', e.target.checked)}
                />
                <span className={styles.toggleSlider} />
              </label>
            </div>

            {/* Shell env export */}
            <div className={styles.featureRow}>
              <div className={styles.featureLabel}>
                <IconCircleCheck size={16} stroke={1.5} />
                <div>
                  <div className={styles.featureTitle}>Export API keys to shell rc</div>
                  <div className={styles.featureDesc}>Write NVIDIA_API_KEY / GROQ_API_KEY / … to your shell rc file.</div>
                </div>
              </div>
              <label className={styles.toggleSwitch}>
                <input
                  type="checkbox"
                  checked={Boolean(config.settings?.shellEnvEnabled)}
                  onChange={(e) => setShellEnv(e.target.checked)}
                />
                <span className={styles.toggleSlider} />
              </label>
            </div>

            {/* Update row */}
            <div className={styles.featureRow}>
              <div className={styles.featureLabel}>
                <IconDownload size={16} stroke={1.5} />
                <div>
                  <div className={styles.featureTitle}>Check for updates</div>
                  <div className={styles.featureDesc}>
                    The header chip turns green when a newer npm version is available.
                    Use the 'Update now' button to install.
                  </div>
                </div>
              </div>
              <div className={styles.featureActions}>
                <button
                  className={styles.smallBtn}
                  onClick={onCheckUpdatesClick}
                >
                  Check now
                </button>
                <button
                  className={styles.smallBtn}
                  onClick={() => onOpenChangelog?.(null)}
                >
                  <IconHistory size={13} stroke={1.5} /> Changelog
                </button>
              </div>
            </div>

            {/* Legacy proxy cleanup */}
            <div className={styles.featureRow}>
              <div className={styles.featureLabel}>
                <IconRefresh size={16} stroke={1.5} />
                <div>
                  <div className={styles.featureTitle}>Cleanup discontinued proxy artifacts</div>
                  <div className={styles.featureDesc}>
                    Remove old config / env / service leftovers from the old multi-tool proxy.
                  </div>
                </div>
              </div>
              <button
                className={styles.smallBtn}
                onClick={runLegacyCleanup}
              >
                Run cleanup
              </button>
            </div>
          </div>
          {legacyCleanupMsg && (
            <div className={styles.notice}>{legacyCleanupMsg}</div>
          )}
        </section>
      )}

      <div className={styles.toolbar}>
        <div className={styles.toolbarSearch}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search providers..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className={styles.toolbarActions}>
          <button className={styles.toolbarBtn} onClick={expandAll}>Expand All</button>
          <button className={styles.toolbarBtn} onClick={collapseAll}>Collapse All</button>
        </div>
      </div>

      <div className={styles.providers}>
        {entries.map(([key, p]) => {
          const isExpanded = expandedCards.has(key)
          const isRevealed = revealedKeys.has(key)

          return (
            <div key={key} className={`${styles.card} ${isExpanded ? styles.cardExpanded : ''}`}>
              <div className={styles.cardHeader} onClick={() => toggleCard(key)}>
                <div className={styles.cardIcon}>
                  <IconPlug size={20} stroke={1.5} />
                </div>
                <div className={styles.cardInfo}>
                  <div className={styles.cardName}>{p.displayName || p.name}</div>
                  <div className={styles.cardMeta}>{p.modelCount} models · {key}{p.billingNote ? ` · ${p.billingNote}` : ''}</div>
                </div>
                <span className={`${styles.cardStatus} ${p.hasKey ? styles.statusConfigured : styles.statusMissing}`}>
                  {p.hasKey ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <IconCircleCheck size={14} stroke={1.5} /> Active
                    </span>
                  ) : (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <IconKey size={14} stroke={1.5} /> No Key
                    </span>
                  )}
                </span>
                <span className={`${styles.toggleIcon} ${isExpanded ? styles.toggleIconExpanded : ''}`}>▼</span>
              </div>

              <div className={styles.cardBody}>
                <div className={styles.cardContent}>
                  {p.hasKey && testResults[key] && (
                    <div className={`${styles.testBadge} ${styles[`test_${testResults[key].outcome}`] || ''}`}>
                      {(() => {
                        const meta = TEST_OUTCOME_META[testResults[key].outcome] || TEST_OUTCOME_META.fail
                        const Icon = meta.icon
                        return (
                          <>
                            <Icon size={12} stroke={1.5} />
                            <span>Last test: {meta.label}{testResults[key].code ? ` (HTTP ${testResults[key].code})` : ''}</span>
                          </>
                        )
                      })()}
                    </div>
                  )}
                  {p.hasKey && (
                    <div className={styles.keyGroup}>
                      <label className={styles.keyLabel}>Current API Key</label>
                      <div className={styles.keyDisplay}>
                        <span className={styles.keyDisplayValue}>
                          {isRevealed ? (p.maskedKey || '••••••••') : maskKey(p.maskedKey || '')}
                        </span>
                        <div className={styles.keyDisplayActions}>
                          <button className={styles.actionBtn} onClick={() => toggleRevealKey(key)} title={isRevealed ? 'Hide' : 'Reveal'}>
                            {isRevealed ? <IconEyeOff size={14} stroke={1.5} /> : <IconEye size={14} stroke={1.5} />}
                          </button>
                          <button
                            className={styles.actionBtn}
                            onClick={() => testKey(key)}
                            disabled={testingKeys.has(key)}
                            title="Test this key against the provider (TUI: T key in Settings)"
                            aria-label={`Test key for ${key}`}
                          >
                            {testingKeys.has(key) ? <span className={styles.testSpinner} /> : <IconBolt size={14} stroke={1.5} />}
                            {testingKeys.has(key) ? 'Testing…' : 'Test'}
                          </button>
                          <button className={`${styles.actionBtn} ${styles.actionBtnDanger}`} onClick={() => deleteKey(key)} title="Delete Key">
                            <IconTrash size={14} stroke={1.5} />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className={styles.keyGroup}>
                    <label className={styles.keyLabel}>{p.hasKey ? 'Update API Key' : 'Add API Key'}{p.billingNote ? ` 💰 ${p.billingNote}` : ''}</label>
                    <div className={styles.keyInputRow}>
                      <input
                        type="password"
                        className={styles.keyInput}
                        placeholder="Enter your API key..."
                        value={keyInputs[key] || ''}
                        onChange={(e) => setKeyInputs((prev) => ({ ...prev, [key]: e.target.value }))}
                        autoComplete="off"
                      />
                      <button className={styles.saveBtn} onClick={() => saveKey(key)}>
                        {p.hasKey ? 'Update' : 'Save'}
                      </button>
                    </div>
                  </div>

                  <div className={styles.enabledRow}>
                    <span className={styles.enabledLabel}>Provider Enabled</span>
                    <label className={styles.toggleSwitch}>
                      <input
                        type="checkbox"
                        defaultChecked={p.enabled !== false}
                        onChange={(e) => toggleProvider(key, e.target.checked)}
                      />
                      <span className={styles.toggleSlider} />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

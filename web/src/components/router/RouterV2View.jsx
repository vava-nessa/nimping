/**
 * @file RouterV2View.jsx
 * @description Web dashboard page for the Smart Model Router v2 (BETA).
 *
 * 📖 Shows what the v1 router page could not: live breaker states including
 * DEGRADED and QUOTA_PAUSED (with expiry), the per-request fallback chain
 * (each attempt with its status/error plus every skipped model and the skip
 * reason), the global last-resort model, and a "test via router" action per
 * model that sends a REAL pinned request through the daemon's full chain
 * (normalization, pre-prompt, content gate), not around it.
 *
 * 📖 Everything here is clearly labelled BETA: v2 runs on its own port next
 * to v1, so this page can be explored with zero risk to the stable router.
 */

import { Fragment, useMemo, useState } from 'react'
import {
  IconPlayerPlay, IconPlayerStop, IconRefresh, IconFlask, IconRoute,
} from '@tabler/icons-react'
import useRouterV2 from '../../hooks/useRouterV2.js'
import styles from './RouterV2View.module.css'

function formatUptime(seconds) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s < 0) return '-'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function formatClock(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '-'
  return new Date(t).toLocaleTimeString()
}

function formatMs(ms) {
  const n = Number(ms)
  return Number.isFinite(n) && n > 0 ? `${Math.round(n)}ms` : '-'
}

const STATE_CLASS = {
  CLOSED: 'stateUp',
  DEGRADED: 'stateDegraded',
  HALF_OPEN: 'stateHalfOpen',
  OPEN: 'stateOpen',
  AUTH_ERROR: 'stateAuth',
  QUOTA_PAUSED: 'stateQuota',
  STALE: 'stateStale',
  UNSUPPORTED: 'stateStale',
}

const STATE_LABEL = {
  CLOSED: 'UP',
  DEGRADED: 'DEGRADED',
  HALF_OPEN: 'PROBING',
  OPEN: 'OPEN',
  AUTH_ERROR: 'AUTH FAIL',
  QUOTA_PAUSED: 'QUOTA PAUSED',
  STALE: 'STALE',
  UNSUPPORTED: 'UNSUPPORTED',
}

function OutcomeBadge({ outcome }) {
  const cls = outcome === 'served'
    ? styles.outcomeServed
    : outcome === 'client_aborted'
      ? styles.outcomeAborted
      : styles.outcomeFailed
  return <span className={cls}>{outcome === 'served' ? 'served' : (outcome === 'client_aborted' ? 'aborted' : (outcome || 'failed'))}</span>
}

export default function RouterV2View({ onClose, onToast }) {
  const { status, stats, history, loading, lastError, refresh, start, stop, testModel } = useRouterV2()
  const [testingKey, setTestingKey] = useState(null)
  const [testResults, setTestResults] = useState({})
  const [expanded, setExpanded] = useState(null)

  const running = status?.ok === true
  const routingOrder = useMemo(() => (Array.isArray(stats?.routingOrder) ? stats.routingOrder : []), [stats])
  const models = useMemo(() => {
    const list = Array.isArray(stats?.models) ? stats.models : []
    return new Map(list.map((m) => [m.key, m]))
  }, [stats])
  const historyEntries = useMemo(() => (Array.isArray(history?.entries) ? history.entries : []), [history])
  const stateCounts = stats?.modelStates || {}

  const handleTest = async (key) => {
    const slashIdx = key.indexOf('/')
    if (slashIdx <= 0) return
    const provider = key.slice(0, slashIdx)
    const model = key.slice(slashIdx + 1)
    setTestingKey(key)
    try {
      const result = await testModel(provider, model)
      setTestResults((prev) => ({ ...prev, [key]: result }))
      if (result.ok) onToast?.(`${key} OK via router v2 (${formatMs(result.latencyMs)})`, 'success')
      else onToast?.(`${key} FAILED via router v2: ${result.error || 'unknown'}`, 'error')
      void refresh()
    } finally {
      setTestingKey(null)
    }
  }

  const handleTestTopThree = async () => {
    for (const entry of routingOrder.slice(0, 3)) {
      await handleTest(entry.key)
    }
  }

  return (
    <div className={styles.wrap} data-testid="router-v2-view">
      <div className={styles.header}>
        <div className={styles.titleBlock}>
          <IconRoute size={22} stroke={1.6} />
          <h2 className={styles.title}>Smart Model Router v2</h2>
          <span className={styles.betaChip}>BETA</span>
        </div>
        <div className={styles.actions}>
          <button className={styles.ghostBtn} onClick={() => void refresh()} title="Refresh">
            <IconRefresh size={15} stroke={1.6} /> Refresh
          </button>
          {running ? (
            <button className={styles.stopBtn} onClick={() => void stop().then((r) => onToast?.(r.ok ? 'Router v2 stopped' : (r.error || 'Stop failed'), r.ok ? 'info' : 'error'))}>
              <IconPlayerStop size={15} stroke={1.6} /> Stop daemon
            </button>
          ) : (
            <button className={styles.startBtn} onClick={() => void start().then((r) => onToast?.(r.ok ? 'Router v2 started' : (r.error || 'Start failed'), r.ok ? 'success' : 'error'))}>
              <IconPlayerPlay size={15} stroke={1.6} /> Start daemon
            </button>
          )}
        </div>
      </div>

      <p className={styles.betaBanner}>
        <strong>Beta:</strong> v2 runs next to the stable Router on its own port
        ({status?.port || 19380}) and shares the same sets, models and API keys.
        Failover here is content-validated: an HTTP 200 with empty or garbage
        output is treated as a failure and fails over. Anthropic-style agents can
        use <code>POST /v1/messages</code> on the same port.
      </p>

      {!running && (
        <div className={styles.stoppedCard}>
          {loading ? (
            <p>Checking for a running v2 daemon...</p>
          ) : (
            <>
              <p>
                {lastError
                  ? <>Router v2 daemon is not reachable ({lastError}).</>
                  : <>Router v2 daemon is not running.</>}
              </p>
              <code className={styles.codeBlock}>free-coding-models --router-v2-bg</code>
              <p className={styles.dim}>
                Or press <strong>Start daemon</strong> above. The stable Router (v1) is unaffected and keeps running on port 19280.
              </p>
            </>
          )}
        </div>
      )}

      {running && (
        <>
          <div className={styles.cards}>
            <div className={styles.card}>
              <span className={styles.cardLabel}>Uptime</span>
              <span className={styles.cardValue}>{formatUptime(stats?.uptimeSeconds)}</span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardLabel}>Requests routed</span>
              <span className={styles.cardValue}>{stats?.requestsRouted ?? 0}</span>
              <span className={styles.cardSub}>{Math.round((stats?.history?.failover_rate ?? 0) * 100)}% needed failover</span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardLabel}>Chain health</span>
              <span className={styles.cardValue}>
                <span className={styles.stateUp}>{stateCounts.CLOSED ?? 0} up</span>{' '}
                <span className={styles.stateDegraded}>{stateCounts.DEGRADED ?? 0} degraded</span>{' '}
                <span className={styles.stateOpen}>{stateCounts.OPEN ?? 0} open</span>
              </span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardLabel}>Validation</span>
              <span className={styles.cardValue}>{stats?.failover?.contentValidation || 'strict'}</span>
              <span className={styles.cardSub}>
                last resort: {stats?.failover?.lastResortModel || 'off'}
              </span>
            </div>
          </div>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3>Fallback chain</h3>
              <span className={styles.sectionHint}>the exact order the next request will try</span>
            </div>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Model</th>
                  <th>State</th>
                  <th>Uptime</th>
                  <th>Last latency</th>
                  <th>Test via router</th>
                </tr>
              </thead>
              <tbody>
                {routingOrder.length === 0 && (
                  <tr><td colSpan={6} className={styles.empty}>No routeable candidates (missing keys or every model is failing).</td></tr>
                )}
                {routingOrder.map((entry, i) => {
                  const health = models.get(entry.key) || {}
                  const state = health.state || entry.state || 'UNKNOWN'
                  const test = testResults[entry.key]
                  return (
                    <tr key={entry.key} className={i === 0 ? styles.primaryRow : ''}>
                      <td>{i === 0 ? '▶' : ''} {entry.priority ?? i + 1}</td>
                      <td className={styles.modelCell}>{entry.key}</td>
                      <td>
                        <span className={styles[STATE_CLASS[state]] || styles.stateUnknown}>
                          {STATE_LABEL[state] || state}
                        </span>
                        {health.quota_paused_until && (
                          <span className={styles.pauseUntil}> until {formatClock(health.quota_paused_until)}</span>
                        )}
                      </td>
                      <td>{health.uptime != null ? `${Math.round(health.uptime * 100)}%` : '-'}</td>
                      <td>{formatMs(health.last_latency_ms)}</td>
                      <td>
                        <button
                          className={styles.testBtn}
                          disabled={testingKey === entry.key}
                          onClick={() => void handleTest(entry.key)}
                          title="Send one real pinned request through the router chain"
                        >
                          <IconFlask size={13} stroke={1.6} />
                          {testingKey === entry.key ? 'testing...' : (test ? (test.ok ? `OK ${formatMs(test.latencyMs)}` : 'failed') : 'test')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {routingOrder.length > 0 && (
              <div className={styles.sectionActions}>
                <button className={styles.ghostBtn} disabled={testingKey !== null} onClick={() => void handleTestTopThree()}>
                  <IconFlask size={14} stroke={1.6} /> Test top 3 through the router
                </button>
              </div>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3>Request chains</h3>
              <span className={styles.sectionHint}>every attempt, skip reason and the winning model</span>
            </div>
            {historyEntries.length === 0 ? (
              <p className={styles.empty}>No requests routed yet. Point a tool at <code>http://localhost:{status?.port || 19380}/v1</code> with model <code>fcm</code>.</p>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Set</th>
                    <th>Outcome</th>
                    <th>Chain</th>
                    <th>Wall</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {historyEntries.map((entry) => {
                    const id = entry.request_id || entry.at
                    const isOpen = expanded === id
                    return (
                      <Fragment key={id}>
                        <tr onClick={() => setExpanded(isOpen ? null : id)} className={styles.chainRow}>
                          <td>{formatClock(entry.at)}</td>
                          <td>{entry.set || '-'}</td>
                          <td><OutcomeBadge outcome={entry.outcome} /></td>
                          <td className={styles.chainCell}>{entry.summary || entry.served_model || '-'}</td>
                          <td>{formatMs(entry.wall_ms)}</td>
                          <td>{entry.last_resort_used ? <span className={styles.lastResort}>last-resort</span> : null}</td>
                        </tr>
                        {isOpen && (
                          <tr className={styles.detailRow}>
                            <td colSpan={6}>
                              <div className={styles.detailBody}>
                                <div>
                                  <strong>Attempts:</strong>
                                  <ol>
                                    {(entry.attempts || []).map((a, i) => (
                                      <li key={`${id}-a${i}`}>
                                        <code>{a.model}</code>
                                        {a.status != null && ` status ${a.status}`}
                                        {a.latency_ms != null && ` · ${formatMs(a.latency_ms)}`}
                                        {a.error && <span className={styles.stateOpen}> · {a.error}</span>}
                                      </li>
                                    ))}
                                  </ol>
                                </div>
                                <div>
                                  <strong>Skipped:</strong>
                                  {(entry.skipped || []).length === 0
                                    ? <span> none</span>
                                    : (
                                      <ul>
                                        {entry.skipped.map((s, i) => (
                                          <li key={`${id}-s${i}`}><code>{s.model}</code> · {s.reason}</li>
                                        ))}
                                      </ul>
                                    )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3>Quick setup</h3>
            </div>
            <div className={styles.setupGrid}>
              <div>
                <span className={styles.cardLabel}>OpenAI-compatible tools</span>
                <code className={styles.codeBlock}>
                  base_url: http://localhost:{status?.port || 19380}/v1{'\n'}model: fcm{'\n'}api_key: fcm-local
                </code>
              </div>
              <div>
                <span className={styles.cardLabel}>Anthropic-protocol agents</span>
                <code className={styles.codeBlock}>
                  base_url: http://localhost:{status?.port || 19380}{'\n'}POST /v1/messages{'\n'}model: fcm (or fcm:@provider/model)
                </code>
              </div>
            </div>
            <p className={styles.dim}>
              Pin a single model for testing or dedicated traffic: <code>model: "fcm:@{routingOrder[0]?.key || 'provider/model'}"</code> routes to that exact model with failover disabled.
            </p>
          </section>
        </>
      )}
    </div>
  )
}

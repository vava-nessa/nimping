/**
 * @file useRouterV2.js
 * @description Polling hook for the Router v2 (BETA) dashboard page.
 *
 * 📖 Talks exclusively to the /api/router-v2/* proxy endpoints (web server
 * proxies to the v2 daemon). Polls status + stats + history on one interval,
 * and stops when the page unmounts. Unlike v1's hook, errors are surfaced
 * (lastError) instead of silently swallowed, so "the page says nothing" can
 * never hide a dead daemon.
 *
 * @functions useRouterV2({ pollMs }) → { status, stats, history, loading, lastError, refresh, start, stop, testModel }
 * @exports useRouterV2
 */

import { useState, useEffect, useCallback, useRef } from 'react'

const DEFAULT_POLL_MS = 3000

export default function useRouterV2({ pollMs = DEFAULT_POLL_MS } = {}) {
  const [status, setStatus] = useState(null)
  const [stats, setStats] = useState(null)
  const [history, setHistory] = useState(null)
  const [loading, setLoading] = useState(true)
  const [lastError, setLastError] = useState(null)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const [statusResp, statsResp, historyResp] = await Promise.all([
        fetch('/api/router-v2/status').then((r) => r.json()).catch(() => null),
        fetch('/api/router-v2/stats').then((r) => r.json()).catch(() => null),
        fetch('/api/router-v2/history?limit=25').then((r) => r.json()).catch(() => null),
      ])
      if (!mountedRef.current) return
      const running = statusResp?.ok === true
      setStatus(statusResp)
      setStats(running && statsResp?.ok === true ? statsResp : null)
      setHistory(running && historyResp ? historyResp : null)
      setLastError(running ? null : (statusResp?.error || null))
    } catch (err) {
      if (mountedRef.current) setLastError(err?.message || 'Router v2 status check failed')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  const lifecycle = useCallback(async (action) => {
    try {
      const resp = await fetch(`/api/router-v2/${action}`, { method: 'POST' })
      const data = await resp.json().catch(() => ({}))
      await refresh()
      return data
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }, [refresh])

  const start = useCallback(() => lifecycle('start'), [lifecycle])
  const stop = useCallback(() => lifecycle('stop'), [lifecycle])

  /**
   * 📖 Test one model through the v2 daemon (pinned request, full chain).
   * @param {string} provider
   * @param {string} model
   */
  const testModel = useCallback(async (provider, model) => {
    try {
      const resp = await fetch('/api/router-v2/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model }),
      })
      return await resp.json()
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    const timer = setInterval(() => void refresh(), Math.max(1500, pollMs))
    return () => {
      mountedRef.current = false
      clearInterval(timer)
    }
  }, [refresh, pollMs])

  return { status, stats, history, loading, lastError, refresh, start, stop, testModel }
}

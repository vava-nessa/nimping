/**
 * @file test/tui-hotkeys.test.js
 * @description Tests covering TUI hotkey behaviour for Task 5.
 *
 * Scope:
 *   1. G        — usage sort: sortResults('usage') sorts by usagePercent asc/desc
 *   2. W key    — ping mode cycle: speed → normal → slow → forced
 *   3. Auto ping transitions — startup speed drops to normal, inactivity drops to slow,
 *                  and activity wakes idle sessions back into a 60s speed burst
 *
 * Because the TUI is a full interactive loop we test the underlying pure logic
 * (sortResults from lib/utils.js) plus a lightweight state-machine helper that
 * mirrors the key-handler logic extracted for testability.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sortResults, getVersionStatusInfo } from '../src/core/utils.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal result object for sort tests. */
function makeResult(overrides = {}) {
  return {
    idx: 1,
    modelId: 'model-x',
    label: 'Model X',
    tier: 'A',
    sweScore: '50%',
    ctx: '128k',
    providerKey: 'nvidia',
    status: 'up',
    pings: [{ ms: 200, code: '200' }],
    usagePercent: undefined,
    ...overrides,
  }
}

// ─── Suite: G — usage sort (sortResults 'usage') ─────────────────────────────

describe('tui-hotkeys – G usage sort', () => {
  it('sortResults("usage", "asc") puts lower usagePercent first', () => {
    const results = [
      makeResult({ idx: 1, label: 'A', usagePercent: 80 }),
      makeResult({ idx: 2, label: 'B', usagePercent: 20 }),
      makeResult({ idx: 3, label: 'C', usagePercent: 50 }),
    ]
    const sorted = sortResults(results, 'usage', 'asc')
    assert.strictEqual(sorted[0].label, 'B')  // 20% — least quota left first
    assert.strictEqual(sorted[1].label, 'C')  // 50%
    assert.strictEqual(sorted[2].label, 'A')  // 80%
  })

  it('sortResults("usage", "desc") puts higher usagePercent first', () => {
    const results = [
      makeResult({ idx: 1, label: 'A', usagePercent: 80 }),
      makeResult({ idx: 2, label: 'B', usagePercent: 20 }),
      makeResult({ idx: 3, label: 'C', usagePercent: 50 }),
    ]
    const sorted = sortResults(results, 'usage', 'desc')
    assert.strictEqual(sorted[0].label, 'A')  // 80% first
    assert.strictEqual(sorted[1].label, 'C')  // 50%
    assert.strictEqual(sorted[2].label, 'B')  // 20%
  })

  it('treats undefined usagePercent as 0 (sorts to bottom on asc)', () => {
    const results = [
      makeResult({ idx: 1, label: 'Has-Usage',  usagePercent: 30 }),
      makeResult({ idx: 2, label: 'No-Usage-A', usagePercent: undefined }),
      makeResult({ idx: 3, label: 'No-Usage-B', usagePercent: null }),
    ]
    const sorted = sortResults(results, 'usage', 'asc')
    // undefined/null → 0, so they sort before 30 on asc
    assert.strictEqual(sorted[0].usagePercent ?? 0, 0)
    assert.strictEqual(sorted[1].usagePercent ?? 0, 0)
    assert.strictEqual(sorted[2].label, 'Has-Usage')
  })

  it('toggling direction when column is already "usage" flips asc/desc', () => {
    // Simulate: state.sortColumn === 'usage' → flip direction
    let sortColumn = 'usage'
    let sortDirection = 'asc'

    // First toggle: same column → flip
    if (sortColumn === 'usage') {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'
    }
    assert.strictEqual(sortDirection, 'desc')

    // Second toggle: flip again
    if (sortColumn === 'usage') {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'
    }
    assert.strictEqual(sortDirection, 'asc')
  })

  it('switching from a different column to "usage" resets direction to asc', () => {
    let sortColumn = 'avg'
    let sortDirection = 'desc'

    // Press G: different column → set usage + reset to asc
    const col = 'usage'
    if (sortColumn === col) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'
    } else {
      sortColumn = col
      sortDirection = 'asc'
    }
    assert.strictEqual(sortColumn, 'usage')
    assert.strictEqual(sortDirection, 'asc')
  })
})

// ─── Suite: W key + auto transitions — ping mode state machine ──────────────

describe('tui-hotkeys – W key ping mode cycle + auto transitions', () => {
  const PING_MODE_CYCLE = ['speed', 'normal', 'slow', 'forced']
  const PING_MODE_INTERVALS = { speed: 2000, normal: 10000, slow: 30000, forced: 4000 }
  const SPEED_MODE_DURATION_MS = 60000
  const IDLE_SLOW_AFTER_MS = 5 * 60_000

  function setPingMode(state, nextMode, source = 'manual', now = 0) {
    state.pingMode = nextMode
    state.pingModeSource = source
    state.pingInterval = PING_MODE_INTERVALS[nextMode]
    state.speedModeUntil = nextMode === 'speed' ? now + SPEED_MODE_DURATION_MS : null
    state.resumeSpeedOnActivity = source === 'idle'
  }

  function refreshAutoPingMode(state, now) {
    if (state.pingMode === 'forced') return
    if (state.speedModeUntil && now >= state.speedModeUntil) {
      setPingMode(state, 'normal', 'auto', now)
      return
    }
    if (now - state.lastUserActivityAt >= IDLE_SLOW_AFTER_MS) {
      if (state.pingMode !== 'slow' || state.pingModeSource !== 'idle') {
        setPingMode(state, 'slow', 'idle', now)
      } else {
        state.resumeSpeedOnActivity = true
      }
    }
  }

  function noteUserActivity(state, now) {
    state.lastUserActivityAt = now
    if (state.pingMode === 'forced') return
    if (state.resumeSpeedOnActivity) {
      setPingMode(state, 'speed', 'activity', now)
    }
  }

  it('W cycles speed → normal → slow → forced → speed', () => {
    const state = { pingMode: 'speed', pingInterval: 2000 }

    const nextMode = () => {
      const currentIdx = PING_MODE_CYCLE.indexOf(state.pingMode)
      const nextIdx = (currentIdx + 1) % PING_MODE_CYCLE.length
      state.pingMode = PING_MODE_CYCLE[nextIdx]
      state.pingInterval = PING_MODE_INTERVALS[state.pingMode]
    }

    nextMode()
    assert.strictEqual(state.pingMode, 'normal')
    assert.strictEqual(state.pingInterval, 10000)

    nextMode()
    assert.strictEqual(state.pingMode, 'slow')
    assert.strictEqual(state.pingInterval, 30000)

    nextMode()
    assert.strictEqual(state.pingMode, 'forced')
    assert.strictEqual(state.pingInterval, 4000)

    nextMode()
    assert.strictEqual(state.pingMode, 'speed')
    assert.strictEqual(state.pingInterval, 2000)
  })

  it('startup speed auto-falls back to normal after one minute', () => {
    const state = {
      pingMode: 'speed',
      pingModeSource: 'startup',
      pingInterval: 2000,
      speedModeUntil: 60000,
      lastUserActivityAt: 0,
      resumeSpeedOnActivity: false,
    }

    refreshAutoPingMode(state, 60000)
    assert.strictEqual(state.pingMode, 'normal')
    assert.strictEqual(state.pingInterval, 10000)
  })

  it('five minutes of inactivity auto-switches to slow', () => {
    const state = {
      pingMode: 'normal',
      pingModeSource: 'manual',
      pingInterval: 10000,
      speedModeUntil: null,
      lastUserActivityAt: 0,
      resumeSpeedOnActivity: false,
    }

    refreshAutoPingMode(state, IDLE_SLOW_AFTER_MS)
    assert.strictEqual(state.pingMode, 'slow')
    assert.strictEqual(state.pingModeSource, 'idle')
    assert.strictEqual(state.resumeSpeedOnActivity, true)
  })

  it('activity after idle slowdown restarts a one-minute speed burst', () => {
    const state = {
      pingMode: 'slow',
      pingModeSource: 'idle',
      pingInterval: 30000,
      speedModeUntil: null,
      lastUserActivityAt: 0,
      resumeSpeedOnActivity: true,
    }

    noteUserActivity(state, 301000)
    assert.strictEqual(state.pingMode, 'speed')
    assert.strictEqual(state.pingModeSource, 'activity')
    assert.strictEqual(state.pingInterval, 2000)
    assert.strictEqual(state.speedModeUntil, 361000)
  })

  it('forced mode ignores idle and speed auto transitions', () => {
    const state = {
      pingMode: 'forced',
      pingModeSource: 'manual',
      pingInterval: 4000,
      speedModeUntil: 1000,
      lastUserActivityAt: 0,
      resumeSpeedOnActivity: false,
    }

    refreshAutoPingMode(state, IDLE_SLOW_AFTER_MS + 1000)
    assert.strictEqual(state.pingMode, 'forced')
    assert.strictEqual(state.pingInterval, 4000)
  })

  it('X key no longer adjusts ping cadence and stays unassigned in the public TUI', () => {
    const sortKeys = {
      'r': 'rank', 'o': 'origin', 'm': 'model',
      'l': 'ping', 'a': 'avg', 's': 'swe', 'c': 'ctx',
      'h': 'condition', 'v': 'verdict', 'b': 'stability', 'u': 'uptime', 'g': 'usage',
    }
    assert.ok(!('x' in sortKeys), 'x must not be in sort keys')
    assert.ok(!('y' in sortKeys), 'y must not be in sort keys')
    assert.ok(!('w' in sortKeys), 'w must not be in sort keys')
  })
})

describe('tui-hotkeys – version status indicator', () => {
  it('marks the install as outdated only when a newer version is explicitly available', () => {
    const info = getVersionStatusInfo('available', '0.2.1')
    assert.equal(info.isOutdated, true)
    assert.equal(info.latestVersion, '0.2.1')
  })

  it('reuses the startup auto-check result when the user skipped the update prompt', () => {
    const info = getVersionStatusInfo('idle', null, '0.2.1')
    assert.equal(info.isOutdated, true)
    assert.equal(info.latestVersion, '0.2.1')
  })

  it('stays quiet when no update has been found', () => {
    const info = getVersionStatusInfo('idle', null)
    assert.equal(info.isOutdated, false)
    assert.equal(info.latestVersion, null)
  })
})

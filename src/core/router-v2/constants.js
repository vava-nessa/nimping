/**
 * @file constants.js
 * @description Shared constants + helpers for Router v2 (ports, state files, model pinning).
 *
 * @details
 *   📖 Router v2 runs BETA alongside v1: own default port range (19380-19389
 *   production, 29380-29389 dev), own PID/port/log/state files with a `-v2`
 *   suffix, so both daemons can run on the same machine without clashing.
 *   Both daemons share the same `~/.free-coding-models.json` config (sets,
 *   keys, favorites); v2 never writes router sets (v1 owns config healing
 *   while v2 is in beta), it only reads + reloads.
 *
 *   📖 Pinned-model syntax: `model: "fcm:@provider/modelId"` routes to that
 *   exact model with failover disabled. It is what "test via router" uses to
 *   exercise ONE model through the FULL routing chain (normalization, pre
 *   prompt, response gate) instead of around it.
 *
 * @functions
 *   → getRouterV2PortRange() - Effective port range (dev vs production)
 *   → getRouterV2PidPath/PortPath/LogPath/StateDir() - Runtime file paths
 *   → parseFcmModel(model) - Resolve `fcm` | `fcm:<set>` | `fcm:@provider/model`
 *
 * @exports ROUTER_V2_DEFAULT_PORT, ROUTER_V2_MAX_PORT, ROUTER_V2_DEFAULT_PORT_DEV
 * @exports ROUTER_V2_MAX_PORT_DEV, getRouterV2PortRange, getRouterV2PidPath
 * @exports getRouterV2PortPath, getRouterV2LogPath, getRouterV2StateDir
 * @exports parseFcmModel, FCM_V2_LOCAL_API_KEY
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export const ROUTER_V2_DEFAULT_PORT = 19380
export const ROUTER_V2_MAX_PORT = 19389
export const ROUTER_V2_DEFAULT_PORT_DEV = 29380
export const ROUTER_V2_MAX_PORT_DEV = 29389

// 📖 Placeholder API key coding tools send when the router needs no real key.
// Kept identical to v1 so switching a tool from v1 to v2 is a base-URL edit.
export const FCM_V2_LOCAL_API_KEY = 'fcm-local'

function isDev() {
  return typeof process.env.FCM_DEV !== 'undefined' ? !!process.env.FCM_DEV : false
}

export function getRouterV2PortRange() {
  return isDev()
    ? { defaultPort: ROUTER_V2_DEFAULT_PORT_DEV, maxPort: ROUTER_V2_MAX_PORT_DEV }
    : { defaultPort: ROUTER_V2_DEFAULT_PORT, maxPort: ROUTER_V2_MAX_PORT }
}

export function getRouterV2PidPath() {
  return join(homedir(), `.free-coding-models-daemon-v2${isDev() ? '-dev' : ''}.pid`)
}

export function getRouterV2PortPath() {
  return join(homedir(), `.free-coding-models-daemon-v2${isDev() ? '-dev' : ''}.port`)
}

export function getRouterV2LogPath() {
  return join(homedir(), `.free-coding-models-daemon-v2${isDev() ? '-dev' : ''}.log`)
}

/**
 * 📖 Directory holding v2 runtime state (breaker store, request history,
 * token counters). Kept next to the classic config file so backups and
 * `--fix-permissions` cover the whole family.
 */
export function getRouterV2StateDir() {
  return homedir()
}

export function getRouterV2BreakersPath() {
  return join(getRouterV2StateDir(), '.free-coding-models-router-v2-breakers.json')
}

export function getRouterV2HistoryPath() {
  return join(getRouterV2StateDir(), '.free-coding-models-router-v2-history.json')
}

export function getRouterV2TokensPath() {
  return join(getRouterV2StateDir(), `.free-coding-models-tokens-v2${isDev() ? '-dev' : ''}.json`)
}

/**
 * 📖 Resolve the `model` field of an incoming request.
 * @param {string} model - raw model string from the client
 * @returns {{ kind: 'default', set: null, pinned: null }
 *           | { kind: 'set', set: string, pinned: null }
 *           | { kind: 'pinned', set: null, pinned: { provider: string, model: string } }
 *           | { kind: 'unknown' }}
 */
export function parseFcmModel(model) {
  if (typeof model !== 'string' || !model.trim()) return { kind: 'unknown', set: null, pinned: null }
  const value = model.trim()
  if (value === 'fcm' || value === 'fcm:default') return { kind: 'default', set: null, pinned: null }
  if (value.startsWith('fcm:@')) {
    const rest = value.slice(5)
    const slashIdx = rest.indexOf('/')
    if (slashIdx <= 0 || slashIdx === rest.length - 1) return { kind: 'unknown', set: null, pinned: null }
    return { kind: 'pinned', set: null, pinned: { provider: rest.slice(0, slashIdx), model: rest.slice(slashIdx + 1) } }
  }
  if (value.startsWith('fcm:')) {
    const setName = value.slice(4).trim()
    if (!setName) return { kind: 'default', set: null, pinned: null }
    return { kind: 'set', set: setName, pinned: null }
  }
  return { kind: 'unknown', set: null, pinned: null }
}

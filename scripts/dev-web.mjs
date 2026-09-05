#!/usr/bin/env node
/**
 * @file scripts/dev-web.mjs
 * @description Dev: free ports 3333+5179 (own processes only), spawn backend, spawn Vite. One command.
 */
import { createServer } from 'node:net'
import { exec, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { writeFileSync } from 'node:fs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')
const API_PORT = 3333

// ─── Port helpers ────────────────────────────────────────────────────────────
function isPortUsed(port) {
  return new Promise((resolve) => {
    const s = createServer()
    s.once('error', (err) => resolve(err.code === 'EADDRINUSE'))
    s.once('listening', () => s.close(() => resolve(false)))
    s.listen(port)
  })
}

function execp(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 8000 }, (err, out, err2) => resolve({ err, out, err2 }))
  })
}

// ─── Main ────────────────────────────────────────────────────────────────────
// 📖 Only processes belonging to this project's dev stack may be killed:
// 📖 vite (dev server), the generated .dev-backend-tmp.mjs wrapper, or anything
// 📖 named free-coding-models. Anything else listening on the port is left
// 📖 alone with a visible note so we never murder an unrelated app.
const OWN_PROCESS = /vite|free-coding-models|dev-backend-tmp|dev-web/

async function freePort(port) {
  const used = await isPortUsed(port)
  if (!used) {
    console.log(`  ✅ Port ${port} free`)
    return
  }
  const { out } = await execp(`lsof -ti:${port} 2>/dev/null`)
  const pids = (out || '').split('\n').map(s => s.trim()).filter(Boolean)
  let killed = 0
  for (const pid of pids) {
    const { out: cmdOut } = await execp(`ps -p ${pid} -o command=`)
    const command = (cmdOut || '').trim()
    if (OWN_PROCESS.test(command)) {
      await execp(`kill -9 ${pid} 2>/dev/null; echo ok`)
      killed++
    } else {
      console.log(`  ⚠️  Port ${port}: left PID ${pid} alone (not ours: ${command || 'unknown process'})`)
    }
  }
  await new Promise(r => setTimeout(r, 600))
  if (killed) console.log(`  🔪 Killed ${killed} own process(es) on port ${port}`)
  else console.log(`  ⚠️  Port ${port} busy: no own process to kill, continuing anyway`)
}

async function main() {
  console.log('\n  ⚡ free-coding-models dev:web\n')

  // Free 3333 (backend) and 5179 (vite), own processes only
  for (const port of [API_PORT, 5179]) {
    await freePort(port)
  }

  // 📖 Write a small wrapper script so we can spawn it cleanly
  // 📖 (avoids ESM require() issues with stdio piping). We set FCM_DEV=1
  // 📖 BEFORE importing the server so the whole backend (web server, daemon
  // 📖 status proxy, readDaemonPort) resolves the DEV port/pid files + dev port
  // 📖 range. Without this, `pnpm dev` read the prod daemon files and the Router
  // 📖 view couldn't see the dev daemon — the user had to click "Start" by hand.
  const wrapperPath = join(ROOT, '.dev-backend-tmp.mjs')
  writeFileSync(wrapperPath, `
process.env.FCM_DEV = '1'
import { startWebServer } from './web/server.js'
startWebServer(${API_PORT}, { open: false, startPingLoop: true }).then(() => {}).catch(console.error)
`)

  // Spawn backend (inherit FCM_DEV=1 from this process env too, belt + suspenders)
  console.log(`\n  🚀 Backend on :${API_PORT} (FCM_DEV=1)...\n`)
  const api = spawn('node', [wrapperPath], { stdio: 'inherit', cwd: ROOT, env: { ...process.env, FCM_DEV: '1' } })

  // Wait for port to be ready (poll)
  let portReady = false
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 300))
    portReady = await isPortUsed(API_PORT)
    if (portReady) break
  }

  if (!portReady) {
    console.log('  ⚠️  Backend may still be starting...')
  }

  // Spawn Vite directly (no pnpm exec overhead). 📖 --config points at the
  // 📖 web/ config so dev gets the full proxy set (/api + /socket.io with ws
  // 📖 upgrade + /v1). cwd stays at ROOT because web/vite.config.js declares
  // 📖 root: 'web', which Vite resolves against the working directory. The
  // 📖 root vite.config.js remains the config for `pnpm build:web` / preview.
  const viteBin = join(ROOT, 'node_modules/vite/bin/vite.js')
  const viteConfig = join(ROOT, 'web/vite.config.js')
  console.log('  🚀 Vite on :5179...\n')
  const vite = spawn('node', [viteBin, '--host', '--config', viteConfig], { stdio: 'inherit', cwd: ROOT })

  api.on('error', e => console.error('  ❌ API err:', e.message))
  vite.on('error', e => console.error('  ❌ Vite err:', e.message))

  process.on('SIGINT', () => {
    console.log('\n  🛑 Shutting down...')
    api.kill()
    vite.kill()
    try { import('node:fs').then(m => m.unlinkSync(wrapperPath)) } catch {}
    process.exit(0)
  })
}

main().catch(e => { console.error(e); process.exit(1) })
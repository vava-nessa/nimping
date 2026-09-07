#!/usr/bin/env node
/**
 * @file free-coding-models.js
 * @description Live terminal availability checker for coding LLM models with OpenCode & OpenClaw integration.
 */

// 📖 --dev mode: must set FCM_DEV before any module imports resolve daemon paths.
// 📖 Also auto-detect git checkouts — a repo checkout is always in dev mode because
// 📖 the router daemon must use dev ports/files to avoid clashing with a production
// 📖 npm install running on the same machine.
// 📖 IMPORTANT: these checks MUST run synchronously before any static imports
// 📖 resolve, because router-daemon.js reads FCM_DEV at module load time.
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
if (process.argv.includes('--dev') || (!process.env.FCM_DEV && existsSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.git')))) {
  process.env.FCM_DEV = '1'
}
// 📖 --config-dir <dir>: point FCM's config files (config.json + backups/) at an
// 📖 arbitrary directory (e.g. the XDG layout ~/.config/free-coding-models).
// 📖 Stored as FCM_CONFIG_DIR BEFORE any static imports resolve so
// 📖 src/core/config.js picks the path up at module load time. An externally-set
// 📖 FCM_CONFIG_DIR (e.g. Docker) is preserved when the flag is absent.
const _configDirIdx = process.argv.indexOf('--config-dir')
if (_configDirIdx !== -1 && process.argv[_configDirIdx + 1] && !process.argv[_configDirIdx + 1].startsWith('--')) {
  const _raw = process.argv[_configDirIdx + 1].trim()
  const _expanded = _raw === '~' ? homedir() : _raw.startsWith('~/') ? join(homedir(), _raw.slice(2)) : _raw
  process.env.FCM_CONFIG_DIR = resolve(_expanded)
}

import chalk from 'chalk';
import { parseArgs, TIER_LETTER_MAP } from '../src/core/utils.js';
import { loadConfig, saveConfig } from '../src/core/config.js';
import { ensureTelemetryConfig } from '../src/core/telemetry.js';
import { ensureFavoritesConfig } from '../src/core/favorites.js';
import { buildCliHelpText } from '../src/tui/cli-help.js';
import { ALT_LEAVE } from '../src/core/constants.js';
import { enforceMandatoryStartupUpdate, isPackageDevMode } from '../src/core/updater.js';
import { checkConfigSecurity } from '../src/core/security.js';
import { runApp } from '../src/tui/app.js';

// Global error handlers to ensure terminal is restored if something crashes catastrophically
process.on('uncaughtException', (err) => {
  if (process.argv.some(arg => arg === '--daemon')) {
    console.error(err);
    return;
  }
  process.stdout.write(ALT_LEAVE);
  console.error(chalk.red('\n[Fatal Error] An unhandled exception occurred.'));
  console.error(err);
  console.error(chalk.yellow('\nPlease file an issue at https://github.com/vava-nessa/free-coding-models/issues or use the feedback form (I key) to report this to the author.'));
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  if (process.argv.some(arg => arg === '--daemon')) {
    console.error(reason);
    return;
  }
  process.stdout.write(ALT_LEAVE);
  console.error(chalk.red('\n[Fatal Error] An unhandled promise rejection occurred.'));
  console.error(reason);
  console.error(chalk.yellow('\nPlease file an issue at https://github.com/vava-nessa/free-coding-models/issues or use the feedback form (I key) to report this to the author.'));
  process.exit(1);
});

async function main() {
  const cliArgs = parseArgs(process.argv);

  if (cliArgs.helpMode) {
    console.log();
    console.log(buildCliHelpText({ chalk, title: 'free-coding-models' }));
    console.log();
    process.exit(0);
  }

  // 📖 --clear-runtime (t3): wipe ~/.free-coding-models/runtime-telemetry.json
  // 📖 before launching any surface. Keeps the TUI / daemon / web flows consistent.
  if (cliArgs.clearRuntimeMode) {
    try {
      const { clearRuntimeTelemetry } = await import('../src/core/runtime-telemetry.js')
      const ok = clearRuntimeTelemetry()
      console.log(chalk.dim(`  ${ok ? '✓' : '✗'} runtime-telemetry.json ${ok ? 'cleared' : 'clear failed'}`))
    } catch (err) {
      console.log(chalk.dim(`  runtime-telemetry.json clear failed: ${err?.message || err}`))
    }
  }

  // 📖 --check-drift (t5): diff sources.js against models.dev and print a report.
  // 📖 Runs BEFORE the config + update check so it works on bare clones and CI.
  if (cliArgs.checkDriftMode) {
    const threshold = cliArgs.driftThreshold ?? 0
    const args = ['--threshold', String(threshold)]
    // 📖 Forward --no-fail so the script exits 0 even on drift (useful for the
    // 📖 GitHub Actions job that opens an issue instead of failing the build).
    if (process.argv.includes('--no-fail') || process.argv.includes('--report-only')) {
      args.push('--no-fail')
    }
    const { spawn } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const here = dirname(fileURLToPath(import.meta.url))
    const script = join(here, '..', 'scripts', 'check-drift.mjs')
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' })
    child.on('exit', code => process.exit(code ?? 1))
    child.on('error', err => {
      console.error(chalk.red(`failed to spawn check-drift: ${err.message}`))
      process.exit(3)
    })
    return
  }

  // Load JSON config before operational modes so the mandatory update policy can
  // 📖 persist failure counters for TUI, Web Dashboard, Docker daemon, and Desktop sidecar launches.
  const config = loadConfig();
  ensureTelemetryConfig(config);
  ensureFavoritesConfig(config);

  const isDevMode = isPackageDevMode();
  const shouldEnforceUpdate = !cliArgs.daemonStopMode && !cliArgs.daemonStatusMode && !cliArgs.routerV2StopMode && !cliArgs.routerV2StatusMode;
  const startupUpdate = shouldEnforceUpdate
    ? await enforceMandatoryStartupUpdate(config, {
      saveConfig,
      isDevMode,
      surface: cliArgs.webMode ? 'web dashboard' : cliArgs.daemonMode ? 'router daemon' : 'TUI',
    })
    : { latestVersion: null, allowedOutdated: false, warningMessage: null, failures: 0, checked: false, updated: false, blocked: false };

  if (startupUpdate.updated) {
    try {
      // 📖 Stop any running daemon so that the relaunch/restart will start the new version.
      const { stopRouterDaemon } = await import('../src/core/router-daemon.js');
      await stopRouterDaemon();
    } catch {}
    return;
  }
  if (startupUpdate.blocked) process.exit(1);
  if (startupUpdate.allowedOutdated) {
    process.env.FCM_UPDATE_ALLOWED_OUTDATED = '1';
    process.env.FCM_UPDATE_LATEST_VERSION = startupUpdate.latestVersion || '';
    process.env.FCM_UPDATE_WARNING_MESSAGE = startupUpdate.warningMessage || '';
    process.env.FCM_UPDATE_FAILURES = String(startupUpdate.failures || 0);
  }

  // 📖 If the daemon is running an outdated version, stop it so it will restart on the new version.
  if (!cliArgs.daemonStopMode && !cliArgs.daemonStatusMode) {
    try {
      const { getRouterDaemonStatus, stopRouterDaemon } = await import('../src/core/router-daemon.js');
      const status = await getRouterDaemonStatus();
      const LOCAL_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
      if (status.ok && status.version && status.version !== LOCAL_VERSION) {
        console.log(chalk.yellow(`  ⚠ Outdated daemon version v${status.version} detected (current: v${LOCAL_VERSION}). Stopping old daemon...`));
        await stopRouterDaemon();
      }
    } catch {}
  }

  // 📖 Config security check (issue #173): the insecure-permission warning and its
  // 📖 "Fix permissions automatically?" prompt must fully resolve BEFORE any surface
  // 📖 takes over the terminal. It used to run un-awaited inside runApp, so the TUI
  // 📖 covered the prompt (invisible on Windows) and the app looked frozen.
  // 📖 Daemon / web dashboard / JSON surfaces pass promptAllowed=false so at most a
  // 📖 warning + manual hint goes to stderr, and the daemon can never hang on a prompt.
  // 📖 --fix-permissions / --yes / -y auto-applies chmod 600 (best-effort on Windows).
  const promptAllowed = !cliArgs.webMode
    && !cliArgs.jsonMode
    && !cliArgs.daemonMode
    && !cliArgs.daemonBackgroundMode
    && !cliArgs.daemonStopMode
    && !cliArgs.daemonStatusMode
    && !cliArgs.routerV2Mode
    && !cliArgs.routerV2BackgroundMode
    && !cliArgs.routerV2StopMode
    && !cliArgs.routerV2StatusMode;
  try {
    await checkConfigSecurity({ autoFix: cliArgs.fixPermissionsMode, promptAllowed });
  } catch {
    // 📖 A security-check failure must never block the app from starting.
  }

  // 📖 Standalone web dashboard: same full-catalog ping UI as the TUI, served
  // 📖 locally with Socket.IO/SSE/REST realtime updates.
  if (cliArgs.webMode) {
    const { startWebServer } = await import('../web/server.js');
    const parsedPort = Number.parseInt(process.env.FCM_WEB_PORT || process.env.FCM_PORT || '3333', 10);
    const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3333;
    await startWebServer(port, { open: true, startPingLoop: true, updateStatus: startupUpdate });
    return;
  }

  // 📖 Router daemon lifecycle flags run before the TUI so automation and
  // 📖 editor integrations can manage the local OpenAI-compatible endpoint.
  if (cliArgs.daemonMode || cliArgs.daemonBackgroundMode || cliArgs.daemonStopMode || cliArgs.daemonStatusMode) {
    const {
      getRouterDaemonStatus,
      runRouterDaemon,
      startRouterDaemonBackground,
      stopRouterDaemon,
    } = await import('../src/core/router-daemon.js');

    if (cliArgs.daemonMode) {
      await runRouterDaemon();
      return;
    }

    const result = cliArgs.daemonBackgroundMode
      ? await startRouterDaemonBackground()
      : cliArgs.daemonStopMode
        ? await stopRouterDaemon()
        : await getRouterDaemonStatus();

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  // 📖 Router v2 lifecycle flags are now ALIASES of the main daemon: the v2
  // engine (content-validated failover, persisted breakers, decision traces,
  // Anthropic /v1/messages) is merged into the regular router daemon on the
  // historical port. The flags keep working for existing scripts.
  if (cliArgs.routerV2Mode || cliArgs.routerV2BackgroundMode || cliArgs.routerV2StopMode || cliArgs.routerV2StatusMode) {
    const {
      getRouterDaemonStatus,
      runRouterDaemon,
      startRouterDaemonBackground,
      stopRouterDaemon,
    } = await import('../src/core/router-daemon.js');

    if (cliArgs.routerV2Mode) {
      await runRouterDaemon();
      return;
    }

    const result = cliArgs.routerV2BackgroundMode
      ? await startRouterDaemonBackground()
      : cliArgs.routerV2StopMode
        ? await stopRouterDaemon()
        : await getRouterDaemonStatus();

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  // 📖 --sync-set [name] — auto-discover, probe, and populate a router set
  if (cliArgs.syncSetMode) {
    const { syncSet } = await import('../src/core/sync-set.js');
    const result = await syncSet({ name: cliArgs.syncSetName || 'auto' });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  // 📖 --playground / playground subcommand — boot the TUI directly into the
  // 📖 Playground chat overlay. Falls through to the TUI; the key handler
  // 📖 opens the playground on first render.
  const wantPlayground = cliArgs.playgroundMode === true

  // Validate --tier early, before entering alternate screen
  if (cliArgs.tierFilter && !TIER_LETTER_MAP[cliArgs.tierFilter]) {
    // 📖 Strip control characters before echoing raw argv back to the terminal,
    // 📖 otherwise an argv sequence like \r could forge fake terminal output.
    const safeTierEcho = String(cliArgs.tierFilter).replace(/[\x00-\x1f\x7f]/g, '')
    console.error(chalk.red(`  Unknown tier "${safeTierEcho}". Valid tiers: S, A, B, C`));
    process.exit(1);
  }

  await runApp(cliArgs, config, { startupUpdate, isDevMode, wantPlayground });
}

main().catch((err) => {
  process.stdout.write(ALT_LEAVE);
  console.error(chalk.red('\n[Fatal Error]'));
  console.error(err);
  console.error(chalk.yellow('\nPlease file an issue at https://github.com/vava-nessa/free-coding-models/issues or use the feedback form (I key) to report this to the author.'));
  process.exit(1);
});

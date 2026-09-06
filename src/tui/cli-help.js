/**
 * @file src/cli-help.js
 * @description Shared CLI help builder for the startup `--help` flag and the in-app help overlay.
 *
 * @details
 *   📖 Keeping CLI help text in one module avoids the classic drift where the TUI overlay
 *   📖 documents one set of flags while `--help` prints another. New flags should be added
 *   📖 here once, then both entry points stay aligned.
 *
 *   📖 The builder accepts an optional `chalk` instance. When omitted, it returns plain text,
 *   📖 which keeps unit tests simple and makes the function safe for non-TTY contexts.
 *
 * @functions
 *   → `buildCliHelpLines` — build formatted help lines with optional colors and indentation
 *   → `buildCliHelpText` — join the help lines into one printable string
 *
 * @exports buildCliHelpLines, buildCliHelpText
 * @see ./tool-metadata.js — source of truth for launcher modes and their CLI flags
 */

import { getToolModeOrder, getToolMeta } from '../core/tool-metadata.js'

const ANALYSIS_FLAGS = [
  { flag: '--best', description: 'Show only top tiers (A+, S, S+)' },
  { flag: '--fiable', description: 'Run the 10s reliability analysis mode' },
  { flag: '--json', description: 'Output results as JSON for scripts/automation' },
  { flag: '--tier <S|A|B|C>', description: 'Filter models by tier family' },
  { flag: '--recommend', description: 'Open Smart Recommend immediately on startup' },
  { flag: '--premium', description: 'Start with S-tier filter + verdict sort (you can reset it in-app)' },
  { flag: '--sort <column>', description: 'Sort by column (rank, tier, origin, model, ping, avg, swe, ctx, condition, verdict, uptime, stability, aiLatency, tps)' },
  { flag: '--desc | --asc', description: 'Set sort direction (descending or ascending)' },
  { flag: '--origin <provider>', description: 'Filter models by provider origin' },
  { flag: '--ping-interval <ms>', description: 'Override ping interval in milliseconds' },
  { flag: '--hide-unconfigured', description: 'Hide models without configured API keys' },
  { flag: '--show-unconfigured', description: 'Show all models regardless of API key config' },
  { flag: '--reprobe, --no-cache', description: 'Force-rebuild the persistent probe-cache this run (skip cached healthy models)' },
  { flag: '--probe-ttl <ms>', description: 'Override probe-cache TTL (default 24h); healthy models within TTL are not re-pinged' },
  { flag: '--show-broken', description: "Don't auto-hide models that the probe-cache marked broken (one-shot override)" },
  { flag: '--check-drift', description: 'Diff sources.js against models.dev and print a drift report; exit 1 on mismatch (t5)' },
  { flag: '--drift-threshold <N>', description: 'Only fail --check-drift when N+ mismatches are found (default: 0 = any drift)' },
]

const CONFIG_FLAGS = [
  { flag: 'web | --web | --gui', description: 'Start the full-catalog realtime Web Dashboard' },
  { flag: 'playground | --playground', description: 'Open the in-TUI Playground chat overlay (auto-starts the router if needed)' },
  { flag: '--daemon', description: 'Start the FCM Router daemon + web dashboard (same port)' },
  { flag: '--daemon-bg', description: 'Start the FCM Router daemon in the background' },
  { flag: '--daemon-status', description: 'Print FCM Router daemon status JSON' },
  { flag: '--daemon-stop', description: 'Gracefully stop the FCM Router daemon' },
  { flag: '--router-v2', description: 'Start the Router v2 daemon (BETA) on port 19380: content-validated failover + Anthropic /v1/messages' },
  { flag: '--router-v2-bg', description: 'Start Router v2 (BETA) in the background' },
  { flag: '--router-v2-status', description: 'Print Router v2 (BETA) daemon status JSON' },
  { flag: '--router-v2-stop', description: 'Gracefully stop the Router v2 (BETA) daemon' },
  { flag: '--sync-set [name]', description: 'Auto-discover and live-probe models into a router set' },
  { flag: '--config-dir <dir>', description: 'Store config.json + backups/ in <dir> (e.g. --config-dir ~/.config/free-coding-models for the XDG layout)' },
  { flag: '--fix-permissions, --yes, -y', description: 'Auto-fix insecure config file permissions (chmod 600) without prompting; safe for scripts and CI' },
  { flag: '--no-telemetry', description: 'Disable anonymous telemetry for this run' },
  { flag: '--help, -h', description: 'Print this help and exit' },
]

const EXAMPLES = [
  'free-coding-models --help',
  'free-coding-models web',
  'free-coding-models --daemon',
  'free-coding-models --daemon-bg',
  'free-coding-models --daemon-status',
  'free-coding-models --sync-set',
  'free-coding-models --sync-set my-coding-set',
  'free-coding-models --playground',
  'free-coding-models --openclaw --tier S',
  "free-coding-models --json | jq '.[0]'",
]

/**
 * 📖 buildHowTheRouterWorks — a single-source explanation of the router
 * 📖 internals (circuit breaker, probe mechanism, pre-prompt) that the
 * 📖 Web Help modal and the TUI in-app help overlay both render. Keeping
 * 📖 it here prevents the two surfaces from drifting apart.
 */
export function buildHowTheRouterWorksLines({ chalk = null, indent = '' } = {}) {
  const lines = []
  const header = (text) => `${indent}${paint(chalk, chalk?.bold, text)}`
  const body = (text) => `${indent}${paint(chalk, chalk?.dim, text)}`
  const bullet = (text) => `${indent}  • ${text}`

  lines.push(header('How the FCM Router Works'))
  lines.push('')

  lines.push(header('1. The smart router daemon'))
  lines.push(body('Point any OpenAI-compatible client at http://localhost:19280/v1'))
  lines.push(body('with model: "fcm". The daemon picks the healthiest model in'))
  lines.push(body('your active set and forwards the request — with automatic'))
  lines.push(body('failover if the first model 429s or 5xxs. Failover prefers the'))
  lines.push(body('same model family on another provider (toggled per set as'))
  lines.push(body('Family failover on the Router Dashboard) before switching family.'))
  lines.push('')

  lines.push(header('2. The pre-prompt (system message)'))
  lines.push(body('A first-class system message is injected on every proxied'))
  lines.push(body('request. The default text introduces the assistant as the FCM'))
  lines.push(body('routing agent and points the user to the dashboard URL.'))
  lines.push(body('You can edit it from Settings (Settings → Pre-prompt).'))
  lines.push('')

  lines.push(header('3. The probe mechanism (every 10s/30s/120s)'))
  lines.push(body('The daemon sends a 1-token chat-completion ping to every model'))
  lines.push(body('in the active set. The probe measures latency + status code, not'))
  lines.push(body('just URL reachability — so a wrong API key is caught and the'))
  lines.push(body('circuit-breaker is opened.'))
  lines.push(bullet('eco: probe every 120s (saves quota)'))
  lines.push(bullet('balanced: probe every 30s (default)'))
  lines.push(bullet('aggressive: probe every 10s (uses more quota)'))
  lines.push('')

  lines.push(header('4. The circuit breaker (per-model state)'))
  lines.push(body('Each model has a tiny disjoncteur that flips between 3 states.'))
  lines.push(body('The raw jargon is hidden in the UI — here is what the colors mean:'))
  lines.push(bullet('Healthy (green)  — last probe returned 2xx, route here freely'))
  lines.push(bullet('Down (red)      — last 3 probes failed, skip until cooldown'))
  lines.push(bullet('Recovering (yellow) — cooldown expired, retrying with 1 request'))
  lines.push(bullet('Auth error (orange) — 401/403, your API key is wrong for this model'))
  lines.push(bullet('Deprecated (gray) — removed from the catalog, will be replaced'))
  lines.push(body('When a model flips to Auth error, the auto-heal on next start'))
  lines.push(body('replaces it with a working alternative from the same provider first,'))
  lines.push(body('then falls through to any provider.'))
  lines.push('')

  lines.push(header('5. Failover order'))
  lines.push(body('Models in the active set are tried in priority order. A model'))
  lines.push(body('in Recovering/Down/Auth error is skipped — the request goes to'))
  lines.push(body('the next healthy one. If ALL models fail, you get a 503 with the'))
  lines.push(body('"models_tried" list in the error body — useful for debugging.'))
  lines.push('')

  lines.push(header('6. Auto-heal (default behavior)'))
  lines.push(body('On daemon start, the active set is checked. Any model in Auth'))
  lines.push(body('error or Deprecated is swapped for a working alternative. The'))
  lines.push(body('first time you add/remove/reorder a model, auto-heal switches off'))
  lines.push(body('and your manual choices are preserved.'))
  lines.push('')

  lines.push(header('7. Rate limits (RPD / RPM / TPM)'))
  lines.push(body('Each provider has its own quota. Common free-tier limits:'))
  lines.push(bullet('Groq on-demand: 14 400 RPD, 30 RPM per model'))
  lines.push(bullet('Mistral La Plateforme: 1 RPS, 1B TPM (experiment plan)'))
  lines.push(bullet('NVIDIA NIM: ~40 RPM (no credit card)'))
  lines.push(bullet('OpenRouter free routes: 50 RPD'))
  lines.push(body('When a provider returns 429, the router fails over. When the'))
  lines.push(body('daily quota is fully exhausted, the model goes Auth error and'))
  lines.push(body('auto-heal swaps it out next start.'))
  lines.push('')

  return lines
}

function paint(chalk, formatter, text) {
  if (!chalk || !formatter) return text
  return formatter(text)
}

function formatEntry(label, description, { chalk = null, indent = '', labelWidth = 40 } = {}) {
  const coloredLabel = paint(chalk, chalk?.cyan, label.padEnd(labelWidth))
  const coloredDescription = paint(chalk, chalk?.dim, description)
  return `${indent}${coloredLabel} ${coloredDescription}`
}

export function buildCliHelpLines({ chalk = null, indent = '', title = 'CLI Help' } = {}) {
  const lines = []
  const launchFlags = getToolModeOrder()
    .map((mode) => getToolMeta(mode))
    .filter((meta) => meta.flag)
    .map((meta) => ({ flag: meta.flag, description: `${meta.label} mode` }))

  lines.push(`${indent}${paint(chalk, chalk?.bold, title)}`)
  lines.push(`${indent}${paint(chalk, chalk?.dim, 'Usage: free-coding-models [apiKey] [options]')}`)
  lines.push('')
  lines.push(`${indent}${paint(chalk, chalk?.bold, 'Tool Flags')}`)
  for (const entry of launchFlags) {
    lines.push(formatEntry(entry.flag, entry.description, { chalk, indent }))
  }
  lines.push('')
  lines.push(`${indent}${paint(chalk, chalk?.bold, 'Analysis Flags')}`)
  for (const entry of ANALYSIS_FLAGS) {
    lines.push(formatEntry(entry.flag, entry.description, { chalk, indent }))
  }
  lines.push('')
  lines.push(`${indent}${paint(chalk, chalk?.bold, 'Config & Maintenance')}`)
  for (const entry of CONFIG_FLAGS) {
    lines.push(formatEntry(entry.flag, entry.description, { chalk, indent }))
  }
  lines.push('')
  lines.push(`${indent}${paint(chalk, chalk?.dim, 'Default launcher with no tool flag: OpenCode CLI')}`)
  lines.push(`${indent}${paint(chalk, chalk?.dim, 'Flags can be combined: --openclaw --tier S --json')}`)
  lines.push('')
  lines.push(`${indent}${paint(chalk, chalk?.bold, 'Examples')}`)
  for (const example of EXAMPLES) {
    lines.push(`${indent}${paint(chalk, chalk?.cyan, example)}`)
  }
  lines.push('')
  lines.push('')
  // 📖 Append the "How the router works" deep-dive so a single `--help`
  // 📖 or in-app Help overlay covers everything the user needs.
  for (const line of buildHowTheRouterWorksLines({ chalk, indent })) {
    lines.push(line)
  }

  return lines
}

export function buildCliHelpText(options = {}) {
  return buildCliHelpLines(options).join('\n')
}

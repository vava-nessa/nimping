# CLI Flags Reference (canonical)

This is the single source of truth for every CLI flag. It mirrors `parseArgs()` in [`src/core/utils.js`](../src/core/utils.js); if a flag is not listed here, it does not exist. Run `free-coding-models --help` to print the in-app list.

Flags combine freely in any order. Value flags accept both `--flag value` and `--flag=value` forms.

## Tool launchers

Start the TUI pre-configured for a tool: `Enter` writes the selected model into that tool's config and launches it. Tool-to-config mapping: [integrations.md](./integrations.md).

| Flag | Tool |
|------|------|
| *(none)* or `--opencode` | OpenCode CLI |
| `--opencode-desktop` | OpenCode Desktop |
| `--opencode-web` | OpenCode WebUI |
| `--openclaw` | OpenClaw |
| `--crush` | Crush |
| `--goose` | Goose |
| `--aider` | Aider |
| `--kilo` | Kilo CLI |
| `--qwen` | Qwen Code |
| `--openhands` | OpenHands |
| `--amp` | Amp |
| `--pi` | Pi |
| `--hermes` | Hermes |
| `--continue` | Continue CLI |
| `--cline` | Cline |
| `--xcode` | Xcode Intelligence |
| `--copilot` | GitHub Copilot CLI |
| `--forgecode` | ForgeCode |
| `--zcode` | ZCode |
| `--jcode` | jcode |
| `--caveman` | Caveman Code |

Default (no tool flag) = OpenCode CLI. Press `Z` in the TUI to cycle tools without restarting.

## Filtering and display

| Flag | Type | Description |
|------|------|-------------|
| `--best` | boolean | Show only top-tier models (A+, S, S+). |
| `--premium` | boolean | Start with an elite-focused preset (tier filter `S` + `verdict` sort). Fully resettable in the TUI. |
| `--tier <letter>` | value | Filter by tier family: `S` = S+/S, `A` = A+/A/A-, `B` = B+/B, `C` = C only. |
| `--origin <provider>` | value | Filter by provider key (e.g. `nvidia`, `groq`, `cerebras`). |
| `--hide-unconfigured` | boolean | Hide models whose provider has no API key configured. |
| `--show-unconfigured` | boolean | Show all models regardless of API key configuration (overrides the default). |
| `--recommend` | boolean | Open the Smart Recommend overlay immediately on startup (same as pressing `Q`). |

## Sorting

| Flag | Type | Description |
|------|------|-------------|
| `--sort <column>` | value | Start sorted by a column. Valid values: `rank`, `tier`, `origin`, `model`, `ping`, `avg`, `swe`, `ctx`, `condition`, `verdict`, `uptime`, `stability`, `aiLatency`, `tps`. |
| `--asc` | boolean | Sort ascending (smallest first). |
| `--desc` | boolean | Sort descending (largest first). |

## Output modes

| Flag | Type | Description |
|------|------|-------------|
| `--json` | boolean | Skip the TUI, print all model results as a JSON array and exit. Combine with `jq` for scripting. |
| `--fiable` | boolean | Wait 10s, pick the most reliable model by avg + stability + uptime, print `provider/model_id` and exit. |
| `--web`, `--gui`, `web` | boolean / subcommand | Launch the Web Dashboard instead of the TUI (default port 3333). See [web-dashboard.md](./web-dashboard.md). |
| `--help`, `-h` | boolean | Print the full help text with all flags and exit. |

## Smart Model Router

| Flag | Type | Description |
|------|------|-------------|
| `--daemon` | boolean | Start the router daemon in the foreground (dashboard + `/v1` API on port 19280). |
| `--daemon-bg` | boolean | Start the router daemon detached in the background. |
| `--daemon-status` | boolean | Print router daemon status JSON and exit. |
| `--daemon-stop` | boolean | Gracefully stop the running router daemon. |
| `--sync-set [name]` | boolean + optional value | Auto-discover, live-probe and populate a router set with the best currently available models. Without a name it refreshes the default `auto` set. See [sync-set.md](./sync-set.md). |
| `--playground`, `playground` | boolean / subcommand | Boot the TUI directly into the Playground chat overlay (expects the router daemon running, or start it with `--daemon-bg`). |

## Probe cache

| Flag | Type | Description |
|------|------|-------------|
| `--reprobe`, `--no-cache` | boolean | Force-rebuild the persistent probe cache this run (ping everything fresh). |
| `--probe-ttl <ms>` | value | Override the 24h probe-cache TTL (e.g. `--probe-ttl 3600000` for 1h). |
| `--show-broken` | boolean | Do not auto-hide broken models this run. |

## Runtime, config and maintenance

| Flag | Type | Description |
|------|------|-------------|
| `--ping-interval <ms>` | value | Override the ping interval in milliseconds (e.g. `--ping-interval 5000`). |
| `--config-dir <dir>` | value | Store `config.json` + `backups/` in `<dir>` instead of the default location. |
| `--fix-permissions`, `--yes`, `-y` | boolean | Auto-fix insecure config file permissions (chmod 600) without prompting. Never prompts on piped stdin, daemon, web, or `--json` runs. |
| `--clear-runtime` | boolean | Wipe `~/.free-coding-models/runtime-telemetry.json` (resets the real-world score baseline). |
| `--check-drift` | boolean | Diff `sources.js` against the `models.dev` community catalog, print a drift report, exit non-zero on mismatch. |
| `--drift-threshold <n>` | value | With `--check-drift`: only exit non-zero when more than `<n>` mismatches are found. |
| `--no-telemetry` | boolean | Disable anonymous usage telemetry for this session. |
| `--dev` | boolean | Dev mode: skips self-update logic (used when running from a git checkout). |

## Examples

```bash
# Start in Crush mode filtered to S-tier only
free-coding-models --crush --tier S

# Get the fastest S-tier model ID (headless, for scripts)
free-coding-models --tier S --json | jq -r '.[0].modelId'

# Filter by latency
free-coding-models --json | jq '.[] | select(.avgPing < 500)'

# Most reliable model right now
free-coding-models --fiable

# Start the local Smart Model Router endpoint
free-coding-models --daemon-bg

# Inspect router port, active set, uptime, and request totals
free-coding-models --daemon-status

# Auto-build a router set from the currently working models
free-coding-models --sync-set

# Open the in-TUI chat playground
free-coding-models --playground

# Fresh probes, ignore the 24h cache
free-coding-models --reprobe

# Check catalog drift against models.dev
free-coding-models --check-drift

# Start with an elite-focused preset (resettable in-app)
free-coding-models --premium

# Sort by SWE score descending
free-coding-models --sort swe --desc

# Groq models only
free-coding-models --origin groq

# Configure Goose with an S-tier model
free-coding-models --goose --tier S
```

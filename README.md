<p align="center">
  <img src="icon.png" alt="free-coding-models logo" width="328" height="328">
</p>

<h1 align="center">free-coding-models</h1>

<p align="center">
  <strong>Find the fastest free coding model in seconds.</strong><br>
  Live latency, stability and verdicts for 229 models from 24 free AI providers, then install the one you pick straight into your favorite coding tool.<br><br>
  <strong>Works with:</strong> OpenCode CLI / Desktop / WebUI, OpenClaw, Crush, Goose, Aider, Kilo CLI, Qwen Code, OpenHands, Amp, Hermes, Continue, Cline, Xcode, Pi, ZCode, ForgeCode, Copilot, jcode, Caveman Code and more.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/free-coding-models"><img src="https://img.shields.io/npm/v/free-coding-models?color=3d6b00&label=npm&logo=npm" alt="npm version"></a>
  <a href="https://github.com/vava-nessa/free-coding-models/actions/workflows/tests.yml"><img src="https://github.com/vava-nessa/free-coding-models/actions/workflows/tests.yml/badge.svg" alt="Tests"></a><br>
  <img src="https://img.shields.io/node/v/free-coding-models?color=3d6b00&logo=node.js" alt="node version">
  <img src="https://img.shields.io/npm/l/free-coding-models?color=3d6b00" alt="license">
  <a href="https://discord.gg/ZTNFHvvCkU"><img src="https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white" alt="Join our Discord"></a>
</p>

```bash
npm install -g free-coding-models
free-coding-models
```

<p align="center">
  <sub>Then create a free account on one of the <a href="#-providers">24 providers</a> to grab an API key.</sub>
</p>

<p align="center">
  <img src="website/public/demo.gif" alt="free-coding-models demo" width="100%">
</p>

<p align="center">
  <sub>Made with ❤️ and ☕ by <a href="https://vanessadepraute.dev">Vanessa Depraute</a> (aka <a href="https://vavanessa.dev">Vava-Nessa</a>)</sub>
</p>

---

## 💡 Why this tool?

There is a large catalog of free and free-limited coding models (**24 providers / 229 live models**, generated from [`sources.js`](./sources.js)). Which one is fastest *right now*? Which one is actually stable, versus just lucky on the last ping?

`free-coding-models` (FCM) answers that by pinging every model in parallel, showing live latency, and computing a **live Stability Score (0-100)** combining p95 latency, jitter, spike rate and uptime. Average latency alone is misleading: a model that randomly spikes to 6 seconds is not reliable.

Once you pick a model, FCM writes it directly into your coding tool's config and opens the tool, so you go from *"which model?"* to *"coding"* in under 10 seconds.

| Surface | What it is | Docs |
|---|---|---|
| 🎛️ **TUI** | The interactive terminal dashboard. The default: live ranking, pick + launch. | [docs/tui.md](./docs/tui.md) |
| 🌐 **Web Dashboard** | Browser control center, shareable filtered views, Docker-ready. | [docs/web-dashboard.md](./docs/web-dashboard.md) |
| 🔌 **Agent Extensions** | OpenCode & Pi plugins: hot-swap models mid-session. | [Agent extensions](#-agent-extensions) |
| 🔀 **Smart Model Router** | A local OpenAI-compatible daemon with auto-failover. | [docs/router.md](./docs/router.md) |

Other highlights: AI Speed Test benchmarks (real completions, AI Latency + TPS), Smart Recommend (3-question wizard), a `Ctrl+P` Command Palette, a persistent 24h probe cache shared by every surface, live quota from response headers, real-world telemetry scores, models.dev enrichment with drift detection, and a tier scale based on SWE-bench Verified (S+ ≥ 70% down to C). Details: [docs/stability.md](./docs/stability.md).

---

## ⚡ Quick Start

**① Install** (Node.js 18+, no native build, never needs sudo):

```bash
npm install -g free-coding-models
free-coding-models --help   # prints every flag
```

**② Grab one free API key.** One is enough to start; add more later with `P` inside the app:

- **Groq** → [console.groq.com/keys](https://console.groq.com/keys)
- **Cerebras** → [cloud.cerebras.ai](https://cloud.cerebras.ai) (lowest latency in the catalog)
- **NVIDIA NIM** → [build.nvidia.com](https://build.nvidia.com) (biggest no-credit-card quota)

**③ Launch & paste your key:** `free-coding-models`. First run prompts for keys (Enter skips), models ping in parallel, rows light up green ✅.

**④ Pick a model & launch your tool:** `↑↓` navigate, `Enter` to write the model into your tool's config and launch it. Pre-target another tool from the CLI, or cycle live with `Z`:

```bash
free-coding-models --goose --tier S      # Goose, pre-filtered to S-tier only
free-coding-models --crush --origin groq # Crush, Groq models only
free-coding-models --fiable              # print the single most reliable model and exit
```

**⑤ Go further:**

- 🌐 Prefer a browser? `free-coding-models web` opens the [Web Dashboard](./docs/web-dashboard.md).
- 🔀 Want one endpoint that never dies? `free-coding-models --daemon-bg` starts the [Smart Model Router](./docs/router.md).
- 🤖 Live inside an agent? Install the [OpenCode plugin](./packages/fcm-opencode/README.md) or the [Pi extension](./packages/fcm-pi/README.md).

<p align="center">
  <img src="demo2.gif" alt="free-coding-models TUI demo" width="100%">
</p>

---

## 🟢 Providers

**24 active providers / 229 live models**, sorted by live model count. Top 8:

| Provider | Models | Best tier | Env var |
|----------|--------|-----------|---------|
| [Alibaba DashScope](https://modelstudio.console.alibabacloud.com) | 27 | S+ | `DASHSCOPE_API_KEY` |
| [Ollama Cloud](https://ollama.com/settings/keys) | 19 | S+ | `OLLAMA_API_KEY` |
| [OpenRouter](https://openrouter.ai/keys) | 19 | S+ | `OPENROUTER_API_KEY` |
| [Cloudflare AI](https://dash.cloudflare.com) | 15 | S | `CLOUDFLARE_API_TOKEN` |
| [Kilo](https://kilo.ai) | 14 | S+ | `KILO_API_KEY` |
| [NVIDIA NIM](https://build.nvidia.com) | 14 | S+ | `NVIDIA_API_KEY` |
| [Pollinations AI](https://enter.pollinations.ai) | 13 | S+ | `POLLINATIONS_API_KEY` |
| [OVHcloud AI](https://endpoints.ai.cloud.ovh.net) | 12 | S+ | `OVH_AI_ENDPOINTS_ACCESS_TOKEN` |

> 📖 **Full table, free-tier limits, env vars, tier scale and provider notes:** [`docs/providers.md`](./docs/providers.md) (generated from `sources.js` by `node scripts/generate-provider-table.mjs`, so counts cannot drift). OpenCode Zen's free models are listed there too.

> ⚠️ Health probes consume provider quota: FCM auto-pauses a provider on `429`, backs off exponentially per failing model, and shows a footer chip while a provider rests. Leave a key empty and anonymous liveness probes still work for most providers.

---

## 🎛️ The Terminal UI (TUI)

The TUI is the heart of FCM: a live, sortable table of every model with real latency, stability, verdict, and a one-key launch into your coding tool. Sorts are one letter (`R` rank, `S` SWE, `V` verdict, `B` stability...), filters are `T` (tier cycle), `D` (provider cycle), `E` (visibility cycle), and the essentials are:

| Key | Action |
|-----|--------|
| `↑↓` / `Enter` | Navigate / launch the selected model |
| `Z` | Cycle target tool (OpenCode → OpenClaw → Crush → Goose → ...) |
| `F` / `Y` | Favorite a model / toggle pinned favorites mode |
| `Ctrl+A` / `Ctrl+U` | AI Speed Test on selected model / all visible models |
| `Q` | Smart Recommend (3-question wizard, Top 3 picks) |
| `Ctrl+P` | Command Palette (fuzzy search over every filter, sort and action) |
| `;` | Playground chat with the router |
| `Shift+P` / `Ctrl+Shift+P` | Re-probe failed rows / probe all models (404/410) |
| `Space` | Expand the selected row (provider, endpoint URL, full model ID) |
| `Shift+B` | Toggle broken-model visibility |
| `G` / `P` / `I` / `N` | Theme / Settings / Help / Reset view |
| `Ctrl+C` | Exit |

Mouse support: click headers to sort, double-click a row to launch, right-click to favorite, scroll to navigate.

> 📖 **Full key table, mouse reference and workflows:** [`docs/tui.md`](./docs/tui.md) · Stability score and columns: [`docs/stability.md`](./docs/stability.md)

---

## 🌐 The Web Dashboard

A real-time browser control center for the same catalog: full filter/sort parity with the TUI, per-row benchmarks, favorites, Smart Recommend, a Router Dashboard, token usage analytics, and shareable URL deep-links (`?tier=S+&sort=verdict&origin=groq`). Start it with `free-coding-models web` (port 3333) or `free-coding-models --daemon` (dashboard + router API on port 19280). Runs headless in Docker (`ghcr.io/vava-nessa/free-coding-models`).

> 📖 **Modes, Docker, Compose and all env vars** (`FCM_HOST`, `FCM_PORT`, `FCM_WEB_PORT`, `FCM_ROUTER_TOKEN`, `FCM_ALLOWED_ORIGINS`, `FCM_DISCORD_*_WEBHOOK`): [`docs/web-dashboard.md`](./docs/web-dashboard.md)

---

## 🔀 The Smart Model Router

A local OpenAI-compatible daemon: point any coding tool at `http://localhost:19280/v1` with model `fcm` (key `fcm-local`) and FCM routes every request to the best available model in your active set. Adaptive health probes, per-model circuit breakers, family-preserving failover, auto-heal of broken sets, and a Playground chat to try it without configuring a tool.

```bash
free-coding-models --daemon-bg      # start
free-coding-models --daemon-status  # inspect
free-coding-models --daemon-stop    # stop
```

> 📖 **Full guide (probes, circuit breaker, failover, Playground, `--sync-set`, REST API):** [`docs/router.md`](./docs/router.md)

---

## 📖 CLI Flags

Flags combine freely in any order. The most common:

| Flag | Effect |
|------|--------|
| `--best` / `--premium` | Top tiers only / elite preset (S filter + verdict sort) |
| `--tier <S\|A\|B\|C>` | Filter by tier family |
| `--origin <provider>` | Filter by provider (e.g. `groq`) |
| `--sort <column>` + `--asc` / `--desc` | Start sorted by a column (`rank`, `swe`, `verdict`, `stability`, ...) |
| `--json` | Skip the TUI, print results as JSON (great with `jq`) |
| `--fiable` | Wait 10s, print the single most reliable model, exit |
| `--recommend` | Open Smart Recommend on startup |
| `--hide-unconfigured` / `--show-unconfigured` | Control keyless models visibility |
| `--ping-interval <ms>` | Override the ping interval |
| `--reprobe` / `--probe-ttl <ms>` / `--show-broken` | Probe cache control |
| `--check-drift` | Diff `sources.js` vs models.dev, exit 1 on mismatch |
| `--config-dir <dir>` | Custom config location |
| `--fix-permissions` / `--yes` | Auto-fix config file permissions (chmod 600) |
| `--web` | Open the Web Dashboard instead of the TUI |
| `--daemon` / `--daemon-bg` / `--daemon-status` / `--daemon-stop` | Smart Model Router lifecycle |
| `--sync-set [name]` | Auto-populate a router set with the currently best models |
| `--no-telemetry` | Disable anonymous telemetry for this run |
| `--help` / `-h` | Full in-app help |

**Tool launchers** (21): `--opencode` (default), `--openclaw`, `--crush`, `--goose`, `--aider`, `--kilo`, `--qwen`, `--openhands`, `--amp`, `--pi`, `--hermes`, `--continue`, `--cline`, `--xcode`, `--copilot`, `--forgecode`, `--zcode`, `--jcode`, `--caveman`, plus OpenCode Desktop / WebUI variants.

> 📖 **Canonical full flag reference (every flag, verified against the parser):** [`docs/flags.md`](./docs/flags.md) · Tool-to-config mapping: [`docs/integrations.md`](./docs/integrations.md)

---

## 🔌 Agent Extensions

- **OpenCode plugin** (`fcm-opencode`, beta): `/fcm` scans and ranks, `/fcm 1` switches models, `/fcm rescan` forces a fresh scan. Install: [`packages/fcm-opencode/README.md`](./packages/fcm-opencode/README.md)
- **Pi extension** (`fcm-pi`, beta): silent by default, `/fcm` re-scans and lets you pick, `/fcm-list` shows a ranked table, error-triggered picker on 4xx/5xx. Install: [`packages/fcm-pi/README.md`](./packages/fcm-pi/README.md)
- **Shared core** (`fcm-agent-core`): one scan/rank/cache engine for both adapters, with a cross-tool cache and daemon integration. API: [`packages/fcm-agent-core/README.md`](./packages/fcm-agent-core/README.md)

---

## 📋 Contributing

Issues, PRs and new provider integrations are welcome. To add a provider, see the format in [`sources.js`](./sources.js) and re-run `node scripts/generate-provider-table.mjs` so [`docs/providers.md`](./docs/providers.md) stays in sync. Latency numbers are real round-trip times from your machine.

→ [Development guide](./docs/development.md) · [Config reference](./docs/config.md) · [Sync-set](./docs/sync-set.md) · [Contributors](./CONTRIBUTORS.md)

---

## ⚖️ Model Licensing

You own the generated output: the code and text these models produce is yours to use commercially under current provider terms. The licenses below govern the model weights, not your output: Apache 2.0 (Qwen, GPT-OSS, Devstral, Gemma), MIT / permissive (GLM Flash, MiniMax), Modified MIT (Kimi K2), Llama Community License (attribution required), DeepSeek and NVIDIA Nemotron licenses, and hosted-API terms (Gemini, Mistral, OpenRouter-hosted). Verify on the model's official page before making legal decisions; this is a summary, not legal advice.

---

## 📊 Telemetry

FCM collects **anonymous** usage telemetry (app version, tool mode, OS, terminal family, a random install ID). No personal information, API keys, prompts, source code, or file paths ever leave your machine. Disable with `--no-telemetry` or `FREE_CODING_MODELS_TELEMETRY=0`.

---

## 🛡️ Security & Trust

| Signal | Status |
|--------|--------|
| **npm Provenance** | ✅ Sigstore-signed |
| **SBOM** | ✅ Attached to every GitHub Release |
| **Dependencies** | ✅ Small, pure JavaScript (chalk for the TUI; socket.io + UI libs for the dashboard), no native builds |
| **Security Policy** | ✅ [`SECURITY.md`](./SECURITY.md) |
| **Dependabot + `npm audit` CI** | ✅ Weekly updates, scan on every push |
| **License** | ✅ MIT |

Keys live locally in `~/.free-coding-models.json` (`0600`) and are only ever sent to the matching provider endpoint. FCM never requires sudo and never executes arbitrary remote code. To report a vulnerability, see [`SECURITY.md`](./SECURITY.md).

---

## Star History

<a href="https://star-history.dera.page/#vava-nessa/free-coding-models&type=timeline&logscale&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=vava-nessa/free-coding-models&type=timeline&theme=dark&logscale&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=vava-nessa/free-coding-models&type=timeline&logscale&legend=top-left" />
   <img alt="Star History Chart" src="https://star-history.dera.page/svg?repos=vava-nessa/free-coding-models&type=timeline&logscale&legend=top-left" />
 </picture>
</a>

---

## Contributors

Created and maintained by [Vanessa Depraute](https://vanessadepraute.dev) ([@vava-nessa](https://github.com/vava-nessa)), with contributions from [@erwinh22](https://github.com/erwinh22), [@whit3rabbit](https://github.com/whit3rabbit), [@skylaweber](https://github.com/skylaweber), [@PhucTruong-ctrl](https://github.com/PhucTruong-ctrl), [@chindris-mihai-alexandru](https://github.com/chindris-mihai-alexandru), [@serajbaltu](https://github.com/serajbaltu), [@stgreenb](https://github.com/stgreenb), [@MoriDanWork](https://github.com/MoriDanWork), [@fan92rus](https://github.com/fan92rus), [@Muhammad95959](https://github.com/Muhammad95959), [@FaintFlower](https://github.com/FaintFlower), [@lehneres](https://github.com/lehneres), [@ia-S-on](https://github.com/ia-S-on) and [@bangla24bdrang-lab](https://github.com/bangla24bdrang-lab).

→ Full credits and highlighted contributions: [`CONTRIBUTORS.md`](./CONTRIBUTORS.md)

---

## 📚 More docs

[Providers](./docs/providers.md) · [TUI](./docs/tui.md) · [Web Dashboard](./docs/web-dashboard.md) · [Router](./docs/router.md) · [Flags](./docs/flags.md) · [Integrations](./docs/integrations.md) · [Stability & columns](./docs/stability.md) · [Sync-set](./docs/sync-set.md) · [Config](./docs/config.md) · [Development](./docs/development.md) · [Other free AI resources](./docs/resources.md)

## License

[MIT](./LICENSE)

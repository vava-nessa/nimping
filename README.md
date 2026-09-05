<p align="center">
  <img src="icon.png" alt="free-coding-models logo" width="328" height="328">
</p>

<h1 align="center">free-coding-models</h1>

<p align="center">
  <strong>Find the fastest free coding model in seconds</strong><br>
  Track a large catalog of free coding models from 20+ trusted AI providers in real time, then install the one you pick straight into your favorite coding tool.<br><br>
  <strong>Works with:</strong> OpenCode CLI / Desktop / WebUI, OpenClaw, Crush, Goose, Aider, Kilo CLI, Qwen Code, OpenHands, Amp, Hermes, Continue, Cline, Xcode, Pi, ZCode, ForgeCode, Copilot and more.<br><br>
  <strong>Use Kimi K2, DeepSeek V3/V4, GPT-OSS, Qwen3, MiniMax M3, GLM, Llama 4, Gemma 4, Devstral and more — for free</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/free-coding-models?color=3d6b00&label=npm&logo=npm" alt="npm version" width="200"><br>
  <img src="https://img.shields.io/node/v/free-coding-models?color=3d6b00&logo=node.js" alt="node version" width="200"><br>
  <img src="https://img.shields.io/npm/l/free-coding-models?color=3d6b00" alt="license" width="200"><br>
  <img src="https://img.shields.io/badge/models-large%20catalog-3d6b00?logo=nvidia" alt="models count" width="200"><br>
  <img src="https://img.shields.io/badge/providers-20%2B-1a56db" alt="providers count" width="200">
</p>

```bash
npm install -g free-coding-models
free-coding-models
```

<p align="center">
  <sub>Then create a free account on one of the <a href="#-free-ai-providers">many providers</a> to grab an API key.</sub>
</p>

<p align="center">
  <a href="#-why-this-tool">💡 Why</a> •
  <a href="#-quick-start">⚡ Quick Start</a> •
  <a href="#-free-ai-providers">🟢 Providers</a> •
  <a href="#-the-terminal-ui-tui">🎛️ TUI</a> •
  <a href="#-the-web-dashboard">🌐 Web</a> •
  <a href="#-agent-extensions">🔌 Extensions</a> •
  <a href="#-the-smart-model-router">🔀 Router</a> •
  <a href="#-reference">📖 Reference</a> •
  <a href="#-contributing">📋 Contributing</a> •
  <a href="#️-model-licensing--commercial-use">⚖️ Licensing</a> •
  <a href="#-telemetry">📊 Telemetry</a> •
  <a href="#️-security--trust">🛡️ Security</a> •
  <a href="#-other-free-ai-resources">🆓 More resources</a>
</p>

<p align="center">
  <img src="demo.gif" alt="free-coding-models demo" width="100%">
</p>

<p align="center">
  <a href="https://discord.gg/ZTNFHvvCkU"><img src="https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white&style=for-the-badge" alt="Join our Discord"></a>
</p>

<p align="center">
  <sub>Made with ❤️ and ☕ by <a href="https://vanessadepraute.dev">Vanessa Depraute</a> (aka <a href="https://vavanessa.dev">Vava-Nessa</a>)</sub>
</p>

---

## 💡 Why this tool?

There is a large catalog of free and free-limited coding models from 20+ vetted providers. Which one is fastest *right now*? Which one is actually stable, versus just lucky on the last ping?

`free-coding-models` (FCM) answers that by pinging every model in parallel, showing live latency, and computing a **live Stability Score (0–100)**. Average latency alone is misleading — a model that randomly spikes to 6 seconds isn't reliable. The stability score combines **p95 latency** (30%), **jitter/variance** (30%), **spike rate** (20%), and **uptime** (20%) to measure true reliability.

Once you've picked a model, FCM writes it directly into your coding tool's config — so you go from *"which model?"* to *"coding"* in under 10 seconds.

**FCM ships as four surfaces**, all powered by the same engine:

| Surface | What it is | When to use it |
|---|---|---|
| 🎛️ **TUI** | The interactive terminal dashboard | The default. Live ranking, pick + launch a model. |
| 🌐 **Web Dashboard** | A browser control center | Browse from your browser, share filtered views, run headless in Docker. |
| 🔌 **Extensions** | OpenCode & Pi agent plugins | Hot-swap models mid-session without leaving your agent. |
| 🔀 **Router** | A local OpenAI-compatible daemon | One localhost endpoint that auto-fails-over between free models. |

> The TUI and Web Dashboard are the **core** of the product — that's where most users live. Extensions and the Router build on top of the same engine and are covered later in this doc.

---

## ⚡ Quick Start

From zero to "coding with a free model" in about 2 minutes — then a fast tour of the coolest features. Each step links to the full section when you want to go deeper.

### ① Install

```bash
npm install -g free-coding-models
free-coding-models --help   # sanity check — prints every flag
```

Requires **Node.js 18+**. That's the only prerequisite — FCM has a single runtime dependency (`chalk`), no native build step, and never needs `sudo`. Update later at any time with `npm install -g free-coding-models@latest` (or `Shift+U` inside the app).

### ② Grab one free API key

FCM tracks a large catalog of models from 20+ providers, but you only need **one key** to start. The fastest sign-ups (no credit card, instant key):

- **Groq** → [console.groq.com/keys](https://console.groq.com/keys) — Llama 4, GPT-OSS, blazing fast
- **Cerebras** → [cloud.cerebras.ai](https://cloud.cerebras.ai) — the lowest latency in the whole catalog
- **NVIDIA NIM** → [build.nvidia.com](https://build.nvidia.com) — 27 models, the biggest free variety

👉 See the full [**provider table**](#-free-ai-providers) for limits, tiers, and env vars. You can add more keys at any time from inside the app (**`P`** → Settings) — one is enough to begin.

### ③ Launch & paste your key

```bash
free-coding-models
```

On first run FCM prompts you for API keys. **Paste yours** (or press `Enter` to skip — you'll still see keyless latency rows marked 🔑 NO KEY, and can add keys later with **`P`**). Models start pinging in parallel; rows light up green ✅ as they respond. The default view shows only the providers you have keys for, so the table is calm, not overwhelming.

### ④ Pick a model & launch your tool

```
↑↓ navigate the live table   →   Enter to launch
```

The model you land on is written straight into your tool's config **and the tool opens immediately** — that's the whole trick, start to finish in seconds. The default target is **OpenCode CLI**; pre-target another tool from the command line or cycle it live with **`Z`**:

```bash
free-coding-models --goose --tier S      # Goose, pre-filtered to S-tier only
free-coding-models --crush --origin groq  # Crush, Groq models only
free-coding-models --aider                # Aider
free-coding-models --opencode --premium   # OpenCode, elite-focused preset
```

> 💡 **Missing tool?** If the target CLI isn't installed, FCM catches it, offers a one-line install prompt, installs the official global binary, then resumes the exact same launch automatically.
>
> 💡 **Headless?** Skip the TUI entirely: `free-coding-models --tier S --json | jq -r '.[0].modelId'` prints the fastest S-tier model ID for scripts. Or `free-coding-models --fiable` waits 10s and prints the single most reliable model right now.

→ Full keybindings & workflows: [The Terminal UI (TUI)](#-the-terminal-ui-tui)

### ⑤ The 30-second cool tour 👇

You're in. Try these next — they're the features that make FCM feel good:

| Press | What happens | Go deeper |
|---|---|---|
| **`Ctrl+P`** | Open the ⚡️ **Command Palette** — fuzzy-search every filter, sort, and action in the app | [TUI](#-the-terminal-ui-tui) |
| **`Q`** | **Smart Recommend** — answer 3 questions, get your Top 3 models picked for you | [TUI](#-the-terminal-ui-tui) |
| **`Ctrl+A`** / **`Ctrl+U`** | Run a real **AI Speed Test** on one model / all visible models (splits into Latency + TPS) | [TUI](#-the-terminal-ui-tui) |
| **`F`** then **`Y`** | **Favorite** a model, then **pin** your favorites to the top so they never scroll away | [TUI](#-the-terminal-ui-tui) |
| **`Z`** | **Cycle tool** (OpenCode → OpenClaw → Crush → Goose → …) without restarting | [TUI](#-the-terminal-ui-tui) |
| **`G`** | **Cycle theme** (Auto → Dark → Light) if your terminal fights the colors | [TUI](#-the-terminal-ui-tui) |
| **`;`** | Open the **Playground** — chat with the router right inside the TUI | [Router](#-the-smart-model-router) |

<p align="center">
  <img src="https://img.shields.io/badge/USE_%E2%9A%A1%EF%B8%8F%20COMMAND%20PALETTE-CTRL%2BP-22c55e?style=for-the-badge" alt="Use ⚡️ Command Palette with Ctrl+P">
</p>

### ⑥ Go further

Once the TUI feels familiar, FCM has three more surfaces — pick the one that matches how you work:

- 🌐 **Prefer a browser?** → `free-coding-models web` opens the realtime [**Web Dashboard**](#-the-web-dashboard) on `localhost:3333` (or run it headless in [Docker](#-the-web-dashboard)).
- 🔀 **Want one endpoint that never dies?** → `free-coding-models --daemon-bg` starts the [**Smart Model Router**](#-the-smart-model-router); point any tool at `http://localhost:19280/v1` with model `fcm` and let it auto-fail-over between free models.
- 🤖 **Live inside an agent?** → install the [**OpenCode plugin**](#-agent-extensions) or the [**Pi extension**](#-agent-extensions) to hot-swap models mid-session with a single `/fcm`.

<p align="center">
  <img src="demo2.gif" alt="free-coding-models TUI demo" width="100%">
</p>

---

## 🟢 Free AI Providers

A large catalog of coding models from 20+ active providers, ranked by practical free-tier usefulness. Sign up on any one of them to get a key — you only need one to start.

| # | Provider | Models | Tier range | Free tier | Env var |
|---|----------|--------|-----------|-----------|--------|
| 1 | [NVIDIA NIM](https://build.nvidia.com) | 25 | S+ → C | ~40 RPM (no credit card) | `NVIDIA_API_KEY` |
| 2 | [Groq](https://console.groq.com/keys) | 5 | S → B | 30 RPM, 1K‑14.4K req/day (no credit card) | `GROQ_API_KEY` |
| 3 | [Cerebras](https://cloud.cerebras.ai) | 2 | S+ → S | 30 RPM, 1M tokens/day (no credit card) | `CEREBRAS_API_KEY` |
| 4 | [Google AI Studio](https://aistudio.google.com/apikey) | 10 | S+ → A | Gemini free quotas vary by model/region | `GOOGLE_API_KEY` |
| 5 | [Mistral La Plateforme](https://console.mistral.ai/api-keys) | 6 | S+ → A | Experiment plan, free evaluation tier | `MISTRAL_API_KEY` |
| 6 | [Cloudflare Workers AI](https://dash.cloudflare.com) | 19 | S+ → B | 10K neurons/day, 300 RPM (no credit card) | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` |
| 7 | [OpenRouter](https://openrouter.ai/keys) | 14 | S+ → C | 50 req/day free, 1K/day with $10 spend | `OPENROUTER_API_KEY` |
| 8 | [SambaNova](https://cloud.sambanova.ai/apis) | 6 | S+ → B+ | Small developer quota, useful for light usage | `SAMBANOVA_API_KEY` |
| 9 | [OVHcloud AI Endpoints](https://endpoints.ai.cloud.ovh.net) | 10 | S → B | 2 req/min/IP free, 400 RPM with key | `OVH_AI_ENDPOINTS_ACCESS_TOKEN` |
| 10 | [Codestral](https://console.mistral.ai/api-keys) | 1 | B+ | 30 RPM, 2K req/day | `MISTRAL_API_KEY` |
| 11 | [ZAI](https://z.ai) | 7 | S | Free Flash models only | `ZAI_API_KEY` |
| 12 | [Scaleway](https://console.scaleway.com/iam/api-keys) | 15 | S+ → B | 1M free tokens | `SCALEWAY_API_KEY` |
| 13 | [Alibaba DashScope](https://modelstudio.console.alibabacloud.com) | 23 | S+ → A+ | 1M free tokens/model, Singapore, 90 days | `DASHSCOPE_API_KEY` |
| 14 | [OpenCode Zen](https://opencode.ai/zen) | 7 | S+ → B+ | Free with OpenCode account | Zen models ✨ |
| 15 | [Kilo](https://kilo.ai) | 2 | A+ | Free auto-router works without a key | optional `KILO_API_KEY` |
| 16 | [LLM7](https://llm7.io) | 4 | S+ → A- | Shared free tier, optional free token | optional `LLM7_API_KEY` |
| 17 | [Routeway](https://routeway.ai) | 10 | S+ → C | Explicit `:free` zero-price models | `ROUTEWAY_API_KEY` |
| 18 | [Novita AI](https://novita.ai) | 0 | - | No zero-price models currently | `NOVITA_API_KEY` |
| 19 | [Ollama Cloud](https://ollama.com/pricing) | 17 | S+ → A | Free cloud usage with session/weekly limits | `OLLAMA_API_KEY` |
| 20 | [Pollinations AI](https://enter.pollinations.ai) ⚠️ experimental | 10 | S+ → B+ | Daily Pollen grants, free tier via Pollen (see note below) | `POLLINATIONS_API_KEY` |
| 21 | [SiliconFlow](https://cloud.siliconflow.cn/account/ak) | 3 | A → B+ | 3 models @ $0, 1000 RPM (phone SMS required) | `SILICONFLOW_API_KEY` |
| 22 | [Requesty](https://app.requesty.ai/api-keys) | 12 | S+ → C | 200 req/day free, no card (4x OpenRouter) | `REQUESTY_API_KEY` |
| 23 | [OrcaRouter](https://www.orcarouter.ai) | 3 | S+ → A+ | Free Hacker tier · 3 $-0 models, zero token markup | `ORCAROUTER_API_KEY` |
| 24 | [Vercel AI Gateway](https://vercel.com/ai-gateway) | 4 | S+ → B+ | $5 gateway credits every 30 days, no card + explicit $0 models | `VERCEL_AI_GATEWAY_API_KEY` |

> **Pollinations Pollen, c'est quoi ?** Pollinations ne facture pas en $ mais en **Pollen** (≈ $1). Pas besoin d'acheter : tu recois du Pollen **gratuit chaque jour** selon ton tier seed/flower/nectar via quests (star le repo `pollinations/pollinations` sur GitHub, aider sur un issue). Si ton solde affiche `0.0000` sur `enter.pollinations.ai`, tout `MISS` (prompt non cache) retourne `402 PAYMENT_REQUIRED` ("Insufficient balance ~0.0001 pollen") et le ping affichera `402`. Un `HIT` Cloudflare cache peut encore passer en `200` meme avec 0 Pollen mais ce n'est pas fiable. Verifie ton solde sur `enter.pollinations.ai` -> API Keys, complete une quest et attends le grant quotidien a minuit UTC. **Note : integration Pollinations encore experimentale et non confirmee comme stable, le systeme Pollen peut changer.**
> **SiliconFlow & Requesty** : integrations verifiees le 2026-08-24 via `/v1/models` live et docs officielles, free tiers recurrents confirmes sans Pollen.

> 💡 One key is enough to start. Add more at any time by pressing **`P`** inside the TUI (or via the Web Dashboard **Settings** page). A few providers (`Kilo`, `LLM7`, OVHcloud sandbox) can even answer without a key, with tighter shared limits.

### Tier scale

Every model is tiered by its **SWE-bench Verified** score — the industry-standard benchmark for real coding tasks.

| Tier | SWE-bench | Best for |
|------|-----------|----------|
| **S+** | ≥ 70% | Complex refactors, real-world GitHub issues |
| **S** | 60–70% | Most coding tasks, strong general use |
| **A+/A** | 40–60% | Solid alternatives, targeted programming |
| **A-/B+** | 30–40% | Smaller tasks, constrained infra |
| **B/C** | < 30% | Code completion, edge/minimal setups |

Press **`T`** in the TUI to cycle the tier filter (All → S+ → S → … → C → All).

### ⚠️ Health checks consume provider quota

FCM continuously health-probes every model so you see live latency, status, and verdict. When you've configured a provider's API key, **those probes are authenticated and count against that provider's daily quota**. Rate-limited providers like **OpenRouter** (50 req/day free) are the most sensitive: one overloaded model re-pinged every second can burn your quota in minutes.

To protect you, FCM:

- **Auto-pauses** a provider the moment its probe gets a `429` (it honors the `Retry-After` header).
- **Backs off exponentially** per failing model (30s → 1m → 2m → 5m) instead of re-pinging it every cycle.
- **Surfaces a footer chip** like `⏸ openrouter 14h` so you can see which providers are resting.

> If you don't need authenticated probes for a provider, just leave its key empty — anonymous probes still work for liveness checks on most providers, and they won't burn your personal quota.

<details>
<summary><strong>🧹 Providers removed from the catalog (and why)</strong></summary>

`iFlow` shut down on April 17, 2026. `Together AI`, `Perplexity API`, `DeepInfra`, `Replicate`, `Fireworks`, `Hyperbolic`, `Hugging Face`, `SiliconFlow`, `Chutes AI` were removed because they are paid, trial-credit only, too tiny to be useful, unclear as a stable free API, or tool-specific rather than a generally usable free provider. `Rovo` and `Gemini CLI` were removed as tool integrations (CLI-only, not generally usable free providers). The full list of free-tier providers kept *outside* the core catalog lives in [Other Free AI Resources](#-other-free-ai-resources).

</details>

---

## 🎛️ The Terminal UI (TUI)

The TUI is the heart of FCM. Launch it with `free-coding-models` and you get a live, sortable table of every model — real latency, stability, verdict, and a one-key launch into your coding tool.

<p align="center"><video src="website/public/videos/tui-first-launch.mp4" alt="First launch — many models ping in parallel" autoplay muted loop playsinline width="100%"></video></p>

### First-run flow

1. `free-coding-models` opens the TUI and prompts for API keys. Paste one (or skip).
2. Models start pinging in parallel. Rows turn green ✅ as they respond.
3. Navigate with **`↑↓`**, press **`Enter`** on the model you want — FCM writes it into your tool's config and launches the tool.

### Common workflows

**"Give me the fastest model that actually works"**
Sort by stability with **`B`** (or **`V`** for verdict) — the top rows with 🥇🥈🥉 medals are your best bets. Models in `NO KEY` or `AUTH FAIL` are faded to 80% opacity so you instantly see what you can't use.

**"Configure OpenCode with Groq's fastest model"**
```bash
free-coding-models --opencode --origin groq
# → navigate, press Enter. opencode.json is written and the CLI opens.
```

<p align="center"><video src="website/public/videos/tui-pick-and-launch.mp4" alt="Pick a model & launch — Enter writes the model and opens the tool" autoplay muted loop playsinline width="100%"></video></p>

**"Benchmark before I commit to a model"**
- **`Ctrl+A`** runs an AI Speed Test on the selected model (a real completion request — not just a ping). Results split into **AI Latency** + **TPS**.
- **`Ctrl+U`** runs the global benchmark across all visible models.
- Enable **Startup AI Speed Scan** in Settings (`P`) to run the global benchmark automatically after launch.

<p align="center"><video src="website/public/videos/tui-speed-test.mp4" alt="AI Speed Test — Ctrl+A benchmarks the selected model" autoplay muted loop playsinline width="100%"></video></p>

**"I don't know which model to pick — pick for me"**
Press **`Q`** to open **Smart Recommend**, a 3-question wizard (task type, priorities…) that returns Top 3 shared-score recommendations.

**"Keep my go-to models pinned"**
Star a model with **`F`** — favorites persist across sessions (shared with the Web Dashboard via `~/.free-coding-models.json`). Press **`Y`** to toggle **Pinned mode**: favorites stay pinned at the top and never scroll off-screen.

**"Switch tools without restarting"**
Press **`Z`** to cycle the target tool (OpenCode → OpenClaw → Crush → Goose → …). Models incompatible with the active tool get a dark-red row background so you instantly see what works.

**"My terminal theme fights the TUI colors"**
Press **`G`** to cycle **Auto → Dark → Light**. Recolors the full interface live (table, Settings, Help, overlays).

### Keyboard reference

| Key | Action |
|-----|--------|
| `↑↓` | Navigate models |
| `Enter` | Launch the selected model in the active tool |
| `Z` | Cycle target tool |
| `T` | Cycle tier filter (All → S+ → S → … → C) |
| `D` | Cycle provider filter |
| `E` | Cycle visibility filter (`Active only → Configured only → Usable only`) |
| `X` | Clear the active custom text filter |
| `F` | Favorite / unfavorite a model |
| `Y` | Toggle favorites mode (`Normal` ↔ `Pinned + always visible`) |
| `G` | Cycle global theme (`Auto → Dark → Light`) |
| **`Ctrl+P`** | Open the ⚡️ **Command Palette** (fuzzy action launcher) |
| **`;`** | Open the **Playground** chat overlay (chat with the FCM router) |
| **`Ctrl+A`** | Run an AI Speed Test for the selected model |
| **`Ctrl+U`** | Run the Global AI Speed Test (real provider requests) |
| **`Shift+P`** | Re-probe failed rows only (auth fail / 429 / 404 / timeout) - no whole-list rescan |
| **`Ctrl+Shift+P`** | Probe all configured models (404/410 check, auto-hides broken ones) |
| **`Space`** | Expand the selected row: 2-line detail with provider, endpoint URL and the full model ID (press again or move the cursor to collapse) |
| `R/S/C/M/O/L/A/H/V/B/U` | Sort by Rank / SWE / ContexT / Model / Origin / Last ping / Avg ping / Health / Verdict / staBility / Uptime |
| `W` | Sort by real-world score (`Real` column — see [Runtime telemetry](#-runtime-telemetry-real-world-scores)) |
| `Shift+W` | Open the Runtime Report overlay (per-model breakdown + recent calls) |
| `Shift+B` | Toggle visibility of broken models (footer shows `⚡ N cached · 🔴 M broken`) |
| `Shift+U` | Update to the latest version (when an update is available) |
| `P` | Settings (API keys, providers, updates, theme, Startup Speed Scan) |
| `Q` | Smart Recommend overlay |
| `N` | Changelog |
| `I` | Feedback / bug report |
| `K` | Help overlay |
| `Ctrl+C` | Exit |

### Mouse reference

| Action | Result |
|--------|--------|
| **Click column header** | Sort by that column |
| **Click Tier header** | Cycle tier filter |
| **Click CLI Tools header** | Cycle tool mode |
| **Click model row** | Move cursor to model |
| **Double-click model row** | Select and launch model |
| **Right-click model row** | Toggle favorite |
| **Scroll wheel** | Navigate table / overlays / palette |
| **Click footer hotkey** | Trigger that action |
| **Click update banner** | Install latest version and relaunch |
| **Click outside modal** | Close the command palette |

→ **Stability score & full column reference:** [`docs/stability.md`](./docs/stability.md)

---

## 🌐 The Web Dashboard

The Web Dashboard is a real-time, browser-based control center for the same catalog — full parity with the TUI for everything that's safe to port. It's the best surface for browsing at a glance, sharing filtered views, or running FCM headless in Docker.

### Start it

```bash
# Catalog-only dashboard on http://localhost:3333 (override with FCM_WEB_PORT)
free-coding-models web

# Full dashboard + Smart Model Router on http://localhost:19280
free-coding-models --daemon
```

| Mode | Port | What you get |
|------|------|--------------|
| `web` (or `--web` / `--gui`) | `3333` (`FCM_WEB_PORT`) | The realtime catalog dashboard only — browse, filter, benchmark. |
| `--daemon` | `19280` (`FCM_PORT`) | Dashboard **+** the Smart Model Router API (`/v1/...`) on the same port. |
| `--daemon-bg` | `19280` | Same as `--daemon`, but detached so it keeps running after the TUI closes. |

> 💡 Open the dashboard with `open http://localhost:3333` (or `19280`), or drive it headless with `chrome-devtools`.

### What's in the dashboard

The model table uses **100% of the viewport width** (no rails) under a sticky header + filter bar, and every TUI capability ships behind a button or chip.

| Area | Highlights |
|---|---|
| **Header** | Logo + version · nav (Dashboard, Settings, Analytics, Recommend, Router) · kebab menu (Help, Changelog, Install Endpoints, Installed Models) · endpoint target picker · `⌘K` palette · AI Latency toggle · theme · export |
| **Model table** | 17 resizable columns (widths saved in localStorage), ⭐ star + 🔌 install per row, medal borders for top-3, dark-red rows for tool-incompatible models, click an AI Latency cell to run a per-row benchmark, sticky header |
| **Filter bar** | Tier / Status / Verdict / Health chip rows · Visibility (Normal / Configured only / Usable only) · Provider select · text filter with `X` clear · Reset (TUI `N`) · ping mode (Speed / Normal / Slow / Forced) · "next ping in Xs" countdown |
| **Detail panel** | Slide-in on row click · install-endpoint + per-row benchmark · favorite toggle + reorder (TUI `Shift+↑↓`) · latency trend chart · all stats |
| **Command palette** | `⌘K` / `Ctrl+P` — the only global shortcut. Fuzzy search across views, theme, ping mode, reset, export, **and the full TUI command registry** |
| **Smart Recommend** | The 3-question wizard → Top 3 shared-score recommendations with Pin + install actions |
| **Router Dashboard** | Daemon start/stop, model health table with circuit-breaker badges, request log, probe-mode selector, "Probe all" benchmark, and a **Test Router** mini-playground |
| **Token Usage** | (inside Analytics) today + all-time summary, 7-day bar chart, top models & providers breakdown |
| **Settings parity** | Theme (auto/dark/light), favorites pinned mode, Startup AI Speed Scan, shell-env export, per-provider **Test key** button — all persisted to the same `~/.free-coding-models.json` the TUI uses |

**Keyboard:** `Esc` closes any modal · `Cmd+K` toggles the palette. Everything else is mouse-first.

**URL deep-linking:** `?tier=S+&sort=verdict&origin=groq&toolMode=goose&q=…` hydrates the dashboard on load **and** every filter/sort/view change is reflected back into the URL (debounced). CLI flags become shareable links — favorites are shared with the TUI through the same config file.

<p align="center"><video src="website/public/videos/web-url-deep-linking.mp4" alt="URL deep-linking — filter the dashboard, share the URL" autoplay muted loop playsinline width="100%"></video></p>

### Run it in Docker

Run FCM without installing Node.js using the official image:

> **Note:** GHCR requires authentication even for public images. Login once with:
> ```bash
> echo $GITHUB_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
> ```
> Or use a [personal access token](https://github.com/settings/tokens) with `read:packages` scope.

```bash
# Quick start — daemon + web UI on port 19280
docker run -p 19280:19280 ghcr.io/vava-nessa/free-coding-models:latest

# With an API key
docker run -p 19280:19280 -e OPENROUTER_API_KEY=your_key ghcr.io/vava-nessa/free-coding-models:latest
```

Point your coding tool at `http://localhost:19280/v1` with model `fcm` and key `fcm-local`. See the [Smart Model Router](#-the-smart-model-router) section for routing details.

**Available image tags:** `latest` · `v{major}.{minor}.{patch}` (e.g. `v0.3.70`) · `v{major}.{minor}` (e.g. `v0.3`) · `v{major}` (e.g. `v0`)

| Env var | Default | Description |
|---------|---------|-------------|
| `FCM_HOST` | `0.0.0.0` | Bind host (`127.0.0.1` for localhost-only) |
| `FCM_PORT` | `19280` | Port to listen on |
| `FREE_CODING_MODELS_TELEMETRY` | `0` | `0` disables telemetry |

<details>
<summary><strong>Docker Compose + troubleshooting</strong></summary>

```yaml
version: '3.8'
services:
  fcm:
    image: ghcr.io/vava-nessa/free-coding-models:latest
    container_name: fcm
    restart: unless-stopped
    ports:
      - "19280:19280"
    environment:
      FREE_CODING_MODELS_TELEMETRY: "0"
      FCM_HOST: "0.0.0.0"
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
      ORCAROUTER_API_KEY: ${ORCAROUTER_API_KEY:-}
    volumes:
      - fcm-data:/home/fcm
volumes:
  fcm-data:
```

**Troubleshooting:**
- **Won't start** — `docker logs fcm`, and check port 19280 isn't in use (`docker ps | grep 19280`).
- **Health check fails** — wait ~30s for the first probe cycle; verify keys with `docker exec fcm curl http://localhost:19280/health`.
- **Can't connect from host** — ensure `FCM_HOST=0.0.0.0` (default) and the firewall allows localhost.
- **Reset data** — config lives in the `fcm-data` volume; wipe it with `docker-compose down -v`.

</details>

---

## 🔌 Agent Extensions

FCM ships two **agent extensions** that bring the scanner/ranker directly into your coding agent — so you can hot-swap models mid-session without leaving the terminal. Both share one core (`fcm-agent-core`), so a scan done in one benefits the other.

### OpenCode Plugin — `fcm-opencode` ⚠️ BETA

The OpenCode adapter for the FCM scanner. Startup is intentionally light: fresh cache first, daemon second, **no direct scan** unless you run `/fcm`.

```bash
# Local install (symlink the adapter into OpenCode's plugins dir)
mkdir -p ~/.config/opencode/plugins
ln -sf /Users/<you>/Documents/GitHub/free-coding-models/packages/fcm-opencode/index.js \
  ~/.config/opencode/plugins/fcm-opencode.js
```

> (`opencode-plugin/` at the repo root is kept as a thin compat wrapper, so existing symlinks keep working.)

| Command | Description |
|---------|-------------|
| `/fcm` | Run an explicit scan and list ranked choices (no switch) |
| `/fcm 1` | Switch OpenCode config to ranked model #1 |
| `/fcm best` | Switch OpenCode config to the best ranked model |
| `/fcm rescan` | Force a fresh scan |
| `/fcm status` / `/fcm-status` | Show plugin diagnostics |
| `/fcm router` / `/fcm-router` | Switch OpenCode config to the local FCM Smart Router daemon |

→ Full details: [`packages/fcm-opencode/README.md`](./packages/fcm-opencode/README.md)

### Pi Extension — `FCM-Pi` ⚠️ BETA

A native [Pi coding agent](https://pi.dev) extension. It stays **silent by default** — no scan, no footer noise, no automatic model switch on boot or `/resume`. It only acts when you ask.

**Install** — add the extension path to `~/.pi/agent/settings.json` (not yet on npm — local path only):

```json
{
  "packages": [
    "/Users/<you>/Documents/GitHub/free-coding-models/pi-extension"
  ]
}
```

Then restart Pi. The extension loads automatically. Requires Pi + `free-coding-models` installed and configured with at least one API key.

| Feature | What it does |
|---------|--------------|
| **Silent startup** | No scan, no footer noise, no auto-switch on boot or `/resume` |
| **Manual scan** | `/fcm` pings ~30 candidates in parallel, then waits for your explicit pick |
| **Live progress** | The Pi status bar shows `⠸ Probing: Kimi K2.6 [Nvidia]…` only while probing, then hides |
| **10-min disk cache** | Results cached to `~/.pi/agent/fcm-cache.json` for fast diagnostics |
| **Error-triggered picker** | If a request fails (HTTP 4xx/5xx), FCM reopens the picker and marks the failed model `🔴 BUGGED` |
| **Daemon integration** | If the router daemon is running (`--daemon-bg`), scan results are fetched instantly from its cache |

| Command | Description |
|---------|-------------|
| `/fcm` | Re-scan and pick a model interactively from the top 10 |
| `/fcm-list` | Ranked table of top 20 models (SWE / Latency / TPS / Provider) |
| `/fcm-router` | Connect Pi to the local FCM Smart Router daemon |
| `/fcm-status` | Diagnostics: active model, last scan source, daemon state |

**Composite ranking** — SWE-bench (60%) + Latency (20%) + TPS (10%) + Stability (10%). Cerebras free-tier models are capped at ~64-65k total tokens (paid tier gets 131k) and are hidden from Pi/OpenCode pickers when they fail real agent prompts.

→ Full architecture: [`packages/fcm-pi/README.md`](./packages/fcm-pi/README.md)

### Shared agent architecture

```
packages/
├── fcm-agent-core/   ← shared core (scan, rank, cache, daemon, keys, providers; no rendering)
├── fcm-pi/           ← Pi adapter (hooks, commands, status-bar renderer, ~/.pi/agent disk writer)
└── fcm-opencode/     ← OpenCode adapter (config mutation, commands, toasts, shell.env)
```

- The core emits **structured progress events**; each adapter renders them its own way (Pi status bar, OpenCode toast).
- API keys are never inlined into OpenCode config — referenced via `{env:FCM_<PROVIDER>_API_KEY}`.
- A **cross-tool cache** means a scan done in Pi benefits OpenCode (and vice-versa).

> One-time self-link so `free-coding-models` resolves by name during local-path use:
> ```bash
> cd packages && mkdir -p node_modules && ln -s ../../ node_modules/free-coding-models
> ```

→ Public API & rationale: [`packages/fcm-agent-core/README.md`](./packages/fcm-agent-core/README.md)

---

## 🔀 The Smart Model Router

The **FCM Router** is a local OpenAI-compatible daemon. Point any coding tool at a single localhost endpoint and let FCM route each request to the best available model in your active set — with automatic failover when a model 429s or 5xxs.

> This is the most advanced surface. Most users start with the TUI or Web Dashboard and only reach for the router once they want *one endpoint that never goes down*.

### Quick start

```bash
# Start the router in the background (keeps running after the TUI closes)
free-coding-models --daemon-bg

# Check the active port, set, model count, uptime, and request totals
free-coding-models --daemon-status

# Stop it cleanly
free-coding-models --daemon-stop
```

Point your coding tool at:

| Field | Value |
|-------|-------|
| Base URL | `http://localhost:19280/v1` |
| Model | `fcm` |
| API key | `fcm-local` |

On first start the daemon auto-creates a `fast-coding` set from your configured providers. It stores router settings in `~/.free-coding-models.json`, writes lifecycle logs to `~/.free-coding-models-daemon.log`, and tracks token metadata in `~/.free-coding-models-tokens.json`.

### How it works

**1. Probe mechanism (adaptive cadence)** — the daemon sends a 1-token chat-completion ping to every model in the active set. It measures latency **+ status code**, not just reachability, so a wrong API key is caught and the circuit breaker opens. Probe modes:

| Mode | Interval | Use when |
|------|----------|----------|
| `eco` | 120s | You want to save quota |
| `balanced` *(default)* | 30s | Everyday use |
| `aggressive` | 10s | You're actively debugging routing |

**2. Circuit breaker (per-model state)** — each model flips between states:

| State | Meaning |
|-------|---------|
| 🟢 **Healthy** | Last probe returned 2xx — route here freely |
| 🔴 **Down** | Last 3 probes failed — skip until cooldown |
| 🟡 **Recovering** | Cooldown expired — retrying with 1 request |
| 🟠 **Auth error** | 401/403 — your API key is wrong for this model |
| ⚪ **Deprecated** | Removed from the catalog — will be replaced |

**3. Failover order (family preserving)** — models are tried in priority order; a `Recovering` / `Down` / `Auth error` model is skipped and the request goes to the next healthy one. When a model fails, the router first looks for the **same model family on another provider** (e.g. `nvidiaNim/deepseek-v4-pro` down → `sambanova/DeepSeek-V3.1` next), so your coding assistant keeps the same model behaviour mid-conversation instead of silently switching to a different family. If no same-family alternative is healthy, it falls back to the plain priority order. Families covered: Claude, DeepSeek, Gemini, GPT, Nemotron, Llama, MiniMax, Qwen, Kimi, GLM, Mistral, OpenAI o-series. The toggle lives on the Router Dashboard's set panel (**Family failover: on/off**, on by default, stored per set as `familyFailover`), and family hops are tagged `family` in the request log of both the TUI and Web dashboard. If *all* fail, you get a `503` with a `models_tried` list in the body for debugging.

**4. Auto-heal (on by default)** — at daemon start, any model in `Auth error` or `Deprecated` is swapped for a working alternative (same provider first, then cross-provider). The first time you manually add/remove/reorder a model, auto-heal switches off and your choices are preserved — so a new user with a half-broken key set lands on a usable default set by the time the dashboard renders.

### Playground — chat with the router

The fastest way to try the router without configuring a tool. Every chat starts with a configurable **pre-prompt** that introduces the assistant as the FCM routing agent.

```bash
free-coding-models --daemon-bg     # 1. start the router (if not running)
free-coding-models --playground    # 2. open the Playground in the TUI
# …or press ; inside the TUI
# …or click "Playground" in the Web Dashboard header
```

<p align="center"><video src="website/public/videos/router-playground.mp4" alt="Playground — chat with the router and see the routed provider/model" autoplay muted loop playsinline width="100%"></video></p>

The Playground streams responses token-by-token (SSE), shows the routed-via provider/model + latency + tokens on every reply, lets you pin a specific model (`fcm` = auto, or `groq/<id>` / `cerebras/<id>` / …) for A/B testing, and lets you toggle the pre-prompt per session. The pre-prompt lives in `router.prePrompt` and is editable from any surface (the daemon reloads it on its 10s config-refresh tick):

```json
{
  "router": {
    "prePrompt": {
      "enabled": true,
      "text": "You are free-coding-models, the free coding-model routing agent..."
    }
  }
}
```

### Routing behavior details

- Priority order works immediately on cold start, then probes refine health over time.
- **Transient failures** (`429`, `500`, `502`, `503`, timeouts) fail over to the next model.
- **Auth problems** (`401`, `403`, missing keys) are marked separately so bad credentials never poison the circuit breaker; after one provider returns an auth error, the router skips the rest of that provider for the current request.
- Upstream HTML maintenance pages and malformed "successful" JSON are treated as retryable provider failures instead of being forwarded to your tool.
- Quota/rate-limit failures include retry headers in the final router `503` payload when providers expose them.
- If a coding tool disconnects mid-request, the daemon aborts the upstream request **without** counting it as a provider failure.
- Streaming requests retry before the first byte; after partial output starts, the daemon records the failure and lets the current stream finish as safely as possible.

### Auto-discover the best set — `--sync-set`

`--sync-set [name]` auto-discovers, live-probes, and populates a named router set with the best currently-available coding models — perfect for scheduled refreshes so your set stays current without manual picking.

```bash
free-coding-models --sync-set              # create/refresh the default "auto" set
free-coding-models --sync-set my-coding-set # named set
free-coding-models --daemon-bg             # then run the daemon with it
```

Each candidate is probed twice (plain text must return exactly `OK`, and a tool-call must produce a valid `tool_calls` array), so models that work reliably with function-calling tools get in. Run it on a cron to keep the set fresh:

```bash
# crontab — refresh every 4 hours
0 */4 * * * /usr/local/bin/free-coding-models --sync-set >> ~/.free-coding-models-sync.log 2>&1
```

→ Full pipeline, output shape, and failure modes: [`docs/sync-set.md`](./docs/sync-set.md)

### REST API

**Router endpoints** (`/v1/...`):

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/chat/completions` | Route through the active set |
| `POST /v1/sets/:name/chat/completions` | Route through a named set |
| `GET /v1/models` | Virtual models (`fcm`, `fcm:set-name`) |
| `GET /health` | Daemon status JSON |
| `GET /stats` | Routing, health, request log, token + probe-cache + quota + runtime stats |
| `GET /stream/events` | Live SSE events for router updates |
| `POST /daemon/probe-mode` | Set probe mode `{ "probeMode": "eco" \| "balanced" \| "aggressive" }` |

**Web Dashboard endpoints** (same port in `--daemon` mode):

| Endpoint | Purpose |
|----------|---------|
| `GET /` | Web dashboard HTML |
| `GET /api/models` | All model data with latency stats |
| `GET /api/config` | Provider config (keys masked) |
| `GET /api/events` | Live SSE events for the dashboard |
| `GET /api/key/:provider` | Reveal the full API key for a provider |
| `POST /api/settings` | Save API keys and provider toggles |

→ Full router guide: [`docs/README_ROUTER.md`](./docs/README_ROUTER.md)

---

## 📖 Reference

The internals below power every surface. They're gathered here so they don't interrupt the core workflow above.

### CLI flags

Flags combine freely in any order. Run `free-coding-models --help` to print the full list in-app.

| Flag | Effect |
|------|--------|
| `--best` | Show only top tiers (A+, S, S+) |
| `--premium` | Start with an S-tier filter + verdict sort (resettable in-app) |
| `--tier <S\|A\|B\|C>` | Filter by tier family (`S` = S+/S, `A` = A+/A/A-, …) |
| `--origin <provider>` | Filter by provider (e.g. `nvidia`, `groq`, `cerebras`) |
| `--sort <column>` | Sort by `rank, tier, origin, model, ping, avg, swe, ctx, condition, verdict, uptime, stability, aiLatency, tps` |
| `--asc` / `--desc` | Sort direction |
| `--json` | Skip the TUI — print all results as JSON and exit (great for `jq`) |
| `--fiable` | Wait 10s, pick the most reliable model, print `provider/model_id` and exit |
| `--recommend` | Open Smart Recommend immediately on startup |
| `--hide-unconfigured` / `--show-unconfigured` | Control whether models without a key are shown |
| `--ping-interval <ms>` | Override the ping interval |
| `--reprobe` / `--no-cache` | Rebuild the persistent probe-cache this run |
| `--probe-ttl <ms>` | Override the probe-cache TTL (default 24h) |
| `--show-broken` | Don't auto-hide broken models this run |
| `--check-drift` | Diff `sources.js` against `models.dev`; exit 1 on mismatch |
| `--no-telemetry` | Disable anonymous telemetry for this run |
| `--config-dir <dir>` | Store `config.json` + `backups/` in `<dir>` (e.g. `--config-dir ~/.config/free-coding-models`) |
| `--fix-permissions` / `--yes` / `-y` | Auto-fix insecure config file permissions (chmod 600) without prompting; never asked on piped stdin, daemon, web, or `--json` runs |

**Tool launchers** — start the TUI pre-configured for a tool, then `Enter` writes the model into that tool's config and launches it:

| Flag | Tool | Flag | Tool |
|------|------|------|------|
| `--opencode` | 📦 OpenCode CLI | `--openhands` | 🤲 OpenHands |
| `--opencode-desktop` | 📦 OpenCode Desktop | `--amp` | ⚡ Amp |
| `--opencode-web` | 📦 OpenCode WebUI | `--hermes` | 🔮 Hermes |
| `--openclaw` | 🦞 OpenClaw | `--continue` | ▶️ Continue CLI |
| `--crush` | 💘 Crush | `--cline` | 🧠 Cline |
| `--goose` | 🪿 Goose | `--xcode` | 🛠️ Xcode Intelligence |
| `--aider` | 🛠 Aider | `--pi` | π Pi |
| `--kilo` | ⚡️ Kilo CLI | `--copilot` | 🤖 Copilot CLI |
| `--qwen` | 🐉 Qwen Code | `--forgecode` | 🔥 ForgeCode |
| | | `--zcode` | 🧊 ZCode |

> Default (no tool flag) = OpenCode CLI. Press **`Z`** in the TUI to cycle tools without restarting. Incompatible models get a dark-red row background when a tool mode is active.

→ Full flag reference: [`docs/flags.md`](./docs/flags.md) · Tool → config mapping: [`docs/integrations.md`](./docs/integrations.md)

### OpenCode Zen — free models exclusive to OpenCode

[OpenCode Zen](https://opencode.ai/zen) is a hosted AI gateway offering **5 free coding models** exclusively through OpenCode CLI/Desktop (OpenAI-compatible endpoint, so other tools can use them too):

| Model | Tier | SWE-bench | Context |
|-------|------|-----------|---------|
| Big Pickle | S+ | 72.0% | 200k |
| DeepSeek V4 Flash Free | S+ | 79.0% | 200k |
| MiMo-V2.5 Free | S+ | - | 200k |
| Nemotron 3 Super Free | A+ | 52.0% | 200k |
| MiniMax M3 Free | S+ | 59.0% | 1M |

Sign up at [opencode.ai/auth](https://opencode.ai/auth), enter your Zen key via `P`, and Zen models appear in the main table (auto-switching to OpenCode CLI on launch).

### 🧠 Persistent probe cache

Every health-probe result is cached to `~/.free-coding-models/probe-cache.json` for **24 hours** and **shared across all surfaces** (CLI TUI, Web Dashboard / daemon, Tauri Desktop).

- **Warm start** renders the full ranking in <500ms using cached results, then re-pings only models that are due (broken or past TTL).
- **Broken models** are auto-hidden across sessions — a model that 401s today stays out of tomorrow's default view, and recovers automatically when it returns `ok`.
- **Cross-process safe** — debounced flush + atomic rename + read-merge-write, so the CLI and the daemon share the file without clobbering each other.

| Flag / key | Effect |
|------------|--------|
| `--reprobe` / `--no-cache` | Nuke the cache; ping everything fresh |
| `--probe-ttl <ms>` | Override the 24h TTL (e.g. `--probe-ttl 3600000` for 1h) |
| `--show-broken` | Don't auto-hide broken models this run |
| `Shift+B` (TUI) | Toggle broken-model visibility (footer: `⚡ N cached · 🔴 M broken`) |

**Cache location:** `$XDG_CACHE_HOME/free-coding-models/probe-cache.json` if set, else `~/.free-coding-models/probe-cache.json` (Windows: `%USERPROFILE%\.free-coding-models\probe-cache.json`). Plain JSON, `0600` perms — inspect or wipe it any time.

### 📊 Live quota from response headers

Every chat-completion response carries rate-limit headers (`x-ratelimit-remaining-requests`, etc.). The daemon parses them passively on every routed request — **zero extra network requests, zero quota waste**.

- **8 header variants** supported (SambaNova, Mistral, generic `x-ratelimit-*`, no-`x-` proxy variant, + 3 daily/token/token-minute Cerebras-style variants).
- **Pre-warmed by pings** — even health pings return headers, so quota is visible before you ever route a real request.
- **5-minute staleness** — snapshots older than 5 min are excluded, with the active `/api/v1/key` fetcher as fallback for idle providers.

| Surface | What you'll see |
|---------|-----------------|
| TUI footer | `📊 groq 78% · sambanova 41%` (top 5 most-depleted first) |
| Web Dashboard | `Provider Quota` section with animated progress bars |
| `/stats.quota` | `{ providerKey: { remaining, limit, percent, source, lastUpdated, windowType } }` |

The `source` field is `"header"` (passive) or `"endpoint"` (active fetcher) — handy in devtools to debug why a provider shows the value it does.

### 📈 Runtime telemetry: real-world scores

Every routed request through the daemon feeds a persistent per-model telemetry file (`~/.free-coding-models/runtime-telemetry.json`) — the **honesty layer** that complements SWE-bench with what models *actually* do on free tiers.

- **Real success rate** = `successCalls / totalCalls` (updated on every request, success and failure alike).
- **Real throughput** = `avgTokensPerSecond` from completion tokens / total latency.
- **Recent calls (last 50)** — for "why did this just 500?" without rebuilding state.
- **Composite `Real` score** = `successRate × 0.6 + sigmoid01(tok/s) × 0.25 + recency × 0.15` (null below 5 calls — no penalty for new models).

| Surface | What you'll see |
|---------|-----------------|
| TUI `Real` column | Inline composite per row (`–` when insufficient) |
| TUI `W` / `Shift+W` | Sort by real-world score / Runtime Report overlay |
| Web Dashboard | "Runtime Telemetry" cards with animated success-rate bars |
| `/stats.runtime` | `{ stats: { modelsTracked, totalCalls, modelsWithSignal }, models: {…} }` |

**Privacy** — the file is **local only** (`0600` perms) and holds metadata only: success, latency, tokens, error reason. No prompts, no responses, no content. Wipe the baseline with `--clear-runtime`.

### Features at a glance

- **Parallel pings** — all models tested simultaneously via native `fetch`
- **AI benchmark columns** — `Ctrl+A` / `Ctrl+U` split into AI Latency + TPS; optional Startup AI Speed Scan
- **Adaptive monitoring** — 2s burst for 60s → 10s normal → 30s idle
- **Stability score** — composite 0–100 (p95, jitter, spike rate, uptime)
- **Smart ranking** — top 3 highlighted 🥇🥈🥉
- **Configured-only default** — shows only providers you have keys for; keyless models still ping (🔑 NO KEY)
- **Smart Recommend** — questionnaire picks the best model for your task type
- **Smart Model Router** — local OpenAI-compatible daemon with model sets, failover, circuit breakers, health probes, token stats
- **Playground chat** — multi-turn chat with the router on every surface
- **⚡️ Command Palette** — `Ctrl+P` fuzzy action launcher
- **Install Endpoints** — push a full provider catalog into any tool's config
- **Missing-tool bootstrap** — detect absent CLIs, offer one-click install, resume the launch
- **Tool compatibility matrix** — incompatible rows highlighted in dark red
- **Width guardrail** — warning instead of a broken table in narrow terminals
- **Mandatory self-update** — checks npm on startup and auto-installs; falls back to a red warning if install fails twice
- **Extended benchmark catalog** — `src/data/benchmarks.json` layers Coding/Math/Agentic/Reasoning/MMLU-Pro/GPQA/HLE on top of `sources.js` (footer: `📊 bench 49 (2026-07-25)`)
- **Live `models.dev` enrichment + drift detection** — community catalog overlaid in the background (footer: `📡 102 live · 62 curated`); `--check-drift` prints a drift report

### Configuration file

`~/.free-coding-models.json` (created on first run, `0600` perms) holds API keys, provider toggles, favorites, settings, and the router config. The TUI reads env vars first; the daemon reads config first then falls back to env vars (background services may not inherit your shell). → [`docs/config.md`](./docs/config.md)

---

## 📋 Contributing

We welcome contributions — issues, PRs, new provider integrations.

**Q: How accurate are the latency numbers?**
A: Real round-trip times measured by your machine. Results depend on your network and provider load at that moment.

**Q: Can I add a new provider?**
A: Yes — see [`sources.js`](./sources.js) for the model catalog format.

→ [Development guide](./docs/development.md) · [Config reference](./docs/config.md) · [Tool integrations](./docs/integrations.md) · [Stability & columns](./docs/stability.md) · [Sync-set](./docs/sync-set.md)

---

## ⚖️ Model Licensing & Commercial Use

**Short answer:** the cataloged models are API/CLI-served where generated-output ownership is generally granted by the provider/model terms. **You own the generated output** — code, text, or otherwise — and can use it commercially. The licenses below govern the *model weights themselves*, not your generated content.

| License | Models | Commercial Output |
|---------|--------|:-----------------:|
| **Apache 2.0** | Qwen3/Qwen3.5/Qwen2.5 Coder, GPT-OSS 120B/20B, Devstral 2, Gemma 4 | ✅ Unrestricted |
| **MIT / permissive model terms** | GLM Flash, MiniMax M2.x, Devstral 2 | ✅ Provider/model terms apply |
| **Modified MIT** | Kimi K2/K2.6 (>100M MAU → display "Kimi K2" branding) | ✅ With attribution at scale |
| **Llama Community License** | Llama 3.3 70B, Llama 4 Scout/Maverick | ✅ Attribution required. >700M MAU → separate Meta license |
| **DeepSeek License** | DeepSeek V3/V3.1/V3.2/V4 family | ✅ Use restrictions on model (no military, no harm) — output is yours |
| **NVIDIA Nemotron License** | Nemotron Super/Ultra/Nano | ✅ Updated Mar 2026, now near-Apache 2.0 permissive |
| **MiniMax Model License** | MiniMax M2, M2.5, M3 | ✅ Royalty-free, non-exclusive. Prohibited-uses policy applies to model |
| **Proprietary / hosted API terms** | Gemini, GitHub Models, Mistral/Codestral, OpenRouter-hosted models | ✅ Provider ToS applies |
| **OpenCode Zen** | Big Pickle, GPT 5 Nano, MiniMax M3 Free, Nemotron 3 Super Free, HY3/Ling/Trinity previews | ✅ Per OpenCode Zen ToS |

**Key points:** (1) generated code is yours; (2) Apache 2.0 / permissive families (Qwen, GLM Flash, GPT-OSS, Devstral, Gemma) are the lowest-friction; (3) Llama requires "Built with Llama" attribution, >700M MAU needs a Meta license; (4) DeepSeek / MiniMax have use-restriction policies that govern the model, not your output; (5) API-served models grant output ownership under their current ToS.

> ⚠️ This is a summary, not legal advice. License terms can change — always verify on the model's official page before making legal decisions.

---

## 📊 Telemetry

`free-coding-models` collects **anonymous** usage telemetry to understand how the CLI is used and improve the product. No personal information, API keys, prompts, source code, file paths, or secrets are ever collected — only anonymous product analytics (app version, tool mode, OS, terminal family, a random local install ID, and a few product actions like saving keys or installing catalogs).

| Method | How |
|--------|-----|
| CLI flag | `free-coding-models --no-telemetry` |
| Env var | `FREE_CODING_MODELS_TELEMETRY=0` (also `false` / `off`) |

---

## 🛡️ Security & Trust

<p align="center">
  <img src="https://img.shields.io/badge/dependencies-1-76b900?logo=npm" alt="1 dependency">
  <img src="https://img.shields.io/badge/provenance-sigstore-blueviolet?logo=signstore" alt="npm provenance">
  <img src="https://img.shields.io/badge/supply_chain-verified-brightgreen" alt="supply chain verified">
</p>

| Signal | Status |
|--------|--------|
| **npm Provenance** | ✅ Sigstore-signed |
| **SBOM** | ✅ Attached to every GitHub Release |
| **Dependencies** | ✅ 1 runtime (`chalk`) |
| **Lockfile** | ✅ `pnpm-lock.yaml` tracked |
| **Security Policy** | ✅ [`SECURITY.md`](SECURITY.md) |
| **Code Owners** | ✅ [`CODEOWNERS`](CODEOWNERS) — all changes require maintainer review |
| **Dependabot** | ✅ Weekly automated updates |
| **Audit CI** | ✅ `npm audit` on every push/PR + weekly scan |
| **License** | ✅ MIT |

**What this tool does:** pings public API endpoints to measure latency/availability · reads your API keys from `.env` (only if you configure them) · opens config files for editing (with permission) · reports anonymous usage data.

**What this tool does NOT do:** ❌ never sends your API keys, code, or personal data to any third party · ❌ never installs or executes arbitrary code beyond `chalk` · ❌ never modifies files outside its own config dir · ❌ never requires `sudo`, root, or elevated permissions.

> To report a vulnerability, see [`SECURITY.md`](SECURITY.md).

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

## About the creator

`free-coding-models` was created and is maintained by [Vanessa Depraute](https://vanessadepraute.dev), a Paris-based Senior Full-Stack JavaScript Developer with almost 20 years of experience building web and mobile products. She specializes in React, TypeScript, AI developer tooling, and turning complex product ideas into production-ready applications.

[Portfolio](https://vanessadepraute.dev) · [GitHub](https://github.com/vava-nessa) · [LinkedIn](https://www.linkedin.com/in/vanessa-depraute-310b801ba/) · [X / @vavanessadev](https://x.com/vavanessadev)

---

## Special thanks to contributors

<table align="center">
  <tr>
    <td align="center" width="120"><a href="https://github.com/vava-nessa"><img src="https://avatars.githubusercontent.com/u/5466264?v=4&s=80" width="80" height="80" style="border-radius:50%" alt="vava-nessa"></a></td>
    <td align="center" width="120"><a href="https://github.com/erwinh22"><img src="https://avatars.githubusercontent.com/u/6641858?v=4&s=80" width="80" height="80" style="border-radius:50%" alt="erwinh22"></a></td>
    <td align="center" width="120"><a href="https://github.com/whit3rabbit"><img src="https://avatars.githubusercontent.com/u/12357518?v=4&s=80" width="80" height="80" style="border-radius:50%" alt="whit3rabbit"></a></td>
    <td align="center" width="120"><a href="https://github.com/skylaweber"><img src="https://avatars.githubusercontent.com/u/172871734?v=4&s=80" width="80" height="80" style="border-radius:50%" alt="skylaweber"></a></td>
    <td align="center" width="120"><a href="https://github.com/PhucTruong-ctrl"><img src="https://avatars.githubusercontent.com/u/PhucTruong-ctrl.png?s=80" width="80" height="80" style="border-radius:50%" alt="PhucTruong-ctrl"></a></td>
    <td align="center" width="120"><a href="https://github.com/chindris-mihai-alexandru"><img src="https://avatars.githubusercontent.com/u/12643176?v=4&s=80" width="80" height="80" style="border-radius:50%" alt="chindris-mihai-alexandru"></a></td>
    <td align="center" width="120"><a href="https://github.com/serajbaltu"><img src="https://avatars.githubusercontent.com/u/90699173?v=4&s=80" width="80" height="80" style="border-radius:50%" alt="serajbaltu"></a></td>
    <td align="center" width="120"><a href="https://github.com/stgreenb"><img src="https://avatars.githubusercontent.com/u/18483964?v=4&s=80" width="80" height="80" style="border-radius:50%" alt="stgreenb"></a></td>
    <td align="center" width="120"><a href="https://github.com/MoriDanWork"><img src="https://avatars.githubusercontent.com/u/55363096?v=4&s=80" width="80" height="80" style="border-radius:50%" alt="MoriDanWork"></a></td>
    <td align="center" width="120"><a href="https://github.com/fan92rus"><img src="https://avatars.githubusercontent.com/u/13201333?v=4&s=80" width="80" height="80" style="border-radius:50%" alt="fan92rus"></a></td>
    <td align="center" width="120"><a href="https://github.com/Muhammad95959"><img src="https://avatars.githubusercontent.com/u/75130655?v=4&s=80" width="80" height="80" style="border-radius:50%" alt="Muhammad95959"></a></td>
    <td align="center" width="120"><a href="https://github.com/FaintFlower"><img src="https://avatars.githubusercontent.com/u/310248465?v=4&s=80" width="80" height="80" style="border-radius:50%" alt="FaintFlower"></a></td>
    <td align="center" width="120"><a href="https://github.com/lehneres"><img src="https://avatars.githubusercontent.com/u/7437288?v=4&s=80" width="80" height="80" style="border-radius:50%" alt="lehneres"></a></td>
    <td align="center" width="120"><a href="https://github.com/ia-S-on"><img src="https://avatars.githubusercontent.com/u/200600946?v=4&s=80" width="80" height="80" style="border-radius:50%" alt="ia-S-on"></a></td>
    <td align="center" width="120"><a href="https://github.com/bangla24bdrang-lab"><img src="https://avatars.githubusercontent.com/u/321290409?v=4&s=80" width="80" height="80" style="border-radius:50%" alt="bangla24bdrang-lab"></a></td>
  </tr>
  <tr>
    <td align="center"><a href="https://github.com/vava-nessa"><sub><b>vava-nessa</b></sub></a></td>
    <td align="center"><a href="https://github.com/erwinh22"><sub><b>erwinh22</b></sub></a></td>
    <td align="center"><a href="https://github.com/whit3rabbit"><sub><b>whit3rabbit</b></sub></a></td>
    <td align="center"><a href="https://github.com/skylaweber"><sub><b>skylaweber</b></sub></a></td>
    <td align="center"><a href="https://github.com/PhucTruong-ctrl"><sub><b>PhucTruong-ctrl</b></sub></a></td>
    <td align="center"><a href="https://github.com/chindris-mihai-alexandru"><sub><b>chindris-mihai-alexandru</b></sub></a></td>
    <td align="center"><a href="https://github.com/serajbaltu"><sub><b>serajbaltu</b></sub></a></td>
    <td align="center"><a href="https://github.com/stgreenb"><sub><b>stgreenb</b></sub></a></td>
    <td align="center"><a href="https://github.com/MoriDanWork"><sub><b>MoriDanWork</b></sub></a></td>
    <td align="center"><a href="https://github.com/fan92rus"><sub><b>fan92rus</b></sub></a></td>
    <td align="center"><a href="https://github.com/Muhammad95959"><sub><b>Muhammad95959</b></sub></a></td>
    <td align="center"><a href="https://github.com/FaintFlower"><sub><b>FaintFlower</b></sub></a></td>
    <td align="center"><a href="https://github.com/lehneres"><sub><b>lehneres</b></sub></a></td>
    <td align="center"><a href="https://github.com/ia-S-on"><sub><b>ia-S-on</b></sub></a></td>
    <td align="center"><a href="https://github.com/bangla24bdrang-lab"><sub><b>bangla24bdrang-lab</b></sub></a></td>
  </tr>
  <tr>
    <td align="center" colspan="15"><sub>🛡️ <b>fan92rus</b> — Windows path traversal fix (<code>path.sep</code>)</sub></td>
  </tr>
  <tr>
    <td align="center" colspan="15"><sub>📁 <b>Muhammad95959</b> — <code>--config-dir</code> flag & XDG support</sub></td>
  </tr>
  <tr>
    <td align="center" colspan="15"><sub>⭐ <b>FaintFlower</b> — Star History chart mirror fix</sub></td>
  </tr>
  <tr>
    <td align="center" colspan="15"><sub>🚀 <b>lehneres</b> — Proxmox VE installation scripts</sub></td>
  </tr>
  <tr>
    <td align="center" colspan="15"><sub>🌩️ <b>ia-S-on</b> — Cloudflare <code>{account_id}</code> env resolution in launch paths</sub></td>
  </tr>
  <tr>
    <td align="center" colspan="15"><sub>🐬 <b>bangla24bdrang-lab</b> — OrcaRouter provider integration</sub></td>
  </tr>
</table>

---

## 🆓 Other Free AI Resources

Curated resources kept **outside** the active CLI catalog — IDE extensions, coding agents, GitHub lists, and providers that are useful but not clean enough for the core free-provider table.

### 📚 Awesome Lists (curated by the community)

| Resource | What it is |
|----------|------------|
| [cheahjs/free-llm-api-resources](https://github.com/cheahjs/free-llm-api-resources) (18.4k ⭐) | Comprehensive list of free LLM API providers with rate limits |
| [mnfst/awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis) (2.1k ⭐) | Permanent free LLM API tiers organized by provider |
| [inmve/free-ai-coding](https://github.com/inmve/free-ai-coding) (648 ⭐) | Pro-grade AI coding tools side-by-side — limits, models, CC requirements |
| [amardeeplakshkar/awesome-free-llm-apis](https://github.com/amardeeplakshkar/awesome-free-llm-apis) | Additional free LLM API resources |

### 🖥️ AI-Powered IDEs with Free Tiers

| IDE | Free tier | Credit card |
|-----|-----------|-------------|
| [Qwen Code](https://github.com/QwenLM/qwen-code) | 2,000 requests/day | No |
| [Jules](https://jules.google/) | 15 tasks/day | No |
| [AWS Kiro](https://kiro.dev/) | 50 credits/month | No |
| [Trae](https://trae.ai/) | 10 fast + 50 slow requests/month | No |
| [Codeium](https://codeium.com/) | Unlimited forever, basic models | No |
| [JetBrains AI Assistant](https://www.jetbrains.com/ai/) | Unlimited completions + local models | No |
| [Continue.dev](https://www.continue.dev/) | Free VS Code/JetBrains extension, local models via Ollama | No |
| [Warp](https://warp.dev/) | 150 credits/month (first 2 months), then 75/month | No |
| [Amazon Q Developer](https://aws.amazon.com/q/developer/) | 50 agentic requests/month | Required |
| [Windsurf](https://windsurf.com/) | 25 prompt credits/month | Required |
| [Kilo Code](https://kilocode.ai/) | Up to $25 signup credits (one-time) | Required |
| [Tabnine](https://www.tabnine.com/) | Basic completions + chat (limited) | Required |
| [SuperMaven](https://www.supermaven.com/) | Basic suggestions, 1M token context | Required |

### 🔑 API Providers with Permanent Free Tiers

| Provider | Free limits | Notable models |
|----------|-------------|----------------|
| [Vercel AI Gateway](https://vercel.com/ai-gateway) | $5 credits every 30 days (no card) + explicit $0 models | MiniMax M3 (1M ctx), Laguna S 2.1, MiniMax M2.7, Ling 3.0 Flash Fin |
| [OrcaRouter](https://www.orcarouter.ai) | Free Hacker tier, zero token markup, 3 API keys | DeepSeek V4 Flash (Free), Tencent Hy3 (Free), Qwen3.8 27B (Free) |
| [OpenRouter](https://openrouter.ai/keys) | 50 req/day, 1K/day with $10 purchase | Qwen3-Coder, Tencent HY3, Laguna, Gemma 4 |
| [Google AI Studio](https://aistudio.google.com/apikey) | Varies by Gemini model and region | Gemini 3.8 Flash, Gemini 2.5 Pro |
| [NVIDIA NIM](https://build.nvidia.com) | ~40 RPM | MiniMax M2.7, GLM 5.1, Kimi K2.6 |
| [GitHub Models](https://models.github.ai) | Depends on GitHub/Copilot tier | GPT-4.1, DeepSeek V3, Llama 4 |
| [Groq](https://console.groq.com/keys) | 1K–14.4K req/day (model-dependent) | Llama 3.3 70B, Llama 4 Scout, GPT-OSS |
| [Cerebras](https://cloud.cerebras.ai/) | 30 RPM, 1M tokens/day | Qwen3-235B, Llama 3.1 70B, GPT-OSS 120B |
| [Cohere](https://cohere.com/) | 20 RPM, 1K/month | Command R+, Aya Expanse 32B |
| [Mistral La Plateforme](https://console.mistral.ai/) | 1 req/s, 1B tokens/month | Mistral Large, Devstral, Magistral |
| [Cloudflare Workers AI](https://dash.cloudflare.com) | 10K neurons/day | Llama 3.3 70B, QwQ 32B, 47+ models |
| [OVHcloud AI Endpoints](https://endpoints.ai.cloud.ovh.net) | 2 req/min/IP sandbox | GPT-OSS, Qwen3, Mistral |

### 🧪 Good candidates kept outside the core catalog

| Provider | Why it's not core |
|----------|--------------------|
| [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) | Useful gateway with included credits, but it's a router/billing layer, not a provider of permanently free models. |
| [Cohere](https://cohere.com/) | Real evaluation key, but the allowance is small and the catalog isn't coding-first enough for the default TUI. |
| [Ollama Cloud](https://ollama.com/pricing) | Interesting for light cloud usage, but closer to hosted Ollama capacity than a classic OpenAI-compatible free provider. |

### 💰 Providers with Trial Credits

| Provider | Credits | Duration |
|----------|---------|----------|
| [Hyperbolic](https://app.hyperbolic.ai/) | $1 | Trial/promo |
| [Fireworks](https://fireworks.ai/) | $1 | Trial/promo |
| [Nebius](https://tokenfactory.nebius.com/) | $1 | Permanent |
| [SambaNova Cloud](https://cloud.sambanova.ai/) | $5 | 3 months |
| [AI21](https://studio.ai21.com/) | $10 | 3 months |
| [Upstage](https://console.upstage.ai/) | $10 | 3 months |
| [NLP Cloud](https://nlpcloud.com/home) | $15 | Permanent |
| [Alibaba DashScope](https://bailian.console.alibabacloud.com/) | 1M tokens/model | 90 days |
| [Scaleway](https://console.scaleway.com/generative-api/models) | 1M tokens | Permanent |
| [Modal](https://modal.com) | $5/month | Monthly |
| [Inference.net](https://inference.net) | $1 (+ $25 on survey) | Permanent |
| [Novita](https://novita.ai/) | $0.5 | 1 year |

These trial-credit providers are deliberately not treated as core unless their free allowance is practical for recurring coding use.

### 🎓 Free with Education / Developer Programs

| Program | What you get |
|---------|--------------|
| [GitHub Student Pack](https://education.github.com/pack) | Free Copilot Pro for students (verify with .edu email) |
| [GitHub Copilot Free](https://code.visualstudio.com/blogs/2024/12/18/free-github-copilot) | 50 chat + 2,000 completions/month in VS Code |
| [Copilot Pro for teachers/maintainers](https://docs.github.com/en/copilot/how-tos/manage-your-account/get-free-access-to-copilot-pro) | Free Copilot Pro for open-source maintainers & educators |

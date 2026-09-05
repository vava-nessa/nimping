# fcm-pi — Pi Agent Extension for free-coding-models

> Native extension for the **[Pi coding agent](https://pi.dev)** powering Pi sessions with 100+ free AI coding models, composite SWE-bench ranking, and local router daemon connectivity.

---

## Features

- **Silent by default**: Zero startup lag, no footer spam, no forced model switches on Pi boot or `/resume`.
- **Manual parallel scan (`/fcm`)**: Probes ~30 candidate models in parallel on demand, evaluating SWE-bench score (60%), latency (20%), TPS throughput (10%), and jitter stability (10%).
- **Branded progress footer**: Live scan progress displays the `> free-coding-models` badge with percentage completion in the terminal.
- **Error-triggered picker**: On 4xx/5xx API errors during a session, FCM re-opens the selection menu and marks the failed model `🔴 BUGGED`.
- **Context window safety filter**: Automatically hides models with insufficient context windows (< 16k) that fail multi-file Pi agent prompts.
- **Shared core architecture**: Uses `fcm-agent-core` for unified scanning, ranking, caching, and key resolution.

---

## Installation

> 📖 Path-only package: it depends on `fcm-agent-core` via `file:../fcm-agent-core` and is **not published to npm**. Clone the [free-coding-models repo](https://github.com/vava-nessa/free-coding-models) and install from your local clone.

Add the absolute path of `packages/fcm-pi` to your `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/Users/<your-username>/Documents/GitHub/free-coding-models/packages/fcm-pi"
  ]
}
```

*Note*: The legacy `pi-extension/` directory is kept as a thin re-export wrapper for backwards compatibility with existing settings paths.

---

## Slash Commands

| Command | Action | Description |
|---|---|---|
| `/fcm` | Interactive Scan & Picker | Runs parallel probe scan and opens interactive model picker |
| `/fcm-list` | Ranked Model Table | Prints top 20 models ranked by composite score |
| `/fcm-router` | Connect Router | Points Pi session to local FCM Smart Router daemon (`localhost:19280`) |
| `/fcm-status` | Diagnostics | Prints current model, cache source, and daemon connection status |

---

## Package Structure

```
packages/fcm-pi/
├── extensions/index.js        ← Extension entry point (commands & hooks)
└── lib/
    ├── pi-config-writer.js    ← Writes ~/.pi/agent/ model & setting configs
    └── pi-progress-renderer.js ← Formats scan progress footer & status badge
```

---

## Provider Notes

- **Cerebras**: Free-tier context is capped at ~64-65k tokens (paid tier gets 131k); small context models are auto-filtered out from Pi agent prompts.
- **NVIDIA NIM**: ~40 RPM rate limit on no-card tier; initial parallel scan caches metrics to `~/.pi/agent/fcm-cache.json` for 10 minutes.

# fcm-opencode — OpenCode Plugin for free-coding-models

> Native plugin for **[OpenCode CLI](https://opencode.ai)** providing free model provider injection, reasoning format compatibility, and local router daemon integration.

---

## Features

- **Light startup**: Uses cache-first strategy to prevent OpenCode CLI boot freezes.
- **Provider injection**: Injects free model provider entries prefixed with `fcm-*` into `~/.config/opencode/config.json`.
- **Reasoning compatibility**: Normalizes reasoning LLM output (`<think>...</think>`) into native OpenCode `reasoning_content` blocks.
- **Environment variable security**: References API keys via `{env:FCM_<PROVIDER>_API_KEY}` without embedding raw key strings in configuration files.
- **Cross-tool cache sharing**: Reads and shares scan metrics with `~/.pi/agent/fcm-cache.json`.

---

## Installation

> 📖 Path-only package: it depends on `fcm-agent-core` via `file:../fcm-agent-core` and is **not published to npm**. Clone the [free-coding-models repo](https://github.com/vava-nessa/free-coding-models) and install from your local clone.

Symlink `packages/fcm-opencode/index.js` into your OpenCode plugins directory:

```bash
mkdir -p ~/.config/opencode/plugins
ln -sf /Users/<your-username>/Documents/GitHub/free-coding-models/packages/fcm-opencode/index.js \
  ~/.config/opencode/plugins/fcm-opencode.js
```

Or run the CLI auto-injection:

```bash
free-coding-models --opencode
```

---

## OpenCode Commands

| Command | Action | Description |
|---|---|---|
| `/fcm` | Scan Models | Scans candidate models and lists choices without changing current model |
| `/fcm 1` / `/fcm 2` | Select Model #N | Explicitly switches active model to choice #N |
| `/fcm best` | Select Best | Switches OpenCode to top-ranked healthy model |
| `/fcm rescan` | Force Rescan | Forces a fresh health and latency scan |
| `/fcm status` (or `/fcm-status`) | Diagnostics | Shows active model, cache state, and daemon connection |
| `/fcm router` (or `/fcm-router`) | Connect Router | Points OpenCode session to local FCM Smart Router daemon |

---

## Architecture & Shared Core

```
packages/fcm-opencode/
├── index.js               ← OpenCode plugin hooks, commands, & config writer
└── package.json           ← Node ESM package manifest
```

All scanner, ranker, cache, and provider metadata logic is imported from [`fcm-agent-core`](../fcm-agent-core).

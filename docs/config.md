# Configuration Reference

Everything FCM persists lives in one JSON file. This page documents its shape so you can edit it by hand, back it up, or script against it.

## Config file

`~/.free-coding-models.json` is created automatically on first run (permissions `0600`). It stores your API keys, per-provider toggles, favorites, UI settings, and the Smart Model Router config.

```json
{
  "apiKeys": {
    "nvidia":      "nvapi-xxx",
    "groq":        "gsk_xxx",
    "cerebras":    "csk_xxx",
    "openrouter":  "sk-or-xxx",
    "sambanova":   "sambanova-xxx",
    "cloudflare":  "cf_xxx",
    "zai":         "zai-xxx",
    "mistral":     "xxx",
    "codestral":   "xxx"
  },
  "providers": {
    "nvidia":     { "enabled": true },
    "groq":       { "enabled": true },
    "cerebras":   { "enabled": true },
    "openrouter": { "enabled": true },
    "zai":        { "enabled": false }
  },
  "settings": {
    "hideUnconfiguredModels": true
  },
  "router": {
    "enabled": true,
    "activeSet": "fast-coding",
    "port": 19280,
    "probeMode": "balanced",
    "sets": {
      "fast-coding": {
        "name": "fast-coding",
        "models": [
          { "provider": "groq", "model": "openai/gpt-oss-120b", "priority": 1 },
          { "provider": "cerebras", "model": "gpt-oss-120b", "priority": 2 }
        ],
        "created": "2026-04-22T10:00:00.000Z"
      }
    }
  },
  "favorites": [
    "nvidia/deepseek-ai/deepseek-v3.2"
  ]
}
```

> Only the providers you've configured appear in `apiKeys` / `providers`. See the [provider table in the README](../README.md#-free-ai-providers) for the full list of 20 active providers and their env vars.

### Per-provider API key fields

API keys are stored under `apiKeys.<providerId>` using the provider IDs from the catalog (`nvidia`, `groq`, `cerebras`, `googleai`, `github-models`, `mistral`, `cloudflare`, `openrouter`, `sambanova`, `ovhcloud`, `codestral`, `zai`, `scaleway`, `dashscope`, `opencode-zen`, `kilo`, `llm7`, `routeway`, `novita`, `ollama-cloud`). Toggle a provider off with `providers.<id>.enabled: false` without deleting its key.

---

## Environment variables

The **TUI** reads env vars before config values. The **Smart Model Router daemon** reads config keys first, then falls back to env vars - because a background service may not inherit your shell environment.

| Variable | Provider |
|----------|----------|
| `NVIDIA_API_KEY` | NVIDIA NIM |
| `GROQ_API_KEY` | Groq |
| `CEREBRAS_API_KEY` | Cerebras |
| `GOOGLE_API_KEY` | Google AI Studio |
| `GITHUB_TOKEN` | GitHub Models |
| `MISTRAL_API_KEY` | Mistral La Plateforme + Codestral |
| `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`) | Cloudflare Workers AI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `SAMBANOVA_API_KEY` | SambaNova |
| `OVH_AI_ENDPOINTS_ACCESS_TOKEN` | OVHcloud AI Endpoints |
| `ZAI_API_KEY` | ZAI |
| `SCALEWAY_API_KEY` | Scaleway |
| `DASHSCOPE_API_KEY` | Alibaba DashScope |
| `ROUTEWAY_API_KEY` | Routeway |
| `NOVITA_API_KEY` | Novita AI |
| `OLLAMA_API_KEY` | Ollama Cloud |
| `KILO_API_KEY` *(optional)* | Kilo (works without a key) |
| `LLM7_API_KEY` *(optional)* | LLM7 (works without a key) |

Daemon-only environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `FCM_HOST` | `0.0.0.0` | Bind host (`127.0.0.1` for localhost-only) |
| `FCM_PORT` | `19280` | Router/dashboard port (scans `19280`-`19289` if busy) |
| `FCM_WEB_PORT` | `3333` | Catalog-only `web` dashboard port |
| `FREE_CODING_MODELS_TELEMETRY` | `1` | `0` disables telemetry |

---

## Runtime settings

| Setting | Default | Description |
|---------|---------|-------------|
| Ping timeout | 15 s | Per-request timeout. Slow models get more time. |
| Ping cadence | 2 s → 10 s → 30 s | Fast burst at startup, then normal, then idle slowdown. |
| Configured-only | on | Only show providers with API keys. Toggle with `E`. |
| Favorites | persistent | Stored in the config file; survive app restarts and updates. |

---

## Smart Model Router

The `router` section is created automatically the first time you run `free-coding-models --daemon-bg` or `--daemon`. It controls the local OpenAI-compatible daemon.

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` until started | Whether router config is active. Starting the daemon enables it. |
| `port` | `19280` | Preferred localhost port. If occupied, the daemon scans `19280`-`19289`. |
| `activeSet` | `fast-coding` | Model set used by `/v1/chat/completions`. |
| `probeMode` | `balanced` | Health probe intensity: `eco`, `balanced`, or `aggressive`. |
| `sets` | auto-created | Named ordered model groups. Lower priority numbers are tried first during cold start. |
| `prePrompt` | `{ enabled, text }` | System message injected on every proxied request. Editable from any surface; the daemon reloads it on its 10s config-refresh tick. |

Each set model entry:

| Field | Description |
|-------|-------------|
| `provider` | Provider ID from `sources.js`, such as `groq` or `nvidia`. |
| `model` | Provider-native model ID. |
| `priority` | User priority inside the set. The config normalizer keeps priorities contiguous. |

Runtime files:

| File | Purpose |
|------|---------|
| `~/.free-coding-models-daemon.pid` | Running daemon PID for stop/status discovery. |
| `~/.free-coding-models-daemon.port` | Actual port selected after fallback scanning. |
| `~/.free-coding-models-daemon.log` | Rotating daemon lifecycle, probe, and routing metadata logs. |
| `~/.free-coding-models-tokens.json` | Daily and all-time token counters from successful non-streaming responses. |
| `~/.free-coding-models/runtime-telemetry.json` | Per-model real-world success rate + throughput (see Runtime telemetry). |
| `~/.free-coding-models/probe-cache.json` | 24h shared probe cache across all surfaces (see Probe cache). |

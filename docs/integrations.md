# Tool Integrations

Every tool follows the same pattern:

1. Run `free-coding-models --<tool>` (or press `Z` to cycle)
2. Wait for models to ping (green ✅)
3. Navigate with ↑↓, press **Enter**
4. If the tool CLI is missing, FCM offers a tiny install confirmation and runs the official global install command
5. FCM writes the selected model into the tool's config and launches it

---

## Tool → Config mapping

Every tool writes the selected provider + model into its native config (or sets env vars for CLI-only tools), then launches it. Missing CLIs are detected and offered for one-line install automatically.

| Tool | Flag | Config written |
|------|------|----------------|
| OpenCode CLI | `--opencode` | `~/.config/opencode/opencode.json` |
| OpenCode Desktop | `--opencode-desktop` | `~/.config/opencode/opencode.json` (then opens the app) |
| OpenCode WebUI | `--opencode-web` | `~/.config/opencode/opencode.json` (then opens the web dashboard) |
| OpenClaw | `--openclaw` | `~/.openclaw/openclaw.json` |
| Crush | `--crush` | `~/.config/crush/crush.json` |
| Goose | `--goose` | `~/.config/goose/config.yaml` + `custom_providers/<id>.json` + `secrets.yaml` |
| Aider | `--aider` | `~/.aider.conf.yml` (+ passes `--model`) |
| Kilo CLI | `--kilo` | `~/.config/kilo/opencode.json` |
| Qwen Code | `--qwen` | `~/.qwen/settings.json` (+ `~/.qwen/models.json`) |
| OpenHands | `--openhands` | `LLM_MODEL` env var |
| Amp | `--amp` | `~/.config/amp/settings.json` |
| Pi | `--pi` | `~/.pi/agent/models.json` + `~/.pi/agent/settings.json` |
| Continue | `--continue` | `~/.continue/config.yaml` |
| Cline | `--cline` | `~/.cline/globalState.json` |
| Hermes | `--hermes` | `~/.hermes/config.yaml` (via `hermes config set` + `hermes gateway restart`) |
| ForgeCode | `--forgecode` | `~/.forge/.forge.toml` (`[[providers]]` block) |
| ZCode | `--zcode` | `~/.zcode/v2/config.json` + `bots-model-cache.v2.json` |
| Xcode Intelligence | `--xcode` | None: launches Xcode; configure the endpoint in Xcode settings |
| Copilot CLI | `--copilot` | `COPILOT_*` BYOK env vars (`COPILOT_PROVIDER_BASE_URL`, `COPILOT_MODEL`, `COPILOT_PROVIDER_API_KEY`) |
| jcode | `--jcode` | Provider env vars set, then launches `jcode` (model IDs are namespaced for its whitelist) |
| Caveman Code | `--caveman` | Provider API key passed via the provider's standard env var, then launches `caveman` |

> To point any tool at the local Smart Model Router instead of a direct provider, use Base URL `http://localhost:19280/v1`, model `fcm`, key `fcm-local` (see [router.md](./router.md)). There is no dedicated `--fcm-router` CLI flag.

> Default (no tool flag) = OpenCode CLI. Press **`Z`** in the TUI to cycle tools without restarting. Entries installed via the Install Endpoints flow are namespaced under `fcm-*` in the target config.

---

## OpenCode

```bash
free-coding-models --opencode
```

FCM auto-detects your configured providers, writes the selected model to `opencode.json`, and launches `opencode`.

### tmux sub-agent panes

When launched inside `tmux`, FCM auto-adds `--port` so OpenCode can spawn sub-agent panes:

- Priority 1: reuse `OPENCODE_PORT` if valid and free
- Priority 2: auto-pick first free port in `4096-5095`

```bash
OPENCODE_PORT=4098 free-coding-models --opencode
```

### ZAI + OpenCode (transparent proxy)

ZAI uses `/api/coding/paas/v4/*` instead of standard `/v1/*`. When you pick a ZAI model in OpenCode mode, FCM automatically starts a localhost proxy that rewrites ZAI paths to OpenCode's expected format. It starts on a random port and shuts down when OpenCode exits. No manual config needed.

### Manual setup (optional)

Create or edit `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "nvidia": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "NVIDIA NIM",
      "options": {
        "baseURL": "https://integrate.api.nvidia.com/v1",
        "apiKey": "{env:NVIDIA_API_KEY}"
      }
    }
  },
  "model": "nvidia/deepseek-ai/deepseek-v3.2"
}
```

> ⚠️ Free models have usage limits - check [build.nvidia.com](https://build.nvidia.com) for quotas.

---

## OpenClaw

```bash
free-coding-models --openclaw
```

FCM writes the selected model as primary into `~/.openclaw/openclaw.json` and launches `openclaw`.

### What gets written

```json
{
  "models": {
    "providers": {
      "nvidia": {
        "baseUrl": "https://integrate.api.nvidia.com/v1",
        "api": "openai-completions"
      }
    }
  },
  "env": { "NVIDIA_API_KEY": "nvapi-xxxx" },
  "agents": {
    "defaults": {
      "model": { "primary": "nvidia/deepseek-ai/deepseek-v3.2" },
      "models": { "nvidia/deepseek-ai/deepseek-v3.2": {} }
    }
  }
}
```

> ⚠️ `providers` must be nested under `models.providers` - a root-level `providers` key is ignored.
>
> ⚠️ The model must also be listed in `agents.defaults.models` (the allowlist), or OpenClaw rejects it with *"not allowed"*.

---

## Install Endpoints (Command Palette)

The **Install endpoints** action (Command Palette via `Ctrl+P`, or the Web Dashboard header menu) opens a step-by-step flow to install a full provider catalog into a tool's config - so you can pick the model **inside** the tool instead of from FCM.

Steps:

1. **Provider** - pick one with a configured API key
2. **Tool** - config-based (`OpenCode`, `OpenClaw`, `Crush`, `Goose`, `Pi`, `Aider`, `Amp`, `Qwen`) or env-based (`OpenHands`)
3. **Scope** - all models or selected models only
4. **Models** (if selected) - multi-select from the provider catalog

Notes:

- Entries are namespaced under `fcm-*` in the target config
- `OpenCode CLI` and `OpenCode Desktop` share `opencode.json`
- For `OpenHands`, FCM writes `~/.fcm-openhands-env` - source it before launching

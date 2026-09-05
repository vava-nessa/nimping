# Smart Model Router

The **FCM Router** is a local OpenAI-compatible daemon. Point any coding tool at a single localhost endpoint and let FCM route each request to the best available model in your active set, with automatic failover when a model 429s or 5xxs.

The router is a shipped, supported feature (it stopped being experimental long ago). Most users start with the TUI or Web Dashboard and reach for the router once they want *one endpoint that never goes down*.

## Quick start

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

To protect the `/v1/*` endpoints on shared machines, set `FCM_ROUTER_TOKEN` (any client must then send `Authorization: Bearer <token>` or `x-api-key: <token>`), and `FCM_ALLOWED_ORIGINS` to restrict which origins may talk to the dashboard. See [web-dashboard.md](./web-dashboard.md) for the full env var table.

## Managing models

Open the **Router Dashboard** with `Shift+R` from the main table. It shows a status banner (stopped / starting / running), the quick-setup credentials above, and your active model set in fallback order.

Your **favorites** (star models with `F` in the main table) automatically become the router's model pool. The order determines fallback priority: `#1` is tried first for every request, `#2` is the first fallback, and so on. Use `Shift+↑` / `Shift+↓` to reorder.

## How it works

### 1. Probe mechanism (adaptive cadence)

The daemon sends a 1-token chat-completion ping to every model in the active set. It measures latency **and** status code, not just reachability, so a wrong API key is caught and the circuit breaker opens. Probe modes (cycle with `I` inside the Router Dashboard, or `POST /daemon/probe-mode`):

| Mode | Interval | Use when |
|------|----------|----------|
| `eco` | 120s | You want to save quota |
| `balanced` (default) | 30s | Everyday use |
| `aggressive` | 10s | You are actively debugging routing |

### 2. Circuit breaker (per-model state)

| State | Meaning |
|-------|---------|
| Healthy | Last probe returned 2xx, route here freely |
| Down | Last 3 probes failed, skip until cooldown |
| Recovering | Cooldown expired, retrying with 1 request |
| Auth error | 401/403, your API key is wrong for this model |
| Deprecated | Removed from the catalog, will be replaced |

### 3. Failover order (family preserving)

Models are tried in priority order; a `Recovering` / `Down` / `Auth error` model is skipped and the request goes to the next healthy one. When a model fails, the router first looks for the **same model family on another provider** (e.g. `nvidiaNim/deepseek-v4-pro` down → `sambanova/DeepSeek-V3.1` next), so your coding assistant keeps the same model behavior mid-conversation instead of silently switching families. If no same-family alternative is healthy, it falls back to plain priority order. Families covered: Claude, DeepSeek, Gemini, GPT, Nemotron, Llama, MiniMax, Qwen, Kimi, GLM, Mistral, OpenAI o-series. The toggle lives on the Router Dashboard's set panel (**Family failover: on/off**, on by default, stored per set as `familyFailover`), and family hops are tagged `family` in the request log. If *all* models fail, you get a `503` with a `models_tried` list in the body for debugging.

### 4. Auto-heal (on by default)

At daemon start, any model in `Auth error` or `Deprecated` is swapped for a working alternative (same provider first, then cross-provider). The first time you manually add/remove/reorder a model, auto-heal switches off and your choices are preserved, so a new user with a half-broken key set lands on a usable default set by the time the dashboard renders.

### 5. Per-provider schema normalization

Before forwarding to a provider, the router runs a small normalizer keyed on the provider. Today `zai` (GLM) and `mistral` / `codestral` are normalized: unsupported parameters (`parallel_tool_calls`, `n`, `top_k`, `logprobs`, `echo`, `user`, `metadata`, `store`) are stripped, orphan `tool` role messages that lack a matching assistant `tool_calls` entry are dropped, and `temperature` is clamped to the provider's accepted range. This removes most 400/422 errors that ZCode, Claude Code and Cline hit with tool-call flows. Other OpenAI-compatible providers pass through unchanged.

## Routing behavior details

- Priority order works immediately on cold start, then probes refine health over time.
- **Transient failures** (`429`, `500`, `502`, `503`, timeouts) fail over to the next model.
- **Auth problems** (`401`, `403`, missing keys) are marked separately so bad credentials never poison the circuit breaker; after one provider returns an auth error, the router skips the rest of that provider for the current request.
- Upstream HTML maintenance pages and malformed "successful" JSON are treated as retryable provider failures instead of being forwarded to your tool.
- Quota/rate-limit failures include retry headers in the final router `503` payload when providers expose them.
- If a coding tool disconnects mid-request, the daemon aborts the upstream request **without** counting it as a provider failure.
- Streaming requests retry before the first byte; after partial output starts, the daemon records the failure and lets the current stream finish as safely as possible.

## Playground: chat with the router

The fastest way to try the router without configuring a tool. Every chat starts with a configurable **pre-prompt** that introduces the assistant as the FCM routing agent.

```bash
free-coding-models --daemon-bg     # 1. start the router (if not running)
free-coding-models --playground    # 2. open the Playground in the TUI
# ...or press ; inside the TUI
# ...or click "Playground" in the Web Dashboard header
```

The Playground streams responses token-by-token (SSE), shows the routed-via provider/model + latency + tokens on every reply, lets you pin a specific model (`fcm` = auto, or `groq/<id>` / `cerebras/<id>` / ...) for A/B testing, and lets you toggle the pre-prompt per session. The pre-prompt lives in `router.prePrompt` and is editable from any surface (the daemon reloads it on its 10s config-refresh tick):

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

## Auto-discover the best set: `--sync-set`

`--sync-set [name]` auto-discovers, live-probes, and populates a named router set with the best currently-available coding models. Perfect for scheduled refreshes so your set stays current without manual picking.

```bash
free-coding-models --sync-set               # create/refresh the default "auto" set
free-coding-models --sync-set my-coding-set # named set
free-coding-models --daemon-bg              # then run the daemon with it
```

Each candidate is probed twice (plain text must return exactly `OK`, and a tool-call must produce a valid `tool_calls` array), so models that work reliably with function-calling tools get in. Run it on a cron to keep the set fresh:

```bash
# crontab: refresh every 4 hours
0 */4 * * * /usr/local/bin/free-coding-models --sync-set >> ~/.free-coding-models-sync.log 2>&1
```

Full pipeline, output shape, and failure modes: [sync-set.md](./sync-set.md)

## REST API

**Router endpoints** (`/v1/...`):

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/chat/completions` | Route through the active set |
| `POST /v1/sets/:name/chat/completions` | Route through a named set |
| `GET /v1/models` | Virtual models (`fcm`, `fcm:set-name`) |
| `GET /health` | Daemon status JSON |
| `GET /stats` | Routing, health, request log, token + probe-cache + quota + runtime stats |
| `GET /stream/events` | Live SSE events for router updates |
| `POST /daemon/probe-mode` | Set probe mode: `{ "probeMode": "eco" | "balanced" | "aggressive" }` |

**Web Dashboard endpoints** (same port in `--daemon` mode):

| Endpoint | Purpose |
|----------|---------|
| `GET /` | Web dashboard HTML |
| `GET /api/models` | All model data with latency stats |
| `GET /api/config` | Provider config (keys masked) |
| `GET /api/events` | Live SSE events for the dashboard |
| `GET /api/key/:provider` | Reveal the full API key for a provider |
| `POST /api/settings` | Save API keys and provider toggles |

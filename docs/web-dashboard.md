# Web Dashboard

The Web Dashboard is a real-time, browser-based control center for the same catalog: full parity with the TUI for everything that is safe to port. It is the best surface for browsing at a glance, sharing filtered views, or running FCM headless in Docker.

## Start it

```bash
# Catalog-only dashboard on http://localhost:3333 (override with FCM_WEB_PORT)
free-coding-models web

# Full dashboard + Smart Model Router on http://localhost:19280
free-coding-models --daemon
```

| Mode | Port | What you get |
|------|------|--------------|
| `web` (or `--web` / `--gui`) | `3333` (`FCM_WEB_PORT`) | The realtime catalog dashboard only: browse, filter, benchmark. |
| `--daemon` | `19280` (`FCM_PORT`) | Dashboard + the Smart Model Router API (`/v1/...`) on the same port. |
| `--daemon-bg` | `19280` | Same as `--daemon`, but detached so it keeps running after the TUI closes. |

Tip: open the dashboard with `open http://localhost:3333` (or `19280`), or drive it headless with a browser automation tool.

## What's in the dashboard

The model table uses the full viewport width under a sticky header + filter bar, and every TUI capability ships behind a button or chip.

| Area | Highlights |
|---|---|
| **Header** | Logo + version, nav (Dashboard, Settings, Analytics, Recommend, Router), kebab menu (Help, Changelog, Install Endpoints, Installed Models), endpoint target picker, `Cmd+K` palette, AI Latency toggle, theme, export |
| **Model table** | 17 resizable columns (widths saved in localStorage), star + install per row, medal borders for top-3, dark-red rows for tool-incompatible models, click an AI Latency cell to run a per-row benchmark, sticky header |
| **Filter bar** | Tier / Status / Verdict / Health chip rows, visibility (Normal / Configured only / Usable only), provider select, text filter with clear, Reset, ping mode (Speed / Normal / Slow / Forced), "next ping in Xs" countdown |
| **Detail panel** | Slide-in on row click: install-endpoint + per-row benchmark, favorite toggle + reorder, latency trend chart, all stats |
| **Command palette** | `Cmd+K` / `Ctrl+P`, the only global shortcut. Fuzzy search across views, theme, ping mode, reset, export, and the full TUI command registry |
| **Smart Recommend** | The 3-question wizard with Top 3 shared-score recommendations and Pin + install actions |
| **Router Dashboard** | Daemon start/stop, model health table with circuit-breaker badges, request log, probe-mode selector, "Probe all" benchmark, and a Test Router mini-playground |
| **Token Usage** | (inside Analytics) today + all-time summary, 7-day bar chart, top models and providers breakdown |
| **Settings parity** | Theme (auto/dark/light), favorites pinned mode, Startup AI Speed Scan, shell-env export, per-provider Test key button. All persisted to the same `~/.free-coding-models.json` the TUI uses |

**Keyboard:** `Esc` closes any modal, `Cmd+K` toggles the palette. Everything else is mouse-first.

**URL deep-linking:** `?tier=S+&sort=verdict&origin=groq&toolMode=goose&q=...` hydrates the dashboard on load, and every filter/sort/view change is reflected back into the URL (debounced). CLI flags become shareable links; favorites are shared with the TUI through the same config file.

## Run it in Docker

Run FCM without installing Node.js using the official image:

> **Note:** GHCR requires authentication even for public images. Login once with:
> ```bash
> echo $GITHUB_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
> ```
> Or use a [personal access token](https://github.com/settings/tokens) with `read:packages` scope.

```bash
# Quick start: daemon + web UI on port 19280
docker run -p 19280:19280 ghcr.io/vava-nessa/free-coding-models:latest

# With an API key
docker run -p 19280:19280 -e OPENROUTER_API_KEY=your_key ghcr.io/vava-nessa/free-coding-models:latest
```

Point your coding tool at `http://localhost:19280/v1` with model `fcm` and key `fcm-local`. See [router.md](./router.md) for routing details.

**Available image tags:** `latest`, `v{major}.{minor}.{patch}` (e.g. `v0.3.70`), `v{major}.{minor}` (e.g. `v0.3`), `v{major}` (e.g. `v0`)

### Environment variables

| Env var | Default | Description |
|---------|---------|-------------|
| `FCM_HOST` | `0.0.0.0` | Bind host (`127.0.0.1` for localhost-only) |
| `FCM_PORT` | `19280` | Router/daemon port (`--daemon` mode); also the web port fallback |
| `FCM_WEB_PORT` | `3333` | Port for catalog-only `web` mode |
| `FCM_ROUTER_TOKEN` | unset | Optional shared-token auth: when set, every `/v1/*` route requires `Authorization: Bearer <token>` (or `x-api-key: <token>`). Leave unset for the default no-auth local behavior. |
| `FCM_ALLOWED_ORIGINS` | unset | Comma-separated origin URLs allowed by the dashboard CORS check, e.g. `http://mybox:19280,http://10.0.0.5:19280`. Useful when the daemon runs on another host. |
| `FCM_DISCORD_FEATURE_WEBHOOK` | unset | Optional Discord webhook URL used by the in-app anonymous feature-request action. |
| `FCM_DISCORD_BUG_WEBHOOK` | unset | Optional Discord webhook URL used by the in-app anonymous bug-report action. |
| `FREE_CODING_MODELS_TELEMETRY` | `0` in Docker | Set `0` / `false` / `off` to disable anonymous telemetry. |

### Docker Compose + troubleshooting

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
- **Won't start**: check `docker logs fcm`, and make sure port 19280 is not already in use (`docker ps | grep 19280`).
- **Health check fails**: wait about 30s for the first probe cycle; verify keys with `docker exec fcm curl http://localhost:19280/health`.
- **Can't connect from host**: keep `FCM_HOST=0.0.0.0` (the default) and make sure the firewall allows localhost.
- **Reset data**: config lives in the `fcm-data` volume; wipe it with `docker-compose down -v`.

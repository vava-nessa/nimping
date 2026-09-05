# Development

## Setup

```bash
git clone https://github.com/vava-nessa/free-coding-models
cd free-coding-models
pnpm install
pnpm start
```

Requires Node.js 18+ and pnpm. The marketing site lives in `website/` (TanStack Start + Vite) and the agent extensions live in `packages/` - both have their own `package.json`.

## Repository layout

| Path | Role |
|------|------|
| [`bin/free-coding-models.js`](../bin/free-coding-models.js) | CLI entrypoint - arg parsing, help text, launches the TUI or daemon. |
| [`sources.js`](../sources.js) | The model catalog (24 providers / 229 live models, see [providers.md](./providers.md)). Edit here to add a provider, then re-run `node scripts/generate-provider-table.mjs` to refresh the provider table. |
| `src/core/` | Pure logic: config, pinging, scoring, probes, tool launchers, router daemon, telemetry, sync-set, drift detection. No rendering. |
| `src/tui/` | The ANSI terminal UI - app loop, renderer, key/mouse handlers, overlays, command palette, theme. |
| `src/data/benchmarks.json` | Extended benchmark overlay (Coding/Math/Agentic/Reasoning/MMLU-Pro/GPQA/HLE), refreshed via `pnpm update:benchmarks`. |
| `packages/fcm-agent-core/` | Shared scan/rank/cache/daemon core for the agent extensions. |
| `packages/fcm-pi/` · `packages/fcm-opencode/` | Pi and OpenCode adapters (thin renderers over the shared core). |
| `website/` | Marketing/docs site (TanStack Start). |
| `test/` | Unit + E2E tests (`node:test`, zero deps). |

### Key `src/core` modules

| File | Responsibility |
|------|----------------|
| `utils.js` | Pure helpers: sorting, filtering, scoring, `parseArgs`. |
| `config.js` | Read/write `~/.free-coding-models.json`. |
| `ping.js` · `ping-loop.js` | Parallel health probing + adaptive cadence. |
| `probe-cache.js` | 24h cross-surface probe cache. |
| `router-daemon.js` | The local OpenAI-compatible daemon + failover + circuit breaker. |
| `router-dashboard.js` | Web Dashboard + router control surface. |
| `tool-launchers.js` · `endpoint-installer.js` | Write models into external tools' configs. |
| `runtime-telemetry.js` · `provider-quota-fetchers.js` | Real-world scores + passive quota headers. |
| `sync-set.js` | Auto-discover/live-probe a router set. |
| `models-dev-fetcher.js` · `models-drift.js` | `models.dev` enrichment + `--check-drift`. |

## Tests

```bash
pnpm test           # unit tests (node:test, zero deps)
pnpm test:fcm       # AI E2E flow - drives the real TUI in a PTY
pnpm test:fcm:mock  # same flow but with a mock binary
```

Pure logic lives under `src/core/` so it can be tested without mocking the TUI. When you add new pure logic (calculations, parsing, filtering), expose it from `src/core/` and add a test in `test/`.

## Releasing

1. Update `changelog/vX.Y.Z.md` with the release notes for the new version (this file becomes the GitHub Release body).
2. Bump `"version"` in `package.json`.
3. Commit everything with the version number as the message:

```bash
git add .
git commit -m "0.1.4"
git push origin main
```

GitHub Actions auto-publishes to npm on every push to `main`. Verify the *real* published package (a local `npm install -g .` can mask missing files):

```bash
npm view free-coding-models version
npm install -g free-coding-models@<new-version>
free-coding-models --help
```

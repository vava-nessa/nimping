---
id: t14
title: Quality pass: security, reliability, ponytail cleanup, docs
status: Done
created: 2026-09-05
updated: 2026-09-05T23:35:52Z
---

## Completion report (2026-09-05)

Executed in worktree `feat/quality-pass`, 10 commits, merged sequence:

1. `fix(security)`: raw API keys masked over HTTP, Host header allowlist (anti DNS-rebinding), Origin:null untrusted, origin checks on shutdown/sets/benchmark/SSE, CORS wildcard removed from web/server.js, /v1 cookie stripping + optional FCM_ROUTER_TOKEN, telemetry bodies dropped, keys written 0600, telemetry opt-out honored, Discord webhooks moved to env.
2. `fix(core,tui)`: multi-key array 401s, hiddenModels persistence, verdict "Perfect" on 401 fixed, ping history cap 300 + startup burst x5, auto-hide clobbering, invisible palette, stream-timeout crash loop, 8 missing env vars, tier mismatches, dead code removed.
3. `fix(website)` + `fix(web)`: 19 TS errors to 0, catalog re-synced (229 models), SEO (title/OG/sitemap/404), PostHog placeholder + Google Fonts removed, -9399 lines of committed WIP.
4. `chore(ponytail)`: 4.4 MB dead media deleted, npm tarball 1.8 to 1.3 MB packed (397 files), packages self-imports fixed, kandown to devDependencies, docker entrypoint PID + 13 env passthroughs.
5. `test`: 5 orphan files revived (104 tests), glob runner, 18 new tests. 946 to 1068 tests.
6. `docs`: README 67 KB to 16 KB, provider tables generated via scripts/generate-provider-table.mjs, all claims verified against code, 200+ em dashes purged.
7. `ci`: tests workflow added; commit-log Discord failure diagnosed (dead webhook, needs secret rotation).

Verification evidence: pnpm test 1068/1068 x2 runs; website typecheck 0 errors; npm pack dry-run 397 files; tmux TUI smoke (render + palette + Shift+B chip truthful); daemon smoke: /api/key/groq returns masked, Host: evil.com 403, normal host 200; CLI --help + --tier S clean.

Follow-ups for vava:
- Recreate the Discord webhook and update secret DISCORD_WEBHOOK_GITHUB (current one answers 404). Discord feedback webhooks are now env-only: set FCM_DISCORD_FEATURE_WEBHOOK / FCM_DISCORD_BUG_WEBHOOK to re-enable feedback.
- Daemon startup burst (229-model load) still saturates the event loop for ~1-4 min: separate finding, not fixed in this pass.

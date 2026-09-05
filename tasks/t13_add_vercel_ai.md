---
id: t13
title: Add Vercel AI Gateway provider (v0.5.85)
status: Done
created: 2026-09-05
updated: 2026-09-05T18:03:23Z
---

## Completion report (2026-09-05)

Shipped as v0.5.85, published on npm and verified on the global install.

### What was done

- Researched 6 candidate providers found via a competitor directory scan; only Vercel AI Gateway passed the legitimacy + free-tier bar (others: gray-market reseller, paywalled API, anonymous operator, trial credits, models too weak for coding).
- Added provider `vercel-gateway` to `sources.js` + website mirror: 4 live-verified $0 models (MiniMax M3 Free S+ 78.4% 1M ctx, MiniMax M2.7 Free S+ 78.0% 196k ctx, Laguna S 2.1 Free S+ 256k ctx, Ling 3.0 Flash Fin Free B+ 256k ctx). quotaCode 'limited'.
- Wired across surfaces: `src/core/config.js` env keys (`VERCEL_AI_GATEWAY_API_KEY`, `AI_GATEWAY_API_KEY`), `provider-metadata.js` (settings panel + env map), `quota-capabilities.js` (monthly reset), `provider-key-tester.js` (/v1/models probe), `models-dev-index.js` (alias 'vercel'), `opencode.js` (x2) + `kilo.js` (provider config generation), `theme.js` (dark + light colors).
- Added integrity test in `test/test.js` (models must be explicit `-free` $0 IDs).
- README: provider table row 24 + permanent free tiers table row.
- `changelog/v0.5.85.md` written before commit; used as release notes source.

### Verification evidence

- `pnpm test`: 880/880 pass (168 suites), 0 fail.
- `pnpm start`: TUI renders, pings models, no runtime errors. Settings screen renders "Vercel AI Gateway" row (verified via createOverlayRenderers with real sources/metadata).
- `pnpm build:web` + website `vite build`: both succeed (pre-existing tsc errors in DocsSidebar/MarkdownRenderer also exist on main baseline, unrelated).
- `check-drift.mjs`: zero drift flagged on the 4 new model IDs (7 pre-existing informational items elsewhere).
- npm: 0.5.85 published ~2 min after push; `npm install -g free-coding-models@0.5.85` then verified: sources exposes vercel-gateway (4 models), MODELS=229, providers=24, `free-coding-models --help` works, TUI runs on the global binary.
- Commit fd8d990 pushed to main; CI auto-published.

### Follow-ups discovered (not blockers)

- `website/src/_fcm-sources/sources.js` had drifted from root `sources.js` before this task (169 lines, the 0.5.84 audit only updated the root copy; a Devstral restore only exists in the website copy). Needs a reconciliation pass + re-audit.
- Vercel gateway exposes `GET /v1/credits`; a quota fetcher (like OpenRouter's) could display remaining credits. Not wired in this release (needs a real key to test).
- README "Permanent Free Tiers" table still lists GitHub Models (retired 2026-07-30, HTTP 410 verified). Pre-existing staleness.
- models.dev flags `laguna-s-2.1` as deprecated (2026-09-05); Vercel still serves the $0 variant live today, kept with a re-verify comment in sources.js.
- Optional: visual pass of the website catalog page (`pnpm dev` in website/, port 4328) to eyeball the new provider card; data-only change, vite build already validates compilation.

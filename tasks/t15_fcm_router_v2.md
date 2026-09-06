---
id: t15
title: FCM Router v2 beta
status: In Progress
created: 2026-09-06
updated: 2026-09-06T19:33:01Z
---

# FCM Router v2 (beta)

## Intent

Build a parallel Smart Model Router v2 that fixes every reliability gap found in the
v1 audit, without touching v1 (zero regression risk). v2 ships marked **beta** in the
TUI and the Web dashboard, on its own port, reusing the same config/sets/API keys.

## Scope

- New `src/core/router-v2/` modules: failure classifier, response content gate
  (JSON + stream readiness), decision trace, persisted circuit breakers
  (DEGRADED state + escalating backoff), persisted request history (JSONL),
  Anthropic `/v1/messages` compat layer, test-via-router bench client.
- New daemon `src/core/router-v2/daemon.js`: listens before probing, validates
  200 bodies (empty choices / embedded error = failover), body-read timeout,
  quota-aware candidates + Retry-After, blame attribution (client 4xx/aborts do
  not damage model health), activeRequests lifecycle fix, strips `x-api-key`
  upstream, cumulative retry budget, global last-resort model, decision headers.
- CLI flags `--router-v2`, `--router-v2-bg`, `--router-v2-status`, `--router-v2-stop`,
  `--router-v2-test`. New default port range (prod + dev), own PID/port files.
- TUI: new overlay "Router v2 (beta)" + NEW hotkeys (test via router, selected + all),
  fallback chain per request with skip reasons.
- Web: "Router v2 (beta)" page, proxy endpoints, health table, request history,
  test-this-set button.
- Tests: `test/router-v2.test.js` covering every fix above + Anthropic translation.
- Docs: `docs/router-v2.md`, README section (beta), TUI help.

## Acceptance criteria

- [x] v1 untouched: existing router tests pass unchanged (full suite 1119/1119 green).
- [x] A 200 with empty `choices`, embedded `error`, or below-min content triggers
      failover (JSON + streaming), verified by tests.
- [x] JSON upstream that trickles the body cannot hang a request (timeout, tested).
- [x] Quota-exhausted / Retry-After models are skipped by candidate selection.
- [x] Client 4xx and client aborts never markFailure healthy models (tested).
- [x] `x-api-key` from clients never reaches an upstream provider (tested).
- [x] Circuit breaker state survives daemon restart (persisted, tested).
- [x] Anthropic `/v1/messages` (stream + non-stream) routes through v2 (tested).
- [x] Response carries decision headers + request history is persisted and
      rendered in TUI overlay + web page (beta badge visible on both).
- [x] New hotkeys documented in help + docs; none clash with existing keys
      (Shift+V, Ctrl+T, Ctrl+Shift+T confirmed free).
- [x] `pnpm test` fully green (1119 pass); web build passes.

## Verification evidence (2026-09-06)

- `node --test test/router-v2.test.js`: 37/37 pass.
- `pnpm test` (full suite): 1119 tests / 227 suites, 0 fail.
- `vite build` (web dashboard): builds clean; bundle contains the Router v2 page.
- Real end-to-end via tmux TUI + dev daemon on :29380:
  - Shift+V opens the BETA overlay; daemon starts from the overlay button.
  - Real chat completion served: content "Hi there, friend!" via llm7/minimax-m2.7,
    headers `x-fcm-v2-model` / `x-fcm-v2-attempts` / `x-fcm-v2-decision` present.
  - Failover observed live: `poolside/laguna-xs-2.1(auth_error) -> minimax-m2.7(200)`.
  - Rate-limited model paused (429 + Retry-After) and skipped on next requests.
  - Anthropic `/v1/messages` non-stream returns a valid message payload; streaming
    returns a valid Anthropic SSE stream (message_start/text_delta/message_stop).
  - Overlay `T` test action: `✅ 2868ms` in the V2 TEST column.
- Web proxy verified: `/api/router-v2/status|stats|history` proxied to the daemon.

## Decisions

- v2 is a fork-and-harden of the v1 daemon (vava decision: do not break v1),
  with new leaf modules for the new subsystems; v1 retirement comes later.
  Shared pure helpers are imported from v1 (export-only additions there).
- Same sets/config/keys as v1; port 19380 prod / 29380 dev, own PID/port/state
  files (`-v2` suffix).
- New test hotkeys, do NOT reuse Ctrl+A / Ctrl+U (vava decision): Shift+V,
  Ctrl+T, Ctrl+Shift+T.
- Anthropic `/v1/messages` included in v2 (vava decision).
- Config-mutating endpoints stay v1-only while v2 is beta (v2 reads config,
  reloads every 10s, only mutates probe mode + set activation).

## Out of scope

- Multi-key rotation per provider, session stickiness, shadow routing (P3, later).
- Removing or deprecating v1.

## Status

Implementation complete on branch `feat/router-v2` (worktree
`../free-coding-models-router-v2`), committed, awaiting vava review + merge.

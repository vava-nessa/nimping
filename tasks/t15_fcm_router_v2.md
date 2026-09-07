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

- [ ] v1 untouched: existing router tests pass unchanged, v1 daemon behavior identical.
- [ ] A 200 with empty `choices`, embedded `error`, or below-min content triggers
      failover (JSON + streaming), verified by tests.
- [ ] JSON upstream that trickles the body cannot hang a request (timeout, tested).
- [ ] Quota-exhausted / Retry-After models are skipped by candidate selection.
- [ ] Client 4xx and client aborts never markFailure healthy models (tested).
- [ ] `x-api-key` from clients never reaches an upstream provider (tested).
- [ ] Circuit breaker state survives daemon restart (persisted, tested).
- [ ] Anthropic `/v1/messages` (stream + non-stream) routes through v2 (tested).
- [ ] Response carries decision headers + request history is persisted and
      rendered in TUI overlay + web page (beta badge visible on both).
- [ ] New hotkeys documented in help + docs; none clash with existing keys.
- [ ] `pnpm test` fully green; `pnpm start` runs clean; web typecheck/build passes.

## Decisions

- v2 is a fork-and-harden of the v1 daemon (vava decision: do not break v1),
  with new leaf modules for the new subsystems; v1 retirement comes later.
- Same sets/config/keys as v1; different port (19380 prod / 29380 dev) and own
  PID/port files.
- New test hotkeys, do NOT reuse Ctrl+A / Ctrl+U (vava decision).
- Anthropic `/v1/messages` included in v2 (vava decision).

## Out of scope

- Multi-key rotation per provider, session stickiness, shadow routing (P3, later).
- Removing or deprecating v1.

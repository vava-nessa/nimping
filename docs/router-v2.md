# Smart Model Router v2 (BETA)

Router v2 is a hardened rebuild of the Smart Model Router. It runs **next to**
the stable Router (v1) on its own port, shares the same sets / models / API
keys, and is flagged **BETA** everywhere (TUI overlay, web dashboard, CLI).
Nothing you do with v2 touches how v1 behaves.

```bash
free-coding-models --daemon           # start in the foreground (port 19280)
free-coding-models --daemon-bg        # start in the background
free-coding-models --daemon-status    # print status JSON
free-coding-models --daemon-stop      # stop it
```

> 📖 **Migration note:** Router v2 started as a parallel beta daemon on port
> 19380 and has since been MERGED into the main router daemon. The v2 engine
> (everything documented below) now powers the historical `--daemon` port,
> and the `--router-v2*` flags remain as aliases of the main lifecycle so
> existing scripts keep working. Nothing to reconfigure: point your tool at
> `http://localhost:19280/v1` as before.

## What v2 fixes over v1

1. **Content-validated failover.** A `200` only counts as success when the
   payload holds real content (text, tool calls or reasoning). Empty
   `choices`, embedded `error` objects, or content-less answers fail over to
   the next model. Streaming gets the same treatment: an SSE error frame
   before any content fails over **before bytes reach your tool**, and a
   stream that closes without producing content is a failure, not a success.
2. **No more hung requests.** Non-streaming upstream body reads are
   timeout-protected (`router.failover.bodyReadTimeoutMs`, default 30s).
3. **Quota-aware routing.** A `429` model is paused for its `Retry-After`
   window (capped at 15 min) and skipped until the pause expires. The final
   `429` response to your tool carries a `Retry-After` header.
4. **Blame attribution.** Client-caused `4xx` (bad payload, unsupported
   field, body too large) fail over to the next model but never count toward
   circuit breakers, so one malformed request can no longer open circuits on
   three healthy models. Client disconnects never mark failures at all.
5. **Persisted circuit breakers.** Breaker state survives daemon restarts
   (`~/.free-coding-models-router-v2-breakers.json`). New `DEGRADED` warning
   state at 60% of the failure threshold, and escalating cooldowns for
   repeatedly-tripping models (capped at 16x).
6. **Decision traces.** Every response carries `x-fcm-v2-model`,
   `x-fcm-v2-attempts` and `x-fcm-v2-decision` headers, and every request is
   persisted to a local history (`~/.free-coding-models-router-v2-history.json`)
   with the full attempt chain and skip reasons. Traces contain routing
   metadata only: no prompts, no completions, no keys.
7. **Fast first boot.** v2 listens before its first probe pass; the old
   up-to-~36s first-boot stall is gone.
8. **Header hygiene.** Client `x-api-key` headers are stripped before
   proxying upstream (the local router token can never leak to a provider).
9. **Retry budget.** Per-request wall-clock budget
   (`router.failover.totalBudgetMs`, default 120s) on top of the attempt cap.
10. **Last-resort model.** Optional escape hatch: set
    `router.failover.lastResortModel: "provider/model"` in
    `~/.free-coding-models.json` and v2 gives that model one final shot when
    the whole set failed.

## Anthropic protocol: `POST /v1/messages`

v2 speaks the Anthropic Messages protocol on the same port, so agents that
talk Anthropic (Claude Code style clients) can use the router directly:

```
base_url: http://localhost:19380
POST /v1/messages
model: "fcm"
```

Both streaming (Anthropic SSE events: `message_start`, `content_block_delta`,
`message_stop`, including `tool_use` / `input_json_delta`) and non-streaming
responses are translated. Image, document and server-side tool blocks are not
supported and are reported as request warnings or dropped.

## Model pinning: test one model through the full chain

```
model: "fcm:@provider/modelId"
```

A pinned request routes to exactly that model with failover disabled, while
still exercising the whole chain: schema normalization, pre-prompt, content
gate, breaker updates. This is what the new test actions use:

| Surface | Action |
|---|---|
| TUI `Ctrl+T` | Test the selected model through Router v2 |
| TUI `Ctrl+Shift+T` | Test every visible model through Router v2 |
| TUI `Shift+V` | Router v2 dashboard (beta): chain, request history, `T` to test |
| Web dashboard | "Router v2" nav entry (BETA chip): chain, request chains, test buttons |

Unlike the direct-to-provider AI Speed Test (`Ctrl+A` / `Ctrl+U`), these
tests measure the exact path your coding traffic takes.

## v2-specific settings (in `~/.free-coding-models.json`, under `router.failover`)

| Key | Default | What it does |
|---|---|---|
| `bodyReadTimeoutMs` | `30000` | Deadline for reading a non-streaming upstream body |
| `totalBudgetMs` | `120000` | Wall-clock budget for the whole failover chain |
| `contentValidation` | `strict` | `strict` / `basic` / `off` response content gate |
| `lastResortModel` | off | Final model tried when the whole set fails |

Circuit breaker thresholds, probe modes and sets are shared with v1 and keep
their existing keys.

## Dashboard API (local, on the v2 port)

- `GET /health`, `GET /stats`
- `GET /api/router-v2/history?limit=50` - persisted request chains
- `GET /api/router-v2/traces` - recent decision traces
- `POST /api/router-v2/test` `{ provider, model }` - one pinned test
- `GET /api/router-v2/events` - SSE: probe, circuit, request, set events

## Known beta limits

- The Playground and the endpoint installer still target v1.
- Set mutations (add/reorder/sync) stay on v1 while v2 is in beta; v2 reads
  the same config and reloads it every 10 seconds.
- Anthropic image/document blocks and server-side tools are not translated.

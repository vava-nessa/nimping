# Sync Set - Automatic Router Set Discovery

`--sync-set [name]` auto-discovers, live-probes, and populates a named router
set with the best currently-available coding models. It is designed for
automated / scheduled use so your router set stays up-to-date without manual
model selection.

## Quick Start

```bash
# Create or refresh a set called "auto" (the default name)
free-coding-models --sync-set

# Create a named set
free-coding-models --sync-set my-coding-set

# Run the daemon with the auto-selected set
free-coding-models --daemon-bg
```

## How It Works

1. **Catalog scan** - Reads all models from `sources.js` and filters to
   routeable providers where the user has an API key configured.

2. **Candidate ranking** - Models are scored by:
   - Tier (S+ > S > A+ > A > …)
   - SWE-bench Verified percentage
   - Coding keyword affinity (models whose ID mentions "coder", "code",
     "deepseek", "qwen", etc. get a small bonus)

3. **Live probing** - Top candidates are tested sequentially with two requests:
   - **Plain text** - `"Reply with exactly OK and nothing else."` - must
     return exactly `OK`
   - **Tool call** - `"Use the echo tool with text exactly OK"` - must
     produce a valid `tool_calls` array

   Both must pass. This ensures coding tools that rely on function calling
   (Forge, OpenCode, Aider, Cursor, etc.) will work reliably.

4. **Set population** - The first N passing models are written into the named
   set in the config file (`~/.free-coding-models.json`).

5. **Daemon reload** - If the router daemon is running, it receives `SIGHUP`
   to hot-reload the updated config.

## Output

The command prints a JSON result to stdout, suitable for scripting:

```json
{
  "ok": true,
  "name": "auto",
  "activated": true,
  "selected": [
    { "provider": "nvidia", "model": "qwen/qwen3-coder-480b-a35b-instruct", "priority": 1 },
    { "provider": "nvidia", "model": "deepseek-ai/deepseek-v3.1-terminus", "priority": 2 }
  ],
  "daemonReloaded": true,
  "probeCount": 5,
  "probeResults": [
    { "model": "nvidia/qwen/qwen3-coder-480b-a35b-instruct", "ok": true, "reason": "ok" },
    { "model": "nvidia/some-other-model", "ok": false, "reason": "no_tool_calls" }
  ]
}
```

## Failure Modes

| Scenario | Behavior |
|----------|----------|
| No API keys configured | Exits with `ok: false, reason: "no_candidates"` |
| All probes fail (429/timeout) | Keeps existing set if one exists, otherwise exits with error |
| Daemon not running | Set is still written; daemon will pick it up on next start |

## Scheduling

You can run `--sync-set` on a cron/launchd schedule to keep your set fresh:

```bash
# crontab example - refresh every 4 hours
0 */4 * * * /usr/local/bin/free-coding-models --sync-set >> ~/.free-coding-models-sync.log 2>&1
```

```xml
<!-- macOS launchd example -->
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/free-coding-models</string>
  <string>--sync-set</string>
</array>
<key>StartInterval</key>
<integer>14400</integer>
```

## Filtering

Models are automatically filtered:
- **Minimum SWE score**: 40% (below this, models are unlikely to handle
  real coding tasks)
- **Excluded providers**: `googleai` (streaming thought-tag issues)
- **Excluded patterns**: `thinking`, `gemma` model IDs
- **OpenRouter**: Only `:free` models are considered by default
- **Tier floor**: C-tier models are excluded

## Programmatic Use

The sync-set logic is exported for use in custom scripts:

```js
import { syncSet, buildSyncCandidates, probeModel } from './src/sync-set.js'

// Full pipeline
const result = await syncSet({ name: 'my-set', targetCount: 3 })

// Just ranking without probing
const candidates = buildSyncCandidates(apiKeys, { minSwePercent: 50 })

// Probe a single model
const probeResult = await probeModel(candidate, apiKey)
```

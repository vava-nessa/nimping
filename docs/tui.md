# Terminal UI (TUI) Reference

The TUI is the heart of `free-coding-models`. Launch it with `free-coding-models` and you get a live, sortable table of every model: real latency, stability, verdict, and a one-key launch into your coding tool.

Every binding below was verified against `src/tui/key-handler.js` (the file is the source of truth; if this doc and the code ever disagree, trust the code and fix this doc).

## First-run flow

1. `free-coding-models` opens the TUI and prompts for API keys. Paste one (or skip).
2. Models start pinging in parallel. Rows turn green ✅ as they respond.
3. Navigate with `↑↓`, press `Enter` on the model you want. FCM writes it into your tool's config and launches the tool.

## Keyboard reference

### Navigation and launch

| Key | Action |
|-----|--------|
| `↑` / `↓` (or `k` / `j`) | Navigate models (wraps around the list) |
| `Enter` | Launch the selected model in the active tool |
| `Space` | Expand the selected row: 2-line detail card with provider, endpoint URL and the full model ID (press again or move the cursor to collapse) |
| `Shift+↑` / `Shift+↓` | Reorder favorites in pinned mode |

### Filters

| Key | Action |
|-----|--------|
| `T` | Cycle tier filter (All → S+ → S → A+ → A → A- → B+ → B → C → All) |
| `D` | Cycle provider filter (All → NVIDIA → Groq → ... → All) |
| `E` | Cycle visibility (Normal → Configured only → Usable only) |
| `X` | Clear the active custom text filter (set from the Command Palette) |
| `Shift+B` | Toggle visibility of broken models (footer shows the cached/broken counters) |
| `N` | Reset all filters and sort back to defaults |

Note: plain `V` and `H` sort by verdict / health (see below). `Shift+V` and `Shift+H` cycle the verdict and health FILTER modes (All, then each value, back to All): the sort handler explicitly ignores shifted keys so both behaviors coexist.

### Sorts

Plain letter keys sort the table by that column. Pressing the same key again toggles the direction.

| Key | Sorts by |
|-----|----------|
| `R` | Rank |
| `O` | Origin (provider) |
| `M` | Model name |
| `L` | Latest ping |
| `A` | Average ping |
| `S` | SWE-bench score |
| `C` | Context window |
| `H` | Health / condition |
| `V` | Verdict |
| `B` | Stability score |
| `U` | Uptime |

### Actions

| Key | Action |
|-----|--------|
| `Z` | Cycle target tool (OpenCode → OpenClaw → Crush → Goose → ...) |
| `F` | Favorite / unfavorite the selected model |
| `Y` | Toggle favorites display mode (Normal ↔ Pinned + always visible) |
| `G` | Cycle global theme (Auto → Dark → Light) |
| `W` | Cycle ping mode (speed 2s → normal 10s → slow 30s → forced 4s) |
| `P` | Settings screen (API keys, providers, updates, theme, Startup Speed Scan) |
| `Q` | Smart Recommend overlay: 3-question wizard that returns Top 3 picks |
| `I` | Toggle the help overlay |
| `Ctrl+P` | Open the Command Palette (fuzzy search across every filter, sort and action) |
| `;` | Open the Playground chat overlay (chat with the FCM router) |
| `Ctrl+A` | Run an AI Speed Test on the selected model (real completion: AI Latency + TPS) |
| `Ctrl+U` | Run the global AI Speed Test across all visible models |
| `Shift+P` | Re-probe failed rows only (auth fail / 429 / 404 / timeout), no whole-list rescan |
| `Ctrl+Shift+P` | Probe all configured models (404/410 check, auto-hides broken ones) |
| `Shift+R` | Open / close the Router Dashboard overlay |
| `Shift+T` | Open the Token Usage screen |
| `Shift+W` | Open the Runtime Report overlay (per-model real-world success rate + throughput) |
| `Shift+U` | Update to the latest version (when an update is available) |
| `Esc` | Dismiss the narrow-terminal warning, close overlays |
| `Ctrl+C` | Exit |

## Mouse reference

| Action | Result |
|--------|--------|
| Click a column header | Sort by that column |
| Click the Tier header | Cycle the tier filter |
| Click the CLI Tools header | Cycle the tool mode |
| Click a model row | Move the cursor to that model |
| Double-click a model row | Select and launch it (same as `Enter`) |
| Right-click a model row | Toggle favorite |
| Scroll wheel | Navigate table, overlays and palette |
| Click a footer hotkey | Trigger that action |
| Click the update banner | Install the latest version and relaunch |
| Click outside a modal | Close the Command Palette |

## Common workflows

**"Give me the fastest model that actually works"**
Sort by stability with `B` (or verdict with `V`). The top rows with medals are your best bets. Models in `NO KEY` or `AUTH FAIL` are faded so you instantly see what you cannot use.

**"Configure OpenCode with Groq's fastest model"**

```bash
free-coding-models --opencode --origin groq
# navigate, press Enter. opencode.json is written and the CLI opens.
```

**"Benchmark before I commit to a model"**
`Ctrl+A` runs a real completion against the selected model (not just a ping) and reports AI Latency + TPS. `Ctrl+U` runs it across all visible models. Enable Startup AI Speed Scan in Settings (`P`) to run the global benchmark automatically after launch.

**"Keep my go-to models pinned"**
Star a model with `F` (favorites persist in `~/.free-coding-models.json`, shared with the Web Dashboard). Press `Y` to pin favorites at the top so they never scroll away.

**"Switch tools without restarting"**
Press `Z` to cycle the target tool. Models incompatible with the active tool get a dark-red row background.

**"My terminal theme fights the TUI colors"**
Press `G` to cycle Auto → Dark → Light. It recolors the whole interface live.

Stability score and column reference: [stability.md](./stability.md)

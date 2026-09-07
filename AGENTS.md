# Agent Instructions

## STRICT VERIFICATION MANDATE (ALWAYS VERIFY BEFORE SHIPPING)

> [!CAUTION]
> NEVER deliver work, submit a feature, or claim a task is completed without explicitly checking and verifying it beforehand!
>
> 1. **Check existing reference implementations first**: Before designing UI or features, search for and inspect reference code in existing projects (e.g., Kandown or past clean implementations) to avoid guessing or inventing broken/flawed designs.
> 2. **Visual & Browser Verification**:
>    - For web pages: ALWAYS run `pnpm dev` inside `website/`, open the URL in Chrome (`open http://localhost:4328`), and visually inspect layout, sidebar, navigation, links, and rendered Markdown styling.
> 3. **Run Unit Tests & Build**:
>    - Always execute `pnpm test` and `pnpm --prefix website typecheck` (or `pnpm build`) to confirm zero regressions before marking a task complete.
> 4. **Zero AI Slop**:
>    - Never generate generic placeholder chips, artificial summary cards, or fake quote boxes when raw Markdown source content is available. Render real source data cleanly and accurately.

## Cross-Surface Compatibility Mandate

> [!IMPORTANT]
> Every single new feature, engine enhancement, bug fix, or catalog change **MUST** function perfectly across all three user-facing surfaces of the application:
> 1. **CLI (TUI)**: Terminal command line mode.
> 2. **Web Dashboard / Docker**: Daemon-served web interface on `localhost:19280`.
> 3. **Desktop version (Tauri)**: System tray utility. PLANNED, not implemented yet: `desktop/` holds only the PRD, no code exists today. Treat it as a design target, not an existing surface.
>
> If you add or modify logic in the shared core (`src/` or `sources.js`), you must ensure it does not break the two shipped surfaces (TUI + Web Dashboard/Docker), and that the planned Desktop version will be able to reuse it. Building a feature that only works on one surface while ignoring or breaking the others is strictly prohibited.

## Website Development & Testing (MANDATORY)

> [!IMPORTANT]
> Every time work is performed on the marketing site / documentation (`website/` directory):
> 1. Launch the dev server (`pnpm dev` inside `website/`) in a dedicated **herdr tab** labelled `vite 4328` or `website 4328`.
> 2. Open `http://localhost:4328` in Chrome (or via `chrome-devtools new_page` / `open http://localhost:4328`) so vava can view and test the website in real time.

## Post-Feature Testing

After completing any feature or fix, the agent MUST:

1. Run `pnpm test` to verify all unit tests pass (1050+ tests across 200+ suites; exact counts grow over time, `pnpm test` prints them)
2. If any test fails, fix the issue immediately
3. Re-run `pnpm test` until all tests pass
4. Run `pnpm start` to verify there are no runtime errors
5. If there are errors, fix them immediately
6. Re-run `pnpm start` until all errors are resolved
7. Only then consider the task complete

This ensures the codebase remains in a working state at all times.

## Release Process (MANDATORY)

When releasing a new version, follow this exact process:

1. **Version Check**: Check if version already exists with `git log --oneline | grep "^[a-f0-9]\+ [0-9]"`
2. **Version Bump**: Update version in `package.json` (e.g., `0.1.16` → `0.1.17`)
3. **Commit ALL Changed Files**: `git add . && git commit -m "0.1.17"`
   - Always commit with just the version number as the message (e.g., "0.1.17")
   - Include ALL modified files in the commit (bin/, src/, test/, README.md, changelog/, etc.)
4. **Push**: `git push origin main` - GitHub Actions will auto-publish to npm
5. **Wait for npm Publish":
   ```bash
   for i in $(seq 1 30); do sleep 10; v=$(npm view free-coding-models version 2>/dev/null); echo "Attempt $i: npm version = $v"; if [ "$v" = "0.1.17" ]; then echo "✅ published!"; break; fi; done
   ```
5. **Install and Verify**: `npm install -g free-coding-models@0.1.17`
6. **Test Binary**: `free-coding-models --help` (or any other command to verify it works)
7. **Only when the global npm-installed version works → the release is confirmed**

**Why:** A local `npm install -g .` can mask issues because it symlinks the repo. The real npm package is a tarball built from the `files` field - only a real npm install will catch missing files.

## Real-World npm Verification (MANDATORY for every fix/feature)

**Never trust local-only testing.** `pnpm start` runs from the repo and won't catch missing files in the published package. Always run the full npm verification:

1. Bump version in `package.json` (e.g. `0.1.14` → `0.1.15`)
2. Commit and push to `main` - GitHub Actions auto-publishes to npm
3. Wait for the new version to appear on npm:
   ```bash
   # Poll until npm has the new version
   for i in $(seq 1 30); do sleep 10; v=$(npm view free-coding-models version 2>/dev/null); echo "Attempt $i: npm version = $v"; if [ "$v" = "NEW_VERSION" ]; then echo "✅ published!"; break; fi; done
   ```
4. Install the published version globally:
   ```bash
   npm install -g free-coding-models@NEW_VERSION
   ```
5. Run the global binary and verify it works:
   ```bash
   free-coding-models
   ```
6. Only if the global npm-installed version works → the fix is confirmed

**Why:** A local `npm install -g .` can mask issues because it symlinks the repo. The real npm package is a tarball built from the `files` field - if something is missing there, only a real npm install will catch it.

## Test Architecture

- Tests live in `test/test.js` using Node.js built-in `node:test` + `node:assert` (zero deps)
- Pure logic functions are in `src/utils.js` (extracted from the main CLI for testability)
- The main CLI (`bin/free-coding-models.js`) imports from `src/utils.js`
- If you add new pure logic (calculations, parsing, filtering), add it to `src/utils.js` and write tests
- If you modify existing logic in `src/utils.js`, update the corresponding tests

### What's tested:
- **sources.js data integrity** - model structure, valid tiers, no duplicates, count consistency
- **Core logic** - getAvg, getVerdict, getUptime, filterByTier, sortResults, findBestModel
- **CLI arg parsing** - all flags (--best, --fiable, --opencode, --openclaw, --tier)
- **Package sanity** - package.json fields, bin entry exists, shebang, ESM imports

## GitHub Contributors

When new PRs are merged, add the contributor's GitHub handle to the footer in `bin/free-coding-models.js` (the `Contributors:` line near line 775), separated by spaces. Also update this list:

- @whit3rabbit
- @PhucTruong-ctrl
- @stgreenb
- @MoriDanWork
- @Muhammad95959
- @FaintFlower
- @lehneres
- @ia-S-on
- @bangla24bdrang-lab

## Testing the TUI with tmux

The project's TUI is built with raw ANSI escape codes + chalk. To visually test TUI behavior, use **tmux** - pre-installed on macOS and provides native PTY support.

### Setup

No setup needed - tmux is already installed. Just spawn sessions and send keys.

### Core Commands

| Command | What it does |
|---------|-------------|
| `tmux new-session -d -s <name> "pnpm start"` | Spawn the TUI in a detached session |
| `tmux send-keys -t <name> "keys"` | Send keypresses to the session |
| `tmux send-keys -t <name> C-c` | Send Ctrl+C |
| `tmux send-keys -t <name> Escape` | Send Escape |
| `tmux send-keys -t <name> Up` | Send ArrowUp |
| `tmux send-keys -t <name> Down` | Send ArrowDown |
| `tmux send-keys -t <name> Enter` | Send Enter |
| `tmux capture-pane -p -t <name>` | Capture current screen as text |
| `tmux capture-pane -p -t <name> -S -200` | Capture with scrollback (200 lines) |
| `tmux kill-session -t <name>` | Kill the session |
| `tmux attach -t <name>` | Connect to session (watch live) |
| `tmux attach -t <name> -r` | Connect read-only |

### Key Reference

| Key | Action | Use Case |
|-----|--------|----------|
| `T` | Cycle tier filter | Test filtering (All → S+ → S → A+ → A → A- → B+ → B → C → All) |
| `P` | Open Settings screen | Test API key config, enable/disable providers |
| `Z` | Cycle mode | Test mode switching (OpenCode CLI → Desktop → OpenClaw) |
| `R` | Sort by rank | Verify rank-based sorting |
| `Y` | Sort by tier | Verify tier-based sorting |
| `O` | Sort by origin | Verify origin-based sorting |
| `M` | Sort by model name | Verify model name sorting |
| `L` | Sort by latest ping | Verify ping sorting |
| `A` | Sort by avg ping | Verify average ping sorting |
| `S` | Sort by SWE score | Verify SWE score sorting |
| `N` | Sort by context window | Verify context window sorting |
| `H` | Sort by health/condition | Verify health-based sorting |
| `V` | Sort by verdict | Verify verdict sorting |
| `U` | Sort by uptime | Verify uptime sorting |
| `↑`/`↓` | Navigate rows | Move cursor up/down |
| `Enter` | Select model | Choose model |
| `Ctrl+C` | Exit | Quit the TUI |
| `Ctrl+P` | Command Palette | Open cmd palette |
| `Shift+P` | Probe failed rows only | Re-probe rows showing auth fail / 429 / 404 / timeout (issue #168) |
| `Ctrl+Shift+P` | Probe all models | 404/410 probe on every configured model (terminals that support the combo) |
| `Space` | Expand selected row | Toggle a 2-line provider/model detail card under the cursor row; Space again or cursor move collapses |
| `Esc` | Close modal/dialog | Close palette, settings, help |

### Example Test Flow

```bash
# 1. Spawn the TUI in a detached session
tmux new-session -d -s fcm-test "cd /Users/vava/Documents/GitHub/free-coding-models && pnpm start"

# 2. Wait for it to render, then capture
sleep 2
tmux capture-pane -p -t fcm-test

# 3. Test tier filter - press T, wait, verify
tmux send-keys -t fcm-test "T"
sleep 1
tmux capture-pane -p -t fcm-test | tail -20

# 4. Test cmd palette - Ctrl+P
tmux send-keys -t fcm-test C-p
sleep 1
tmux capture-pane -p -t fcm-test | tail -25

# 5. Close with Escape
tmux send-keys -t fcm-test Escape
sleep 1

# 6. Test navigation - scroll down
for i in {1..5}; do
  tmux send-keys -t fcm-test Down
  sleep 1
  tmux capture-pane -p -t fcm-test | tail -15
done

# 7. Connect to watch live
tmux attach -t fcm-test

# 8. Clean up
tmux kill-session -t fcm-test
```

### Watch Live While Testing

```bash
# Terminal 1: spawn and let it run
tmux new-session -d -s fcm-live "cd /path/to/project && pnpm start"

# Terminal 2: watch the live session
tmux attach -t fcm-live

# From anywhere, send keys to test while watching in Terminal 2
tmux send-keys -t fcm-live "T"  # cycle tier
tmux send-keys -t fcm-live C-p  # open palette
```

### Tips

- Use `sleep 1` after `send-keys` to let the TUI re-render before capturing
- `tmux capture-pane -p` outputs ANSI codes - pipe through `cat -v` or strip with a tool if you need clean text
- Sessions persist - you can detach (`Ctrl+b d`) and re-attach later
- Use `tmux list-sessions` to see all active sessions
- For read-only watching (no accidental input): `tmux attach -t <name> -r`

### When Should the Agent Use tmux Testing?

Use tmux when:
- **Visual Testing Needed** - Changes affect TUI rendering, layout, colors, or formatting
- **Interaction Testing** - New keypress handlers, filters, or navigation logic
- **Regression Detection** - Verify existing flows still work after code changes
- **User-Facing Features** - Settings screen, mode switching, tier filtering
- **Live Demo** - Let the user watch the TUI run in real-time

**Do NOT use tmux testing** for:
- Unit test verification (use `pnpm test` instead)
- Code-only logic changes (use tests for pure functions)
- Build errors (use `pnpm build:web` or `pnpm start`)

### Why tmux over agent-tui?

| tmux | agent-tui |
|------|-----------|
| Pre-installed on macOS | Extra npm dependency |
| Zero config | Needs daemon setup |
| `tmux send-keys` is simple | Custom CLI wrapper |
| `tmux capture-pane` is direct | Screenshot API |
| Native PTY, no latency | Additional abstraction layer |
| Sessions persist, can re-attach | Ephemeral sessions |
| Can watch live in another terminal | Must use screenshots |

---

## Changelog (MANDATORY)

**Per-version changelog files.** Every version has its own changelog file in the `changelog/` directory, named `changelog/vX.Y.Z.md` where `X.Y.Z` is the version number.

### Rules

- **Format:** Each file must start with `# Changelog vX.Y.Z - YYYY-MM-DD` followed by the release notes.
- **Location:** All changelog files live in `changelog/` - there is **no** root-level `CHANGELOG.md`.
- **Structure:** List changes under `### Added`, `### Fixed`, or `### Changed` as appropriate.
- **Content:** Check all commits, code changes, and work done since the last version to ensure the changelog is **complete**. Add clear, user-facing explanations of *why* changes were made and *how* they work.
- **Order:** Keep the structure clean so it can be reused directly in the GitHub Release notes screen.
- **Timing:** Create/update the changelog file BEFORE committing and pushing.

### Creating a new changelog file

```bash
# For version 0.3.68 released on 2026-05-20
cat > changelog/v0.3.68.md << 'EOF'
# Changelog v0.3.68 - 2026-05-20

### Added
- ...

### Changed
- ...

### Fixed
- ...
EOF
```

### Historical changelogs

All past versions (v0.1.1 through the latest) already have their changelog files in `changelog/`. They were extracted from GitHub Release notes and git commit messages. If a version's notes are missing or sparse, it means no detailed release notes were published for that version.

## Version Bump Workflow (/bump command)

When user requests `/bump`, `"push commit"`, or `"bump a new version now"`, execute this comprehensive workflow:

### 1. Check Version Status
- Check current version in `package.json`
- Check last published version: `git log --oneline | grep "^[a-f0-9]\+ [0-9]"`
- If multiple uncommitted version bumps exist, consolidate them into the next sequential version

### 2. Update Changelog
- Review all work done since the last published version
- Create a new file `changelog/vX.Y.Z.md` with the release notes for the new version
- Include comprehensive details, intentions, and explanations for all changes
- Ensure changelog is user-facing with clear bullet points
- Use the format: `# Changelog vX.Y.Z - YYYY-MM-DD` followed by `### Added`, `### Changed`, `### Fixed` sections

**⚠️ CRITICAL - Changelog = GitHub Release body:**
The content of `changelog/vX.Y.Z.md` (minus the `# Changelog vX.Y.Z - YYYY-MM-DD` header line) MUST be used as the GitHub Release body when the release is created. This is the single source of truth - the changelog file IS the release notes. Never publish a GitHub Release with empty or auto-generated notes when a changelog file exists. The CI workflow automates this (it reads `changelog/vX.Y.Z.md` and uses it as `--notes-file`), but if you create a release manually, you must copy the changelog content into the release body verbatim.

### 3. Update Documentation
- Review and update `README.md` if needed for new features/changes
- Ensure documentation reflects current functionality

### 4. Pre-Commit Verification
- Run `pnpm test` - fix any failures immediately
- Run `pnpm start` - verify no runtime errors
- Only proceed when all tests pass

### 5. Commit and Push
- Update version in `package.json` to next sequential version
- Identify the most significant change for this release
- `git add . && git commit -m "VERSION_NUMBER - EMOJI SHORT_TITLE"` (version + emoji + main feature)
- `git push origin main` - triggers GitHub Actions auto-publish

### 6. Verify npm Publication
- Poll npm registry for 5 minutes:
  ```bash
  for i in $(seq 1 30); do sleep 10; v=$(npm view free-coding-models version 2>/dev/null); echo "Attempt $i: npm version = $v"; if [ "$v" = "NEW_VERSION" ]; then echo "✅ published!"; break; fi; done
  ```

### 7. Final Verification
- `npm install -g free-coding-models@NEW_VERSION`
- `free-coding-models --help` - verify binary works globally
- Only confirm release when global npm-installed version functions correctly

**Critical:** Never skip versions - consolidate all changes into the next sequential version number.

## Tweet after Bump (MANDATORY - propose after every version bump)

After every successful `bump` (npm publish verified + `free-coding-models --help` works), the agent MUST propose a ready-to-post tweet for vava.

**Goal:** content first, zero fluff. The news starts at line 1. No funny hook, no star count, links at the very bottom.

**Structure to propose (copy-paste ready):**

```
<human hook: 1-2 sentences in your own voice, why this release exists or what annoyed you>

free-coding-models vX.Y.Z is out. What it means for you:
- <concrete user benefit 1>
- <concrete user benefit 2>
- <bonus features/features list, 1 line>

📦 github: https://github.com/vava-nessa/free-coding-models
📦 npm: https://www.npmjs.com/package/free-coding-models

#AI #Coding #OpenSource #VibeCoding #FreeLLM #freeai #codingmodels #freecodingmodels #pi #codex #claudecode
```

**Rules:**
- Open with a HUMAN hook: 1-2 sentences in your own voice (a frustration, a story, why this release exists). No standardized formula, no star count. It should read like a person, not a changelog.
- Then one line: `free-coding-models vX.Y.Z is out. What it means for you:` followed by 2 lines max of concrete user benefits (the "2/2" pitch: what it actually changes for the person reading).
- Then an optional single "also in" line for the remaining features (emoji bullets welcome but not mandatory).
- Links go at the bottom, after everything: repo link then npm link, each prefixed with 📦.
- Hashtag block is fixed: `#AI #Coding #OpenSource #VibeCoding #FreeLLM #freeai #codingmodels #freecodingmodels #pi #codex #claudecode`.
- Keep total tweet under ~600 chars so it fits in one X post with line breaks. No em dash "-" ever.
- Propose it automatically, don't wait for vava to ask. Show it in a code block ready to copy.

**Example for v0.5.84:**

```
free-coding-models v0.5.84 is live!

what's new ?
- 🔍 full audit: 28 dead models removed, 42 fresh ones added (225 total)
- 🚀 Kilo gateway: 2 to 19 free coding models
- 🧠 new Qwen3.8 family + GLM-5.3, all 1M ctx
- 🪦 37 context windows fixed against live APIs
- 🐛 router tests updated after NVIDIA killed gpt-oss-120b

📦 github: https://github.com/vava-nessa/free-coding-models
📦 npm: https://www.npmjs.com/package/free-coding-models

#AI #Coding #OpenSource #VibeCoding #FreeLLM #freeai #codingmodels #freecodingmodels #pi #codex #claudecode
```


This project uses Kandown. Before task work, run `kandown work` and follow its output. <!-- kandown:agent-ref -->
## Task management

This project uses **kandown** for task management. **Always run `kandown work` when starting a new task** - it prints the current rules and board state, kept in sync with the installed CLI version. (Tasks live in `./tasks/*.md`.)

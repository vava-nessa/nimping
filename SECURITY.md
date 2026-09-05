# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| Latest release | ✅ |
| Older versions | ❌ |

We only provide security fixes for the latest published version.

## Reporting a Vulnerability

**Thank you for helping keep this project safe.**

- **Preferred:** Open a private advisory via [GitHub Security Advisories](https://github.com/vava-nessa/free-coding-models/security/advisories/new)
- **Alternative:** Email the maintainer directly via [GitHub profile](https://github.com/vava-nessa)

Please do **not** disclose security vulnerabilities publicly (issues, discussions, social media) before a fix is released.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Affected version(s)
- Potential impact
- Suggested fix (if you have one)

### Response timeline

- **Acknowledgment:** within 48 hours
- **Initial assessment:** within 5 business days
- **Fix target:** within 30 days (critical issues prioritized)

## Security Architecture

### What this tool does

`free-coding-models` is a CLI tool that:

1. Pings AI model API endpoints to measure latency
2. Writes model configuration to supported coding tool config files
3. Stores API keys locally in the user's home directory

### What this tool does NOT do

- ❌ Does **not** collect, transmit, or store source code
- ❌ Does **not** send prompts or completions to any server we operate
- ❌ Does **not** execute arbitrary code from remote servers
- ❌ Does **not** require root/admin privileges
- ❌ Does **not** access files outside of:
  - `~/.config/opencode/` (OpenCode config)
  - `~/.openclaw/` (OpenClaw config)
  - `~/.crush/` (Crush config)
  - `~/.config/goose/` (Goose config)
  - `~/.aider.conf.yml` (Aider config)
  - `~/.config/openhands/` (OpenHands config)
  - `~/.config/amp/` (Amp config)
  - `~/.pi/` (Pi config)
  - Tool-specific config directories (only when explicitly requested)

### API keys

- API keys are stored **locally only** in `~/.free-coding-models.json` (the single config file: keys, provider toggles, favorites, settings, router config)
- Keys are **never** sent to any server except the matching provider API endpoint
- Keys are **never** logged, printed in plaintext, or included in telemetry
- Config file has restrictive permissions (user-only readable, `0600`)

### Network activity

The tool makes HTTPS requests **only** to:

| Purpose | Endpoints |
| ------- | --------- |
| Model APIs | Provider API endpoints (listed in sources.js) |
| npm registry | `registry.npmjs.org` (version check only) |
| Telemetry | Anonymous usage stats (no personal info, no keys, no code) |

No other outbound network connections are made.

### Dependencies

Dependencies stay minimal and are all pure JavaScript (no native build step):

- `chalk` - terminal colors for the CLI/TUI
- `socket.io` / `socket.io-client` - realtime updates for the optional Web Dashboard
- `@tanstack/react-table`, `@tanstack/react-virtual`, `@tabler/icons-react` - web dashboard UI

Minimal dependency surface = minimal attack surface.

## Supply Chain Security

| Feature | Status |
| ------- | ------ |
| npm Provenance (Sigstore) | ✅ Published with provenance |
| Signed artifacts | ✅ Sigstore-signed via GitHub Actions |
| SBOM | ✅ Generated per release |
| Lockfile committed | ✅ `pnpm-lock.yaml` |
| Automated dependency audit | ✅ CI runs `npm audit` |
| Branch protection | ✅ `main` branch protected |
| CODEOWNERS | ✅ Required for all changes |
| Dependabot | ✅ Automated dependency updates |
| OpenSSF Scorecard | ✅ Tracked |

## Attribution

Security policy template adapted from [OpenSSF Best Practices](https://openssf.org/best-practices-badge/) and [GitHub Security Hardening](https://docs.github.com/en/code-security).

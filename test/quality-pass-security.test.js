// 📖 Security + reliability fixes quality pass:
//   - isTelemetryEnabled now honors the persisted config opt-out (telemetry.enabled=false)
//     while CLI flags and FREE_CODING_MODELS_TELEMETRY still override it.
//   - shellSingleQuote keeps API keys literal in sourced env files (quotes, $(), backticks).
//   - ENV_VAR_NAMES covers every provider whose OpenCode/Kilo config references {env:VAR}.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isTelemetryEnabled } from '../src/core/telemetry.js'
import { shellSingleQuote } from '../src/core/shared-helpers.js'
import { ENV_VAR_NAMES } from '../src/core/provider-metadata.js'

// ─── isTelemetryEnabled (config opt-out now honored) ─────────────────────────

function withTelemetryEnv(value, fn) {
  const previous = process.env.FREE_CODING_MODELS_TELEMETRY
  if (value === undefined) delete process.env.FREE_CODING_MODELS_TELEMETRY
  else process.env.FREE_CODING_MODELS_TELEMETRY = value
  try {
    fn()
  } finally {
    if (previous === undefined) delete process.env.FREE_CODING_MODELS_TELEMETRY
    else process.env.FREE_CODING_MODELS_TELEMETRY = previous
  }
}

test('isTelemetryEnabled: config telemetry.enabled=false opts out', () => {
  withTelemetryEnv(undefined, () => {
    assert.equal(isTelemetryEnabled({ telemetry: { enabled: false } }, {}), false)
  })
})

test('isTelemetryEnabled: config without telemetry shape defaults to enabled', () => {
  withTelemetryEnv(undefined, () => {
    assert.equal(isTelemetryEnabled({}, {}), true)
  })
})

test('isTelemetryEnabled: env var 1 overrides a config opt-out', () => {
  withTelemetryEnv('1', () => {
    assert.equal(isTelemetryEnabled({ telemetry: { enabled: false } }, {}), true)
  })
})

test('isTelemetryEnabled: env var 0 disables telemetry even when config is enabled', () => {
  withTelemetryEnv('0', () => {
    assert.equal(isTelemetryEnabled({ telemetry: { enabled: true } }, {}), false)
  })
})

test('isTelemetryEnabled: CLI --no-telemetry flag wins over everything', () => {
  withTelemetryEnv('1', () => {
    assert.equal(isTelemetryEnabled({ telemetry: { enabled: true } }, { noTelemetry: true }), false)
  })
})

// ─── shellSingleQuote (env file escaping) ────────────────────────────────────

test('shellSingleQuote: plain value is wrapped in single quotes', () => {
  assert.equal(shellSingleQuote('sk-abc123'), `'sk-abc123'`)
})

test('shellSingleQuote: embedded single quote is POSIX-escaped', () => {
  assert.equal(shellSingleQuote(`pass'word`), `'pass'\\''word'`)
})

test('shellSingleQuote: double quotes and dollars stay literal', () => {
  const evil = `he"llo $(rm -rf /) \`id\` world`
  const escaped = shellSingleQuote(evil)
  // 📖 Whole value wrapped in single quotes: $, `, and " are inert to the shell.
  assert.ok(escaped.startsWith("'") && escaped.endsWith("'"))
  assert.equal(escaped, `'he"llo $(rm -rf /) \`id\` world'`)
})

test('shellSingleQuote: escaped value survives a real sh source round-trip', () => {
  // 📖 End-to-end proof: sourcing a file that exports the escaped key must
  // 📖 yield the original literal value. Skipped where /bin/sh is unavailable.
  if (process.platform === 'win32') return
  const secret = `p@ss'w0rd "$(whoami)" $(echo pwned)`
  const dir = mkdtempSync(join(tmpdir(), 'fcm-shell-escape-'))
  try {
    const envFile = join(dir, 'env.sh')
    writeFileSync(envFile, `export OPENAI_API_KEY=${shellSingleQuote(secret)}\n`)
    const result = spawnSync('/bin/sh', ['-c', `. '${envFile}' && printf '%s' "$OPENAI_API_KEY"`], { encoding: 'utf8' })
    assert.equal(result.status, 0, `sh failed: ${result.stderr}`)
    assert.equal(result.stdout, secret)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── ENV_VAR_NAMES completeness ──────────────────────────────────────────────

test('ENV_VAR_NAMES: entries exist for all {env:VAR} config writers', () => {
  // 📖 These names must match the provider tables in opencode.js / kilo.js exactly.
  const expected = {
    huggingface: 'HUGGINGFACE_API_KEY',
    deepinfra: 'DEEPINFRA_API_KEY',
    fireworks: 'FIREWORKS_API_KEY',
    together: 'TOGETHER_API_KEY',
    hyperbolic: 'HYPERBOLIC_API_KEY',
    perplexity: 'PERPLEXITY_API_KEY',
    chutes: 'CHUTES_API_KEY',
    iflow: 'IFLOW_API_KEY',
  }
  for (const [providerKey, envName] of Object.entries(expected)) {
    assert.equal(ENV_VAR_NAMES[providerKey], envName, `ENV_VAR_NAMES[${providerKey}] must be ${envName}`)
  }
})

test('ENV_VAR_NAMES: every value is a SCREAMING_SNAKE env var name', () => {
  for (const [providerKey, envName] of Object.entries(ENV_VAR_NAMES)) {
    assert.match(envName, /^[A-Z][A-Z0-9_]*$/, `${providerKey} -> ${envName} is not a valid env var name`)
  }
})

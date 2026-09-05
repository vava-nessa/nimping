/**
 * @file opencode.js
 * @description OpenCode integration helpers for direct launches and Desktop setup.
 *
 * @details
 *   This module owns all OpenCode-related behavior:
 *   - Configure opencode.json with selected models/providers
 *   - Launch OpenCode CLI or Desktop
 *   - Manage ZAI proxy bridge for non-standard API paths
 *
 *   🎯 Key features:
 *   - Provider-aware config setup for OpenCode (NIM, Groq, Cerebras, etc.)
 *   - ZAI proxy bridge to rewrite /v1/* → /api/coding/paas/v4/*
 *   - Auto-pick tmux port for OpenCode sub-agents
 *
 *   → Functions:
 *   - `setOpenCodeModelData` — Keep shared merged model references available
 *   - `startOpenCode` — Launch OpenCode CLI with selected model
 *   - `startOpenCodeDesktop` — Set model and open Desktop app
 *
 *   @see src/opencode-config.js — shared OpenCode config read/write helpers
 */

import chalk from 'chalk'
import { createServer } from 'net'
import { createServer as createHttpServer } from 'http'
import { request as httpsRequest } from 'https'
import { homedir } from 'os'
import { join } from 'path'
import { copyFileSync, existsSync } from 'fs'
import { PROVIDER_COLOR } from '../tui/render-table.js'
import { sources } from '../../sources.js'
import { loadOpenCodeConfig, saveOpenCodeConfig } from './opencode-config.js'
import { getApiKey } from './config.js'
import { ENV_VAR_NAMES, OPENCODE_MODEL_MAP, isWindows, isMac, isLinux } from './provider-metadata.js'
import { resolveToolBinaryPath } from './tool-bootstrap.js'

// 📖 OpenCode config location: ~/.config/opencode/opencode.json on ALL platforms.
// 📖 OpenCode uses xdg-basedir which resolves to %USERPROFILE%\.config on Windows.
const OPENCODE_CONFIG = join(homedir(), '.config', 'opencode', 'opencode.json')
const OPENCODE_PORT_RANGE_START = 4096
const OPENCODE_PORT_RANGE_END = 5096

// 📖 Keep merged model references available for future OpenCode-related features.
let mergedModelsRef = []
let mergedModelByLabelRef = new Map()

// 📖 setOpenCodeModelData: Provide mergedModels + mergedModelByLabel to this module.
export function setOpenCodeModelData(mergedModels, mergedModelByLabel) {
  mergedModelsRef = Array.isArray(mergedModels) ? mergedModels : []
  mergedModelByLabelRef = mergedModelByLabel instanceof Map ? mergedModelByLabel : new Map()
}

// 📖 isTcpPortAvailable: checks if a local TCP port is free for OpenCode.
// 📖 Used to avoid tmux sub-agent port conflicts when multiple projects run in parallel.
function isTcpPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port)
  })
}

// 📖 resolveOpenCodeTmuxPort: selects a safe port for OpenCode when inside tmux.
// 📖 Priority:
// 📖 1) OPENCODE_PORT from env (if valid and available)
// 📖 2) First available port in 4096-5095
async function resolveOpenCodeTmuxPort() {
  const envPortRaw = process.env.OPENCODE_PORT
  const envPort = Number.parseInt(envPortRaw || '', 10)

  if (Number.isInteger(envPort) && envPort > 0 && envPort <= 65535) {
    if (await isTcpPortAvailable(envPort)) {
      return { port: envPort, source: 'env' }
    }
    console.log(chalk.yellow(`  ⚠ OPENCODE_PORT=${envPort} is already in use; selecting another port for this run.`))
  }

  for (let port = OPENCODE_PORT_RANGE_START; port < OPENCODE_PORT_RANGE_END; port++) {
    if (await isTcpPortAvailable(port)) {
      return { port, source: 'auto' }
    }
  }

  return null
}

function getOpenCodeConfigPath() {
  return OPENCODE_CONFIG
}

// 📖 Map source model IDs to OpenCode built-in IDs when they differ.
function getOpenCodeModelId(providerKey, modelId) {
  if (providerKey === 'nvidia') return modelId.replace(/^nvidia\//, '')
  if (providerKey === 'zai') return modelId.replace(/^zai\//, '')
  return OPENCODE_MODEL_MAP[providerKey]?.[modelId] || modelId
}

function buildOpenAiCompatibleProviderConfig(providerKey) {
  const source = sources[providerKey]
  const envVarName = ENV_VAR_NAMES[providerKey]
  if (!source?.url || !envVarName) return null
  const baseURL = source.url
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/responses$/i, '')
  return {
    npm: '@ai-sdk/openai-compatible',
    name: source.name || providerKey,
    options: { baseURL, apiKey: `{env:${envVarName}}` },
    models: {},
  }
}

// ─── ZAI proxy bridge ─────────────────────────────────────────────────────────

// 📖 createZaiProxy: Localhost reverse proxy bridging ZAI's non-standard API paths
// 📖 to OpenCode's expected /v1/* OpenAI-compatible format.
// 📖 Returns { server, port } — caller must server.close() when done.
async function createZaiProxy(apiKey) {
  const server = createHttpServer((req, res) => {
    let targetPath = req.url
    // 📖 Rewrite /v1/* → /api/coding/paas/v4/*
    if (targetPath.startsWith('/v1/')) {
      targetPath = '/api/coding/paas/v4/' + targetPath.slice(4)
    } else if (targetPath.startsWith('/v1')) {
      targetPath = '/api/coding/paas/v4' + targetPath.slice(3)
    } else {
      // 📖 Non /v1 paths (e.g. /api/v0/ health checks) — reject
      res.writeHead(404)
      res.end()
      return
    }
    const headers = { ...req.headers, host: 'api.z.ai' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    // 📖 Remove transfer-encoding to avoid chunked encoding issues with https.request
    delete headers['transfer-encoding']
    const proxyReq = httpsRequest({
      hostname: 'api.z.ai',
      port: 443,
      path: targetPath,
      method: req.method,
      headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res)
    })
    proxyReq.on('error', () => { res.writeHead(502); res.end() })
    req.pipe(proxyReq)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port }
}

// ─── Shared OpenCode spawn helper ─────────────────────────────────────────────

// 📖 spawnOpenCode: Resolve API keys + spawn opencode CLI with correct env.
async function spawnOpenCode(args, providerKey, fcmConfig, existingZaiProxy = null) {
  const envVarName = ENV_VAR_NAMES[providerKey]
  const resolvedKey = getApiKey(fcmConfig, providerKey)
  const childEnv = { ...process.env }
  // 📖 Suppress MaxListenersExceededWarning from @modelcontextprotocol/sdk
  childEnv.NODE_NO_WARNINGS = '1'
  const finalArgs = [...args]
  const hasExplicitPortArg = finalArgs.includes('--port')
  if (envVarName && resolvedKey) childEnv[envVarName] = resolvedKey

  // 📖 ZAI proxy: OpenCode's Go binary doesn't know about ZAI as a provider.
  // 📖 Start proxy if needed, or reuse existing proxy if passed in.
  let zaiProxy = existingZaiProxy
  if (providerKey === 'zai' && resolvedKey && !zaiProxy) {
    const { server, port } = await createZaiProxy(resolvedKey)
    zaiProxy = server
    console.log(chalk.dim(`  🔀 ZAI proxy listening on port ${port} (rewrites /v1/* → ZAI API)`))
  }

  // 📖 In tmux, OpenCode sub-agents need a listening port to open extra panes.
  if (process.env.TMUX && !hasExplicitPortArg) {
    const tmuxPort = await resolveOpenCodeTmuxPort()
    if (tmuxPort) {
      const portValue = String(tmuxPort.port)
      childEnv.OPENCODE_PORT = portValue
      finalArgs.push('--port', portValue)
      if (tmuxPort.source === 'env') {
        console.log(chalk.dim(`  📺 tmux detected — using OPENCODE_PORT=${portValue}.`))
      } else {
        console.log(chalk.dim(`  📺 tmux detected — using OpenCode port ${portValue} for sub-agent panes.`))
      }
    } else {
      console.log(chalk.yellow(`  ⚠ tmux detected but no free OpenCode port found in ${OPENCODE_PORT_RANGE_START}-${OPENCODE_PORT_RANGE_END - 1}; launching without --port.`))
    }
  }

  const { spawn } = await import('child_process')
  const child = spawn(resolveToolBinaryPath('opencode') || 'opencode', finalArgs, {
    stdio: 'inherit',
    // 📖 Windows keeps a shell because npm-installed CLIs resolve to .cmd shims;
    // 📖 everywhere else the resolved absolute binary path is spawned directly.
    shell: isWindows,
    detached: false,
    env: childEnv
  })

  return new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      if (zaiProxy) zaiProxy.close()
      // 📖 ZAI cleanup: remove the ephemeral proxy provider from opencode.json
      if (providerKey === 'zai') {
        try {
          const cfg = loadOpenCodeConfig()
          if (cfg.provider?.zai) delete cfg.provider.zai
          if (typeof cfg.model === 'string' && cfg.model.startsWith('zai/')) delete cfg.model
          saveOpenCodeConfig(cfg)
        } catch { /* best-effort cleanup */ }
      }
      resolve(code)
    })
    child.on('error', (err) => {
      if (zaiProxy) zaiProxy.close()
      if (err.code === 'ENOENT') {
        console.error(chalk.red('\n  X Could not find "opencode" -- is it installed and in your PATH?'))
        console.error(chalk.dim('    Install: npm i -g opencode-ai   or see https://opencode.ai'))
        resolve(1)
      } else {
        reject(err)
      }
    })
  })
}

// ─── Start OpenCode CLI ───────────────────────────────────────────────────────

export async function startOpenCode(model, fcmConfig) {
  const providerKey = model.providerKey ?? 'nvidia'
  const ocModelId = getOpenCodeModelId(providerKey, model.modelId)
  const modelRef = `${providerKey}/${ocModelId}`

  if (providerKey === 'nvidia') {
    const config = loadOpenCodeConfig()
    const backupPath = `${getOpenCodeConfigPath()}.backup-${Date.now()}`

    if (existsSync(getOpenCodeConfigPath())) {
      copyFileSync(getOpenCodeConfigPath(), backupPath)
      console.log(chalk.dim(`  Backup: ${backupPath}`))
    }

    if (!config.provider) config.provider = {}
    if (!config.provider.nvidia) {
      config.provider.nvidia = {
        npm: '@ai-sdk/openai-compatible',
        name: 'NVIDIA NIM',
        options: {
          baseURL: 'https://integrate.api.nvidia.com/v1',
          apiKey: '{env:NVIDIA_API_KEY}'
        },
        models: {}
      }
      // 📖 Color provider name the same way as in the main table
      const providerRgb = PROVIDER_COLOR['nvidia'] ?? [105, 190, 245]
      const coloredNimName = chalk.bold.rgb(...providerRgb)('NVIDIA NIM')
      console.log(chalk.green(`  + Auto-configured ${coloredNimName} provider in OpenCode`))
    }

    console.log(chalk.green(`  Setting ${chalk.bold(model.label)} as default...`))
    console.log(chalk.dim(`  Model: ${modelRef}`))
    console.log()

    config.model = modelRef
    if (!config.provider.nvidia.models) config.provider.nvidia.models = {}
    config.provider.nvidia.models[ocModelId] = { name: model.label }

    saveOpenCodeConfig(config)

    const savedConfig = loadOpenCodeConfig()
    console.log(chalk.dim(`  Config saved to: ${getOpenCodeConfigPath()}`))
    console.log(chalk.dim(`  Default model in config: ${savedConfig.model || 'NOT SET'}`))
    console.log()

    if (savedConfig.model === config.model) {
      console.log(chalk.green(`  Default model set to: ${modelRef}`))
    } else {
      console.log(chalk.yellow(`  Config might not have been saved correctly`))
    }
    console.log()
    console.log(chalk.dim('  Starting OpenCode...'))
    console.log()

    await spawnOpenCode(['--model', modelRef], providerKey, fcmConfig)
    return
  }

  if (providerKey === 'replicate') {
    console.log(chalk.yellow('  Replicate models are monitor-only for now in OpenCode mode.'))
    console.log(chalk.dim('    Reason: Replicate uses /v1/predictions instead of OpenAI chat-completions.'))
    console.log(chalk.dim('    You can still benchmark this model in the TUI and use other providers for OpenCode launch.'))
    console.log()
    return
  }

  if (providerKey === 'zai') {
    const resolvedKey = getApiKey(fcmConfig, providerKey)
    if (!resolvedKey) {
      console.log(chalk.yellow('  ZAI API key not found. Set ZAI_API_KEY environment variable.'))
      console.log()
      return
    }

    const { server: zaiProxyServer, port: zaiProxyPort } = await createZaiProxy(resolvedKey)
    console.log(chalk.dim(`  ZAI proxy listening on port ${zaiProxyPort} (rewrites /v1/* -> ZAI API)`))

    console.log(chalk.green(`  Setting ${chalk.bold(model.label)} as default...`))
    console.log(chalk.dim(`  Model: ${modelRef}`))
    console.log()

    const config = loadOpenCodeConfig()
    const backupPath = `${getOpenCodeConfigPath()}.backup-${Date.now()}`

    if (existsSync(getOpenCodeConfigPath())) {
      copyFileSync(getOpenCodeConfigPath(), backupPath)
      console.log(chalk.dim(`  Backup: ${backupPath}`))
    }

    if (!config.provider) config.provider = {}
    config.provider.zai = {
      npm: '@ai-sdk/openai-compatible',
      name: 'ZAI',
      options: {
        baseURL: `http://127.0.0.1:${zaiProxyPort}/v1`,
        apiKey: 'zai-proxy',
      },
      models: {}
    }
    config.provider.zai.models[ocModelId] = { name: model.label }
    config.model = modelRef

    saveOpenCodeConfig(config)

    const savedConfig = loadOpenCodeConfig()
    console.log(chalk.dim(`  Config saved to: ${getOpenCodeConfigPath()}`))
    console.log(chalk.dim(`  Default model in config: ${savedConfig.model || 'NOT SET'}`))
    console.log()

    if (savedConfig.model === config.model) {
      console.log(chalk.green(`  Default model set to: ${modelRef}`))
    } else {
      console.log(chalk.yellow(`  Config might not have been saved correctly`))
    }
    console.log()
    console.log(chalk.dim('  Starting OpenCode...'))
    console.log()

    await spawnOpenCode(['--model', modelRef], providerKey, fcmConfig, zaiProxyServer)
    return
  }

  // 📖 Zen models are built-in to OpenCode — they use the native `opencode` provider prefix
  // 📖 and don't need a custom provider entry in opencode.json.
  if (providerKey === 'opencode-zen') {
    const zenModelRef = `opencode/${ocModelId}`
    console.log(chalk.green(`  Setting ${chalk.bold(model.label)} as default (Zen built-in)...`))
    console.log(chalk.dim(`  Model: ${zenModelRef}`))
    console.log()

    const config = loadOpenCodeConfig()
    const backupPath = `${getOpenCodeConfigPath()}.backup-${Date.now()}`

    if (existsSync(getOpenCodeConfigPath())) {
      copyFileSync(getOpenCodeConfigPath(), backupPath)
      console.log(chalk.dim(`  Backup: ${backupPath}`))
    }

    config.model = zenModelRef
    saveOpenCodeConfig(config)

    const savedConfig = loadOpenCodeConfig()
    console.log(chalk.dim(`  Config saved to: ${getOpenCodeConfigPath()}`))
    console.log(chalk.dim(`  Default model in config: ${savedConfig.model || 'NOT SET'}`))
    console.log()

    if (savedConfig.model === config.model) {
      console.log(chalk.green(`  Default model set to: ${zenModelRef}`))
    } else {
      console.log(chalk.yellow(`  Config might not have been saved correctly`))
    }
    console.log()

    await spawnOpenCode(['--model', zenModelRef], providerKey, fcmConfig)
    return
  }

  console.log(chalk.green(`  Setting ${chalk.bold(model.label)} as default...`))
  console.log(chalk.dim(`  Model: ${modelRef}`))
  console.log()

  const config = loadOpenCodeConfig()
  const backupPath = `${getOpenCodeConfigPath()}.backup-${Date.now()}`

  if (existsSync(getOpenCodeConfigPath())) {
    copyFileSync(getOpenCodeConfigPath(), backupPath)
    console.log(chalk.dim(`  Backup: ${backupPath}`))
  }

  if (!config.provider) config.provider = {}
  if (!config.provider[providerKey]) {
    if (providerKey === 'groq') {
      config.provider.groq = { options: { apiKey: '{env:GROQ_API_KEY}' }, models: {} }
    } else if (providerKey === 'cerebras') {
      config.provider.cerebras = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Cerebras',
        options: { baseURL: 'https://api.cerebras.ai/v1', apiKey: '{env:CEREBRAS_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'sambanova') {
      config.provider.sambanova = {
        npm: '@ai-sdk/openai-compatible',
        name: 'SambaNova',
        options: { baseURL: 'https://api.sambanova.ai/v1', apiKey: '{env:SAMBANOVA_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'openrouter') {
      config.provider.openrouter = {
        npm: '@ai-sdk/openai-compatible',
        name: 'OpenRouter',
        options: { baseURL: 'https://openrouter.ai/api/v1', apiKey: '{env:OPENROUTER_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'orcarouter') {
      config.provider.orcarouter = {
        npm: '@ai-sdk/openai-compatible',
        name: 'OrcaRouter',
        options: { baseURL: 'https://api.orcarouter.ai/v1', apiKey: '{env:ORCAROUTER_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'vercel-gateway') {
      config.provider['vercel-gateway'] = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Vercel AI Gateway',
        options: { baseURL: 'https://ai-gateway.vercel.sh/v1', apiKey: '{env:VERCEL_AI_GATEWAY_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'huggingface') {
      config.provider.huggingface = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Hugging Face Inference',
        options: { baseURL: 'https://router.huggingface.co/v1', apiKey: '{env:HUGGINGFACE_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'deepinfra') {
      config.provider.deepinfra = {
        npm: '@ai-sdk/openai-compatible',
        name: 'DeepInfra',
        options: { baseURL: 'https://api.deepinfra.com/v1/openai', apiKey: '{env:DEEPINFRA_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'fireworks') {
      config.provider.fireworks = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Fireworks AI',
        options: { baseURL: 'https://api.fireworks.ai/inference/v1', apiKey: '{env:FIREWORKS_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'codestral') {
      config.provider.codestral = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Mistral Codestral',
        options: { baseURL: 'https://api.mistral.ai/v1', apiKey: '{env:MISTRAL_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'hyperbolic') {
      config.provider.hyperbolic = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Hyperbolic',
        options: { baseURL: 'https://api.hyperbolic.xyz/v1', apiKey: '{env:HYPERBOLIC_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'scaleway') {
      config.provider.scaleway = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Scaleway',
        options: { baseURL: 'https://api.scaleway.ai/v1', apiKey: '{env:SCALEWAY_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'googleai') {
      config.provider.googleai = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Google AI Studio',
        options: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '{env:GOOGLE_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'siliconflow') {
      config.provider.siliconflow = {
        npm: '@ai-sdk/openai-compatible',
        name: 'SiliconFlow',
        options: { baseURL: 'https://api.siliconflow.cn/v1', apiKey: '{env:SILICONFLOW_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'together') {
      config.provider.together = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Together AI',
        options: { baseURL: 'https://api.together.xyz/v1', apiKey: '{env:TOGETHER_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'cloudflare') {
      const cloudflareAccountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim()
      if (!cloudflareAccountId) {
        console.log(chalk.yellow('  Cloudflare Workers AI requires CLOUDFLARE_ACCOUNT_ID for OpenCode integration.'))
        console.log(chalk.dim('    Export CLOUDFLARE_ACCOUNT_ID and retry this selection.'))
        console.log()
        return
      }
      config.provider.cloudflare = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Cloudflare Workers AI',
        options: { baseURL: `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/ai/v1`, apiKey: '{env:CLOUDFLARE_API_TOKEN}' },
        models: {}
      }
    } else if (providerKey === 'perplexity') {
      config.provider.perplexity = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Perplexity API',
        options: { baseURL: 'https://api.perplexity.ai', apiKey: '{env:PERPLEXITY_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'iflow') {
      config.provider.iflow = {
        npm: '@ai-sdk/openai-compatible',
        name: 'iFlow',
        options: { baseURL: 'https://apis.iflow.cn/v1', apiKey: '{env:IFLOW_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'chutes') {
      config.provider.chutes = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Chutes AI',
        options: { baseURL: 'https://chutes.ai/v1', apiKey: '{env:CHUTES_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'ovhcloud') {
      config.provider.ovhcloud = {
        npm: '@ai-sdk/openai-compatible',
        name: 'OVHcloud AI',
        options: { baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', apiKey: '{env:OVH_AI_ENDPOINTS_ACCESS_TOKEN}' },
        models: {}
      }
    } else {
      const providerConfig = buildOpenAiCompatibleProviderConfig(providerKey)
      if (providerConfig) config.provider[providerKey] = providerConfig
    }
  }

  const isBuiltinMapped = OPENCODE_MODEL_MAP[providerKey]?.[model.modelId]
  if (!isBuiltinMapped) {
    if (!config.provider[providerKey].models) config.provider[providerKey].models = {}
    config.provider[providerKey].models[ocModelId] = { name: model.label }
  }

  config.model = modelRef
  saveOpenCodeConfig(config)

  const savedConfig = loadOpenCodeConfig()
  console.log(chalk.dim(`  Config saved to: ${getOpenCodeConfigPath()}`))
  console.log(chalk.dim(`  Default model in config: ${savedConfig.model || 'NOT SET'}`))
  console.log()

  if (savedConfig.model === config.model) {
    console.log(chalk.green(`  Default model set to: ${modelRef}`))
  } else {
    console.log(chalk.yellow(`  Config might not have been saved correctly`))
  }
  console.log()
  console.log(chalk.dim('  Starting OpenCode...'))
  console.log()

  await spawnOpenCode(['--model', modelRef], providerKey, fcmConfig)
}

// ─── Start OpenCode Web ───────────────────────────────────────────────────────

export async function startOpenCodeWeb(model, fcmConfig) {
  const providerKey = model.providerKey ?? 'nvidia'
  const ocModelId = getOpenCodeModelId(providerKey, model.modelId)
  const modelRef = `${providerKey}/${ocModelId}`

  console.log(chalk.green(`  Setting ${chalk.bold(model.label)} as default...`))
  console.log(chalk.dim(`  Model: ${modelRef}`))
  console.log()

  const config = loadOpenCodeConfig()
  const backupPath = `${getOpenCodeConfigPath()}.backup-${Date.now()}`

  if (existsSync(getOpenCodeConfigPath())) {
    copyFileSync(getOpenCodeConfigPath(), backupPath)
    console.log(chalk.dim(`  Backup: ${backupPath}`))
  }

  if (!config.provider) config.provider = {}
  
  // 📖 Provider-specific config setup (same as CLI/Desktop)
  if (providerKey === 'nvidia' && !config.provider.nvidia) {
    config.provider.nvidia = {
      npm: '@ai-sdk/openai-compatible',
      name: 'NVIDIA NIM',
      options: { baseURL: 'https://integrate.api.nvidia.com/v1', apiKey: '{env:NVIDIA_API_KEY}' },
      models: {}
    }
  } else if (providerKey === 'groq' && !config.provider.groq) {
    config.provider.groq = { options: { apiKey: '{env:GROQ_API_KEY}' }, models: {} }
  } else if (providerKey === 'cerebras' && !config.provider.cerebras) {
    config.provider.cerebras = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Cerebras',
      options: { baseURL: 'https://api.cerebras.ai/v1', apiKey: '{env:CEREBRAS_API_KEY}' },
      models: {}
    }
  }
  // ... other providers are handled as they are selected
  
  if (providerKey !== 'opencode-zen' && config.provider[providerKey]) {
    if (!config.provider[providerKey].models) config.provider[providerKey].models = {}
    config.provider[providerKey].models[ocModelId] = { name: model.label }
  }

  config.model = providerKey === 'opencode-zen' ? `opencode/${ocModelId}` : modelRef
  saveOpenCodeConfig(config)

  console.log(chalk.dim(`  Config saved to: ${getOpenCodeConfigPath()}`))
  console.log(chalk.dim('  Starting OpenCode Web...'))
  console.log()

  await spawnOpenCode(['web', '--model', modelRef], providerKey, fcmConfig)
}

// ─── Start OpenCode Desktop ───────────────────────────────────────────────────

export async function startOpenCodeDesktop(model, fcmConfig) {
  const providerKey = model.providerKey ?? 'nvidia'
  const ocModelId = getOpenCodeModelId(providerKey, model.modelId)
  const modelRef = `${providerKey}/${ocModelId}`

  const printDesktopLaunchError = () => {
    console.error(chalk.red('  Could not open OpenCode Desktop'))
    if (isWindows) {
      console.error(chalk.dim('    Make sure OpenCode is installed from https://opencode.ai'))
    } else if (isLinux) {
      console.error(chalk.dim('    Install via: snap install opencode OR flatpak install ai.opencode.OpenCode'))
      console.error(chalk.dim('    Or download from https://opencode.ai'))
    } else {
      console.error(chalk.dim('    Is it installed at /Applications/OpenCode.app?'))
    }
  }

  const launchDesktop = async () => {
    // 📖 Linux: try each launcher directly (shell:false) so modelRef is never
    // 📖 interpolated into a shell command string. The final candidate opens the
    // 📖 .desktop entry without a model argument.
    if (isLinux) {
      const { execFile } = await import('child_process')
      const tryExecFile = (cmd, args) => new Promise((resolve) => {
        execFile(cmd, args, (err) => resolve(!err))
      })
      const launched =
        (await tryExecFile('opencode-desktop', ['--model', modelRef])) ||
        (await tryExecFile('flatpak', ['run', 'ai.opencode.OpenCode', '--model', modelRef])) ||
        (await tryExecFile('snap', ['run', 'opencode', '--model', modelRef])) ||
        (await tryExecFile('xdg-open', ['/usr/share/applications/opencode.desktop']))
      if (!launched) printDesktopLaunchError()
      return
    }

    const { exec } = await import('child_process')
    let command
    if (isMac) {
      command = 'open -a OpenCode'
    } else if (isWindows) {
      command = 'start "" "%LOCALAPPDATA%\\Programs\\OpenCode\\OpenCode.exe" 2>nul || start "" "%PROGRAMFILES%\\OpenCode\\OpenCode.exe" 2>nul || start OpenCode'
    }
    exec(command, (err) => {
      if (err) printDesktopLaunchError()
    })
  }

  if (providerKey === 'nvidia') {
    const config = loadOpenCodeConfig()
    const backupPath = `${getOpenCodeConfigPath()}.backup-${Date.now()}`

    if (existsSync(getOpenCodeConfigPath())) {
      copyFileSync(getOpenCodeConfigPath(), backupPath)
      console.log(chalk.dim(`  Backup: ${backupPath}`))
    }

    if (!config.provider) config.provider = {}
    if (!config.provider.nvidia) {
      config.provider.nvidia = {
        npm: '@ai-sdk/openai-compatible',
        name: 'NVIDIA NIM',
        options: {
          baseURL: 'https://integrate.api.nvidia.com/v1',
          apiKey: '{env:NVIDIA_API_KEY}'
        },
        models: {}
      }
      // 📖 Color provider name the same way as in the main table
      const providerRgb = PROVIDER_COLOR['nvidia'] ?? [105, 190, 245]
      const coloredNimName = chalk.bold.rgb(...providerRgb)('NVIDIA NIM')
      console.log(chalk.green(`  + Auto-configured ${coloredNimName} provider in OpenCode`))
    }

    console.log(chalk.green(`  Setting ${chalk.bold(model.label)} as default for OpenCode Desktop...`))
    console.log(chalk.dim(`  Model: ${modelRef}`))
    console.log()

    config.model = modelRef
    if (!config.provider.nvidia.models) config.provider.nvidia.models = {}
    config.provider.nvidia.models[ocModelId] = { name: model.label }

    saveOpenCodeConfig(config)

    const savedConfig = loadOpenCodeConfig()
    console.log(chalk.dim(`  Config saved to: ${getOpenCodeConfigPath()}`))
    console.log(chalk.dim(`  Default model in config: ${savedConfig.model || 'NOT SET'}`))
    console.log()

    if (savedConfig.model === config.model) {
      console.log(chalk.green(`  Default model set to: ${modelRef}`))
    } else {
      console.log(chalk.yellow(`  Config might not have been saved correctly`))
    }
    console.log()
    console.log(chalk.dim('  Opening OpenCode Desktop...'))
    console.log()

    await launchDesktop()
    return
  }

  if (providerKey === 'replicate') {
    console.log(chalk.yellow('  Replicate models are monitor-only for now in OpenCode Desktop mode.'))
    console.log(chalk.dim('    Reason: Replicate uses /v1/predictions instead of OpenAI chat-completions.'))
    console.log(chalk.dim('    You can still benchmark this model in the TUI and use other providers for Desktop launch.'))
    console.log()
    return
  }

  if (providerKey === 'zai') {
    console.log(chalk.yellow('  ZAI models are supported in OpenCode CLI mode only (not Desktop).'))
    console.log(chalk.dim('    Reason: ZAI requires a localhost proxy that only works with the CLI spawn.'))
    console.log(chalk.dim('    Use OpenCode CLI mode (default) to launch ZAI models.'))
    console.log()
    return
  }

  // 📖 Zen models are built-in to OpenCode — remap to `opencode/<model-id>` and skip provider config.
  if (providerKey === 'opencode-zen') {
    const zenModelRef = `opencode/${ocModelId}`
    console.log(chalk.green(`  Setting ${chalk.bold(model.label)} as default for OpenCode Desktop (Zen built-in)...`))
    console.log(chalk.dim(`  Model: ${zenModelRef}`))
    console.log()

    const config = loadOpenCodeConfig()
    const backupPath = `${getOpenCodeConfigPath()}.backup-${Date.now()}`

    if (existsSync(getOpenCodeConfigPath())) {
      copyFileSync(getOpenCodeConfigPath(), backupPath)
      console.log(chalk.dim(`  Backup: ${backupPath}`))
    }

    config.model = zenModelRef
    saveOpenCodeConfig(config)

    const savedConfig = loadOpenCodeConfig()
    console.log(chalk.dim(`  Config saved to: ${getOpenCodeConfigPath()}`))
    console.log(chalk.dim(`  Default model in config: ${savedConfig.model || 'NOT SET'}`))
    console.log()

    if (savedConfig.model === config.model) {
      console.log(chalk.green(`  Default model set to: ${zenModelRef}`))
    } else {
      console.log(chalk.yellow(`  Config might not have been saved correctly`))
    }
    console.log()
    console.log(chalk.dim('  Opening OpenCode Desktop...'))
    console.log()

    await launchDesktop()
    return
  }

  console.log(chalk.green(`  Setting ${chalk.bold(model.label)} as default for OpenCode Desktop...`))
  console.log(chalk.dim(`  Model: ${modelRef}`))
  console.log()

  const config = loadOpenCodeConfig()
  const backupPath = `${getOpenCodeConfigPath()}.backup-${Date.now()}`

  if (existsSync(getOpenCodeConfigPath())) {
    copyFileSync(getOpenCodeConfigPath(), backupPath)
    console.log(chalk.dim(`  Backup: ${backupPath}`))
  }

  if (!config.provider) config.provider = {}
  if (!config.provider[providerKey]) {
    if (providerKey === 'groq') {
      config.provider.groq = { options: { apiKey: '{env:GROQ_API_KEY}' }, models: {} }
    } else if (providerKey === 'cerebras') {
      config.provider.cerebras = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Cerebras',
        options: { baseURL: 'https://api.cerebras.ai/v1', apiKey: '{env:CEREBRAS_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'sambanova') {
      config.provider.sambanova = {
        npm: '@ai-sdk/openai-compatible',
        name: 'SambaNova',
        options: { baseURL: 'https://api.sambanova.ai/v1', apiKey: '{env:SAMBANOVA_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'openrouter') {
      config.provider.openrouter = {
        npm: '@ai-sdk/openai-compatible',
        name: 'OpenRouter',
        options: { baseURL: 'https://openrouter.ai/api/v1', apiKey: '{env:OPENROUTER_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'orcarouter') {
      config.provider.orcarouter = {
        npm: '@ai-sdk/openai-compatible',
        name: 'OrcaRouter',
        options: { baseURL: 'https://api.orcarouter.ai/v1', apiKey: '{env:ORCAROUTER_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'vercel-gateway') {
      config.provider['vercel-gateway'] = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Vercel AI Gateway',
        options: { baseURL: 'https://ai-gateway.vercel.sh/v1', apiKey: '{env:VERCEL_AI_GATEWAY_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'huggingface') {
      config.provider.huggingface = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Hugging Face Inference',
        options: { baseURL: 'https://router.huggingface.co/v1', apiKey: '{env:HUGGINGFACE_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'deepinfra') {
      config.provider.deepinfra = {
        npm: '@ai-sdk/openai-compatible',
        name: 'DeepInfra',
        options: { baseURL: 'https://api.deepinfra.com/v1/openai', apiKey: '{env:DEEPINFRA_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'fireworks') {
      config.provider.fireworks = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Fireworks AI',
        options: { baseURL: 'https://api.fireworks.ai/inference/v1', apiKey: '{env:FIREWORKS_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'codestral') {
      config.provider.codestral = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Mistral Codestral',
        options: { baseURL: 'https://api.mistral.ai/v1', apiKey: '{env:MISTRAL_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'hyperbolic') {
      config.provider.hyperbolic = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Hyperbolic',
        options: { baseURL: 'https://api.hyperbolic.xyz/v1', apiKey: '{env:HYPERBOLIC_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'scaleway') {
      config.provider.scaleway = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Scaleway',
        options: { baseURL: 'https://api.scaleway.ai/v1', apiKey: '{env:SCALEWAY_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'googleai') {
      config.provider.googleai = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Google AI Studio',
        options: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '{env:GOOGLE_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'siliconflow') {
      config.provider.siliconflow = {
        npm: '@ai-sdk/openai-compatible',
        name: 'SiliconFlow',
        options: { baseURL: 'https://api.siliconflow.cn/v1', apiKey: '{env:SILICONFLOW_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'together') {
      config.provider.together = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Together AI',
        options: { baseURL: 'https://api.together.xyz/v1', apiKey: '{env:TOGETHER_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'cloudflare') {
      const cloudflareAccountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim()
      if (!cloudflareAccountId) {
        console.log(chalk.yellow('  Cloudflare Workers AI requires CLOUDFLARE_ACCOUNT_ID for OpenCode integration.'))
        console.log(chalk.dim('    Export CLOUDFLARE_ACCOUNT_ID and retry this selection.'))
        console.log()
        return
      }
      config.provider.cloudflare = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Cloudflare Workers AI',
        options: { baseURL: `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/ai/v1`, apiKey: '{env:CLOUDFLARE_API_TOKEN}' },
        models: {}
      }
    } else if (providerKey === 'perplexity') {
      config.provider.perplexity = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Perplexity API',
        options: { baseURL: 'https://api.perplexity.ai', apiKey: '{env:PERPLEXITY_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'iflow') {
      config.provider.iflow = {
        npm: '@ai-sdk/openai-compatible',
        name: 'iFlow',
        options: { baseURL: 'https://apis.iflow.cn/v1', apiKey: '{env:IFLOW_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'chutes') {
      config.provider.chutes = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Chutes AI',
        options: { baseURL: 'https://chutes.ai/v1', apiKey: '{env:CHUTES_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'ovhcloud') {
      config.provider.ovhcloud = {
        npm: '@ai-sdk/openai-compatible',
        name: 'OVHcloud AI',
        options: { baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', apiKey: '{env:OVH_AI_ENDPOINTS_ACCESS_TOKEN}' },
        models: {}
      }
    } else {
      const providerConfig = buildOpenAiCompatibleProviderConfig(providerKey)
      if (providerConfig) config.provider[providerKey] = providerConfig
    }
  }

  const isBuiltinMapped = OPENCODE_MODEL_MAP[providerKey]?.[model.modelId]
  if (!isBuiltinMapped) {
    if (!config.provider[providerKey].models) config.provider[providerKey].models = {}
    config.provider[providerKey].models[ocModelId] = { name: model.label }
  }

  config.model = modelRef
  saveOpenCodeConfig(config)

  const savedConfig = loadOpenCodeConfig()
  console.log(chalk.dim(`  Config saved to: ${getOpenCodeConfigPath()}`))
  console.log(chalk.dim(`  Default model in config: ${savedConfig.model || 'NOT SET'}`))
  console.log()

  if (savedConfig.model === config.model) {
    console.log(chalk.green(`  Default model set to: ${modelRef}`))
  } else {
    console.log(chalk.yellow(`  Config might not have been saved correctly`))
  }
  console.log()
  console.log(chalk.dim('  Opening OpenCode Desktop...'))
  console.log()

  await launchDesktop()
}

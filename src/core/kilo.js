/**
 * @file kilo.js
 * @description Kilo CLI integration helpers for direct launches (OpenCode fork).
 */

import chalk from 'chalk'
import { sources } from '../../sources.js'
import { loadKiloConfig, saveKiloConfig, getKiloConfigPath } from './kilo-config.js'
import { getApiKey } from './config.js'
import { ENV_VAR_NAMES, OPENCODE_MODEL_MAP } from './provider-metadata.js'
import { resolveToolBinaryPath } from './tool-bootstrap.js'

// 📖 Map source model IDs to Kilo built-in IDs (same as OpenCode).
function getKiloModelId(providerKey, modelId) {
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

// 📖 spawnKilo: Resolve API keys + spawn kilo CLI with correct env.
async function spawnKilo(args, providerKey, fcmConfig) {
  const envVarName = ENV_VAR_NAMES[providerKey]
  const resolvedKey = getApiKey(fcmConfig, providerKey)
  const childEnv = { ...process.env }
  childEnv.NODE_NO_WARNINGS = '1'
  const finalArgs = [...args]
  
  if (envVarName && resolvedKey) childEnv[envVarName] = resolvedKey

  const { spawn } = await import('child_process')
  const child = spawn(resolveToolBinaryPath('kilo') || 'kilo', finalArgs, {
    stdio: 'inherit',
    shell: true,
    detached: false,
    env: childEnv
  })

  return new Promise((resolve, reject) => {
    child.on('exit', (code) => resolve(code))
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.error(chalk.red('\n  X Could not find "kilo" -- is it installed and in your PATH?'))
        console.error(chalk.dim('    Install: npm i -g @kilocode/cli   or see https://kilo.ai'))
        resolve(1)
      } else {
        reject(err)
      }
    })
  })
}

// ─── Start Kilo CLI ──────────────────────────────────────────────────────────

export async function startKilo(model, fcmConfig) {
  const providerKey = model.providerKey ?? 'nvidia'
  const ocModelId = getKiloModelId(providerKey, model.modelId)
  const modelRef = `${providerKey}/${ocModelId}`

  console.log(chalk.green(`  Setting ${chalk.bold(model.label)} as default...`))
  console.log(chalk.dim(`  Model: ${modelRef}`))
  console.log()

  const config = loadKiloConfig()

  if (!config.provider) config.provider = {}
  if (!config.provider[providerKey]) {
    // 📖 Auto-configure provider if missing (same as OpenCode logic)
    if (providerKey === 'nvidia') {
      config.provider.nvidia = {
        npm: '@ai-sdk/openai-compatible',
        name: 'NVIDIA NIM',
        options: { baseURL: 'https://integrate.api.nvidia.com/v1', apiKey: '{env:NVIDIA_API_KEY}' },
        models: {}
      }
    } else if (providerKey === 'groq') {
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
    } else if (providerKey === 'perplexity') {
      config.provider.perplexity = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Perplexity API',
        options: { baseURL: 'https://api.perplexity.ai', apiKey: '{env:PERPLEXITY_API_KEY}' },
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
  if (!isBuiltinMapped && config.provider[providerKey]) {
    if (!config.provider[providerKey].models) config.provider[providerKey].models = {}
    config.provider[providerKey].models[ocModelId] = { name: model.label }
  }

  config.model = modelRef
  saveKiloConfig(config)

  console.log(chalk.dim(`  Config saved to: ${getKiloConfigPath()}`))
  console.log()
  console.log(chalk.dim('  Starting Kilo...'))
  console.log()

  await spawnKilo(['--model', modelRef], providerKey, fcmConfig)
}

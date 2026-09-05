/**
 * @file provider-metadata.js
 * @description Provider metadata, environment variable names, and OpenCode model ID mapping.
 *              Extracted from bin/free-coding-models.js to allow shared access by setup wizard,
 *              Settings overlay, and OpenCode integration helpers.
 *
 * @details
 *   This module owns three separate concerns that all relate to "knowing about providers":
 *
 *   1. `PROVIDER_METADATA` — human-readable display info (label, colour, signup URL, rate limits)
 *      used in the setup wizard (`promptApiKey`) and the Settings overlay. Providers that need
 *      credits/billing can expose `paidProviderNote`, which Settings renders as a 💰 warning.
 *
 *   2. `ENV_VAR_NAMES` — maps providerKey → the environment variable name that carries the API key.
 *      Used when spawning OpenCode child processes so that keys stored only in
 *      ~/.free-coding-models.json are also visible to the child via `{env:VAR}` references.
 *
 *   3. `OPENCODE_MODEL_MAP` — sparse mapping of source model IDs to OpenCode built-in model IDs
 *      (only entries where the IDs differ need to be listed).  Groq's API aliases short names
 *      to full names but OpenCode does exact ID matching against its built-in model list.
 *
 *   Platform booleans (`isWindows`, `isMac`, `isLinux`) are also exported here so that
 *   OpenCode Desktop launch logic and auto-update can share them without re-reading `process.platform`.
 *
 * @exports
 *   PROVIDER_METADATA, ENV_VAR_NAMES, OPENCODE_MODEL_MAP,
 *   getProviderBillingNote, getProviderLabelWithBilling,
 *   isWindows, isMac, isLinux
 *
 * @see bin/free-coding-models.js  — consumes all exports from this module
 * @see src/config.js              — resolveApiKeys / getApiKey use ENV_VAR_NAMES indirectly
 */

import chalk from 'chalk'

// 📖 Platform detection — used by Desktop launcher and auto-update to pick the right open/start command.
export const isWindows = process.platform === 'win32'
export const isMac     = process.platform === 'darwin'
export const isLinux   = process.platform === 'linux'

// 📖 ENV_VAR_NAMES: maps providerKey → shell env var name for passing resolved keys to child processes.
// 📖 When a key is stored only in ~/.free-coding-models.json (not in the shell env), we inject it
// 📖 into the child's env so OpenCode's {env:VAR} references still resolve.
export const ENV_VAR_NAMES = {
  nvidia:     'NVIDIA_API_KEY',
  groq:       'GROQ_API_KEY',
  cerebras:   'CEREBRAS_API_KEY',
  sambanova:  'SAMBANOVA_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'github-models': 'GITHUB_TOKEN',
  mistral:    'MISTRAL_API_KEY',
  codestral:  'MISTRAL_API_KEY',
  scaleway:   'SCALEWAY_API_KEY',
  googleai:   'GOOGLE_API_KEY',
  cloudflare: 'CLOUDFLARE_API_TOKEN',
  zai:        'ZAI_API_KEY',
  ovhcloud:   'OVH_AI_ENDPOINTS_ACCESS_TOKEN',
  qwen:       'DASHSCOPE_API_KEY',
  'opencode-zen': 'OPENCODE_ZEN_API_KEY',
  kilo:       'KILO_API_KEY',
  llm7:       'LLM7_API_KEY',
  routeway:   'ROUTEWAY_API_KEY',
  novita:     'NOVITA_API_KEY',
  'ollama-cloud': 'OLLAMA_API_KEY',
  pollinations: 'POLLINATIONS_API_KEY',
  siliconflow: 'SILICONFLOW_API_KEY',
  requesty:   'REQUESTY_API_KEY',
  orcarouter: 'ORCAROUTER_API_KEY',
  'vercel-gateway': 'VERCEL_AI_GATEWAY_API_KEY',
}

// 📖 OPENCODE_MODEL_MAP: sparse table of model IDs that differ between sources.js and OpenCode's
// 📖 built-in model registry.  Only add entries where they DIFFER — unmapped models pass through as-is.
export const OPENCODE_MODEL_MAP = {
  groq: {
    'moonshotai/kimi-k2-instruct': 'moonshotai/kimi-k2-instruct-0905',
    'meta-llama/llama-4-maverick-17b-128e-preview': 'meta-llama/llama-4-maverick-17b-128e-instruct',
  }
}

// 📖 PROVIDER_METADATA: display info for each provider, used in setup wizard and Settings panel.
// 📖 `color` is a chalk function for visual distinction in the TUI.
// 📖 `signupUrl` / `signupHint` guide users through first-time key generation.
// 📖 `rateLimits` gives a quick reminder of the free-tier quota without opening a browser.
// 📖 `paidProviderNote` marks providers that require credits/billing despite exposing free/trial/free-tagged models.
export const PROVIDER_METADATA = {
  // 📖 fcm_router is the local Smart Router Daemon — it's not a remote provider
  // 📖 with an API key or signup URL, but several UI surfaces look it up here
  // 📖 to render a human label. Without this entry, the label resolves to the
  // 📖 raw key `fcm_router` (which users read as "Unknown" — see issue #140).
  fcm_router: {
    label: 'Smart Router Daemon',
    color: chalk.rgb(80, 200, 120),
    signupUrl: null,
    signupHint: null,
    rateLimits: 'Local daemon on http://127.0.0.1:19280 — start with Shift+S',
    noKeyNeeded: true,
  },
  nvidia: {
    label: 'NVIDIA NIM',
    color: chalk.rgb(178, 235, 190),
    signupUrl: 'https://build.nvidia.com',
    signupHint: 'Profile → API Keys → Generate',
    rateLimits: 'Free tier: 40 requests/min (no credit card needed)',
  },
  groq: {
    label: 'Groq',
    color: chalk.rgb(255, 204, 188),
    signupUrl: 'https://console.groq.com/keys',
    signupHint: 'API Keys → Create API Key',
    rateLimits: 'Free tier: 30‑50 RPM per model (varies by model)',
  },
  cerebras: {
    label: 'Cerebras',
    color: chalk.rgb(179, 229, 252),
    signupUrl: 'https://cloud.cerebras.ai',
    signupHint: 'API Keys → Create',
    rateLimits: 'Free tier: generous (developer tier 10× higher limits)',
  },
  sambanova: {
    label: 'SambaNova',
    color: chalk.rgb(255, 224, 178),
    signupUrl: 'https://cloud.sambanova.ai/apis',
    signupHint: 'SambaCloud portal → Create API key',
    rateLimits: 'Small developer quota; useful for light coding and smoke tests',
  },
  openrouter: {
    label: 'OpenRouter',
    color: chalk.rgb(225, 190, 231),
    signupUrl: 'https://openrouter.ai/keys',
    signupHint: 'API Keys → Create',
    rateLimits: 'Free on :free: 50/day <$10, 1000/day ≥$10 (20 req/min)',
    detailedLimits: 'No credits (or <$10) → 50 requests/day (20 req/min)\n≥ $10 in credits → 1000 requests/day (20 req/min)\n• Free models (:free) never consume credits\n• Failed requests count toward quota\n• Quota resets daily at midnight UTC\n• Free-tier models may be rate-limited during peak hours',
  },
  'github-models': {
    label: 'GitHub Models',
    color: chalk.rgb(183, 201, 255),
    signupUrl: 'https://models.github.ai',
    signupHint: 'Use a GitHub token with Models access (GITHUB_TOKEN works in GitHub contexts)',
    rateLimits: 'Quota depends on GitHub/Copilot tier; no separate provider billing',
  },
  mistral: {
    label: 'Mistral LP',
    color: chalk.rgb(255, 196, 120),
    signupUrl: 'https://console.mistral.ai/api-keys',
    signupHint: 'La Plateforme → API keys (MISTRAL_API_KEY)',
    rateLimits: 'Experiment plan: free evaluation tier with limited RPS/TPM/monthly tokens',
  },
  huggingface: {
    label: 'Hugging Face Inference',
    color: chalk.rgb(255, 245, 157),
    signupUrl: 'https://huggingface.co/settings/tokens',
    // 📖 Hugging Face serverless inference now expects a fine-grained token with
    // 📖 the dedicated Inference Providers permission, not a generic read token.
    signupHint: 'Settings → Access Tokens → Fine-grained → enable "Make calls to Inference Providers"',
    rateLimits: 'Free monthly credits (~$0.10)',
  },
  replicate: {
    label: 'Replicate',
    color: chalk.rgb(187, 222, 251),
    signupUrl: 'https://replicate.com/account/api-tokens',
    signupHint: 'Account → API Tokens',
    rateLimits: 'Free tier: 6 req/min (no payment) – up to 3,000 RPM (API) / 600 RPM (predictions) with payment',
  },
  deepinfra: {
    label: 'DeepInfra',
    color: chalk.rgb(178, 223, 219),
    signupUrl: 'https://deepinfra.com/login',
    signupHint: 'Login → API keys',
    rateLimits: 'Free tier: 200 concurrent requests (default)',
    paidProviderNote: 'trial credit provider',
  },
  fireworks: {
    label: 'Fireworks AI',
    color: chalk.rgb(255, 205, 210),
    signupUrl: 'https://fireworks.ai',
    signupHint: 'Create account → Generate API key',
    rateLimits: 'Free tier: $1 credits – 10 req/min without payment method (full limits with payment)',
  },
  codestral: {
    label: 'Mistral Codestral',
    color: chalk.rgb(248, 187, 208),
    signupUrl: 'https://console.mistral.ai/api-keys',
    signupHint: 'La Plateforme → API keys (MISTRAL_API_KEY; CODESTRAL_API_KEY also works)',
    rateLimits: 'Codestral free access: 30 req/min, 2000/day',
    paidProviderNote: 'paid - free Experiment plan',
  },
  hyperbolic: {
    label: 'Hyperbolic',
    color: chalk.rgb(255, 171, 145),
    signupUrl: 'https://app.hyperbolic.ai/settings',
    signupHint: 'Settings → API Keys',
    rateLimits: '$1 free trial credits',
  },
  scaleway: {
    label: 'Scaleway',
    color: chalk.rgb(129, 212, 250),
    signupUrl: 'https://console.scaleway.com/iam/api-keys',
    signupHint: 'IAM → API Keys',
    rateLimits: '1M free tokens',
  },
  googleai: {
    label: 'Google AI Studio',
    color: chalk.rgb(187, 222, 251),
    signupUrl: 'https://aistudio.google.com/apikey',
    signupHint: 'Get API key',
    rateLimits: 'Gemini free quotas vary by model and region',
  },
  together: {
    label: 'Together AI',
    color: chalk.rgb(255, 241, 118),
    signupUrl: 'https://api.together.ai/settings/api-keys',
    signupHint: 'Settings → API keys',
    rateLimits: 'Credits/promos vary by account (check console)',
    paidProviderNote: 'trial credit provider',
  },
  cloudflare: {
    label: 'Cloudflare Workers AI',
    color: chalk.rgb(255, 204, 128),
    signupUrl: 'https://dash.cloudflare.com',
    signupHint: 'Create AI API token + set CLOUDFLARE_ACCOUNT_ID',
    rateLimits: 'Free: 10k neurons/day, text-gen 300 RPM',
  },
  perplexity: {
    label: 'Perplexity API',
    color: chalk.rgb(244, 143, 177),
    signupUrl: 'https://www.perplexity.ai/settings/api',
    signupHint: 'Generate API key (billing may be required)',
    rateLimits: 'Tiered limits by spend (default ~50 RPM)',
  },
  qwen: {
    label: 'Alibaba Cloud (DashScope)',
    color: chalk.rgb(255, 224, 130),
    signupUrl: 'https://modelstudio.console.alibabacloud.com',
    signupHint: 'Model Studio → API Key → Create (1M free tokens, 90 days)',
    rateLimits: '1M free tokens per model (Singapore region, 90 days)',
  },
  zai: {
    label: 'ZAI (z.ai)',
    color: chalk.rgb(174, 213, 255),
    signupUrl: 'https://z.ai',
    signupHint: 'Sign up and generate an API key',
    rateLimits: 'Free tier: Flash models only in this catalog',
  },
  iflow: {
    label: 'iFlow',
    color: chalk.rgb(220, 231, 117),
    signupUrl: 'https://platform.iflow.cn',
    signupHint: 'Register → Personal Information → Generate API Key (7-day expiry)',
    rateLimits: 'Free for individuals (no request limits)',
  },
  pi: {
    label: 'Pi (pi.dev)',
    color: chalk.rgb(173, 216, 230), // light blue
    signupUrl: 'https://pi.dev',
    signupHint: 'Install @mariozechner/pi-coding-agent and set ANTHROPIC_API_KEY',
    rateLimits: 'Depends on provider subscription (e.g., Anthropic, OpenAI)',
  },
  'opencode-zen': {
    label: 'OpencodeZen',
    color: chalk.rgb(139, 92, 246), // violet — distinctive from other providers
    signupUrl: 'https://opencode.ai/auth',
    signupHint: 'Login at opencode.ai/auth to get your Zen API key',
    rateLimits: 'Free tier models — requires Zen API key',
    zenOnly: true,
  },
  chutes: {
    label: 'Chutes AI',
    color: chalk.rgb(144, 238, 144),
    signupUrl: 'https://chutes.ai',
    signupHint: 'Sign up and generate an API key',
    rateLimits: 'Free (community GPU-powered), no hard cap',
  },
  ovhcloud: {
    label: 'OVHcloud AI 🆕',
    color: chalk.rgb(100, 149, 205),
    signupUrl: 'https://endpoints.ai.cloud.ovh.net',
    signupHint: 'Manager → Public Cloud → AI Endpoints → API keys (optional: sandbox works without key)',
    rateLimits: 'Free sandbox: 2 req/min per IP per model (no key). With API key: 400 RPM',
  },
  kilo: {
    label: 'Kilo',
    color: chalk.rgb(120, 255, 190),
    signupUrl: 'https://kilo.ai',
    signupHint: 'No key needed for kilo-auto/free; optional OAuth/API token unlocks more models',
    rateLimits: 'Free router model works without a key; limits are managed by Kilo',
    noKeyNeeded: true,
  },
  llm7: {
    label: 'LLM7',
    color: chalk.rgb(180, 255, 140),
    signupUrl: 'https://token.llm7.io',
    signupHint: 'Optional: sign in at token.llm7.io for a free token',
    rateLimits: 'Free shared tier without key; optional free token improves quota',
    noKeyNeeded: true,
  },
  routeway: {
    label: 'Routeway',
    color: chalk.rgb(130, 210, 255),
    signupUrl: 'https://routeway.ai',
    signupHint: 'Create account → API key',
    rateLimits: 'Free :free models with an API key; paid models excluded here',
    paidProviderNote: 'paid — has :free models',
  },
  novita: {
    label: 'Novita AI',
    color: chalk.rgb(255, 185, 120),
    signupUrl: 'https://novita.ai/settings/key-management',
    signupHint: 'Settings → Key Management → Create API key',
    rateLimits: 'Only zero-price live chat models are listed; other Novita models are paid/trial-credit',
    paidProviderNote: 'paid — 3 free models',
  },
  pollinations: {
    label: 'Pollinations AI ⚠️ experimental',
    color: chalk.rgb(255, 105, 180),
    signupUrl: 'https://enter.pollinations.ai',
    signupHint: 'enter.pollinations.ai → API Keys (free Pollen daily; star github.com/pollinations/pollinations to earn Pollen; 0 Pollen = 402; no purchase needed)',
    rateLimits: 'Free via Pollen (daily grants; ~0.0001-0.003 Pollen/req; 0 Pollen = 402; experimental, system may change)',
    detailedLimits: 'Pollen ≈ $1. Daily free Pollen via tier (seed/flower/nectar) + quests (star repo, help issue). No purchase required. Cost per request 0.0001-0.003 Pollen. If balance is 0.0000, every MISS returns 402 PAYMENT_REQUIRED and the TUI shows 402; HIT (Cloudflare cache) may still return 200 but is not reliable. Check balance at enter.pollinations.ai → API Keys. Grants reset daily at midnight UTC. Integration is experimental and not yet confirmed as stable.',
  },
  siliconflow: {
    label: 'SiliconFlow',
    color: chalk.rgb(178, 235, 242),
    signupUrl: 'https://cloud.siliconflow.cn/account/ak',
    signupHint: 'API Keys → Create (phone SMS verification required)',
    rateLimits: 'Free · 3 models @ $0 · 1000 RPM · 1M tokens/day per model',
  },
  requesty: {
    label: 'Requesty',
    color: chalk.rgb(100, 149, 255),
    signupUrl: 'https://app.requesty.ai/api-keys',
    signupHint: 'API Keys → Create (200 req/day free, no card)',
    rateLimits: 'Free · 200 req/day on free models (20 req/min) · no card',
  },
  orcarouter: {
    label: 'OrcaRouter',
    color: chalk.rgb(255, 138, 64),
    signupUrl: 'https://www.orcarouter.ai',
    signupHint: 'Register (GitHub OAuth, no credit card) → API keys',
    rateLimits: 'Free Hacker tier · zero token markup · 3 API keys',
    detailedLimits: 'Zero-markup AI gateway: token prices are passed through at provider rates.\nFree Hacker plan: 3 API keys, adaptive routing + automatic failover + guardrails included.\nOnly the explicit $-0 models are listed in this catalog; the orcarouter/fusion family is pay-as-you-go.',
  },
  'vercel-gateway': {
    label: 'Vercel AI Gateway',
    color: chalk.rgb(140, 170, 255),
    signupUrl: 'https://vercel.com/ai-gateway',
    signupHint: 'AI Gateway → API Keys ($5 credits/30 days, no card)',
    rateLimits: 'Free tier · $5 credits/30 days + $0 models',
    detailedLimits: 'Official Vercel gateway at list prices, zero markup.\nEvery account gets $5 of credits every 30 days, no card required.\nThe monthly credit covers a subset of the catalog; the explicit $0 models stay free.\nCaution: purchasing credits once permanently moves the account to the paid tier and the monthly free credit stops.',
  },
  'ollama-cloud': {
    label: 'Ollama Cloud',
    color: chalk.rgb(230, 230, 230),
    signupUrl: 'https://ollama.com/settings/keys',
    signupHint: 'Settings → Keys → Create API key',
    rateLimits: 'Free plan includes cloud access with session + weekly limits',
  },
}

/**
 * 📖 Return the short paid/billing warning note for a provider, formatted for UI display.
 * @param {string} providerKey
 * @returns {string}
 */
export function getProviderBillingNote(providerKey) {
  const note = PROVIDER_METADATA[providerKey]?.paidProviderNote
  return typeof note === 'string' && note.trim() ? `(${note.trim()})` : ''
}

/**
 * 📖 Return a provider label with a small money marker when credits/billing are required.
 * @param {string} providerKey
 * @param {string} fallbackLabel
 * @returns {string}
 */
export function getProviderLabelWithBilling(providerKey, fallbackLabel) {
  const label = PROVIDER_METADATA[providerKey]?.label || fallbackLabel || providerKey
  return getProviderBillingNote(providerKey) ? `${label} 💰` : label
}

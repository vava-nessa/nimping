/**
 * @file src/lib/providers.ts
 * @description Single source of truth for the AI providers the catalog
 *   integrates with. Powers the `/docs/providers/<slug>` mini-tutorial pages
 *   and the badge at the top of each page.
 *
 *   📖 `signup` is the URL to the dashboard where the user creates an
 *   account, `docs` is the official API key guide, `envVar` is the env
 *   var name FCM reads, and `baseUrl` is the OpenAI-compatible endpoint
 *   (when it differs from the default `https://api.openai.com/v1`).
 *
 *   `freeTier` is a human-readable summary of the free quota — kept short
 *   on purpose because each provider page links to the live docs for the
 *   current numbers. `subtleties` lists the gotchas that catch people out
 *   (e.g. rate-limit reset windows, what counts as a request, geographic
 *   blocks, model retirement).
 */

export type Provider = {
  /** Internal slug used in URLs and the docs file name. */
  slug: string
  /** Display name shown in the UI. */
  name: string
  /** One-line tagline. */
  tagline: string
  /** Signup / dashboard URL where the user creates an account. */
  signup: string
  /** API key / quickstart guide. */
  docs: string
  /** Env var name FCM reads to find the key. */
  envVar: string
  /** OpenAI-compatible base URL. `null` means use the OpenAI default. */
  baseUrl: string | null
  /** Short summary of the free tier (RPM/RPD, daily caps, etc.). */
  freeTier: string
  /** Per-model or provider-specific gotchas the user should know. */
  subtleties: string[]
  /** Account URL or marketing page. */
  href: string
}

export const PROVIDERS: Provider[] = [
  {
    slug: 'nvidia',
    name: 'NVIDIA NIM',
    tagline: '1,000 requests / month · many free models',
    signup: 'https://build.nvidia.com',
    docs: 'https://docs.nvidia.com/nim/',
    envVar: 'NVIDIA_API_KEY',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    freeTier:
      '1,000 free requests per month across the NIM catalog. Higher tiers available for dev/research with extra quota.',
    subtleties: [
      'Quota resets monthly and is shared across all NIM models.',
      'Some models are gated behind an "Applied AI" application approval — these are NOT free.',
      '`reasoning` tokens count as output tokens, not input.',
    ],
    href: 'https://build.nvidia.com',
  },
  {
    slug: 'groq',
    name: 'Groq',
    tagline: '~30–50 RPM per model · 1k context, blazing fast',
    signup: 'https://console.groq.com',
    docs: 'https://console.groq.com/docs/quickstart',
    envVar: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    freeTier:
      'Free dev tier with per-model rate limits (typically 30 RPM and 14.4k RPD). Limits are org-scoped, not per-key.',
    subtleties: [
      'Limits are applied at the org level — adding more keys does not multiply the quota.',
      'Rate limits are hit by tokens-per-minute OR requests-per-minute, whichever first.',
      'Some models have separate `ITPM` / `OTPM` input/output token caps.',
    ],
    href: 'https://groq.com',
  },
  {
    slug: 'cerebras',
    name: 'Cerebras',
    tagline: 'Generous dev tier · 1M-token context on Llama 4',
    signup: 'https://cloud.cerebras.ai',
    docs: 'https://docs.cerebras.ai',
    envVar: 'CEREBRAS_API_KEY',
    baseUrl: 'https://api.cerebras.ai/v1',
    freeTier:
      'Free dev tier with generous RPM and TPM. Best-in-class inference speed (claimed ~2,000 tok/s).',
    subtleties: [
      'Context window is 65k tokens (not 128k like other providers) for the free tier.',
      'Dev tier keys are personal — one key per developer, not per project.',
    ],
    href: 'https://cerebras.net',
  },
  {
    slug: 'googleai',
    name: 'Google AI Studio',
    tagline: 'Gemini 3.5 / 3.1 / 2.5 — free tier with rate limits',
    signup: 'https://aistudio.google.com',
    docs: 'https://ai.google.dev/gemini-api/docs/api-key',
    envVar: 'GOOGLE_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    freeTier:
      'Free tier with per-minute rate limits (e.g. Gemini 3.5 Flash: 15 RPM / 1M TPM / 1,500 RPD). Higher limits via billing.',
    subtleties: [
      '`GOOGLE_API_KEY` is for the **Gemini API**, not Google Cloud Vertex AI. Vertex uses service-account JSON.',
      'Some Gemini models (Imagen, Veo) are NOT in the free tier.',
      'The `baseUrl` path is `/v1beta/openai` — without `openai` at the end the OpenAI-compat shim fails silently.',
    ],
    href: 'https://ai.google.dev',
  },
  {
    slug: 'github-models',
    name: 'GitHub Models',
    tagline: '⚠️ Service retired July 30, 2026 — use Azure AI Foundry or Copilot',
    signup: 'https://github.com/marketplace/models',
    docs: 'https://docs.github.com/en/github-models',
    envVar: 'GITHUB_TOKEN',
    baseUrl: 'https://models.github.ai/inference',
    freeTier:
      'GitHub Models was retired July 30, 2026. Use Azure AI Foundry for the same model catalog, or GitHub Copilot for IDE access.',
    subtleties: [
      'Use a fine-scoped `GITHUB_TOKEN` (PAT) — classic tokens with `models: read` scope.',
      'Some models are only available to Copilot paid plans, even on the inference API.',
    ],
    href: 'https://github.com/marketplace/models',
  },
  {
    slug: 'mistral',
    name: 'Mistral (La Plateforme)',
    tagline: 'Free Experiment plan · many open + proprietary models',
    signup: 'https://console.mistral.ai',
    docs: 'https://docs.mistral.ai/getting-started/quickstart/',
    envVar: 'MISTRAL_API_KEY',
    baseUrl: 'https://api.mistral.ai/v1',
    freeTier:
      '"Experiment" plan is free with rate limits. Some models (e.g. Codestral, Mistral 7B) are free, others require credits.',
    subtleties: [
      '`Codestral` and `Mistral` share the same env var `MISTRAL_API_KEY` and base URL.',
      'Tool/function calling has stricter rate limits than plain chat.',
    ],
    href: 'https://mistral.ai',
  },
  {
    slug: 'cloudflare',
    name: 'Cloudflare Workers AI',
    tagline: '10,000 neurons/day free · text + image models',
    signup: 'https://dash.cloudflare.com',
    docs: 'https://developers.cloudflare.com/workers-ai/get-started/',
    envVar: 'CLOUDFLARE_API_TOKEN',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/v1',
    freeTier:
      '10,000 free "neurons" per day (text models are usually 1 neuron per 1k tokens). 300 RPM default.',
    subtleties: [
      'You need BOTH `CLOUDFLARE_API_TOKEN` AND `CLOUDFLARE_ACCOUNT_ID` env vars. The base URL is templated on the account ID.',
      'Workers AI is OpenAI-compatible but lives behind the `/accounts/<id>/ai/v1` path.',
    ],
    href: 'https://developers.cloudflare.com/workers-ai/',
  },
  {
    slug: 'openrouter',
    name: 'OpenRouter',
    tagline: '50 free req/day · 200+ models, one key',
    signup: 'https://openrouter.ai',
    docs: 'https://openrouter.ai/docs/api-reference/overview',
    envVar: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    freeTier:
      '`:free` models get 50 requests/day and 20 req/min — no credits charged. After that, :paid models require $10+ credits.',
    subtleties: [
      'Free and paid models share the same key — credits are only consumed by paid models.',
      'Some `:free` models are additionally rate-limited by the upstream provider during peak hours.',
      'Failed requests still count toward the daily quota.',
    ],
    href: 'https://openrouter.ai',
  },
  {
    slug: 'sambanova',
    name: 'SambaNova',
    tagline: 'Free dev tier · small quota, fast inference',
    signup: 'https://cloud.sambanova.ai',
    docs: 'https://docs.sambanova.ai/cloud/docs/get-started/overview',
    envVar: 'SAMBANOVA_API_KEY',
    baseUrl: 'https://api.sambanova.ai/v1',
    freeTier:
      'Free "Developer" tier with small RPM / RPD. Useful for smoke tests, not sustained coding.',
    subtleties: [
      'Free tier is shared across all SambaNova Cloud models — heavy use will exhaust it quickly.',
    ],
    href: 'https://sambanova.ai',
  },
  {
    slug: 'ovhcloud',
    name: 'OVHcloud AI Endpoints',
    tagline: 'Free sandbox · 2 RPM no key, 400 RPM with key',
    signup: 'https://www.ovhcloud.com/en/public-cloud/ai-endpoints/',
    docs: 'https://help.ovhcloud.com/csm/en-public-cloud-ai-endpoints',
    envVar: 'OVH_AI_ENDPOINTS_ACCESS_TOKEN',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    freeTier:
      'Sandbox works without a key at 2 RPM. With a free AI Endpoints account, RPM lifts to 400.',
    subtleties: [
      'Sandbox URLs are geo-specific (kepler.ai.cloud.ovh.net). Check the docs for the closest endpoint.',
      'Embeddings + chat + image models are in the same catalog.',
    ],
    href: 'https://www.ovhcloud.com',
  },
  {
    slug: 'codestral',
    name: 'Codestral (Mistral code model)',
    tagline: 'Free via Mistral Experiment plan · 30 RPM / 2k RPD',
    signup: 'https://console.mistral.ai',
    docs: 'https://docs.mistral.ai/getting-started/quickstart/',
    envVar: 'MISTRAL_API_KEY',
    baseUrl: 'https://api.mistral.ai/v1',
    freeTier:
      'Codestral is the code-focused model from Mistral. Free via the Mistral Experiment plan at 30 RPM / 2k RPD.',
    subtleties: [
      'Uses the SAME `MISTRAL_API_KEY` and base URL as the rest of the Mistral catalog.',
      'Best results for FIM (fill-in-the-middle) and code completion tasks.',
    ],
    href: 'https://mistral.ai/news/codestral',
  },
  {
    slug: 'zai',
    name: 'ZAI (z.ai)',
    tagline: 'Free tier · Flash models only',
    signup: 'https://z.ai',
    docs: 'https://docs.z.ai/guides/overview/quick-start',
    envVar: 'ZAI_API_KEY',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    freeTier:
      'Free tier covers the GLM-4.5 / 4.6 Flash models. Other (paid) GLM models require top-ups.',
    subtleties: [
      'The free base URL is `https://api.z.ai/api/coding/paas/v4` (not the standard `/v1`).',
    ],
    href: 'https://z.ai',
  },
  {
    slug: 'scaleway',
    name: 'Scaleway Generative APIs',
    tagline: '1M free tokens (one-time) · Devstral, Qwen, Mistral',
    signup: 'https://console.scaleway.com',
    docs: 'https://www.scaleway.com/en/docs/ai/',
    envVar: 'SCALEWAY_API_KEY',
    baseUrl: 'https://api.scaleway.ai/v1',
    freeTier:
      '1M free tokens one-time credit on signup. Devstral, Qwen3, Mistral Small, Llama 3.x included.',
    subtleties: [
      'Free credits are one-shot — they do not refill monthly. Top up after.',
      'Devstral-2 (123B) is a 260k context model — verify the slug before launching.',
    ],
    href: 'https://www.scaleway.com',
  },
  {
    slug: 'qwen',
    name: 'Alibaba DashScope (Qwen)',
    tagline: '1M tokens / model · 90 days (Singapore region)',
    signup: 'https://dashscope.aliyun.com',
    docs: 'https://www.alibabacloud.com/help/en/model-studio/developer-reference/use-qwen-by-calling-api',
    envVar: 'DASHSCOPE_API_KEY',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    freeTier:
      '1M free tokens per model, valid 90 days. Available on the Singapore (intl) region only.',
    subtleties: [
      'Use the `dashscope-intl.aliyuncs.com` base URL outside China. The China URL is `dashscope.aliyun.com`.',
      'Tokens expire after 90 days and do NOT auto-renew — top up to keep using Qwen.',
    ],
    href: 'https://www.alibabacloud.com/product/model-studio',
  },
  {
    slug: 'opencode-zen',
    name: 'OpenCode Zen',
    tagline: 'Free gateway · OpenCode-curated models',
    signup: 'https://opencode.ai/auth',
    docs: 'https://opencode.ai/docs/zen',
    envVar: 'OPENCODE_ZEN_API_KEY',
    baseUrl: 'https://opencode.ai/zen/v1',
    freeTier:
      'Zen ships a hand-picked catalog of free models. Quota depends on the model (Big Pickle, DeepSeek V4 Flash Free, etc.).',
    subtleties: [
      'Requires an OpenCode account (free signup). The key is per-account, not per-project.',
      'Only the OpenCode CLI / Desktop / WebUI use the Zen endpoint — not all models are exposed outside.',
    ],
    href: 'https://opencode.ai',
  },
  {
    slug: 'kilo',
    name: 'Kilo Code',
    tagline: 'Free router model · optional sign-in for more',
    signup: 'https://kilocode.ai',
    docs: 'https://kilocode.ai/docs',
    envVar: 'KILO_API_KEY',
    baseUrl: null,
    freeTier:
      '`kilo-auto/free` works without a key (it routes to Kilo\'s current free pool). Optional OAuth/API key unlocks more models.',
    subtleties: [
      'Without a key you only get the router model. With a key, the full Kilo catalog opens up.',
    ],
    href: 'https://kilocode.ai',
  },
  {
    slug: 'llm7',
    name: 'LLM7',
    tagline: 'Free · no key needed',
    signup: 'https://llm7.io',
    docs: 'https://llm7.io',
    envVar: 'LLM7_API_KEY',
    baseUrl: null,
    freeTier:
      'Free unauthenticated tier works with tight shared limits. Optional free token at token.llm7.io improves quota.',
    subtleties: [
      'Without a key, the model is throttled across the whole community. A free key is enough for personal use.',
    ],
    href: 'https://llm7.io',
  },
  {
    slug: 'routeway',
    name: 'Routeway',
    tagline: 'Free :free models only',
    signup: 'https://routeway.ai',
    docs: 'https://routeway.ai',
    envVar: 'ROUTEWAY_API_KEY',
    baseUrl: 'https://api.routeway.ai/v1',
    freeTier:
      'Free API access to a curated list of :free models. No paid tiers — everything Routeway exposes is free.',
    subtleties: [
      'Most Routeway models are the same upstream providers (OpenRouter, etc.) so you may double-count quotas if you use both.',
    ],
    href: 'https://routeway.ai',
  },
  {
    slug: 'novita',
    name: 'Novita',
    tagline: 'Free models · small daily quota',
    signup: 'https://novita.ai',
    docs: 'https://novita.ai/docs',
    envVar: 'NOVITA_API_KEY',
    baseUrl: 'https://api.novita.ai/v3/openai',
    freeTier:
      'Free credits for several open-source models. Quota varies by model — check the dashboard.',
    subtleties: [
      'Base URL is `/v3/openai` — different from the standard `/v1`.',
    ],
    href: 'https://novita.ai',
  },
  {
    slug: 'pollinations',
    name: 'Pollinations AI',
    tagline: 'Free · daily Pollen grants · S-tier models included',
    signup: 'https://enter.pollinations.ai',
    docs: 'https://pollinations.ai',
    envVar: 'POLLINATIONS_API_KEY',
    baseUrl: 'https://gen.pollinations.ai/v1',
    freeTier:
      'Free access funded by daily Pollen grants (Pollinations\' usage currency). API keys are issued at enter.pollinations.ai.',
    subtleties: [
      'The OpenAI-compatible endpoint is `https://gen.pollinations.ai/v1` (chat completions).',
      'Heavy S-tier models (Kimi, MiniMax, GLM) burn through the daily Pollen grant faster than small ones.',
    ],
    href: 'https://pollinations.ai',
  },
  {
    slug: 'siliconflow',
    name: 'SiliconFlow',
    tagline: 'Free · $0 models at 1000 RPM',
    signup: 'https://cloud.siliconflow.cn',
    docs: 'https://docs.siliconflow.cn',
    envVar: 'SILICONFLOW_API_KEY',
    baseUrl: 'https://api.siliconflow.cn/v1',
    freeTier:
      'A small set of open models (Qwen, GLM, DeepSeek R1 distills) is priced at $0 with up to 1000 RPM. The rest of the catalog is paid.',
    subtleties: [
      'Only the $0-priced models are effectively free - check the model page before routing production traffic.',
      'The base URL is `api.siliconflow.cn` (China region endpoint).',
    ],
    href: 'https://siliconflow.cn',
  },
  {
    slug: 'requesty',
    name: 'Requesty',
    tagline: 'Free · 200 req/day · no card',
    signup: 'https://app.requesty.ai',
    docs: 'https://docs.requesty.ai',
    envVar: 'REQUESTY_API_KEY',
    baseUrl: 'https://router.requesty.ai/v1',
    freeTier:
      '200 free requests per day, no credit card required. Routes to NVIDIA, Poolside, Google, Mistral and more through one key.',
    subtleties: [
      'Model slugs are namespaced by upstream, e.g. `nvidia/nemotron-3-ultra-550b-a55b`.',
    ],
    href: 'https://requesty.ai',
  },
  {
    slug: 'orcarouter',
    name: 'OrcaRouter',
    tagline: 'Free · 3 $-0 models · zero markup',
    signup: 'https://orcarouter.ai',
    docs: 'https://orcarouter.ai',
    envVar: 'ORCAROUTER_API_KEY',
    baseUrl: 'https://api.orcarouter.ai/v1',
    freeTier:
      'Small catalog of permanently $0 models: DeepSeek V4 Flash, Tencent Hy3 and Qwen3.8 27B.',
    subtleties: [
      'The catalog only lists models served at a $0 price point, so it stays small.',
    ],
    href: 'https://orcarouter.ai',
  },
  {
    slug: 'vercel-gateway',
    name: 'Vercel AI Gateway',
    tagline: 'Free · $5 credits / 30 days + $0 models',
    signup: 'https://vercel.com/ai-gateway',
    docs: 'https://vercel.com/docs/ai-gateway',
    envVar: 'VERCEL_AI_GATEWAY_API_KEY',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    freeTier:
      '$5 of credits refreshed every 30 days plus a set of permanently $0 models. No credit card required.',
    subtleties: [
      'The OpenAI-compatible endpoint is `https://ai-gateway.vercel.sh/v1`.',
      'The $0 variants carry a `-free` slug suffix, e.g. `minimax/minimax-m3-free`.',
    ],
    href: 'https://vercel.com/ai-gateway',
  },
  {
    slug: 'ollama-cloud',
    name: 'Ollama Cloud',
    tagline: 'Free plan · session + weekly caps',
    signup: 'https://ollama.com',
    docs: 'https://docs.ollama.com/cloud',
    envVar: 'OLLAMA_API_KEY',
    baseUrl: 'https://ollama.com/v1',
    freeTier:
      'Free plan includes cloud model access with session-length and weekly token caps. Bigger quotas with Ollama Pro.',
    subtleties: [
      'Sessions expire — long-running agents will get cut off at the session limit.',
      'Some models are CPU-only on the free plan, slower than the GPU tier.',
    ],
    href: 'https://ollama.com',
  },
]

export function getProviderBySlug(slug: string): Provider | null {
  for (const p of PROVIDERS) {
    if (p.slug === slug) return p
  }
  return null
}

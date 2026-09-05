/**
 * @file sources.js
 * @description Model sources for AI availability checker.
 *
 * @details
 *   This file contains all model definitions organized by provider/source.
 *   Each source has its own models array with [model_id, display_label, tier, swe_score, ctx].
 *   - model_id: The model identifier for API calls
 *   - display_label: Human-friendly name for display
 *   - tier: Performance tier (S+, S, A+, A, A-, B+, B, C)
 *   - swe_score: SWE-bench Verified score percentage (self-reported by model provider)
 *   - ctx: Context window size in tokens (e.g., "128k", "32k")
 *
 *   Add new sources here to support additional providers beyond NIM.
 *   Public provider catalogs drift often, so these IDs are periodically
 *   refreshed against official docs and live model endpoints when available.
 *
 *   🎯 Tier scale (based on SWE-bench Verified):
 *   - S+: 70%+ (elite frontier coders)
 *   - S:  60-70% (excellent)
 *   - A+: 50-60% (great)
 *   - A:  40-50% (good)
 *   - A-: 35-40% (decent)
 *   - B+: 30-35% (average)
 *   - B:  20-30% (below average)
 *   - C:  <20% (lightweight/edge)
 *
 *   📖 Source: https://www.swebench.com — scores are self-reported unless noted
 *   📖 Secondary: https://swe-rebench.com (independent evals, scores are lower)
 *   📖 Leaderboard tracker: https://www.marc0.dev/en/leaderboard
 *
 *   @exports nvidiaNim, groq, cerebras, sambanova, openrouter, githubModels, mistral, codestral, scaleway, googleai, zai, qwen, cloudflare, ovhcloud, opencodeZen, kilo, llm7, routeway, novita, ollamaCloud, pollinations, siliconflow, requesty, orcarouter, vercelGateway — model arrays per active provider
 *   @exports sources — map of active free/free-limited providers, each with { name, url, models }

 *   @exports MODELS — flat array of [modelId, label, tier, sweScore, ctx, providerKey]
 *
 *   📖 MODELS now includes providerKey as 6th element so ping() knows which
 *      API endpoint and API key to use for each model.
 */

// 📖 NIM source - https://build.nvidia.com
export const nvidiaNim = [
  // ── S+ tier — SWE-bench Verified ≥70% ──
  // Removed (2026-08-23): z-ai/glm-5.2 (GLM 5.1) — no longer in integrate.api.nvidia.com/v1/models (102 models live)
  // Removed (2026-09-05): moonshotai/kimi-k2.6 (Kimi K2.6) - Model page returns 404 and model is absent from the NVIDIA model catalog; could not verify existence
  // Removed (2026-08-30): deepseek-ai/deepseek-v4-pro (DeepSeek V4 Pro) — 410 Gone per NVIDIA NIM forum; replaced by deepseek-v4-flash:0731 (forums.developer.nvidia.com/t/deepseek-v4-pro-flash-removed/379558)
  ['deepseek-ai/deepseek-v4-flash-0731', 'DeepSeek V4 Flash', 'S+', '79.0%', '1M'], // Fixed (2026-08-13): id 'deepseek-ai/deepseek-v4-flash' → 'deepseek-ai/deepseek-v4-flash-0731' (NIM /v1/models only exposes the -0731 suffix)
  // Removed (2026-08-30): stepfun-ai/step-3.7-flash (Step 3.7 Flash) — 410 Gone per NVIDIA NIM TUI ping (no replacement listed; superseded by step-3.7-flash via Routeway `step-3.7-flash:free`)
  ['nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron 3 Ultra', 'S+', '71.9%', '1M'],
  ['poolside/laguna-xs-2.1', 'Laguna XS 2.1', 'S+', '70.9%', '262k'], // Added (2026-08-13)
  ['meta/muse-glimmer-30b', 'Muse Glimmer 30B', 'B+', '-', '128k'], // Added (2026-09-02) — new in NIM catalog
  ['deepseek-ai/deepseek-v4-pro-0813', 'DeepSeek V4 Pro', 'S+', '-', '1M'],
  // ── S tier — SWE-bench Verified 60–70% ──
  // Removed (2026-09-05): openai/gpt-oss-120b (GPT OSS 120B) - NVIDIA deprecation notice on model page: API deprecated on 09/02/2026 and no longer supported
  // Removed (2026-07-27): meta/llama-4-maverick-17b-128e-instruct (Llama 4 Maverick) — EOL 2026-07-27 (HTTP 410 Gone)
  // Removed (2026-08-23): mistralai/mistral-medium-3.5-128b (Mistral Medium 3.5) — no longer in integrate.api.nvidia.com/v1/models (still on Mistral LP directly)
  // Removed (2026-07-27): mistralai/mistral-small-4-119b-2603 (Mistral Small 4) — EOL 2026-07-27 (HTTP 410 Gone)
  // ⚠️ DEPRECATED - NVIDIA shutdown 2026-09-08
  ['minimaxai/minimax-m3', 'MiniMax M3', 'S+', '78.4%', '1M'],
  ['moonshotai/kimi-k3', 'Kimi K3', 'S', '-', '1M'], // Added (2026-09-02) — new in NIM catalog
  ['mistralai/mistral-nemotron', 'Mistral Nemotron', 'S', '-', '128k'], // Fixed ID (2026-07-27): nvidia/mistral-nemotron → mistralai/mistral-nemotron
  // Removed (2026-07-27): deepseek-ai/deepseek-v3.2 (DeepSeek V3.2) — HTTP 404
  // ── A+ tier — SWE-bench Verified 50–60% ──
  // Removed (2026-07-27): mistralai/mistral-large-3-675b-instruct-2512 (Mistral Large 675B) — EOL 2026-07-23 (HTTP 410 Gone)
  ['nvidia/nemotron-3-super-120b-a12b', 'Nemotron 3 Super', 'S', '60.5%', '1M'],
  ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', 'Nemotron 3 Omni', 'A+', '52.0%', '256k'],
  // Removed (2026-07-27): meta-llama/llama-4-scout-17b-16e-instruct (Llama 4 Scout) — HTTP 404
  // Removed (2026-08-30): nvidia/llama-3.3-nemotron-super-49b-v1.5 (Llama 3.3 Nemotron Super 49B) — 410 Gone per NVIDIA NIM TUI ping
  ['nvidia/nemotron-3.5-lightning-30b-a3b', 'Nemotron 3.5 Lightning 30B', 'A+', '52.8%', '1M'],
  // ── A tier — SWE-bench Verified 40–50% ──
  // Removed (2026-09-05): nvidia/nemotron-nano-3-30b-a3b (Nemotron Nano 30B) - Model page returns 404 and model is absent from the NVIDIA model catalog; superseded by Nemotron 3.5 Lightning
  ['openai/gpt-oss-20b', 'GPT OSS 20B', 'A+', '50.3%', '128k'],
  ['google/gemma-4-31b-it', 'Gemma 4 31B', 'A+', '52.0%', '256k'],
  // Removed (2026-08-30): mistralai/mistral-large-2-instruct (Mistral Large 2) — 404 NOT FOUND per NVIDIA NIM TUI ping (model not in NIM catalog; use Mistral LP `mistral-large-2512`)
  // Removed (2026-07-27): qwen/qwen2.5-coder-32b-instruct (Qwen2.5 Coder 32B) — EOL 2026-05-12 (HTTP 410 Gone)
  // Removed (2026-07-27): deepseek-ai/deepseek-r1 (DeepSeek R1) — HTTP 404
  // Removed (2026-07-27): nvidia/nemotron-3-nano (Nemotron 3 Nano) — HTTP 404 (replaced by nvidia/nvidia-nemotron-nano-9b-v2)
  // Removed (2026-08-30): nvidia/nvidia-nemotron-nano-9b-v2 (Nemotron Nano 9B v2) — 410 Gone per NVIDIA NIM TUI ping (superseded by nvidia/nemotron-nano-3-30b-a3b)
  // Removed (2026-08-30): meta/llama-3.3-70b-instruct (Llama 3.3 70B) — 410 Gone per NVIDIA NIM TUI ping (no longer in NIM catalog)
  // Removed (2026-08-30): deepseek-ai/deepseek-coder-6.7b-instruct (DeepSeek Coder 6.7B) — 404 NOT FOUND per NVIDIA NIM TUI ping
  // Removed (2026-08-30): meta/codellama-70b (CodeLlama 70B) — 404 NOT FOUND per NVIDIA NIM TUI ping (docs.nvidia.com still lists CodeLlama but not via NIM `integrate.api` free tier)
  // Removed (2026-08-30): mistralai/codestral-22b-instruct-v0.1 (Codestral 22B) — 404 NOT FOUND per NVIDIA NIM TUI ping (use Codestral `codestral-2508` via Mistral LP)
  // Removed (2026-08-30): ibm/granite-34b-code-instruct (Granite 34B Code) — 404 NOT FOUND per NVIDIA NIM TUI ping
  // ── A- tier — SWE-bench Verified 35–40% ──
  // Removed (2026-07-27): bytedance/seed-oss-36b-instruct (Seed OSS 36B) — EOL 2026-07-27 (HTTP 410 Gone)
  // Removed (2026-07-27): stockmark/stockmark-2-100b-instruct (Stockmark 100B) — EOL 2026-07-15 (HTTP 410 Gone)
  // ── B+ tier — SWE-bench Verified 30–35% ──
  // Removed (2026-07-27): mistralai/ministral-14b-instruct-2512 (Ministral 14B) — EOL 2026-07-27 (HTTP 410 Gone)
  // Removed (2026-08-30): thinkingmachines/inkling (Inkling) — 410 Gone per NVIDIA NIM TUI ping (per Model Deprecation Request 378412)
  ['google/diffusiongemma-26b-a4b-it', 'DiffusionGemma 26B', 'B+', '-', '256k'],
  // ── B tier — SWE-bench Verified 20–30% ──
  // Removed (2026-09-05): meta/llama-3.2-11b-vision-instruct (Llama 3.2 11B Vision) - Model page on build.nvidia.com has no hosted endpoint at all (no Free Endpoint, no Partner Endpoint, no endpointData payload); docs page remains but the free API endpoint is gone
  // Removed (2026-08-30): nvidia/nemotron-mini-4b-instruct (Nemotron Mini 4B) — 410 Gone per NVIDIA NIM TUI ping
  // ── C tier — lightweight/edge models ──
  // Removed (2026-07-27): microsoft/phi-4-mini-instruct (Phi 4 Mini) — EOL 2026-07-15 (HTTP 410 Gone)
]

// 📖 Groq source - https://console.groq.com
// 📖 Free API keys available at https://console.groq.com/keys
export const groq = [
  // Removed (2026-08-13): llama-3.3-70b-versatile (Llama 3.3 70B) — Groq deprecation, shutdown 2026-08-16
  // Removed (2026-08-13): llama-3.1-8b-instant (Llama 3.1 8B) — Groq deprecation, shutdown 2026-08-16
  ['openai/gpt-oss-120b',                  'GPT OSS 120B',       'S',  '62.4%', '131k'],
  ['openai/gpt-oss-20b', 'GPT OSS 20B', 'A+', '60.7%', '131k'],
  ['qwen/qwen3.6-27b',                     'Qwen3.6 27B',        'S+',  '77.2%',     '131k'],
  ['groq/compound',                        'Groq Compound',      'A',  '45.0%', '131k'],
  ['groq/compound-mini',                   'Groq Compound Mini', 'B+', '32.0%', '131k'],
  ['qwen/qwen3.8-27b', 'Qwen3.8 27B', 'A+', '-', '131k'],
]

// 📖 Cerebras source - https://cloud.cerebras.ai
// 📖 Free API keys available at https://cloud.cerebras.ai
export const cerebras = [
  // Removed (2026-08-23): zai-glm-4.7 (GLM 4.7) — shutdown 2026-08-17 per Cerebras official notice
  // ── S tier — SWE-bench Verified 60–70% ──
  ['gpt-oss-120b', 'GPT OSS 120B', 'S', '62.4%', '65k'], // Fixed (2026-07-27): ctx '128k' → '65k' (free tier per official docs)
  // Removed (2026-09-05): MiniMax-M3 (MiniMax M3) — HTTP 404 "Model does not exist" per live API ping (PR #178 addition reverted)
  // ── A tier — SWE-bench Verified 40–50% ──
  // Removed (2026-09-05): gemma-4-31b (Gemma 4 31B) - Official deprecation notice dated 2026-09-03: gemma-4-31b is no longer available on Cerebras public endpoints; it remains only on paid Dedicated Endpoints, so it no longer has a free access tier
  ['qwen-3.8-27b', 'Qwen 3.8 27B', 'A+', '-', '64k'],
]

// 📖 SambaNova source - https://cloud.sambanova.ai
// 📖 Developer tier limits are small but still useful for smoke tests and occasional coding.
// 📖 Keep this catalog conservative: only models surfaced in current SambaNova docs.
export const sambanova = [
  // ── S+ tier ──
  ['MiniMax-M2.7',                         'MiniMax M2.7',       'S+', '78.0%', '196k'], // Fixed (2026-07-27): ctx '192k' → '196k' (API exact 196608)
  ['MiniMax-M3', 'MiniMax M3', 'S+', '78.4%', '1M'], // Added (2026-09-02) — verified live 2026-09-05 via /v1/models
  // ── S tier ──
  ['DeepSeek-V3.1',                        'DeepSeek V3.1',      'S',  '66.0%', '131k'], // Fixed (2026-07-27): ctx '128k' → '131k' (API exact 131072)
  ['DeepSeek-V3.2',                        'DeepSeek V3.2',      'S+', '70.0%', '32k'],
  ['gpt-oss-120b',                         'GPT OSS 120B',       'S',  '62.4%', '131k'], // Fixed (2026-07-27): ctx '128k' → '131k'
  // ── A tier ──
  ['gemma-4-31B-it',                       'Gemma 4 31B',        'A+',  '52.0%', '131k'], // Fixed (2026-07-27): ctx '128k' → '131k'
  // ── A- tier ──
  ['Meta-Llama-3.3-70B-Instruct',          'Llama 3.3 70B',      'B', '22.0%', '131k'], // Fixed (2026-07-27): ctx '128k' → '131k'
  // ── B+ tier ──
]

// 📖 OpenRouter source - https://openrouter.ai
// 📖 Free :free models with shared quota — 50 free req/day (20 req/min)
// 📖 No credits (or < $10) → 50 requests / day (20 req/min)
// 📖 ≥ $10 in credits → 1000 requests / day (20 req/min)
// 📖 Key things to know:
// 📖 • Free models (:free) never consume your credits. Your $10 stays untouched if you only use :free models.
// 📖 • Failed requests still count toward your daily quota.
// 📖 • Quota resets every day at midnight UTC.
// 📖 • Free-tier popular models may be additionally rate-limited by the provider itself during peak hours.
// 📖 API keys at https://openrouter.ai/keys
export const openrouter = [
  // ── S+ tier — SWE-bench Verified ≥70% ──
  ['nvidia/nemotron-3-ultra-550b-a55b:free', 'Nemotron 3 Ultra', 'S+', '71.9%', '1M'],
  ['poolside/laguna-xs-2.1:free', 'Poolside Laguna XS 2.1', 'S+', '70.9%', '262k'],
  ['poolside/laguna-s-2.1:free', 'Poolside Laguna S 2.1', 'S+', '-', '262k'],
  ['minimax/minimax-m2.7:free', 'MiniMax M2.7', 'S+', '56.2%', '192k'], // Added (2026-09-02)
  ['minimax/minimax-m3:free', 'MiniMax M3', 'S+', '78.4%', '1M'], // Added (2026-09-02)
  ['z-ai/glm-5.2:free', 'GLM-5.2', 'S+', '-', '256k'], // Added (2026-09-02)
  // ── S tier — SWE-bench Verified 60–70% ──
  ['cohere/north-mini-code:free', 'North Mini Code', 'S', '-', '256k'],
  ['nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super', 'S', '60.5%', '262k'],
  // ── A+ tier — SWE-bench Verified 50–60% ──
  ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'Nemotron 3 Omni', 'A+', '52.0%', '256k'],
  ['google/gemma-4-31b-it:free', 'Gemma 4 31B', 'A+', '52.0%', '262k'],
  ['google/gemma-4-26b-a4b-it:free', 'Gemma 4 26B MoE', 'A', '38.0%', '262k'],
  // ── B+ tier — SWE-bench Verified 30–35% ──
  ['liquid/lfm-2.5-2.6b:free', 'LiquidAI LFM2.5-2.6B', 'C', '-', '64k'],
  ['nvidia/nemotron-3.5-lightning:free', 'NVIDIA Nemotron 3.5 Lightning', 'B+', '-', '1M'],
  ['inclusionai/ling-3.0-flash-fin:free', 'Ling 3.0 Flash Fin', 'B+', '-', '262k'], // Added (2026-09-02)
  ['thinkingmachines/inkling:free', 'Inkling', 'B+', '-', '1M'], // Added (2026-09-02)
  ['inclusionai/ling-3.0-flash-sante:free', 'Ling 3.0 Flash Sante', 'B+', '-', '262k'],
  // ── B tier — SWE-bench Verified 20–30% ──
  ['thinkingmachines/inkling-small:free', 'Inkling Small', 'B', '-', '1M'], // Added (2026-09-02)
  ['dots-studio/dots-3-note-preview:free', 'Dots 3 Note Preview', 'B', '-', '512k'], // Added (2026-09-02)
  // ── C tier — lightweight/edge models ──
  ['nvidia/nemotron-3.5-content-safety:free', 'Nemotron 3.5 Content Safety', 'C', '-', '128k'],
]

// 📖 GitHub Models source - https://models.github.ai
// 📖 ⚠️ RETIRED 2026-07-30 — GitHub Models fully shut down (playground, catalog, inference API, BYOK all gone)
// 📖 Catalog returns HTTP 410 Gone with `github_models_retirement_brownout` error.
// 📖 https://github.blog/changelog/2026-07-01-github-models-retirement
// 📖 Kept as an empty array so downstream provider-metadata/config code that imports
// 📖 `githubModels` and references `'github-models'` doesn't crash; the entry is also
// 📖 commented out of the `sources` map below so it won't appear in the catalog.
export const githubModels = [
  // All 35 entries retired 2026-07-30 — see comment above.
]

// 📖 Mistral La Plateforme source - https://console.mistral.ai
// 📖 Experiment plan is free for evaluation/prototyping and exposes general + coding models.
// 📖 Keep Codestral as a separate provider key for backward compatibility with existing configs.
export const mistral = [
  // ── S+ tier — SWE-bench Verified ≥70% ──
  ['mistral-large-2512', 'Mistral Large 3', 'S+', '70.0%', '256k'],
  ['mistral-medium-3-5', 'Mistral Medium 3.5', 'S+', '77.6%', '256k'],
  // Removed (2026-08-13): devstral-2512 (Devstral 2) — Mistral deprecation, full retirement 2026-07-31
  ['zai-glm-5-2', 'Z.ai GLM 5.2', 'S+', '82.8%', '1M'],
  // ── A tier — SWE-bench Verified 40–50% ──
  ['mistral-small-2603', 'Mistral Small 4', 'A', '48.0%', '256k'],
  // ── B+ tier — SWE-bench Verified 30–35% ──
  ['ministral-14b-2512', 'Ministral 3 14B', 'B+', '-', '256k'], // Fixed (2026-08-13): id 'ministral-3-14b-25-12' → 'ministral-14b-2512' (API model ID per Mistral docs JSON)
  // ── B tier — SWE-bench Verified 20–30% ──
  ['ministral-8b-2512', 'Ministral 3 8B', 'B', '-', '256k'], // Fixed (2026-08-13): id 'ministral-3-8b-25-12' → 'ministral-8b-2512'
  ['ministral-3b-2512', 'Ministral 3 3B', 'B', '-', '256k'], // Fixed (2026-08-13): id 'ministral-3-3b-25-12' → 'ministral-3b-2512'
]

// 📖 Mistral Codestral source - https://codestral.mistral.ai
// 📖 Free coding model — 30 req/min, 2000/day (phone number required for key)
// 📖 API keys now use the Mistral platform key format; CODESTRAL_API_KEY remains supported as an alias.
export const codestral = [
  // ── A tier — SWE-bench Verified 40–50% ──
  ['codestral-2508', 'Codestral', 'A', '40.0%', '256k'], // Fixed (2026-07-27): ctx '256k' → '128k' per official Mistral model card
  // Removed (2026-08-23): codestral-2501 (Codestral 2501), codestral-2405 (Codestral 2405) — retired from Mistral API; only codestral-2508 / codestral-latest remain
  // Removed (2026-08-13): codestral-2 (Codestral 2) — fabricated ID, never existed in Mistral catalog (Mistral uses date-stamped versioning)
]

// 📖 Scaleway source - https://console.scaleway.com
// 📖 1M free tokens — API keys at https://console.scaleway.com/iam/api-keys
export const scaleway = [
  // ── S+ tier — SWE-bench Verified ≥70% ──
  ['glm-5.2', 'GLM 5.2', 'S+', '82.8%', '256k'], // Fixed (2026-08-13): ctx '1M' → '256k' (Serverless tier per official catalog)
  ['deepseek-v4-flash-0731', 'DeepSeek V4 Flash', 'S+', '-', '256k'], // Added (2026-08-13)
  // Removed (2026-09-05): devstral-2-123b-instruct-2512 (Devstral 2 123B) - Deprecated 2026-07-01, End of Life 2026-08-01; after EOL the model is no longer accessible on Generative APIs Serverless
  // ── S tier — SWE-bench Verified 60–70% ──
  ['qwen3.5-397b-a17b', 'Qwen3.5 400B VLM', 'S+', '76.2%', '250k'],
  ['gpt-oss-120b', 'GPT OSS 120B', 'S', '62.4%', '128k'],
  ['mistral-medium-3.5-128b', 'Mistral Medium 3.5 128B', 'S+', '77.6%', '180k'], // Fixed (2026-07-27): ctx '256k' → '180k' (Serverless tier)
  // ── A+ tier — SWE-bench Verified 50–60% ──
  // ⚠️ DEPRECATED - Scaleway EOL 2026-10-01
  ['qwen3-coder-30b-a3b-instruct', 'Qwen3 Coder 30B', 'A+', '51.6%', '128k'],
  ['qwen3.6-35b-a3b', 'Qwen3.6 35B MoE', 'S+', '73.4%', '256k'],
  // Removed (2026-09-05): holo2-30b-a3b (Holo2 30B) - Deprecated 2026-07-09, End of Life 2026-08-09; after EOL the model is no longer accessible on Generative APIs Serverless
  ['gemma-4-26b-a4b-it', 'Gemma 4 26B MoE', 'A+', '-', '256k'],
  // Removed (2026-09-02): gemma-4-31b-it (Gemma 4 31B IT) — Dedicated tier only, not available on Serverless
  ['qwen3-235b-a22b-instruct-2507', 'Qwen3 235B', 'A', '45.2%', '250k'], // Restored (2026-09-05) — still Serverless per official docs (silently dropped by PR #178)
  // ── A- tier — SWE-bench Verified 35–40% ──
  ['llama-3.3-70b-instruct', 'Llama 3.3 70B', 'B', '22.0%', '100k'], // Fixed (2026-08-13): ctx '128k' → '100k' (Serverless tier per official catalog)
  // ── B+ tier — SWE-bench Verified 30–35% ──
  ['mistral-small-3.2-24b-instruct-2506', 'Mistral Small 3.2', 'B', '20.0%', '128k'],
  // ⚠️ DEPRECATED - Scaleway EOL 2026-10-01
  ['pixtral-12b-2409', 'Pixtral 12B', 'B+', '-', '128k'], // Restored (2026-09-05) — still Serverless per official docs; PR #178 EOL claim not confirmed
  // ── B tier — SWE-bench Verified 20–30% ──
  // Removed (2026-09-05): gemma-3-27b-it (Gemma 3 27B) - Deprecated 2026-07-01, End of Life 2026-08-01; after EOL the model is no longer accessible on Generative APIs Serverless
]

// 📖 Google AI Studio source - https://aistudio.google.com
// 📖 OpenAI-compatible endpoint exposes Gemini models; free quotas vary by model and region.
export const googleai = [
  ['gemini-3.8-flash',                          'Gemini 3.8 Flash',             'S+', '-',         '1M'], // Added (2026-09-02) — free tier per official pricing page
  ['gemini-3.7-flash',                          'Gemini 3.7 Flash',             'S+', '-',         '1M'], // Added (2026-08-13)
  ['gemini-3.6-flash',                          'Gemini 3.6 Flash',             'S+', '-',         '1M'], // Added (2026-07-27)
  ['gemini-3.5-flash',                          'Gemini 3.5 Flash',             'S+', '78.0%',     '1M'], // Added (2026-09-02)
  ['gemini-3.5-flash-lite',                     'Gemini 3.5 Flash Lite',        'S', '-',         '1M'], // Added (2026-07-27)
  ['gemini-3.1-flash-lite',                     'Gemini 3.1 Flash Lite',        'S', '62.8%', '1M'],
  ['gemini-2.5-flash',                          'Gemini 2.5 Flash',             'A+', '54.0%', '1M'],
  ['gemini-2.5-flash-lite',                     'Gemini 2.5 Flash Lite',        'A',  '42.6%', '1M'],
  ['gemini-3-flash-preview',                    'Gemini 3 Flash Preview',       'S+',  '78.0%', '1M'], // Restored (2026-09-05) — free tier confirmed per official pricing page
  ['gemini-2.5-pro',                            'Gemini 2.5 Pro',               'S', '63.8%', '1M'], // Restored (2026-09-05) — free tier confirmed per official pricing page
  // Removed (2026-09-02): gemini-3.1-pro-preview (Gemini 3.1 Pro Preview) — free tier "Not available" per official pricing page (rechecked 2026-09-05)
  // Removed (2026-09-05): gemini-2.0-flash — not listed on the official pricing page (PR #178 addition reverted)
]

// 📖 ZAI source - https://open.z.ai
// 📖 Free tier is limited to Flash models; paid GLM models are intentionally excluded.
// 📖 Verified live (2026-08-23) via ping test: glm-4.5-flash and glm-4.6v-flash still serve free;
// 📖 glm-4.7-flash is free but was returning "overloaded" 429s; API /models lists only 9 text models.
export const zai = [
  // ── S+ tier — SWE-bench Verified ≥70% ──
  ['zai/glm-5.3-flash', 'GLM-5.3-Flash', 'S+', '-', '1M'], // Added (2026-09-02)
  ['zai/glm-5.2', 'GLM-5.2', 'S+', '-', '1M'], // Added (2026-08-13)
  ['zai/glm-5.3', 'GLM-5.3', 'S+', '-', '1M'],
  // ── S tier — SWE-bench Verified 60–70% ──
  ['zai/glm-4.7-flash', 'GLM-4.7-Flash', 'A+', '59.2%', '200k'], // Fixed (2026-07-27): ctx '203k' → '200k' per official docs
  ['zai/glm-4.5-flash', 'GLM-4.5-Flash', 'S', '59.2%', '128k'],
  ['zai/glm-5-turbo', 'GLM-5-Turbo', 'S', '-', '200k'], // Added (2026-08-13)
  ['zai/glm-4.7', 'GLM-4.7', 'S+', '73.8%', '200k'], // Added (2026-08-13); tier fixed: 73.8% >= 70% is S+ on the documented scale
  ['zai/glm-4.6', 'GLM-4.6', 'S', '68.0%', '200k'], // Added (2026-08-13)
  // Removed (2026-08-23): zai/glm-4.7-flashx, zai/glm-5v-turbo, zai/glm-4.6v — now paid-only ("Insufficient balance or no resource package" per ping test)
  // ── A tier — SWE-bench Verified 40–50% ──
  ['zai/glm-4.6v-flash', 'GLM-4.6V-Flash', 'A', '-', '128k'],
]

// 📖 Alibaba Cloud (DashScope) source - https://dashscope-intl.aliyuncs.com
// 📖 OpenAI-compatible endpoint: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
// 📖 Free tier: 1M tokens per model (Singapore region only), valid for 90 days
// 📖 Get API key: https://modelstudio.console.alibabacloud.com
// 📖 Env var: DASHSCOPE_API_KEY
// 📖 Qwen3-Coder models: optimized coding models with excellent SWE-bench scores
export const qwen = [
  // ── S+ tier — SWE-bench Verified ≥70% ──
  ['qwen3.7-max', 'Qwen3.7 Max', 'S+', '80.4%', '1M'],
  ['qwen3-max', 'Qwen3 Max', 'S+', '78.8%', '256k'],
  ['qwen3.6-plus', 'Qwen3.6 Plus', 'S+', '78.8%', '1M'],
  ['qwen3-235b-a22b', 'Qwen3 235B', 'S+', '70.0%', '128k'],
  ['qwen3.7-plus', 'Qwen3.7 Plus', 'S+', '-', '1M'],
  ['qwen3.6-max-preview', 'Qwen3.6 Max Preview', 'S+', '80.9%', '256k'],
  ['qwen3.8-max', 'Qwen3.8 Max', 'S+', '-', '1M'],
  ['qwen3.8-2.4t-a95b', 'Qwen3.8 2.4T A95B', 'S+', '-', '1M'],
  // ── S tier — SWE-bench Verified 60–70% ──
  ['qwen3.5-plus', 'Qwen3.5 Plus', 'S+', '80.0%', '1M'],
  ['qwen3-coder-plus', 'Qwen3 Coder Plus', 'S', '69.6%', '1M'],
  ['qwen3-coder-next', 'Qwen3 Coder Next', 'S+', '70.6%', '256k'],
  ['qwen3-coder-480b-a35b-instruct', 'Qwen3 Coder 480B', 'S', '69.6%', '256k'],
  ['qwen3.8-27b', 'Qwen3.8 27B', 'S', '-', '1M'],
  // ── A+ tier — SWE-bench Verified 50–60% ──
  ['qwen3.7-flash', 'Qwen3.7 Flash', 'A+', '-', '1M'], // Added (2026-07-27)
  ['qwen3.6-flash', 'Qwen3.6 Flash', 'A+', '60.0%', '1M'],
  ['qwen3.5-flash', 'Qwen3.5 Flash', 'S', '64.4%', '1M'],
  ['qwen3-coder-flash', 'Qwen3 Coder Flash', 'A+', '55.0%', '1M'],
  ['qwen3-vl-flash', 'Qwen3 VL Flash', 'A+', '-', '256k'], // Added (2026-08-13)
  ['qwen3-32b', 'Qwen3 32B', 'B+', '30.0%', '128k'],
  ['qwen3.5-397b-a17b', 'Qwen3.5 397B A17B', 'S+', '76.2%', '256k'],
  ['qwen3.5-122b-a10b', 'Qwen3.5 122B A10B', 'S+', '72.0%', '256k'],
  ['qwen3.5-35b-a3b', 'Qwen3.5 35B A3B', 'S', '69.2%', '256k'],
  ['qwen3-next-80b-a3b-thinking', 'Qwen3 Next 80B Thinking', 'S+', '70.6%', '128k'],
  ['qwen3-next-80b-a3b-instruct', 'Qwen3 Next 80B Instruct', 'S+', '70.6%', '128k'],
  ['qwen3.8-flash', 'Qwen3.8 Flash', 'A+', '-', '1M'],
  // ── A tier — SWE-bench Verified 40–50% ──
  ['qwen3.5-27b', 'Qwen3.5 27B', 'S+', '72.4%', '256k'],
  ['qwen3-30b-a3b', 'Qwen3 30B A3B', 'B', '25.2%', '128k'],
]

// 📖 Cloudflare Workers AI source - https://developers.cloudflare.com/workers-ai
// 📖 OpenAI-compatible endpoint requires account id:
// 📖 https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions
// 📖 Free plan includes daily neuron quota and provider-level request limits.
export const cloudflare = [
  // ── S+ tier — SWE-bench Verified ≥70% ──
  // Removed (2026-09-05): @cf/moonshotai/kimi-k2.6 (Kimi K2.6) - model still exists but docs state it is not available through standard Workers Free billing; requires Workers Paid plan or prepaid AI Gateway credits, so unusable within the free 10k neurons/day tier
  // Removed (2026-09-05): @cf/moonshotai/kimi-k2.7-code (Kimi K2.7 Code) - model still exists but docs state it is not available through standard Workers Free billing; requires Workers Paid plan or prepaid AI Gateway credits
  // Removed (2026-09-05): @cf/zai-org/glm-5.2 (GLM-5.2) - model still exists but docs state it is not available through standard Workers Free billing; requires Workers Paid plan or prepaid AI Gateway credits
  // ── S tier — SWE-bench Verified 60–70% ──
  ['@cf/zai-org/glm-4.7-flash', 'GLM-4.7-Flash', 'A+', '59.2%', '131k'],
  ['@cf/openai/gpt-oss-120b', 'GPT OSS 120B', 'S', '62.4%', '128k'],
  // ── A+ tier — SWE-bench Verified 50–60% ──
  ['@cf/nvidia/nemotron-3-120b-a12b', 'Nemotron 3 Super', 'S', '60.5%', '256k'],
  // ── A tier — SWE-bench Verified 40–50% ──
  ['@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout', 'B', '28.0%', '131k'],
  ['@cf/qwen/qwen3-30b-a3b-fp8', 'Qwen3 30B MoE', 'B', '25.2%', '32k'],
  ['@cf/qwen/qwen2.5-coder-32b-instruct', 'Qwen2.5 Coder 32B', 'A', '47.0%', '32k'],
  ['@cf/openai/gpt-oss-20b', 'GPT OSS 20B', 'A+', '50.3%', '128k'],
  ['@cf/qwen/qwq-32b', 'QwQ 32B', 'A', '-', '24k'],
  ['@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', 'DeepSeek R1 Distill Qwen 32B', 'A', '-', '80k'], // Fixed (2026-07-27): namespace 'deepseek' → 'deepseek-ai'
  // ── A- tier — SWE-bench Verified 35–40% ──
  ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Llama 3.3 70B', 'B', '22.0%', '24k'],
  ['@cf/google/gemma-4-26b-a4b-it', 'Gemma 4 26B MoE', 'A-', '38.0%', '256k'], // Fixed (2026-07-27): ctx '128k' → '256k' (April 2026 changelog)
  ['@cf/qwen/qwen3.8-27b', 'Qwen3.8 27B', 'A-', '-', '262k'],
  // ── B+ tier — SWE-bench Verified 30–35% ──
  ['@cf/mistralai/mistral-small-3.1-24b-instruct', 'Mistral Small 3.1', 'B+', '30.0%', '128k'],
  ['@cf/ibm-granite/granite-4.0-h-micro', 'Granite 4.0 Micro', 'B+', '30.0%', '131k'], // Fixed (2026-07-27): namespace 'ibm' → 'ibm-granite'
  // ── B tier — SWE-bench Verified 20–30% ──
  ['@cf/meta/llama-3.1-8b-instruct-fast', 'Llama 3.1 8B Instruct (Fast)', 'C', '18.0%', '128k'],
  // Removed (2026-08-30): @cf/google/gemma-3-12b-it (Gemma 3 12B IT) — Deprecated 2026-05-30 per Cloudflare Workers AI docs (developers.cloudflare.com/workers-ai/models/gemma-3-12b-it)
  // Removed (2026-08-30): @cf/moonshotai/kimi-k2.5 (Kimi K2.5) — Deprecated 2026-05-30 per Cloudflare changelog; replaced by @cf/moonshotai/kimi-k2.6 (developers.cloudflare.com/changelog/post/2026-05-08-planned-model-deprecations)
]

// 📖 OVHcloud AI Endpoints - https://endpoints.ai.cloud.ovh.net
// 📖 OpenAI-compatible API with European data sovereignty (GDPR)
// 📖 Free sandbox: 2 req/min per IP per model (no API key needed), 400 RPM with API key
// 📖 Env var: OVH_AI_ENDPOINTS_ACCESS_TOKEN
export const ovhcloud = [
  ['Qwen3.5-397B-A17B',                         'Qwen3.5 397B MoE',    'S+',  '76.2%',     '262k'],
  ['Qwen3.6-27B',                               'Qwen3.6 27B',         'S+',  '77.2%',     '262k'],
  // Removed (2026-07-27): Qwen3-Coder-30B-A3B-Instruct (Qwen3 Coder 30B MoE) — no longer in catalog
  ['gpt-oss-120b',                              'GPT OSS 120B',         'S',  '62.4%', '131k'],
  ['gpt-oss-20b',                               'GPT OSS 20B',          'A+',  '50.3%', '131k'],
  ['Meta-Llama-3_3-70B-Instruct',               'Llama 3.3 70B',        'B', '22.0%', '131k'],
  // Removed (2026-07-27): Qwen3-32B (Qwen3 32B) — no longer in catalog
  // Removed (2026-08-13): Mistral-Small-3.2-24B-Instruct-2506 (Mistral Small 3.2) — no longer in OVHcloud public catalog (endpoint still reachable but not listed)
  // Removed (2026-07-27): Mistral-7B-Instruct-v0.3 (Mistral 7B Instruct) — no longer in catalog
  // Removed (2026-08-13): Mistral-Nemo-Instruct-2407 (Mistral Nemo) — no longer in OVHcloud public catalog
  ['Qwen3.5-9B',                                'Qwen3.5 9B',           'B+', '30.0%', '262k'],
  ['Qwen2.5-VL-72B-Instruct', 'Qwen2.5-VL 72B', 'S', '-', '32k'], // Added (2026-08-13)
  // ── Embeddings ──
  ['Qwen3-Embedding-8B',                        'Qwen3 Embedding 8B',   'B',  '-',     '32k'], // Fixed (2026-07-27): ctx '-' → '32k'
  ['bge-m3',                                    'BGE M3',               'B',  '-',     '-'],
  ['bge-multilingual-gemma2',                   'BGE Multilingual Gemma2','B','-',     '-'],
  // Fix (2026-05-26): Qwen3.5-9B ctx 128k→262k, Mistral-Small ctx 131k→128k, Mistral-Nemo ctx 128k→118k, Mistral-7B ctx 32k→127k
  ['Qwen3Guard-Gen-8B', 'Qwen3Guard Gen 8B (moderation, beta)', 'C', '-', '32k'],
  ['Qwen3Guard-Gen-0.6B', 'Qwen3Guard Gen 0.6B (moderation, beta)', 'C', '-', '32k'],
]



// 📖 OpenCode Zen free models — hosted AI gateway accessed through OpenCode CLI/Desktop
// 📖 Endpoint: https://opencode.ai/zen/v1/... — requires OpenCode Zen API key
// 📖 These models are FREE on the Zen platform and only run on OpenCode CLI or OpenCode Desktop
// 📖 Login: https://opencode.ai/auth — get your Zen API key
// 📖 Config: set provider to opencode/<model-id> in OpenCode config
export const opencodeZen = [
  ['big-pickle',                       'Big Pickle',              'S+', '72.0%', '200k'],
  // Removed (2026-09-05): deepseek-v4-flash-free (DeepSeek V4 Flash Free) - deprecated: marked status=deprecated in the models.dev registry (2026-09-05) and dropped from the docs free-models pricing table; free promo ended
  ['mimo-v2.5-free',                   'MiMo-V2.5 Free',          'S+', '-',     '200k'],
  ['nemotron-3-ultra-free', 'Nemotron 3 Ultra Free', 'S+', '71.9%', '1M'],
  // Removed (2026-09-05): hy3-free (Tencent Hy3 Free) — absent from live /v1/models (66 models checked)
  ['nemotron-3.5-lightning-free', 'Nemotron 3.5 Lightning Free', 'S+', '-', '262k'], // Added (2026-08-13)
  // Removed (2026-09-05): laguna-s-2.1-free (Laguna S 2.1 Free) - deprecated: marked status=deprecated in the models.dev registry (2026-09-05) and absent from both the Zen /v1/models endpoint and the docs free-models list; the limited-time promo ended
  ['ling-3.0-flash-fin-free', 'Ling 3.0 Flash Fin Free', 'B+', '-', '262k'], // Added (2026-09-05) — new id in live /v1/models (was ling-3.0-flash-free)
  ['muse-spark-1.2-contributor-free', 'Muse Spark 1.2 Contributor Free', 'A+', '-', '1M'],
  ['muse-spark-1.3-contributor-free', 'Muse Spark 1.3 Contributor Free', 'S+', '-', '1M'],
]

// 📖 Kilo source - https://api.kilo.ai/api/gateway
// 📖 OpenAI-compatible gateway. `kilo-auto/free` works without a key and routes to Kilo's current free model pool.
// 📖 Keep only the stable router model here; individual promo `:free` models churn too quickly.
export const kilo = [
  ['kilo-auto/free',                         'Kilo Auto Free',      'A+', '-',     '256k'],
  // Removed (2026-09-05): kilo-auto/small (Kilo Auto Small) - no longer free: gateway now lists it with isFree=false and paid pricing ($0.05/M prompt, $0.40/M completion); it routes to paid small models
  ['thinkingmachines/inkling-small:free', 'Thinking Machines Inkling Small (free)', 'S+', '80.2%', '1M'], // tier fixed: 80.2% >= 70% is S+ on the documented scale
  ['stepfun/step-3.7-flash:free', 'StepFun Step 3.7 Flash (free)', 'A+', '-', '262k'],
  ['poolside/laguna-s-2.1:free', 'Poolside Laguna S 2.1 (free)', 'A+', '-', '262k'],
  ['nvidia/nemotron-3-ultra-550b-a55b:free', 'NVIDIA Nemotron 3 Ultra (free)', 'A+', '-', '1M'],
  ['minimax/minimax-m2.7:free', 'MiniMax M2.7 (free)', 'A-', '-', '192k'],
  ['cohere/north-mini-code:free', 'Cohere North Mini Code (free)', 'A-', '-', '256k'],
  ['nvidia/nemotron-3-super-120b-a12b:free', 'NVIDIA Nemotron 3 Super (free)', 'A-', '-', '262k'],
  ['poolside/laguna-xs-2.1:free', 'Poolside Laguna XS 2.1 (free)', 'B+', '-', '262k'],
  ['nvidia/nemotron-3.5-lightning:free', 'NVIDIA Nemotron 3.5 Lightning (free)', 'B+', '-', '1M'],
  ['dots-studio/dots-3-note-preview:free', 'Dots Studio Dots3-Note Preview (free)', 'B+', '-', '512k'],
  ['openrouter/free', 'OpenRouter Free Models Router', 'B', '-', '200k'],
  ['minimax/minimax-m3:free', 'MiniMax M3 (free)', 'S+', '80.5%', '1M'], // tier fixed: 80.5% >= 70% is S+ on the documented scale
  ['thinkingmachines/inkling:free', 'Thinking Machines Inkling (free)', 'S+', '80.2%', '1M'], // tier fixed: 80.2% >= 70% is S+ on the documented scale
]

// 📖 LLM7 source - https://api.llm7.io/v1
// 📖 Free unauthenticated tier works with tight shared limits; optional free token at https://token.llm7.io
// 📖 Pro-tagged models from /v1/models are intentionally excluded.
export const llm7 = [
  // 📖 LLM7 live /v1/models: only `turbo` tier is free (noKeyNeeded). All `pro` models are usage-based paid.
  // 📖 Verified live 2026-09-05: turbo tier = minimax-m2.7, gpt-oss, mistral-Nemo-Instruct-2407, codestral-latest.
  // Removed (2026-09-05): glm-5.3, glm-5.3-flash, gemini-3.5-flash-low, gpt-5.4, gpt-5.4-mini, gpt-5.5, gpt-5.6-sol, grok-4.5, grok-4.6 — tier=pro usage_based_only (paid) or nonexistent on /v1/models (PR #178 additions reverted)
  // ── S+ tier — SWE-bench Verified ≥70% ──
  ['minimax-m2.7', 'MiniMax M2.7', 'S+', '78.0%', '180k'],
  // ── A+ tier — SWE-bench Verified 50–60% ──
  // Removed (2026-09-05): gemini-3.1-flash-lite (Gemini 3.1 Flash Lite) — now tier=pro usage_based_only (paid) per live /v1/models
  ['gpt-oss', 'GPT OSS 20B', 'A+', '50.3%', '131k'], // Fixed (2026-09-05): id 'gpt-oss:20b' → 'gpt-oss', ctx '128k' → '131k' (live 131072)
  ['mistral-Nemo-Instruct-2407', 'Mistral Nemo 12B Instruct', 'A-', '-', '128k'], // Added (2026-08-13)
  // ── A tier — SWE-bench Verified 40–50% ──
  ['codestral-latest', 'Codestral Latest', 'A', '40.0%', '32k'],
]

// 📖 Routeway source - https://api.routeway.ai/v1/models
// 📖 OpenAI-compatible gateway with explicit zero-price `:free` chat models.
// 📖 Live catalog checked 2026-06-11; only chat-completions models with free pricing are listed.
export const routeway = [
  // ── S+ tier — SWE-bench Verified ≥70% ──
  ['deepseek-v4-flash:free', 'DeepSeek V4 Flash', 'S+', '79.0%', '42k'], // Restored (2026-09-02) — back in zero-price catalog
  // Removed (2026-09-05): step-3.7-flash:free (Step 3.7 Flash) - free variant discontinued, only paid step-3.7-flash remains ($0.20/$1.15 per M)
  ['minimax-m2.7:free', 'MiniMax M2.7', 'S+', '78.0%', '42k'], // Added (2026-09-02)
  ['muse-glimmer-30b:free', 'Muse Glimmer 30B', 'B+', '-', '131k'], // Added (2026-09-02)
  ['kimi-k2.6:free', 'Kimi K2.6', 'S+', '-', '42k'],
  // ── S tier — SWE-bench Verified 60–70% ──
  // Removed (2026-09-05): laguna-xs.2:free (Poolside Laguna XS.2) - laguna-xs.2 no longer offered in any form, superseded by paid laguna-s-2.1
  // Removed (2026-09-05): gpt-oss-120b:free (GPT OSS 120B) - free variant discontinued, only paid gpt-oss-120b remains ($0.04/$0.30 per M)
  // ── A tier — SWE-bench Verified 40–50% ──
  // Removed (2026-09-05): gemma-4-31b-it:free (Gemma 4 31B) - free variant discontinued, only paid gemma-4-31b-it remains ($0.11/$0.33 per M)
  // Removed (2026-09-05): nemotron-3-nano-30b-a3b:free (Nemotron Nano 30B) - free variant discontinued, only paid nemotron-3-nano-30b-a3b remains ($0.10/$0.15 per M)
  // ── A- tier — SWE-bench Verified 35–40% ──
  // Removed (2026-09-05): llama-3.3-70b-instruct:free (Llama 3.3 70B) - free variant discontinued, only paid llama-3.3-70b-instruct remains ($0.13/$0.39 per M)
  // ── B+ tier — SWE-bench Verified 30–35% ──
  // Removed (2026-09-05): nemotron-nano-9b-v2:free (Nemotron Nano 9B) - free variant discontinued, only paid nemotron-nano-9b-v2 remains ($0.02/$0.04 per M)
  // ── B tier — SWE-bench Verified 20–30% ──
  // Removed (2026-09-05): llama-3.1-8b-instruct:free (Llama 3.1 8B) - free variant discontinued, only paid llama-3.1-8b-instruct remains ($0.09/$0.09 per M)
  // Removed (2026-09-05): llama-3.2-3b-instruct:free (Llama 3.2 3B) - free variant discontinued, only paid llama-3.2-3b-instruct remains ($0.02/$0.05 per M)
  // ── C tier — lightweight/edge models ──
  // Removed (2026-09-05): llama-3.2-1b-instruct:free (Llama 3.2 1B) - free variant discontinued, only paid llama-3.2-1b-instruct remains ($0.15/$0.07 per M)
]

// 📖 Novita AI source - https://api.novita.ai/openai/v1/models
// 📖 Novita is mostly paid/trial-credit, so this catalog only includes live chat models reporting 0 input/output price.
// 📖 Test/dev/placeholder zero-price IDs were intentionally excluded.
export const novita = [
  // ⚠️ Empty as of 2026-08-13 — tencent/hy3 was the last zero-price entry and is now paid-only ($0.14/Mt in, $0.58/Mt out).
  // All other API entries with zero pricing are test/dev/placeholder/internal IDs and intentionally excluded.
  // ── S tier — SWE-bench Verified 60–70% ──
  // Removed (2026-08-13): tencent/hy3 (Tencent Hy3) — isFree:false per Novita pricing page
  // Removed (2026-07-27): qwen/qwen3.5-plus (Qwen3.5 Plus) — no longer in novita catalog
  ['inclusionai/ling-3.0-flash-fin', 'Ling 3.0 Flash Fin', 'B+', '-', '256k'],
  ['inclusionai/ling-3.0-flash-sante', 'Ling 3.0 Flash Sante', 'B+', '-', '256k'],
]

// 📖 Pollinations AI source - https://gen.pollinations.ai
// 📖 OpenAI-compatible endpoint: https://gen.pollinations.ai/v1/chat/completions
// 📖 Free tier: anonymous without key or free API key from https://enter.pollinations.ai
// 📖 Daily Pollen grants per tier (seed/flower/nectar) — free models cost Pollen but grants renew daily; anonymous tier has rate limits.
// 📖 Verified live 2026-08-23 via GET /v1/models (319 models); IDs below are live and coding-relevant.
export const pollinations = [
  // ── S+ tier — SWE-bench Verified ≥70% ──
  ['laguna', 'Laguna XS.2', 'S+', '70.9%', '1M'],
  ['minimax-m2.7', 'MiniMax M2.7', 'S+', '78.0%', '200k'],
  ['glm-5.3', 'Z.ai GLM-5.3', 'S+', '-', '1M'],
  ['kimi', 'Moonshot Kimi K2.6', 'S+', '80.2%', '262k'],
  ['minimax', 'MiniMax M3', 'S+', '80.5%', '524k'],
  // ── S tier — SWE-bench Verified 60–70% ──
  ['qwen-coder', 'Qwen3 Coder', 'S', '69.6%', '262k'],
  ['deepseek', 'DeepSeek V3', 'S', '66.0%', '1M'],
  ['kimi-code', 'Kimi K2 Code', 'S', '60.4%', '262k'],
  ['openai', 'OpenAI GPT', 'S', '62.4%', '400k'],
  // ── A+ tier — SWE-bench Verified 50–60% ──
  ['gemma-4-31b', 'Gemma 4 31B', 'A+', '52.0%', '262k'],
  ['gpt-oss', 'GPT OSS 20B', 'A+', '50.3%', '131k'],
  ['qwen3.7-flash', 'Qwen3.7 Flash', 'A+', '-', '1M'],
  // ── B+ tier ──
  ['nemotron-3.5-lightning', 'Nemotron 3.5 Lightning', 'B+', '-', '262k'],
]

// 📖 SiliconFlow source - https://api.siliconflow.cn/v1/chat/completions
// 📖 OpenAI-compatible endpoint: https://api.siliconflow.cn/v1
// 📖 Free tier: permanently free models at $0 (no card needed beyond phone SMS verification).
// 📖 Verified 2026-08-23 via pricing page + docs: THUDM/GLM-Z1-9B-0414 is 免费; Qwen3-8B and DeepSeek-R1-Distill-Qwen-7B
// 📖 documented as free in SiliconFlow guide 2026-06-05 ("Three models are completely free: Qwen3-8B, DeepSeek-R1-Distill-Qwen-7B, DeepSeek-OCR")
// 📖 and still reachable with free-tier rate limits (1000 RPM). Keep only the chat text models here.
export const siliconflow = [
  // ── A tier — SWE-bench Verified 40–50% ──
  ['THUDM/GLM-Z1-9B-0414', 'GLM-Z1 9B', 'A', '-', '131k'],
  ['deepseek-ai/DeepSeek-R1-0528-Qwen3-8B', 'DeepSeek R1 0528 Qwen3 8B', 'A', '-', '131k'],
  // ── B+ tier ──
  ['Qwen/Qwen3-8B', 'Qwen3 8B', 'B+', '30.0%', '131k'],
  // Removed (2026-09-05): deepseek-ai/DeepSeek-R1-Distill-Qwen-7B (DeepSeek R1 Distill Qwen 7B) - No longer listed on SiliconFlow pricing/catalog page (0 of 184 model records); superseded by the newer R1-0528 Qwen3 distill
  ['Qwen/Qwen3.5-4B', 'Qwen3.5 4B', 'A-', '-', '262k'],
  ['THUDM/GLM-4-9B-0414', 'GLM-4 9B', 'B+', '-', '32k'],
  ['Qwen/Qwen2.5-7B-Instruct', 'Qwen2.5 7B Instruct', 'B', '-', '32k'],
]

// 📖 Requesty source - https://router.requesty.ai/v1
// 📖 OpenAI-compatible gateway: https://router.requesty.ai/v1/chat/completions
// 📖 Free tier: 200 req/day on zero-price free models (4× OpenRouter), no card, EU residency, routing/caching included.
// 📖 Verified live 2026-08-23 via GET /v1/models (676 models, 12 with input_price=0 & output_price=0).
export const requesty = [
  // ── S+ tier — SWE-bench Verified ≥70% ──
  ['nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron 3 Ultra', 'S+', '71.9%', '1M'],
  ['poolside/laguna-xs.2', 'Laguna XS.2', 'S+', '70.9%', '32k'],
  // ── S tier — SWE-bench Verified 60–70% ──
  ['nvidia/nemotron-3-super-120b-a12b', 'Nemotron 3 Super', 'S', '60.5%', '1M'],
  ['poolside/laguna-m.1', 'Laguna M.1', 'S', '-', '32k'],
  // ── A+ tier — SWE-bench Verified 50–60% ──
  ['google/gemma-4-31b-it', 'Gemma 4 31B', 'A+', '52.0%', '262k'],
  ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', 'Nemotron 3 Omni', 'A+', '52.0%', '131k'],
  // ── A tier — SWE-bench Verified 40–50% ──
  ['nvidia/nemotron-3-nano-30b-a3b', 'Nemotron Nano 30B', 'A-', '38.8%', '262k'],
  // ── B+ tier — SWE-bench Verified 30–35% ──
  ['nvidia/nemotron-3.5-lightning-30b-a3b', 'Nemotron 3.5 Lightning', 'B+', '-', '1M'],
  // ── B tier — SWE-bench Verified 20–30% ──
  ['mistral/leanstral-1-5', 'Leanstral 1.5', 'B', '-', '262k'],
  ['novita/inclusionai/ling-3.0-tiny', 'Ling 3.0 Tiny', 'B', '-', '262k'],
  // ── C tier — other zero-price models (kept for breadth) ──
  ['nvidia/nemotron-3.5-content-safety', 'Nemotron Content Safety', 'C', '-', '131k'],
  ['nvidia/muse-glimmer-30b', 'Muse Glimmer 30B', 'C', '-', '131k'],
]

// 📖 OrcaRouter source - https://api.orcarouter.ai/v1
// 📖 OpenAI-compatible gateway: https://api.orcarouter.ai/v1/chat/completions
// 📖 Zero-markup AI gateway: token prices are passed through at provider rates, so only
// 📖 the explicitly $-0 models are listed here. Verified live 2026-08-30 via GET /v1/models
// 📖 (204 models, 3 with pricing.request=0). The orcarouter/fusion + orcarouter/free
// 📖 adaptive-routing models are reachable through the same endpoint for users who opt
// 📖 into pay-as-you-go billing, but are not free so they stay out of this catalog.
export const orcarouter = [
  // ── S+ tier — SWE-bench Verified ≥70% ──
  ['deepseek/deepseek-v4-flash-free', 'DeepSeek V4 Flash (Free)', 'S+', '79.0%', '1M'],
  // ── S tier — SWE-bench Verified 60–70% ──
  ['tencent/hy3-free', 'Tencent Hy3 (Free)', 'S', '-', '256k'],
  // ── A+ tier — SWE-bench Verified 50–60% ──
  ['qwen/qwen3.8-27b-free', 'Qwen3.8 27B (Free)', 'A+', '-', '64k'],
]

// 📖 Vercel AI Gateway source - https://vercel.com/docs/ai-gateway
// 📖 OpenAI-compatible gateway: https://ai-gateway.vercel.sh/v1/chat/completions
// 📖 Official Vercel gateway at list prices (zero markup). Every account gets $5 of
// 📖 gateway credits every 30 days (no card needed), and the catalog also exposes a
// 📖 handful of genuinely $0 models (input AND output priced 0). Verified live
// 📖 2026-09-05 via GET /v1/models (373 models, 5 with $0/$0 pricing).
// 📖 Caveats: the monthly credit only covers a subset of the catalog, and buying
// 📖 credits once permanently moves the account to the paid tier (official FAQ),
// 📖 which is why this provider is quotaCode 'limited'.
export const vercelGateway = [
  // ── S+ tier — SWE-bench Verified ≥70% ──
  ['minimax/minimax-m3-free', 'MiniMax M3 (Free)', 'S+', '78.4%', '1M'], // score mirrors minimax-m3 (ollama-cloud, measured 2026-07-27)
  ['minimax/minimax-m2.7-free', 'MiniMax M2.7 (Free)', 'S+', '78.0%', '196k'], // score mirrors minimax-m2.7 (ollama-cloud, measured 2026-07-27)
  ['poolside/laguna-s-2.1-free', 'Laguna S 2.1 (Free)', 'S+', '-', '256k'], // tier follows family precedent: laguna-xs-2.1 ships S+ 70.9% via NVIDIA. Caution: models.dev flags laguna-s-2.1 deprecated (2026-09-05, Zen promo ended) but Vercel still serves the $0 variant live - re-verify at next audit
  // ── B+ tier — vertical-tuned lightweight (coding secondary) ──
  ['inclusionai/ling-3.0-flash-fin-free', 'Ling 3.0 Flash Fin (Free)', 'B+', '-', '256k'], // 124B MoE (5.1B active), finance-tuned, retains coding + math
]

// 📖 Ollama Cloud source - https://ollama.com/pricing and https://ollama.com/search?c=cloud
// 📖 Free plan includes cloud model access with session/weekly limits. This list keeps coding-relevant cloud models only.
// 📖 Catalog verified 2026-07-18 against official Ollama cloud model search page.
export const ollamaCloud = [
  // ── S+ tier — SWE-bench Verified ≥70% ──
  ['nemotron-3-ultra', 'Nemotron 3 Ultra', 'S+', '71.9%', '256k'],
  ['glm-5.1', 'GLM 5.1', 'S+', '82.8%', '198k'], // Fixed (2026-07-27): ctx '128k' → '198k'
  ['glm-5.2', 'GLM 5.2', 'S+', '82.8%', '976k'], // Fixed (2026-07-27): ctx '128k' → '1M'
  ['minimax-m2.7', 'MiniMax M2.7', 'S+', '78.0%', '200k'],
  ['minimax-m3', 'MiniMax M3', 'S+', '78.4%', '512k'], // Fixed (2026-07-27): ctx '512k' → '1M'
  // Removed (2026-08-23): minimax-m2.5 (MiniMax M2.5) — no longer in ollama.com/v1/models (19 models live)
  ['kimi-k2.6', 'Kimi K2.6', 'S+', '80.2%', '256k'], // Fixed (2026-07-27): ctx '262k' → '256k'
  ['deepseek-v4-flash:0731', 'DeepSeek V4 Flash', 'S+', '79.0%', '1M'], // Fixed (2026-08-23): ID 'deepseek-v4-flash' → 'deepseek-v4-flash:0731' (renamed upstream)
  ['deepseek-v4-pro:0813', 'DeepSeek V4 Pro', 'S+', '80.6%', '1M'], // Fixed (2026-08-23): ID 'deepseek-v4-pro' → 'deepseek-v4-pro:0813' (renamed upstream)
  ['glm-5.3', 'GLM 5.3', 'S+', '-', '1M'],
  // ── S tier — SWE-bench Verified 60–70% ──
  ['kimi-k2.7-code', 'Kimi K2.7 Code', 'S', '60.4%', '256k'], // Fixed (2026-07-27): ctx '262k' → '256k'
  ['gpt-oss:120b', 'GPT OSS 120B', 'S', '62.4%', '128k'],
  ['nemotron-3-super', 'Nemotron 3 Super', 'S', '60.5%', '256k'],
  ['kimi-k3', 'Kimi K3', 'S+', '-', '1M'], // Added (2026-07-27)
  // Removed (2026-08-23): gemini-3-flash-preview (Gemini 3 Flash Preview) — no gemini models left in Ollama Cloud API
  ['glm-5.3-flash', 'GLM 5.3 Flash', 'S', '-', '1M'],
  // ── A+ tier — SWE-bench Verified 50–60% ──
  // Removed (2026-08-23): kimi-k2.5 (Kimi K2.5) — no longer in ollama.com/v1/models
  ['gemma4:31b', 'Gemma 4 31B', 'A+', '52.0%', '256k'], // Fixed (2026-07-27): ctx '256k' → '128k'
  ['gpt-oss:20b', 'GPT OSS 20B', 'A+', '50.3%', '128k'],
  ['mistral-large-3:675b', 'Mistral Large 3 675B Cloud', 'A+', '-', '256k'], // Fixed (2026-08-23): ID 'mistral-large-3:675b-cloud' → 'mistral-large-3:675b' (tag renamed upstream)
  ['qwen3.5:397b', 'Qwen 3.5 Cloud', 'A+', '-', '256k'], // Fixed (2026-08-23): ID 'qwen3.5' → 'qwen3.5:397b' (tag renamed upstream)
  ['nemotron-3-nano:30b', 'Nemotron 3 Nano 30B', 'A-', '38.8%', '1M'],
]

// 📖 All sources combined - used by the main script
// 📖 Each source has: name (display), url (API endpoint), models (array of model tuples)
// 📖 Providers ordered by generosity of free tier (most generous first)
// 📖 See README for full tier-by-tier comparison
// 📖 Each provider now carries a `quota` (human-readable summary) and a
// 📖 `quotaCode` (machine code: 'free' | 'limited' | 'metered') so the website
// 📖 can render a sortable, filterable catalog without re-typing the rules in
// 📖 a second file. The CLI ignores these fields, so this is fully backward-
// 📖 compatible with the existing TUI / router-daemon / OpenCode integration.
export const sources = {
  nvidia: {
    name: 'NVIDIA NIM',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    quota: 'Free · 1000 req/month',
    quotaCode: 'free',
    models: nvidiaNim,
  },
  groq: {
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    quota: 'Free · ~30-50 RPM per model',
    quotaCode: 'free',
    models: groq,
  },
  cerebras: {
    name: 'Cerebras',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    quota: 'Free · generous dev tier',
    quotaCode: 'free',
    models: cerebras,
  },
  googleai: {
    name: 'Google AI',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    quota: 'Free · Gemini quotas vary by model',
    quotaCode: 'free',
    models: googleai,
  },
  // 'github-models': REMOVED 2026-08-13 — GitHub Models retired 2026-07-30 (HTTP 410 Gone).
  // Provider metadata still references this key for backwards compat in user configs,
  // but it is no longer exposed in the catalog.
  // 'github-models': {
  //   name: 'GitHub Models',
  //   url: 'https://models.github.ai/inference/chat/completions',
  //   quota: 'GitHub / Copilot plan quota',
  //   quotaCode: 'metered',
  //   models: githubModels,
  // },
  mistral: {
    name: 'Mistral LP',
    url: 'https://api.mistral.ai/v1/chat/completions',
    quota: 'Free Experiment plan',
    quotaCode: 'free',
    models: mistral,
  },
  cloudflare: {
    name: 'Cloudflare AI',
    url: 'https://api.cloudflare.com/client/v4/accounts/{$CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions',
    quota: 'Free · 10k neurons/day',
    quotaCode: 'limited',
    models: cloudflare,
  },
  openrouter: {
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    quota: '50 free req/day · 1000 with $10 credit',
    quotaCode: 'limited',
    models: openrouter,
  },
  sambanova: {
    name: 'SambaNova',
    url: 'https://api.sambanova.ai/v1/chat/completions',
    quota: 'Small dev tier · light use',
    quotaCode: 'limited',
    models: sambanova,
  },
  ovhcloud: {
    name: 'OVHcloud AI',
    url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
    quota: 'Free sandbox · 2 RPM no key · 400 RPM with key',
    quotaCode: 'free',
    models: ovhcloud,
  },
  codestral: {
    name: 'Codestral',
    url: 'https://api.mistral.ai/v1/chat/completions',
    quota: 'Free · 30 req/min, 2000/day',
    quotaCode: 'free',
    models: codestral,
  },
  zai: {
    name: 'ZAI',
    url: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
    quota: 'Free · Flash models only',
    quotaCode: 'free',
    models: zai,
  },
  scaleway: {
    name: 'Scaleway',
    url: 'https://api.scaleway.ai/v1/chat/completions',
    quota: '1M free tokens',
    quotaCode: 'limited',
    models: scaleway,
  },
  qwen: {
    name: 'Alibaba DashScope',
    url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    quota: '1M tokens/model · 90 days (Singapore)',
    quotaCode: 'limited',
    models: qwen,
  },

  'opencode-zen': {
    name: 'OpencodeZen',
    url: 'https://opencode.ai/zen/v1/chat/completions',
    quota: 'Free · Zen key required',
    quotaCode: 'free',
    models: opencodeZen,
    zenOnly: true,
  },
  kilo: {
    name: 'Kilo',
    url: 'https://api.kilo.ai/api/gateway/chat/completions',
    quota: 'Free · no key needed',
    quotaCode: 'free',
    models: kilo,
    noKeyNeeded: true,
  },
  llm7: {
    name: 'LLM7',
    url: 'https://api.llm7.io/v1/chat/completions',
    quota: 'Free · no key needed',
    quotaCode: 'limited',
    models: llm7,
    noKeyNeeded: true,
  },
  routeway: {
    name: 'Routeway',
    url: 'https://api.routeway.ai/v1/chat/completions',
    quota: 'Free :free models only',
    quotaCode: 'free',
    models: routeway,
  },
  novita: {
    name: 'Novita AI',
    url: 'https://api.novita.ai/openai/v1/chat/completions',
    quota: 'No zero-price models as of 2026-08-13',
    quotaCode: 'limited',
    models: novita, // Empty — kept for backward compat in user configs
  },
  pollinations: {
    name: 'Pollinations AI',
    url: 'https://gen.pollinations.ai/v1/chat/completions',
    quota: 'Free · daily Pollen grants · key at enter.pollinations.ai',
    quotaCode: 'free',
    models: pollinations,
  },
  siliconflow: {
    name: 'SiliconFlow',
    url: 'https://api.siliconflow.cn/v1/chat/completions',
    quota: 'Free · 3 models @ $0 · 1000 RPM',
    quotaCode: 'free',
    models: siliconflow,
  },
  requesty: {
    name: 'Requesty',
    url: 'https://router.requesty.ai/v1/chat/completions',
    quota: 'Free · 200 req/day · no card',
    quotaCode: 'free',
    models: requesty,
  },
  orcarouter: {
    name: 'OrcaRouter',
    url: 'https://api.orcarouter.ai/v1/chat/completions',
    quota: 'Free · 3 $-0 models · zero markup',
    quotaCode: 'free',
    models: orcarouter,
  },
  'vercel-gateway': {
    name: 'Vercel AI Gateway',
    url: 'https://ai-gateway.vercel.sh/v1/chat/completions',
    quota: 'Free · $5 credits/30 days + $0 models · no card',
    quotaCode: 'limited',
    models: vercelGateway,
  },
  'ollama-cloud': {
    name: 'Ollama Cloud',
    url: 'https://ollama.com/v1/chat/completions',
    quota: 'Free plan · session + weekly caps',
    quotaCode: 'free',
    models: ollamaCloud,
  },
}

// 📖 Flatten all models from all sources — each entry includes providerKey as 6th element
// 📖 providerKey lets the main CLI know which API key and URL to use per model
// 📖 Models with a deprecatedAfter date (7th tuple element) are auto-filtered after that date
export const MODELS = [];
const _today = new Date().toISOString().split('T')[0];
for (const [sourceKey, sourceData] of Object.entries(sources)) {
  if (!sourceData || !sourceData.models) continue
  for (const model of sourceData.models) {
    const [modelId, label, tier, sweScore, ctx, addedDate, deprecatedAfter] = model
    if (deprecatedAfter && _today > deprecatedAfter) continue
    MODELS.push([modelId, label, tier, sweScore, ctx, sourceKey, addedDate || null])
  }
}

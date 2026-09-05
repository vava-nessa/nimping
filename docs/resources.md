# Other Free AI Resources

Curated resources kept **outside** the active CLI catalog: IDE extensions, coding agents, GitHub lists, and providers that are useful but not clean enough for the core free-provider table. The core catalog lives in [providers.md](./providers.md).

## Awesome Lists (curated by the community)

| Resource | What it is |
|----------|------------|
| [cheahjs/free-llm-api-resources](https://github.com/cheahjs/free-llm-api-resources) (18.4k stars) | Comprehensive list of free LLM API providers with rate limits |
| [mnfst/awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis) (2.1k stars) | Permanent free LLM API tiers organized by provider |
| [inmve/free-ai-coding](https://github.com/inmve/free-ai-coding) (648 stars) | Pro-grade AI coding tools side-by-side: limits, models, CC requirements |
| [amardeeplakshkar/awesome-free-llm-apis](https://github.com/amardeeplakshkar/awesome-free-llm-apis) | Additional free LLM API resources |

## AI-Powered IDEs with Free Tiers

| IDE | Free tier | Credit card |
|-----|-----------|-------------|
| [Qwen Code](https://github.com/QwenLM/qwen-code) | 2,000 requests/day | No |
| [Jules](https://jules.google/) | 15 tasks/day | No |
| [AWS Kiro](https://kiro.dev/) | 50 credits/month | No |
| [Trae](https://trae.ai/) | 10 fast + 50 slow requests/month | No |
| [Codeium](https://codeium.com/) | Unlimited forever, basic models | No |
| [JetBrains AI Assistant](https://www.jetbrains.com/ai/) | Unlimited completions + local models | No |
| [Continue.dev](https://www.continue.dev/) | Free VS Code/JetBrains extension, local models via Ollama | No |
| [Warp](https://warp.dev/) | 150 credits/month (first 2 months), then 75/month | No |
| [Amazon Q Developer](https://aws.amazon.com/q/developer/) | 50 agentic requests/month | Required |
| [Windsurf](https://windsurf.com/) | 25 prompt credits/month | Required |
| [Kilo Code](https://kilocode.ai/) | Up to $25 signup credits (one-time) | Required |
| [Tabnine](https://www.tabnine.com/) | Basic completions + chat (limited) | Required |
| [SuperMaven](https://www.supermaven.com/) | Basic suggestions, 1M token context | Required |

## API Providers with Permanent Free Tiers

| Provider | Free limits | Notable models |
|----------|-------------|----------------|
| [Vercel AI Gateway](https://vercel.com/ai-gateway) | $5 credits every 30 days (no card) + explicit $0 models | MiniMax M3 (1M ctx), Laguna S 2.1, MiniMax M2.7, Ling 3.0 Flash Fin |
| [OrcaRouter](https://www.orcarouter.ai) | Free Hacker tier, zero token markup, 3 API keys | DeepSeek V4 Flash (Free), Tencent Hy3 (Free), Qwen3.8 27B (Free) |
| [OpenRouter](https://openrouter.ai/keys) | 50 req/day, 1K/day with $10 purchase | Qwen3-Coder, Tencent HY3, Laguna, Gemma 4 |
| [Google AI Studio](https://aistudio.google.com/apikey) | Varies by Gemini model and region | Gemini 3.8 Flash, Gemini 2.5 Pro |
| [NVIDIA NIM](https://build.nvidia.com) | ~40 RPM | MiniMax M2.7, GLM 5.1, Kimi K2.6 |
| [GitHub Models](https://models.github.ai) | Depends on GitHub/Copilot tier | GPT-4.1, DeepSeek V3, Llama 4 |
| [Groq](https://console.groq.com/keys) | 1K-14.4K req/day (model-dependent) | Llama 3.3 70B, Llama 4 Scout, GPT-OSS |
| [Cerebras](https://cloud.cerebras.ai/) | 30 RPM, 1M tokens/day | Qwen3-235B, Llama 3.1 70B, GPT-OSS 120B |
| [Cohere](https://cohere.com/) | 20 RPM, 1K/month | Command R+, Aya Expanse 32B |
| [Mistral La Plateforme](https://console.mistral.ai/) | 1 req/s, 1B tokens/month | Mistral Large, Devstral, Magistral |
| [Cloudflare Workers AI](https://dash.cloudflare.com) | 10K neurons/day | Llama 3.3 70B, QwQ 32B, 47+ models |
| [OVHcloud AI Endpoints](https://endpoints.ai.cloud.ovh.net) | 2 req/min/IP sandbox | GPT-OSS, Qwen3, Mistral |

## Good candidates kept outside the core catalog

| Provider | Why it's not core |
|----------|--------------------|
| [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) | Useful gateway with included credits, but it's a router/billing layer, not a provider of permanently free models. |
| [Cohere](https://cohere.com/) | Real evaluation key, but the allowance is small and the catalog isn't coding-first enough for the default TUI. |
| [Ollama Cloud](https://ollama.com/pricing) | Interesting for light cloud usage, but closer to hosted Ollama capacity than a classic OpenAI-compatible free provider. |

## Providers with Trial Credits

| Provider | Credits | Duration |
|----------|---------|----------|
| [Hyperbolic](https://app.hyperbolic.ai/) | $1 | Trial/promo |
| [Fireworks](https://fireworks.ai/) | $1 | Trial/promo |
| [Nebius](https://tokenfactory.nebius.com/) | $1 | Permanent |
| [SambaNova Cloud](https://cloud.sambanova.ai/) | $5 | 3 months |
| [AI21](https://studio.ai21.com/) | $10 | 3 months |
| [Upstage](https://console.upstage.ai/) | $10 | 3 months |
| [NLP Cloud](https://nlpcloud.com/home) | $15 | Permanent |
| [Alibaba DashScope](https://bailian.console.alibabacloud.com/) | 1M tokens/model | 90 days |
| [Scaleway](https://console.scaleway.com/generative-api/models) | 1M tokens | Permanent |
| [Modal](https://modal.com) | $5/month | Monthly |
| [Inference.net](https://inference.net) | $1 (+ $25 on survey) | Permanent |
| [Novita](https://novita.ai/) | $0.5 | 1 year |

These trial-credit providers are deliberately not treated as core unless their free allowance is practical for recurring coding use.

## Free with Education / Developer Programs

| Program | What you get |
|---------|--------------|
| [GitHub Student Pack](https://education.github.com/pack) | Free Copilot Pro for students (verify with .edu email) |
| [GitHub Copilot Free](https://code.visualstudio.com/blogs/2024/12/18/free-github-copilot) | 50 chat + 2,000 completions/month in VS Code |
| [Copilot Pro for teachers/maintainers](https://docs.github.com/en/copilot/how-tos/manage-your-account/get-free-access-to-copilot-pro) | Free Copilot Pro for open-source maintainers and educators |

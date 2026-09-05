/**
 * @file src/routes/index.tsx
 * @description Landing page for free-coding-models — OpenRouter-inspired:
 *   all-dark surface, subtle borders, lime accent, compact type scale.
 *   Tabler Icons used throughout for visual consistency.
 */
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  IconRadar,
  IconBolt,
  IconServer2,
  IconTerminal2,
  IconBrandDocker,
  IconRocket,
  IconBrandGithub,
  IconCheck,
  IconActivity,
  IconTable,
  IconArrowRight,
} from '@tabler/icons-react'
import { CopyCommand } from '~/components/CopyCommand'
import { ToolMarquee } from '~/components/ToolMarquee'
import { AllToolsSection } from '~/components/AllToolsSection'
import { ProvidersGrid } from '~/components/ProviderSection'
import { Testimonials } from '~/components/Testimonials'
import Scanner from '~/components/Scanner'
import { INSTALL_COMMAND, site } from '~/lib/site'
import { getProviderCount, getTierCount, getTotalCount } from '~/lib/catalog'
import { HomeStructuredData } from '~/components/StructuredData'

export const Route = createFileRoute('/')({
  head: () => ({
    links: [{ rel: 'canonical', href: `${site.url}/` }],
  }),
  component: Home,
})

function Home() {
  return (
    <>
      <HomeStructuredData />
      <Hero />
      <MonitorSection />
      <TierSection />
      <CatalogPreviewSection />
      <IntegrationsSection />
      <AllToolsSection />
      <ProvidersGridSection />
      <Testimonials />
      <CtaSection />
    </>
  )
}

function Shell({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`mx-auto max-w-6xl px-5 sm:px-8 ${className}`}>{children}</div>
}

/* ── Hero — OpenRouter-style: bold centered, lime pill, subtle gradient ── */

function Hero() {
  return (
    <section className="relative border-b border-border overflow-hidden">
      {/* Scanner — React Bits defaults (image fournie) */}
      <div aria-hidden="true" className="absolute inset-0 z-0">
        <Scanner
          color1="#5227FF"
          color2="#FF9FFC"
          color3="#FFFFFF"
          speed={0.5}
          sweepSpeed={0.25}
          sweepWidth={1.6}
          sweepFalloff={6}
          scale={1.5}
          frequency={2}
          ripple={0.22}
          bandDensity={11}
          lineSharpness={5.5}
          glow={0.22}
          scanDirection="vertical"
          colorSpread={0.7}
          brightness={1.0}
          contrast={1.15}
          softness={1.4}
          vignette={0.45}
          scanline
          grain
          grainIntensity={0.05}
          opacity={1.0}
          mouseInteraction
          mouseRadius={0.5}
          mouseStrength={0.5}
        />
        {/* Fade bottom into page background for text legibility */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-bg/10 to-bg" />
      </div>

      <Shell className="relative z-10">
        <div className="py-14 sm:py-20 flex flex-col items-center text-center max-w-4xl mx-auto">
          <div className="mb-6 text-[11px] font-medium tracking-[0.18em] uppercase text-accent-fg/60">
            Free · Open Source · Easy Config
          </div>

          <h1 className="animate-rise text-4xl leading-[1.05] font-semibold tracking-[-0.035em] text-balance sm:text-6xl text-fg">
            The unified dashboard
            <br />
            <span className="text-fg-muted">for free AI coding models.</span>
          </h1>

          <p className="animate-rise mt-6 max-w-2xl text-base leading-relaxed text-fg-muted sm:text-lg">
            free-coding-models pings every free AI endpoint in real time, ranks them by benchmark score, and switches automatically when a provider cuts you off.
          </p>

          <div className="animate-rise mt-10 flex flex-col gap-3 sm:flex-row sm:items-center justify-center">
            <Link
              to="/docs/$"
              params={{ _splat: 'quick-start' }}
              className="group inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-ink transition-all hover:opacity-90"
            >
              <IconRocket size={16} stroke={2} />
              Get started
            </Link>
            <a
              href={site.repo}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-bg-raised/40 px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-bg-raised"
            >
              <IconBrandGithub size={16} stroke={1.75} />
              GitHub
            </a>
          </div>

          <div className="animate-rise mt-14 w-full max-w-2xl">
            <div className="rounded-lg border border-border bg-bg-subtle/60 p-1.5 backdrop-blur-sm">
              <CopyCommand command={INSTALL_COMMAND} className="w-full" />
            </div>
          </div>

          {/* 📖 LobeHub-powered marquee — scrolls all supported tools + providers
              in two rows. Sits right below the install command so the user sees
              the supported ecosystem before they scroll. */}
          <div className="mt-10 w-full overflow-hidden">
            <ToolMarquee />
          </div>

          <div className="animate-rise mt-16 grid w-full max-w-3xl grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
            {[
              { number: String(getTotalCount()), label: 'Models' },
              { number: String(getProviderCount()), label: 'Providers' },
              { number: String(getTierCount('S+')), label: 'S+ tier' },
              { number: '<100ms', label: 'Failover' },
            ].map(({ number, label }) => (
              <div key={label} className="bg-bg p-5 text-center">
                <p className="font-mono text-2xl font-bold text-fg tabular-nums sm:text-3xl">{number}</p>
                <p className="mt-1.5 text-xs text-fg-muted">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </Shell>
    </section>
  )
}

/* ── Monitor Section ──────────────────────────────────────────────────────── */

function MonitorSection() {
  const stats = [
    {
      icon: IconRadar,
      title: 'Live pings',
      detail: 'Google, NVIDIA, Groq, Cerebras, Scaleway, Mistral, and more — all pinged in parallel every few seconds.',
    },
    {
      icon: IconBolt,
      title: 'Instant failover',
      detail: 'When a provider returns 429 or a timeout, the next model takes over without you noticing.',
    },
    {
      icon: IconServer2,
      title: 'Auto-discovered',
      detail: 'Updated continuously as providers launch new free tiers or deprecate old models.',
    },
  ]

  return (
    <section className="border-b border-border py-20 sm:py-28">
      <Shell>
        <div className="max-w-xl mb-14">
          <span className="font-mono text-xs font-medium text-fg-faint uppercase tracking-wider">01 — How it works</span>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
            A live dashboard for free AI servers.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-fg-muted sm:text-lg">
            Every free provider has its own rate limits, latency, and uptime. free-coding-models pings them all in parallel so you always know what's working right now.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {stats.map(({ icon: Icon, title, detail }) => (
            <div key={title} className="rounded-lg border border-border bg-bg-subtle/50 p-6 transition-colors hover:border-border-strong">
              <Icon size={22} className="text-fg-muted mb-4" stroke={1.5} />
              <p className="text-base font-semibold text-fg">{title}</p>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">{detail}</p>
            </div>
          ))}
        </div>
      </Shell>
    </section>
  )
}

/* ── Tier Section ─────────────────────────────────────────────────────────── */

function TierSection() {
  return (
    <section className="border-b border-border py-20 sm:py-28">
      <Shell>
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <div className="flex items-center gap-2 mb-4">
              <IconActivity size={14} className="text-fg-muted" stroke={1.75} />
              <span className="font-mono text-xs font-medium text-fg-faint uppercase tracking-wider">02 — Benchmark ranking</span>
            </div>
            <h2 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              Not all free models are equal.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-fg-muted sm:text-lg">
              Every model in the catalog is ranked by its <strong className="text-fg font-semibold">SWE-bench Verified score</strong> — the industry benchmark for real coding tasks. You choose the tier. The tool handles the rest.
            </p>
            <p className="mt-4 text-base leading-relaxed text-fg-muted sm:text-lg">
              S+ models solve 70%+ of real GitHub issues. S and A tiers cover everyday coding. Filter by tier in the TUI or pass <code className="font-mono text-sm text-fg bg-bg-raised px-1.5 py-0.5 rounded border border-border">--tier S</code> to the CLI.
            </p>
          </div>

          <div className="rounded-lg border border-border overflow-hidden">
            {[
              { tier: 'S+', range: '70 %+',    desc: 'Frontier models. Complex refactors, agentic loops.' },
              { tier: 'S',  range: '60–70 %',  desc: 'Excellent general coding. Most tasks.' },
              { tier: 'A+', range: '50–60 %',  desc: 'Great alternatives with high throughput.' },
              { tier: 'A',  range: '40–50 %',  desc: 'Solid completions, quick edits.' },
              { tier: 'B+', range: '30–40 %',  desc: 'Lightweight models for constrained setups.' },
            ].map((row, i) => (
              <div
                key={row.tier}
                className={`flex items-center gap-4 px-5 py-3 ${i > 0 ? 'border-t border-border' : ''}`}
              >
                <span className="w-12 shrink-0 font-mono text-base font-bold text-fg">{row.tier}</span>
                <span className="w-20 shrink-0 font-mono text-xs text-fg-faint tabular-nums">{row.range}</span>
                <span className="text-sm text-fg-muted">{row.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </Shell>
    </section>
  )
}

/* ── Catalog Preview Section ─────────────────────────────────────────────── */

function CatalogPreviewSection() {
  return (
    <section className="border-b border-border py-20 sm:py-28">
      <Shell>
        <div className="grid gap-12 lg:grid-cols-[1.1fr_1fr] lg:items-center">
          <div>
            <div className="flex items-center gap-2 mb-4">
              <IconTable size={14} className="text-fg-muted" stroke={1.75} />
              <span className="font-mono text-xs font-medium text-fg-faint uppercase tracking-wider">03 — Live catalog</span>
            </div>
            <h2 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              Browse every model, live.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-fg-muted sm:text-lg">
              The full catalog is on the website too — every free model, every provider, with SWE-bench scores, context windows, and quota details. Filter by tier, sort by anything, copy a CLI launch command with one click.
            </p>
            <ul className="mt-5 space-y-2 text-sm text-fg-muted">
              {[
                'Auto-generated from sources.js — never out of date',
                'Sortable columns: tier, SWE, context, quota',
                'Filter by tier chip, quota, or provider',
                'Copy a CLI launch command for any model',
              ].map((feat) => (
                <li key={feat} className="flex items-start gap-2.5">
                  <IconCheck size={15} className="mt-0.5 shrink-0 text-fg-muted" stroke={2} />
                  <span>{feat}</span>
                </li>
              ))}
            </ul>
            <Link
              to="/models"
              className="group mt-7 inline-flex items-center gap-2 rounded-lg border border-border bg-bg-raised/40 px-4 py-2.5 text-sm font-semibold text-fg transition-colors hover:bg-bg-raised"
            >
              Open the catalog
              <IconArrowRight size={15} stroke={2.5} className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>

          {/* Static preview of the /models table — matches the live page. */}
          <div className="overflow-hidden rounded-lg border border-border bg-bg-subtle/40">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] border-collapse text-sm">
                <thead>
                  <tr className="bg-bg-raised text-left text-fg">
                    <th className="px-3 py-2 text-center font-mono text-[10px] font-semibold uppercase tracking-wider w-[10%]">#</th>
                    <th className="px-3 py-2 text-center font-mono text-[10px] font-semibold uppercase tracking-wider w-[10%]">Tier</th>
                    <th className="px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider w-[40%]">Model</th>
                    <th className="px-3 py-2 text-right font-mono text-[10px] font-semibold uppercase tracking-wider w-[20%]">SWE%</th>
                    <th className="px-3 py-2 text-right font-mono text-[10px] font-semibold uppercase tracking-wider w-[20%]">CTX</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { rank: 1, tier: 'S+', label: 'GLM 5.1', id: 'z-ai/glm-5.2', swe: '82.8%', ctx: '128k', border: 'border-l-[3px] border-l-[#ffd700]' },
                    { rank: 2, tier: 'S+', label: 'GLM 5.2', id: '@cf/zai-org/glm-5.2', swe: '82.8%', ctx: '262k', border: 'border-l-[3px] border-l-[#c0c0c0]' },
                    { rank: 3, tier: 'S+', label: 'GLM 5.2', id: 'glm-5.2', swe: '82.8%', ctx: '1M', border: 'border-l-[3px] border-l-[#cd7f32]' },
                    { rank: 4, tier: 'S+', label: 'GLM 5.1', id: 'glm-5.1', swe: '82.8%', ctx: '198k', border: 'border-l-[3px] border-l-transparent' },
                    { rank: 5, tier: 'S+', label: 'Qwen3.6 Max Preview', id: 'qwen3.6-max-preview', swe: '80.9%', ctx: '256k', border: 'border-l-[3px] border-l-transparent' },
                  ].map((row) => (
                    <tr key={row.rank} className={`border-t border-border/60 ${row.border}`}>
                      <td className="px-3 py-2 text-center font-mono text-[11px] font-medium text-fg-faint tabular-nums">{row.rank}</td>
                      <td className="px-3 py-2 text-center">
                        <span className="inline-flex items-center rounded border border-border bg-bg-raised px-1.5 py-0.5 font-mono text-[11px] font-semibold text-fg">{row.tier}</span>
                      </td>
                      <td className="px-3 py-2">
                        <p className="truncate text-[12px] font-medium text-fg">{row.label}</p>
                        <p className="truncate font-mono text-[10px] text-fg-faint">{row.id}</p>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[12px] font-semibold tabular-nums text-fg">{row.swe}</td>
                      <td className="px-3 py-2 text-right font-mono text-[12px] tabular-nums text-fg-muted">{row.ctx}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-border px-3 py-1.5 font-mono text-[10px] text-fg-faint">
              + {getTotalCount() - 5} more models · live at /models
            </div>
          </div>
        </div>
      </Shell>
    </section>
  )
}

/* ── Integrations Section ─────────────────────────────────────────────────── */

function IntegrationsSection() {
  const integrations = [
    {
      icon: IconTerminal2,
      title: 'CLI & Terminal UI',
      desc: 'A full ANSI TUI with sorting, search, tier filtering and keybindings. Works in any terminal.',
      cmd: 'free-coding-models',
    },
    {
      icon: IconRocket,
      title: 'OpenCode',
      desc: 'Plug directly into OpenCode CLI. The best live model is injected automatically into your session.',
      cmd: 'free-coding-models --opencode',
    },
    {
      icon: IconBolt,
      title: 'OpenClaw & Hermes',
      desc: 'Route agentic loops through the best available free model. Transparent to the agent.',
      cmd: 'free-coding-models --openclaw',
    },
    {
      icon: IconBrandDocker,
      title: 'Docker API',
      desc: 'An OpenAI-compatible proxy on localhost:19280. Drop it in front of any tool that expects an API.',
      cmd: 'docker run free-coding-models',
    },
  ]

  return (
    <section className="border-b border-border py-20 sm:py-28">
      <Shell>
        <div className="max-w-xl mb-12">
          <div className="flex items-center gap-2 mb-4">
            <IconServer2 size={14} className="text-fg-muted" stroke={1.75} />
            <span className="font-mono text-xs font-medium text-fg-faint uppercase tracking-wider">04 — Works everywhere</span>
          </div>
          <h2 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
            One tool. Any workflow.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-fg-muted sm:text-lg">
            Use it as a standalone TUI, embed it into your coding agent, or proxy any OpenAI-compatible tool through it.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {integrations.map(({ icon: Icon, title, desc, cmd }) => (
            <div key={title} className="rounded-lg border border-border bg-bg-subtle/40 p-5 flex flex-col gap-4 transition-colors hover:border-border-strong hover:bg-bg-subtle/70">
              <Icon size={22} className="text-fg-muted" stroke={1.5} />
              <div className="flex-1">
                <p className="text-base font-semibold text-fg">{title}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{desc}</p>
              </div>
              <code className="font-mono text-xs text-fg bg-bg-raised px-3 py-1.5 rounded border border-border self-start">
                $ {cmd}
              </code>
            </div>
          ))}
        </div>

        {/* Pi Extension */}
        <div className="mt-3 rounded-lg border border-border bg-bg-subtle/40 overflow-hidden">
          <div className="flex flex-col lg:flex-row">
            <div className="flex-1 p-6 lg:p-8">
              <div className="flex items-center gap-3 mb-4">
                <span className="rounded-md bg-accent px-2.5 py-1 font-mono text-[11px] font-bold text-ink">
                  Pi Extension
                </span>
              </div>
              <h3 className="text-xl font-semibold tracking-tight text-fg">
                Native Pi IDE integration
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-fg-muted max-w-lg">
                Switch between 100+ free models without leaving your editor. The Pi extension adds an inline model picker, auto-failover, and tier filtering directly into your Pi sidebar — zero configuration required.
              </p>
              <code className="mt-5 inline-block font-mono text-xs text-fg bg-bg-raised px-3 py-1.5 rounded border border-border">
                $ free-coding-models --pi
              </code>
            </div>
            <div className="lg:w-64 border-t lg:border-t-0 lg:border-l border-border p-6 flex flex-col justify-center gap-3">
              {[
                'Inline model picker',
                'Auto-failover',
                'Tier filter (S+ / S)',
                'Zero config',
              ].map((feat) => (
                <div key={feat} className="flex items-center gap-2.5">
                  <IconCheck size={15} className="text-fg-muted shrink-0" stroke={2.5} />
                  <span className="text-sm font-medium text-fg">{feat}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Shell>
    </section>
  )
}

/* ── CTA ──────────────────────────────────────────────────────────────────── */

/* ── Providers Grid Section ─────────────────────────────────────────────── */

function ProvidersGridSection() {
  return <ProvidersGrid />
}

function CtaSection() {
  return (
    <section className="py-24">
      <Shell>
        <div className="rounded-2xl border border-border bg-bg-subtle/40 px-6 py-14 sm:px-12 text-center flex flex-col items-center">
          <h2 className="text-2xl font-semibold tracking-tight text-fg sm:text-4xl">
            Start in 30 seconds.
          </h2>
          <p className="mt-4 max-w-md text-sm text-fg-muted sm:text-base">
            One global install. No account. No API key required to get started.
          </p>

          <div className="mt-8 w-full max-w-md">
            <CopyCommand command={INSTALL_COMMAND} className="w-full" />
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/docs/$"
              params={{ _splat: 'quick-start' }}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink transition-opacity hover:opacity-90"
            >
              <IconRocket size={15} stroke={2} />
              Read the docs
            </Link>
            <a
              href={site.repo}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg-raised/40 px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-bg-raised"
            >
              <IconBrandGithub size={15} stroke={1.75} />
              GitHub
            </a>
          </div>
        </div>
      </Shell>
    </section>
  )
}

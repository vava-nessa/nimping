/**
 * @file src/components/ProviderSection.tsx
 * @description Reusable `ProviderLogo` building block + the
 *   `ProviderHero` rendered at the top of every `/docs/providers/<slug>`
 *   page. Mirrors `AllToolsSection.tsx` so the badge style stays
 *   consistent between the two docs sub-trees.
 */
import { Link } from '@tanstack/react-router'
import { IconBolt, IconArrowRight } from '@tabler/icons-react'
import { PROVIDERS, type Provider } from '~/lib/providers'

// 📖 LobeHub slug → icon map. The actual LobeHub slugs for the providers
// in our catalog don't always match the slug we use in URLs / nav, so we
// hand-map them. Where the provider doesn't have a LobeHub asset we
// leave the slug as `null` and the renderer falls back to the LobeHub
// default `m` placeholder monogram (also served by jsDelivr).
const LOBEHUB_ICONS: Record<string, string | null> = {
  nvidia: 'nvidia',
  groq: 'groq',
  cerebras: 'cerebras',
  googleai: 'gemini',     // LobeHub lists Gemini, not "googleai"
  'github-models': 'github',
  mistral: 'mistral',
  cloudflare: 'cloudflare',
  openrouter: 'openrouter',
  sambanova: 'sambanova',
  ovhcloud: 'ovh',         // LobeHub's OVH mark
  codestral: 'mistral',   // Codestral = Mistral family
  zai: 'zai',
  scaleway: 'scaleway',   // need to verify — LobeHub may not have a Scaleway mark
  qwen: 'qwen',           // LobeHub has the Qwen mark
  'opencode-zen': null,   // no Zen asset — fall through to monogram
  kilo: 'kilocode',
  llm7: null,
  routeway: null,
  novita: 'novita',
  'ollama-cloud': 'ollama',
}

const LOBEHUB = 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1/icons'

// 📖 Local overrides — providers that ship their own curated artwork in
// `public/providers/<slug>/`. Wins over the LobeHub fallback so the
// curated logos always render in the docs.
const LOCAL_PROVIDER_ICONS: Record<string, string> = {
  zai: '/providers/zai/zai.webp',
  llm7: '/providers/llm7/llm7.png',
  routeway: '/providers/routeway/routeway.svg',
}

/** 📖 LobeHub URL only — used as the final fallback when a local
 *  override 404s. */
function lobehubIconUrl(slug: string, ext: 'svg' | 'color' = 'color'): string | null {
  const lobe = LOBEHUB_ICONS[slug]
  if (!lobe) return null
  return `${LOBEHUB}/${lobe}${ext === 'color' ? '-color' : ''}.svg`
}

/** 📖 Pick the best-available icon URL for a given provider. Local
 *  override first, then LobeHub, then null (caller falls back to a
 *  monogram). */
function providerIconUrl(slug: string, ext: 'svg' | 'color' = 'color'): string | null {
  if (LOCAL_PROVIDER_ICONS[slug]) return LOCAL_PROVIDER_ICONS[slug]
  return lobehubIconUrl(slug, ext)
}

export type ProviderLogoProps = {
  provider: Provider
  size?: number
  className?: string
  invert?: boolean
  showLabel?: boolean
}

function getInitials(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()
}

/** 📖 Reusable provider logo block. Tries LobeHub colour first; falls back
 *  to a monogram for the providers that don't ship on LobeHub. */
export function ProviderLogo(props: ProviderLogoProps) {
  const provider = props.provider
  const size = props.size ?? 32
  const showLabel = props.showLabel ?? true
  const className = props.className ?? ''

  const url = providerIconUrl(provider.slug, 'color')

  let iconEl: React.ReactNode
  if (url) {
    iconEl = (
      <img
        src={url}
        alt={provider.name}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className={
          'object-contain ' +
          (props.invert ? 'brightness-0 invert' : '')
        }
        style={{ width: size, height: size }}
        // 📖 If the LobeHub colour variant 404s, swap to the mono
        // variant on the fly. Keeps the doc working even when LobeHub
        // removes or renames an asset.
        onError={(e) => {
          const mono = lobehubIconUrl(provider.slug, 'svg')
          if (mono && e.currentTarget.src !== mono) {
            e.currentTarget.src = mono
          }
        }}
      />
    )
  } else {
    const initials = getInitials(provider.name)
    const styleBox: React.CSSProperties = {
      width: size,
      height: size,
      fontSize: size * 0.4,
    }
    iconEl = (
      <div
        className="flex items-center justify-center rounded-md bg-fg/10 font-mono font-bold text-fg-faint"
        style={styleBox}
      >
        {initials}
      </div>
    )
  }

  if (!showLabel) {
    return <div className={className}>{iconEl}</div>
  }

  return (
    <div className={'flex flex-col items-center gap-1.5 ' + className}>
      {iconEl}
      <span className="text-[10px] font-medium text-fg-faint/60">{provider.name}</span>
    </div>
  )
}

function Shell({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`mx-auto max-w-6xl px-5 sm:px-8 ${className}`}>{children}</div>
}

/** 📖 Rendered at the top of each `/docs/providers/<slug>` page. Mirrors
 *  the integration badge style: section eyebrow + logo + name on the
 *  left, big provider logo + quick-link buttons on the right. */
export function ProviderHero({ provider }: { provider: Provider }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-1 items-start gap-4">
        <div className="shrink-0 pt-1 rounded-md p-1.5">
          <ProviderLogo provider={provider} size={40} showLabel={false} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
            Provider
          </p>
          <p className="mt-0.5 text-lg font-semibold text-fg">{provider.name}</p>
          <p className="mt-0.5 truncate text-sm text-fg-muted">{provider.tagline}</p>
        </div>
      </div>
    </div>
  )
}

/** 📖 Grid of every provider at the top of `/docs/providers` (the
 *  landing page). One card per provider, with a quick "Get key" link to
 *  their dashboard. */
export function ProvidersGrid() {
  return (
    <section className="border-b border-border/50 py-20 sm:py-28">
      <Shell>
        <div className="mb-10 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <IconBolt size={14} className="text-fg-muted" stroke={1.75} />
              <span className="font-mono text-xs font-medium text-fg-faint uppercase tracking-wider">
                Providers · {PROVIDERS.length} integrated
              </span>
            </div>
            <h2 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              Every provider, ready to go.
            </h2>
            <p className="mt-3 max-w-xl text-base text-fg-muted sm:text-lg">
              Pick a provider, grab a key, and FCM does the rest. Each card links to the
              signup, the docs, and the full integration walkthrough.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {PROVIDERS.map((p) => (
            <ProviderCard key={p.slug} provider={p} />
          ))}
        </div>
      </Shell>
    </section>
  )
}

function ProviderCard({ provider }: { provider: Provider }) {
  return (
    <Link
      to="/docs/$"
      params={{ _splat: `providers/${provider.slug}` }}
      className="block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      <div className="group/provider relative flex h-full flex-col gap-3 rounded-xl bg-bg-subtle/40 p-4 transition-all duration-200 hover:bg-bg-subtle/70">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md p-1">
            <ProviderLogo provider={provider} size={32} showLabel={false} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-fg">{provider.name}</p>
            <p className="truncate text-[11px] text-fg-faint">{provider.envVar}</p>
          </div>
        </div>
        <p className="line-clamp-2 text-xs leading-relaxed text-fg-muted">
          {provider.tagline}
        </p>
        <span className="mt-auto flex items-center gap-1 text-[11px] font-medium text-fg-faint opacity-0 transition-opacity group-hover/provider:opacity-100">
          Setup guide
          <IconArrowRight size={11} stroke={2.5} />
        </span>
      </div>
    </Link>
  )
}

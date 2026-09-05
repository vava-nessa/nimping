/**
 * @file src/components/ToolMarquee.tsx
 * @description Full-width marquee strip of tool + provider logos, rendered as
 *   a CSS-only infinite scroll.
 *
 *   Layout: two rows stacked, each with a leading label tag and a seamless
 *   infinite-scroll. Logos sit on a 32px-tile above a faded name. Mono
 *   variants are forced white via `brightness-0 invert`; colour variants
 *   show through with no filter. Hover scales the icon for affordance.
 *
 *   Tools come from the shared `lib/tools.ts` registry (also used by the
 *   "All tools" grid at the bottom of the home and the docs badge).
 *   Providers stay local — there's no docs page per provider so no shared
 *   registry is needed.
 */
import { useMemo } from 'react'
import { TOOLS as SHARED_TOOLS, shouldInvert, type Tool } from '~/lib/tools'

type Item = Tool

const TOOLS: Item[] = SHARED_TOOLS

const PROVIDERS: Item[] = [
  { slug: 'nvidia-nim',   name: 'NVIDIA NIM',   tagline: '1000 req/month',          icon: { kind: 'lobe', slug: 'nvidia',     color: true  } , href: '#', accent: '#76b900' },
  { slug: 'groq',         name: 'Groq',         tagline: '~30-50 RPM per model',     icon: { kind: 'lobe', slug: 'groq',       color: false } , href: '#', accent: '#f55036' },
  { slug: 'cerebras',     name: 'Cerebras',     tagline: 'Generous dev tier',       icon: { kind: 'lobe', slug: 'cerebras',   color: true  } , href: '#', accent: '#ff5c1c' },
  { slug: 'google-ai',    name: 'Google AI',    tagline: 'Gemini quotas vary',      icon: { kind: 'lobe', slug: 'gemini',     color: true  } , href: '#', accent: '#4285f4' },
  { slug: 'github',       name: 'GitHub Models',tagline: 'GitHub / Copilot plan',   icon: { kind: 'lobe', slug: 'github',     color: false } , href: '#', accent: '#ffffff' },
  { slug: 'mistral',      name: 'Mistral',      tagline: 'Free Experiment plan',    icon: { kind: 'lobe', slug: 'mistral',    color: true  } , href: '#', accent: '#ff7000' },
  { slug: 'cloudflare',   name: 'Cloudflare',   tagline: '10k neurons/day',         icon: { kind: 'lobe', slug: 'cloudflare', color: true  } , href: '#', accent: '#f38020' },
  { slug: 'openrouter',   name: 'OpenRouter',   tagline: '50 req/day free',         icon: { kind: 'lobe', slug: 'openrouter', color: true  } , href: 'https://openrouter.ai', accent: '#6366f1' },
  { slug: 'sambanova',    name: 'SambaNova',    tagline: 'Small dev tier',          icon: { kind: 'lobe', slug: 'sambanova',  color: true  } , href: '#', accent: '#ff6e00' },
  { slug: 'ovhcloud',     name: 'OVHcloud',     tagline: '2 RPM no key',            icon: { kind: 'simple', slug: 'ovh' }                          , href: '#', accent: '#123fbb' },
  { slug: 'codestral',    name: 'Codestral',    tagline: '30 RPM · 2000/day',       icon: null, accent: '#ff7000', href: 'https://mistral.ai/products/codestral' },
  { slug: 'zai',          name: 'ZAI',          tagline: 'Flash models only',       icon: { kind: 'raw', url: '/providers/zai/zai.webp' }, href: '#' },
  { slug: 'scaleway',     name: 'Scaleway',     tagline: '1M free tokens',          icon: { kind: 'simple', slug: 'scaleway' }                     , href: 'https://www.scaleway.com', accent: '#a78bfa' },
  { slug: 'alibaba',      name: 'Alibaba',      tagline: '1M tokens · 90 days',     icon: { kind: 'lobe', slug: 'alibaba',   color: true  } , href: 'https://www.alibabacloud.com', accent: '#615ced' },
  { slug: 'dashscope',    name: 'DashScope',    tagline: 'Qwen API',                icon: { kind: 'lobe', slug: 'qwen',      color: true  } , href: 'https://dashscope.aliyuncs.com', accent: '#615ced' },
  { slug: 'zen',          name: 'Zen',          tagline: 'OpenCode Zen gateway',    icon: { kind: 'iconify', prefix: 'arcticons', slug: 'zen' }, href: 'https://opencode.ai/auth', accent: '#8b5cf6' },
  { slug: 'novita',       name: 'Novita',       tagline: 'Free models',             icon: { kind: 'lobe', slug: 'novita',    color: true  } , href: 'https://novita.ai', accent: '#ffb978' },
  { slug: 'ollama-cloud', name: 'Ollama Cloud', tagline: 'Session + weekly caps',   icon: { kind: 'lobe', slug: 'ollama',    color: false } , href: 'https://ollama.com', accent: '#e6e6e6' },
  { slug: 'llm7',         name: 'LLM7',         tagline: 'Free · no key needed',    icon: { kind: 'raw', url: '/providers/llm7/llm7.png' }, href: 'https://llm7.io' },
  { slug: 'routeway',     name: 'Routeway',     tagline: 'Free :free models',       icon: { kind: 'raw', url: '/providers/routeway/routeway.svg' }, href: '#' },
]

/** 📖 One logo tile + faded name. */
function Logo({ item }: { item: Item }) {
  // 📖 Which sources render as currentColor (so we need the white
  // invert filter) vs hardcoded colour (let them through)?
  //   - LobeHub mono (`{slug}.svg`) → currentColor → invert
  //   - LobeHub color (`{slug}-color.svg`) → hardcoded → no invert
  //   - simple-icons → fill inherited from text → invert
  //   - iconify default → currentColor → invert
  //   - raw SVG → unknown, render as-is
  //   - null → monogram fallback
  const needsInvert = shouldInvert(item.icon)

  if (item.icon) {
    const src =
      item.icon.kind === 'lobe'
        ? `${'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1/icons'}/${item.icon.slug}${item.icon.color ? '-color' : ''}.svg`
        : item.icon.kind === 'simple'
          ? `${'https://cdn.jsdelivr.net/npm/simple-icons@16/icons'}/${item.icon.slug}.svg`
          : item.icon.kind === 'iconify'
            ? `${'https://api.iconify.design'}/${item.icon.prefix}/${item.icon.slug}.svg`
            : item.icon.url

    return (
      <div
        className="group/logo flex h-16 w-28 shrink-0 flex-col items-center justify-center gap-1.5"
        title={item.name}
      >
        <img
          src={src}
          alt={item.name}
          width={32}
          height={32}
          loading="lazy"
          decoding="async"
          onError={(e) => {
            // 📖 If the icon never loads (404, CORS, etc.) fall back to a
            // coloured monogram so the strip never has a blank tile.
            const target = e.currentTarget
            const wrapper = target.parentElement
            if (wrapper && !wrapper.querySelector('[data-monogram]')) {
              const initials = item.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()
              const fallback = document.createElement('div')
              fallback.setAttribute('data-monogram', 'true')
              fallback.className =
                'flex h-8 w-8 items-center justify-center rounded-md font-mono text-[10px] font-bold text-black'
              fallback.style.backgroundColor = item.accent ?? '#888'
              fallback.textContent = initials
              wrapper.replaceChild(fallback, target)
            }
          }}
          className={`h-8 w-8 object-contain transition-all duration-200 group-hover/logo:scale-110 ${
            needsInvert ? 'brightness-0 invert opacity-70 group-hover/logo:opacity-100' : ''
          }`}
        />
        <span className="max-w-full truncate text-[10px] font-medium text-fg-faint/60 transition-colors group-hover/logo:text-fg-faint">
          {item.name}
        </span>
      </div>
    )
  }
  // 📖 Coloured monogram fallback.
  const initials = item.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()
  return (
    <div
      className="group/logo flex h-16 w-28 shrink-0 flex-col items-center justify-center gap-1.5"
      title={item.name}
    >
      <div
        className="flex h-8 w-8 items-center justify-center rounded-md font-mono text-[10px] font-bold text-black transition-transform duration-200 group-hover/logo:scale-110"
        style={{ backgroundColor: item.accent ?? '#888' }}
      >
        {initials}
      </div>
      <span className="max-w-full truncate text-[10px] font-medium text-fg-faint/60 transition-colors group-hover/logo:text-fg-faint">
        {item.name}
      </span>
    </div>
  )
}

/** 📖 One scrolling row with a leading label tag. Items are rendered twice
 *  so the CSS animation can loop seamlessly: when the first copy has
 *  scrolled off-screen left, the second copy is exactly in place. */
function MarqueeRow({ items, label, duration = 50, reverse = false }: { items: Item[]; label: string; duration?: number; reverse?: boolean }) {
  const doubled = useMemo(() => [...items, ...items], [items])

  return (
    <div className="flex items-center gap-5 pr-5">
      <div className="shrink-0 font-mono text-[10px] font-medium uppercase tracking-wider text-fg-faint">
        {label}
      </div>

      <div
        className="group/marquee relative flex-1 overflow-hidden"
        style={{
          // 📖 Mask edges so icons fade in/out instead of slamming into the
          // viewport edge. Same on both sides for symmetry.
          maskImage:
            'linear-gradient(to right, transparent, black 4%, black 96%, transparent)',
          WebkitMaskImage:
            'linear-gradient(to right, transparent, black 4%, black 96%, transparent)',
        }}
      >
        <div
          className="flex w-max items-center gap-0 will-change-transform group-hover/marquee:[animation-play-state:paused]"
          style={{
            animation: `fcm-marquee-scroll ${duration}s linear infinite${reverse ? ' reverse' : ''}`,
          }}
        >
          {doubled.map((item, i) => (
            <Logo key={`${item.slug}-${i}`} item={item} />
          ))}
        </div>
      </div>
    </div>
  )
}

/** 📖 Renders both rows. The second row scrolls in the opposite direction
 *  (and a touch slower) so the eye has constant motion, no dead spots. */
export function ToolMarquee() {
  return (
    <div className="flex w-full flex-col gap-7 select-none">
      <MarqueeRow items={TOOLS} label="Supported Tools" duration={48} />
      <MarqueeRow items={PROVIDERS} label="Providers" duration={56} reverse />
    </div>
  )
}

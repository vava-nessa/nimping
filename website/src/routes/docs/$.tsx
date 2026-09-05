/**
 * @file src/routes/docs/$.tsx
 * @description Splat route for rendering documentation pages.
 */
import { createFileRoute, notFound, Link, redirect } from '@tanstack/react-router'
import { MDXProvider } from '@mdx-js/react'
import { getDoc } from '~/lib/docs'
import { flatDocs } from '~/content/nav'
import { mdxComponents } from '~/components/MdxComponents'
import { CopyPageButton } from '~/components/CopyPageButton'
import { ToolLogo } from '~/components/AllToolsSection'
import { ProviderLogo } from '~/components/ProviderSection'
import { getToolBySlug, shouldInvert, type Tool } from '~/lib/tools'
import { getProviderBySlug, type Provider } from '~/lib/providers'
import { site } from '~/lib/site'
import { ExternalLink as IconExternalLink } from 'lucide-react'

const ARTICLE_ID = 'doc-article'

export const Route = createFileRoute('/docs/$')({
  loader: ({ params }) => {
    const slug = params._splat ?? 'introduction'
    // 📖 Slug redirects: when pages are renamed, keep the old URL alive so external
    // links don't 404. (The old MDX file is deleted; this redirect is the bridge.)
    const SLUG_REDIRECTS: Record<string, string> = {
      'integrations/pi-extension': 'integrations/pi',
    }
    if (SLUG_REDIRECTS[slug]) {
      throw redirect({ to: '/docs/$', params: { _splat: SLUG_REDIRECTS[slug] } })
    }
    const doc = getDoc(slug)
    if (!doc) throw notFound()
    return { slug, frontmatter: doc.frontmatter }
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          { title: `${loaderData.frontmatter.title} — free-coding-models docs` },
          ...(loaderData.frontmatter.description
            ? [{ name: 'description', content: loaderData.frontmatter.description }]
            : []),
        ]
      : [],
    links: loaderData
      ? [{ rel: 'canonical', href: `${site.url}/docs/${loaderData.slug}` }]
      : [],
  }),
  component: DocPage,
})

function DocPage() {
  const { slug, frontmatter } = Route.useLoaderData()
  const doc = getDoc(slug)
  if (!doc) return null
  const { Content } = doc

  const index = flatDocs.findIndex((item) => item.slug === slug)
  const prev = index > 0 ? flatDocs[index - 1] : undefined
  const next = index > -1 ? flatDocs[index + 1] : undefined

  // 📖 If the page slug is `integrations/<tool>`, look up the tool so we
  // can show its big logo + tagline above the title. Returns null for
  // non-integration pages (quick-start, tier-system, etc.).
  const integrationTool: Tool | null = (() => {
    if (!slug.startsWith('integrations/')) return null
    const toolSlug = slug.slice('integrations/'.length)
    return getToolBySlug(toolSlug)
  })()

  // 📖 Same pattern for `/docs/providers/<slug>` — show the provider
  // badge above the title. Falls through for non-provider pages.
  const providerDoc: Provider | null = (() => {
    if (!slug.startsWith('providers/')) return null
    const providerSlug = slug.slice('providers/'.length)
    return getProviderBySlug(providerSlug)
  })()

  const editUrl = `${site.repo}/edit/main/website/src/content/docs/${slug}.mdx`

  return (
    <article className="min-w-0 py-8 sm:py-10 lg:py-16">
        <header className="mb-8 sm:mb-9 border-b border-border pb-6 sm:pb-8">
          <p className="label mb-3">{frontmatter.section ?? 'Docs'}</p>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="flex min-w-0 flex-1 items-start gap-4">
              <div className="min-w-0 flex-1">
                <h1 className="text-2xl font-semibold tracking-tight sm:text-4xl text-fg">
                  {frontmatter.title}
                </h1>
                {frontmatter.description && (
                  <p className="mt-3 max-w-2xl text-base leading-relaxed text-fg-muted sm:text-lg">
                    {frontmatter.description}
                  </p>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-start gap-2 sm:flex-col sm:items-end sm:gap-3">
              {providerDoc && (
                <a
                  href={providerDoc.signup}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink transition-all hover:opacity-90"
                  title={`Create a free ${providerDoc.name} account`}
                >
                  <IconExternalLink size={14} strokeWidth={2} />
                  Create account
                </a>
              )}
              <CopyPageButton slug={slug} />
              {integrationTool && integrationTool.href !== '#' && (
                <a
                  href={integrationTool.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-mono text-[11px] font-medium text-fg-faint transition-colors hover:text-fg"
                  title={integrationTool.href}
                >
                  Website
                  <IconExternalLink size={11} strokeWidth={1.75} />
                </a>
              )}
              {integrationTool && (
                <div className="rounded-md p-1.5 sm:mt-2">
                  <ToolLogo
                    tool={integrationTool}
                    size={64}
                    showLabel={false}
                    invert={shouldInvert(integrationTool.icon)}
                  />
                </div>
              )}
              {providerDoc && (
                <div className="rounded-md p-1.5 sm:mt-2">
                  <ProviderLogo
                    provider={providerDoc}
                    size={64}
                    showLabel={false}
                    invert={!providerHasColorIcon(providerDoc.slug)}
                  />
                </div>
              )}
            </div>
          </div>
        </header>

        <div id={ARTICLE_ID} className="prose">
          <MDXProvider components={mdxComponents}>
            <Content />
          </MDXProvider>
        </div>

        <nav className="mt-16 grid gap-3 border-t border-border pt-6 sm:grid-cols-2 font-mono">
          {prev ? (
            <Link
              to="/docs/$"
              params={{ _splat: prev.slug }}
              className="group border border-border p-4 rounded-lg transition-colors hover:border-border-strong"
            >
              <span className="label">Previous</span>
              <span className="mt-1 block text-xs font-medium text-fg-muted transition-colors group-hover:text-fg">
                ← {prev.title}
              </span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link
              to="/docs/$"
              params={{ _splat: next.slug }}
              className="group border border-border p-4 rounded-lg text-right transition-colors hover:border-border-strong sm:col-start-2"
            >
              <span className="label">Next</span>
              <span className="mt-1 block text-xs font-medium text-fg-muted transition-colors group-hover:text-fg">
                {next.title} →
              </span>
            </Link>
          )}
        </nav>

        <p className="mt-8 text-xs font-mono">
          <a
            href={editUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="label transition-colors hover:text-fg"
          >
            Edit this page on GitHub →
          </a>
        </p>
      </article>
  )
}

/* ── Tool Hero ────────────────────────────────────────────────────────── */

/** 📖 Same source rules as the marquee: mono / simple-icons / iconify are
 *  inverted to render white on the dark surface, raw + color are kept. */
function toolNeedsInvert(tool: Tool): boolean {
  const i = tool.icon
  if (!i) return false
  if (i.kind === 'lobe') return !i.color
  if (i.kind === 'simple' || i.kind === 'iconify') return true
  return false
}

// 📖 Mirror of `ProviderSection`'s icon registry. Lives here so the docs
// badge can decide whether the provider's LobeHub asset is a colour
// mark (passes through) or a currentColor SVG (must be inverted).
const PROVIDER_COLOR_SLUGS = new Set([
  'nvidia', 'cerebras', 'mistral', 'cloudflare', 'openrouter',
  'sambanova', 'qwen', 'novita',
  'zai', 'llm7', 'routeway',
])

function providerHasColorIcon(slug: string): boolean {
  return PROVIDER_COLOR_SLUGS.has(slug)
}

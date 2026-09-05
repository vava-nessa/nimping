/**
 * @file src/components/SiteHeader.tsx
 * @description Sticky top bar with Tabler Icons for the hamburger menu.
 *   The LobeHub-powered tool + provider marquee used to live below the
 *   header, but it was moved to the home page hero (right under the npm
 *   install command) so the brand row at the top stays compact.
 */
import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { IconMenu2, IconX } from '@tabler/icons-react'
import { Wordmark } from './Logo'
import { SearchTrigger } from './DocSearch'
import { GitHubStars } from './GitHubStars'
import { NpmDownloads } from './NpmDownloads'
import { site } from '~/lib/site'

const NAV = [
  { to: '/models', label: 'Models' },
  { slug: 'introduction', label: 'Docs' },
  { slug: 'providers', label: 'Providers' },
  { to: '/changelogs', label: 'Changelogs' },
] as const

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className={`sticky top-0 z-50 border-b border-border transition-colors duration-200 ${
        scrolled ? 'bg-bg/85 backdrop-blur-xl' : 'bg-bg'
      }`}
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-5 sm:px-8">
        <Link to="/" className="shrink-0" aria-label="free-coding-models home">
          <Wordmark />
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {NAV.map((item) => (
            <Link
              key={'slug' in item ? item.slug : item.to}
              to={'slug' in item ? '/docs/$' : item.to}
              params={'slug' in item ? { _splat: item.slug } : undefined}
              className="label border-b-2 border-transparent py-1 transition-colors hover:text-fg"
              activeProps={{ className: 'label border-b-2 border-accent py-1 text-accent-fg font-bold' }}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-4">
          <div className="hidden sm:block">
            <SearchTrigger />
          </div>

          <div className="hidden items-center gap-4 lg:flex">
            <GitHubStars href={site.repo} />
            <NpmDownloads href={site.npm} />
          </div>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="Toggle navigation"
            className="p-2 text-fg-muted transition-colors hover:text-fg md:hidden"
          >
            {open
              ? <IconX size={20} stroke={1.75} aria-hidden="true" />
              : <IconMenu2 size={20} stroke={1.75} aria-hidden="true" />
            }
          </button>
        </div>
      </div>

      {open && (
        <nav className="border-t border-border bg-bg px-5 py-3 md:hidden">
          {NAV.map((item) => (
            <Link
              key={'slug' in item ? item.slug : item.to}
              to={'slug' in item ? '/docs/$' : item.to}
              params={'slug' in item ? { _splat: item.slug } : undefined}
              onClick={() => setOpen(false)}
              className="label block border-b border-border py-3 hover:text-fg"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  )
}

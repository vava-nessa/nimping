/**
 * @file src/components/ChangelogSidebar.tsx
 * @description The left-hand version picker on /changelogs and /changelogs/$.
 * Mirrors Kandown's ChangelogSidebar: year-grouped sections, mono section labels, accent border on active item.
 */

import { useEffect, useState, useMemo } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { groupByYear, type ChangelogEntry } from '~/lib/changelogs'
import { Search, X } from 'lucide-react'

export function ChangelogSidebar({
  entries,
  activeSlug,
  onNavigate,
}: {
  entries: ChangelogEntry[]
  activeSlug?: string
  onNavigate?: () => void
}) {
  const [search, setSearch] = useState('')

  const filteredEntries = useMemo(() => {
    if (!search.trim()) return entries
    const q = search.toLowerCase()
    return entries.filter(
      (e) =>
        e.version.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        (e.date && e.date.includes(q))
    )
  }, [entries, search])

  const groups = useMemo(() => groupByYear(filteredEntries), [filteredEntries])

  return (
    <nav aria-label="Changelog versions" className="space-y-4 font-sans">
      {/* Quick Search in Sidebar */}
      <div className="relative mb-4">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter versions..."
          className="w-full pl-8 pr-7 py-1.5 text-xs font-mono bg-bg-subtle border border-border rounded-md text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent transition-colors"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg p-0.5 rounded cursor-pointer"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {groups.length > 0 ? (
        groups.map((group) => (
          <div
            key={group.year}
            className="mb-5 border-t border-border pt-4 first:border-t-0 first:pt-0"
          >
            <h2 className="label mb-2 text-[11px] font-mono font-medium text-fg-faint uppercase tracking-wider">
              {group.year === '_' ? 'Unreleased' : group.year}
            </h2>
            <ul className="-ml-px border-l border-border">
              {group.items.map((entry) => {
                return (
                  <li key={entry.slug}>
                    <Link
                      to="/changelogs/$"
                      params={{ _splat: entry.slug }}
                      onClick={onNavigate}
                      className="-ml-px block border-l-2 border-transparent py-1.5 pl-3 text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
                      activeProps={{
                        className:
                          '-ml-px block border-l-2 border-accent py-1.5 pl-3 text-xs font-medium text-fg bg-accent-soft/20',
                      }}
                      activeOptions={{ exact: true }}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="block font-mono text-[11px] font-semibold text-accent-fg">
                          v{entry.version}
                        </span>
                        {entry.date && (
                          <span className="text-[10px] font-mono text-fg-faint">{entry.date}</span>
                        )}
                      </div>
                      <span className="block text-[12px] leading-tight text-fg-muted truncate mt-0.5">
                        {entry.name}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))
      ) : (
        <p className="text-xs font-mono text-fg-faint py-2">No version matches "{search}"</p>
      )}
    </nav>
  )
}

export function MobileChangelogSidebar({
  entries,
  activeSlug,
  open,
  onClose,
}: {
  entries: ChangelogEntry[]
  activeSlug?: string
  open: boolean
  onClose: () => void
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only on route change; onClose is stable and idempotent.
  useEffect(() => {
    onClose()
  }, [pathname])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = overflow
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div className="absolute top-0 left-0 h-full w-[19rem] max-w-[85vw] overflow-y-auto border-r border-border-strong bg-bg p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-4 border-b border-border pb-3">
          <span className="font-mono text-xs font-semibold text-fg">Changelog Versions</span>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-muted hover:text-fg p-1 rounded cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <ChangelogSidebar
          entries={entries}
          activeSlug={activeSlug}
          onNavigate={onClose}
        />
      </div>
    </div>
  )
}

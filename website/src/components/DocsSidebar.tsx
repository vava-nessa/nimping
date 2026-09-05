/**
 * @file src/components/DocsSidebar.tsx
 * @description Sidebar navigation component for docs.
 */
import { useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { docsNav, type DocGroup, type DocLink } from '~/content/nav'

/** 📖 Renders one nav group. If the group declares a `primaryCount`, the items
 *  beyond it are collapsed behind a "View N more..." toggle. The currently
 *  active item is always rendered, even when collapsed, so the user never
 *  loses track of their place in the nav. */
function NavGroup({ group, pathname }: { group: DocGroup; pathname: string }) {
  const [expanded, setExpanded] = useState(false)
  const primaryCount = group.primaryCount ?? group.items.length
  const hasMore = group.items.length > primaryCount

  const activeIndex = group.items.findIndex(
    (item) => pathname === `/docs/${item.slug}`,
  )

  // 📖 Render items in their natural order. Always include the primary slice
  // + the active item (so you can see where you are) + the rest when expanded.
  const visibleItems: DocLink[] = []
  for (let i = 0; i < group.items.length; i++) {
    if (i < primaryCount || i === activeIndex || expanded) {
      const item = group.items[i]
      if (item) visibleItems.push(item)
    }
  }

  const hiddenCount = group.items.length - primaryCount

  return (
    <div>
      <p className="label mb-2.5 text-fg-faint">{group.title}</p>
      <ul className="space-y-1">
        {visibleItems.map((item) => {
          const active = pathname === `/docs/${item.slug}`
          return (
            <li key={item.slug}>
              <Link
                to="/docs/$"
                params={{ _splat: item.slug }}
                className={`block border-l-2 py-1 pl-3 font-mono text-xs transition-colors ${
                  active
                    ? 'border-accent text-fg font-semibold'
                    : 'border-transparent text-fg-muted hover:border-border-strong hover:text-fg'
                }`}
              >
                {item.title}
              </Link>
            </li>
          )
        })}
        {hasMore && (
          <li>
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="block w-full border-l-2 border-transparent py-1 pl-3 text-left font-mono text-xs text-fg-faint transition-colors hover:border-border-strong hover:text-fg"
              aria-expanded={expanded}
            >
              {expanded ? '− View less' : `+ View ${hiddenCount} more...`}
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}

export function DocsSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  return (
    <nav className="space-y-7">
      {docsNav.map((group) => (
        <NavGroup key={group.title} group={group} pathname={pathname} />
      ))}
    </nav>
  )
}

export function MobileSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex bg-bg/90 backdrop-blur-md lg:hidden">
      <div className="w-4/5 max-w-xs border-r border-border bg-bg p-6 overflow-y-auto">
        <div className="mb-6 flex items-center justify-between">
          <span className="font-mono text-xs font-semibold uppercase tracking-wider text-accent-fg">
            Documentation
          </span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-fg-muted hover:text-fg font-mono text-sm"
          >
            ✕
          </button>
        </div>
        <DocsSidebar />
      </div>
      {/* 📖 Click-away backdrop: a real button so keyboard users can close
          the drawer too (not just mouse / Escape). */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close navigation"
        className="flex-1 cursor-default appearance-none border-0 bg-transparent p-0"
      />
    </div>
  )
}

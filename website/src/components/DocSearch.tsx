/**
 * @file src/components/DocSearch.tsx
 * @description Docs search trigger button and modal dialog.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { flatDocs } from '~/content/nav'

export function SearchTrigger({ full = false }: { full?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent('open-doc-search'))}
      className={`group flex shrink-0 items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-border bg-bg-raised/80 px-3 py-1.5 font-mono text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg ${
        full ? 'w-full' : ''
      }`}
    >
      <span className="flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        Search
      </span>
      <kbd className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-[10px] text-fg-faint">
        ⌘K
      </kbd>
    </button>
  )
}

export function SearchDialog() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handleOpen = () => setOpen(true)
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }

    window.addEventListener('open-doc-search', handleOpen)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('open-doc-search', handleOpen)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  // 📖 Move focus into the dialog when it opens and restore it to the
  // trigger element when it closes (or the component unmounts mid-open).
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => previouslyFocused?.focus()
  }, [open])

  if (!open) return null

  const filtered = query.trim()
    ? flatDocs.filter((doc) => doc.title.toLowerCase().includes(query.toLowerCase()) || doc.slug.toLowerCase().includes(query.toLowerCase()))
    : flatDocs

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4 bg-bg/80 backdrop-blur-md">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search documentation"
        className="w-full max-w-lg rounded-xl border border-border bg-bg-raised shadow-2xl overflow-hidden"
      >
        <div className="flex items-center border-b border-border px-4 py-3">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="mr-3 text-fg-faint">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search documentation..."
            aria-label="Search documentation"
            className="w-full bg-transparent font-mono text-sm text-fg outline-none placeholder:text-fg-faint"
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="font-mono text-xs text-fg-faint hover:text-fg"
          >
            ESC
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="p-4 text-center font-mono text-xs text-fg-faint">No documentation matching "{query}"</p>
          ) : (
            filtered.map((item) => (
              <button
                key={item.slug}
                type="button"
                onClick={() => {
                  setOpen(false)
                  navigate({ to: '/docs/$', params: { _splat: item.slug } })
                }}
                className="w-full flex items-center justify-between rounded-lg p-3 text-left hover:bg-bg-subtle transition-colors"
              >
                <div>
                  <p className="font-mono text-xs font-semibold text-fg">{item.title}</p>
                  <p className="font-mono text-[11px] text-fg-faint">/docs/{item.slug}</p>
                </div>
                <span className="font-mono text-[11px] text-accent-fg">→</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

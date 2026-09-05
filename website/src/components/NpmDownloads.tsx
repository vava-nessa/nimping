/**
 * @file src/components/NpmDownloads.tsx
 * @description Npm package download link with count pill.
 */
import { useEffect, useState } from 'react'

export function NpmDownloads({ href }: { href: string }) {
  const [downloads, setDownloads] = useState<string | null>(null)

  useEffect(() => {
    type NpmDownloadsResponse = { downloads?: unknown }
    fetch('https://api.npmjs.org/downloads/point/last-month/free-coding-models')
      .then((res) => {
        if (!res.ok) throw new Error(`npm API ${res.status}`)
        return res.json() as Promise<NpmDownloadsResponse>
      })
      .then((data) => {
        if (typeof data.downloads === 'number') {
          const num = data.downloads
          setDownloads(num > 1000 ? `${(num / 1000).toFixed(1)}k` : `${num}`)
        }
      })
      .catch(() => {})
  }, [])

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      aria-label="npm package"
      className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-border bg-bg-raised/70 px-3 py-1.5 font-mono text-[11.5px] text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="shrink-0 text-[#CB3837]">
        <path d="M0 0v24h24V0H0zm19.2 19.2H12v-9.6H9.6v9.6H4.8V4.8h14.4v14.4z" />
      </svg>
      <span>npm</span>
      {downloads && (
        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent-fg">
          ↓ {downloads}/mo
        </span>
      )}
    </a>
  )
}

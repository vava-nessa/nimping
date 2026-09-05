/**
 * @file src/lib/changelogs.ts
 * @description Dynamic loader & parser for all per-version changelogs from changelog/ directory.
 * Reads raw markdown files directly without compilation artefacts.
 */

export type ChangelogEntry = {
  slug: string
  version: string
  date: string | null
  name: string
  content: string // Full clean markdown body
}

// 📖 Eagerly load all raw changelog markdown files from the project root changelog/ directory
const modules = import.meta.glob<string>('../../../changelog/v*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function parseSemver(v: string): [number, number, number] {
  const parts = v.replace(/^v/, '').split('.').map(Number)
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

function compareSemver(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = parseSemver(a)
  const [bMajor, bMinor, bPatch] = parseSemver(b)

  if (aMajor !== bMajor) return bMajor - aMajor
  if (aMinor !== bMinor) return bMinor - aMinor
  return bPatch - aPatch
}

function cleanMarkdownText(text: string): string {
  return text
    .replace(/^[-*+]\s+/, '') // strip bullet markers
    // 📖 Strip leading emoji. \p{Extended_Pictographic} alternated with the
    // variation selector / ZWJ joiners so composed emoji (e.g. satellite) are
    // fully removed.
    .replace(/^(?:\p{Extended_Pictographic}|[\uFE0F\u200D])+\s*/u, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1') // strip bold
    .replace(/`([^`]+)`/g, '$1') // strip inline code formatting
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // strip markdown links
    .trim()
}

export function getAllChangelogs(): ChangelogEntry[] {
  const changelogs: ChangelogEntry[] = []

  for (const [path, rawText] of Object.entries(modules)) {
    // Extract version from filename (e.g. ../../../changelog/v0.5.61.md -> 0.5.61)
    const fileMatch = path.match(/\/v([\d.]+)\.md$/)
    if (!fileMatch) continue
    const version = fileMatch[1]
    if (!version) continue

    let rawContent = typeof rawText === 'string' ? rawText : String(rawText || '')

    // Defensive check: if rawContent accidentally contains compiled JS (e.g. function MDXContent), skip or fallback
    if (rawContent.includes('function MDXContent') || rawContent.includes('_createMdxContent')) {
      continue
    }

    if (!rawContent.trim()) continue

    const lines = rawContent.split('\n')
    let date: string | null = null
    let name = ''

    // Extract date from header line (e.g. # Changelog v0.5.61 - 2026-07-27 or # 0.5.61 — 2026-07-27 — "Name")
    const headerLine = lines[0] || ''
    const headerMatch = headerLine.match(/# (?:Changelog v[\d.]+|[\d.]+)\s*[-—]\s*(\d{4}-\d{2}-\d{2})/)
    if (headerMatch) {
      date = headerMatch[1] ?? null
    }

    // Find first descriptive bullet point or header for release name
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]?.trim()
      if (!line) continue
      if (line.startsWith('- ') || line.startsWith('* ')) {
        name = cleanMarkdownText(line)
        break
      }
    }

    if (!name) {
      name = `Release v${version}`
    }

    if (name.length > 80) {
      const dashIdx = name.indexOf(' — ')
      if (dashIdx > 10 && dashIdx < 80) {
        name = name.slice(0, dashIdx)
      } else {
        name = name.slice(0, 77) + '...'
      }
    }

    // Strip top H1 heading line for body content so it doesn't duplicate on page
    const bodyLines = headerLine.startsWith('# ') ? lines.slice(1) : lines
    const content = bodyLines.join('\n').trim()

    changelogs.push({
      slug: `v${version}`,
      version,
      date,
      name,
      content,
    })
  }

  // Sort descending by semver
  return changelogs.sort((a, b) => compareSemver(a.version, b.version))
}

export function groupByYear(entries: ChangelogEntry[]): { year: string; items: ChangelogEntry[] }[] {
  const buckets = new Map<string, ChangelogEntry[]>()
  for (const entry of entries) {
    const year = entry.date ? entry.date.slice(0, 4) : '_'
    const bucket = buckets.get(year)
    if (bucket) bucket.push(entry)
    else buckets.set(year, [entry])
  }
  return [...buckets.entries()].map(([year, items]) => ({ year, items }))
}

export function findEntry(entries: ChangelogEntry[], slug: string): ChangelogEntry | undefined {
  const cleanSlug = slug.replace(/^v/, '')
  return entries.find((entry) => entry.slug === slug || entry.version === cleanSlug || entry.slug === `v${cleanSlug}`)
}

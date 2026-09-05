/**
 * @file src/components/MarkdownRenderer.tsx
 * @description Lightweight, rich Markdown renderer component for full changelogs and documentation.
 * Supports headers, code blocks, lists, blockquotes, horizontal rules, and Markdown tables.
 */

import React, { useMemo } from 'react'
import { Sparkles, Wrench, RefreshCw, Layers, Terminal, Check, Copy } from 'lucide-react'

interface MarkdownRendererProps {
  content: string
  className?: string
}

function formatInlineMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // 📖 Escape quotes too: the escaped text ends up inside href="..."
    // attributes, so an unescaped double quote would let a markdown link
    // break out of the attribute (HTML injection).
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="text-fg font-semibold">$1</strong>')
    .replace(
      /`([^`]+)`/g,
      '<code class="font-mono text-xs bg-bg-raised border border-border px-1.5 py-0.5 rounded text-accent-fg font-medium">$1</code>'
    )
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener" class="text-accent-fg underline decoration-accent/40 underline-offset-2 hover:decoration-accent transition-colors">$1</a>'
    )
}

function parseTableRow(line: string): string[] {
  let raw = line.trim()
  if (raw.startsWith('|')) raw = raw.slice(1)
  if (raw.endsWith('|')) raw = raw.slice(0, -1)
  return raw.split('|').map((c) => c.trim())
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim()
  return /^\|?\s*:?-+:?\s*(\|?\s*:?-+:?\s*)*\|?$/.test(trimmed)
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = React.useState(false)
  const copyTimer = React.useRef<number | undefined>(undefined)

  // 📖 Clear the pending "Copied!" reset when unmounting so we never
  // set state on a removed component.
  React.useEffect(() => {
    return () => {
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
    }
  }, [])

  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="relative my-4 rounded-xl border border-border/80 bg-bg-raised/90 overflow-hidden group shadow-sm">
      <div className="flex items-center justify-between px-4 py-2 bg-bg-subtle border-b border-border/60 font-mono text-[11px] text-fg-faint">
        <span className="flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5 text-accent-fg" />
          {language || 'text'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          aria-live="polite"
          className="flex items-center gap-1 text-fg-muted hover:text-fg transition-colors px-2 py-0.5 rounded hover:bg-bg-raised cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" /> Copied!
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" /> Copy
            </>
          )}
        </button>
      </div>
      <pre className="p-4 font-mono text-xs text-fg leading-relaxed overflow-x-auto selection:bg-accent selection:text-ink">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function MarkdownRenderer({ content, className = '' }: MarkdownRendererProps) {
  const blocks = useMemo(() => {
    const lines = content.split('\n')
    const result: Array<{
      type: 'header' | 'section' | 'code' | 'list' | 'blockquote' | 'paragraph' | 'hr' | 'table'
      level?: number
      text?: string
      language?: string
      items?: string[]
      code?: string
      headers?: string[]
      rows?: string[][]
    }> = []

    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (line === undefined) {
        i++
        continue
      }

      // Code blocks (```lang ... ```)
      if (line.trim().startsWith('```')) {
        const lang = line.trim().slice(3).trim()
        const codeLines: string[] = []
        i++
        while (i < lines.length) {
          const cur = lines[i]
          if (cur === undefined || cur.trim().startsWith('```')) break
          codeLines.push(cur)
          i++
        }
        result.push({
          type: 'code',
          language: lang,
          code: codeLines.join('\n'),
        })
        i++
        continue
      }

      const trimmed = line.trim()
      if (!trimmed) {
        i++
        continue
      }

      // Markdown Tables (| Col 1 | Col 2 | ...)
      if (trimmed.startsWith('|') && trimmed.includes('|')) {
        const tableLines: string[] = []
        while (i < lines.length) {
          const cur = lines[i]
          if (cur === undefined || !cur.trim().startsWith('|')) break
          tableLines.push(cur.trim())
          i++
        }

        if (tableLines.length >= 2 && tableLines[0] !== undefined) {
          const headers = parseTableRow(tableLines[0])

          let startIndex = 1
          if (tableLines[1] && isTableSeparator(tableLines[1])) {
            startIndex = 2
          }

          const rows: string[][] = []
          for (let r = startIndex; r < tableLines.length; r++) {
            const row = tableLines[r]
            if (row === undefined) continue
            rows.push(parseTableRow(row))
          }

          result.push({
            type: 'table',
            headers,
            rows,
          })
          continue
        }
      }

      // Main Header (# Changelog ...)
      if (trimmed.startsWith('# ')) {
        result.push({
          type: 'header',
          level: 1,
          text: trimmed.slice(2).trim(),
        })
        i++
        continue
      }

      // Section Headers (### Added, #### Section, etc.)
      if (trimmed.startsWith('#### ')) {
        result.push({
          type: 'section',
          level: 4,
          text: trimmed.slice(5).trim(),
        })
        i++
        continue
      }

      if (trimmed.startsWith('### ')) {
        result.push({
          type: 'section',
          level: 3,
          text: trimmed.slice(4).trim(),
        })
        i++
        continue
      }

      if (trimmed.startsWith('## ')) {
        result.push({
          type: 'section',
          level: 2,
          text: trimmed.slice(3).trim(),
        })
        i++
        continue
      }

      // Horizontal rule
      if (trimmed === '---' || trimmed === '***') {
        result.push({ type: 'hr' })
        i++
        continue
      }

      // Blockquotes
      if (trimmed.startsWith('> ')) {
        const quoteLines: string[] = []
        while (i < lines.length) {
          const cur = lines[i]
          if (cur === undefined || !cur.trim().startsWith('> ')) break
          quoteLines.push(cur.trim().slice(2))
          i++
        }
        result.push({
          type: 'blockquote',
          text: quoteLines.join(' '),
        })
        continue
      }

      // Lists
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        const listItems: string[] = []
        while (i < lines.length) {
          const cur = lines[i]
          if (cur === undefined) break
          const l = cur.trim()
          if (l.startsWith('- ') || l.startsWith('* ')) {
            listItems.push(l.slice(2).trim())
            i++
          } else if (l.startsWith('  ') && listItems.length > 0) {
            // Continuation line / sub-bullet
            listItems[listItems.length - 1] += '\n' + l.trim()
            i++
          } else {
            break
          }
        }
        result.push({
          type: 'list',
          items: listItems,
        })
        continue
      }

      // Regular Paragraph
      result.push({
        type: 'paragraph',
        text: trimmed,
      })
      i++
    }

    return result
  }, [content])

  return (
    <div className={`space-y-4 text-fg-muted font-sans ${className}`}>
      {blocks.map((block, idx) => {
        if (block.type === 'header') {
          return (
            <h1 key={idx} className="font-mono text-xl sm:text-2xl font-bold text-fg border-b border-border pb-3 mb-4">
              {block.text}
            </h1>
          )
        }

        if (block.type === 'section') {
          const text = block.text || ''
          let Icon = Layers
          let color = 'text-accent-fg'

          if (text.toLowerCase().includes('added') || text.toLowerCase().includes('features')) {
            Icon = Sparkles
            color = 'text-emerald-400'
          } else if (text.toLowerCase().includes('fixed') || text.toLowerCase().includes('fixes')) {
            Icon = Wrench
            color = 'text-amber-400'
          } else if (text.toLowerCase().includes('changed') || text.toLowerCase().includes('maintenance')) {
            Icon = RefreshCw
            color = 'text-sky-400'
          }

          const headerTag = block.level === 4 ? 'text-xs sm:text-sm uppercase tracking-wider text-fg-faint' : 'text-sm sm:text-base font-semibold'

          return (
            <h3 key={idx} className={`flex items-center gap-2 font-mono ${headerTag} ${color} mt-6 mb-3 pt-2`}>
              <Icon className="w-4 h-4" />
              {text}
            </h3>
          )
        }

        if (block.type === 'table' && block.headers && block.rows) {
          return (
            <div key={idx} className="my-5 overflow-x-auto rounded-xl border border-border/80 bg-bg-subtle/50 shadow-xs">
              <table className="w-full text-left text-xs sm:text-sm border-collapse">
                <thead className="bg-bg-raised border-b border-border text-fg font-mono text-[11px] uppercase tracking-wider">
                  <tr>
                    {block.headers.map((h, hIdx) => (
                      <th key={hIdx} className="px-4 py-2.5 font-semibold border-r last:border-r-0 border-border/60">
                        <span dangerouslySetInnerHTML={{ __html: formatInlineMarkdown(h) }} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60 text-fg-muted font-sans">
                  {block.rows.map((row, rIdx) => (
                    <tr key={rIdx} className="hover:bg-bg-raised/40 transition-colors">
                      {row.map((cell, cIdx) => (
                        <td key={cIdx} className="px-4 py-2.5 leading-relaxed border-r last:border-r-0 border-border/40">
                          <span dangerouslySetInnerHTML={{ __html: formatInlineMarkdown(cell) }} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }

        if (block.type === 'code' && block.code !== undefined) {
          return <CodeBlock key={idx} code={block.code} language={block.language || 'bash'} />
        }

        if (block.type === 'list' && block.items) {
          return (
            <ul key={idx} className="space-y-2.5 my-3 pl-1">
              {block.items.map((item, itemIdx) => (
                <li key={itemIdx} className="flex items-start gap-2.5 text-xs sm:text-sm leading-relaxed text-fg-muted">
                  <span className="text-accent font-mono text-xs mt-1 shrink-0">•</span>
                  <div
                    className="flex-1"
                    dangerouslySetInnerHTML={{ __html: formatInlineMarkdown(item.replace(/\n/g, '<br/>')) }}
                  />
                </li>
              ))}
            </ul>
          )
        }

        if (block.type === 'blockquote') {
          return (
            <blockquote key={idx} className="border-l-2 border-accent bg-bg-raised/60 px-4 py-3 rounded-r-lg text-xs sm:text-sm italic text-fg">
              <p dangerouslySetInnerHTML={{ __html: formatInlineMarkdown(block.text || '') }} />
            </blockquote>
          )
        }

        if (block.type === 'hr') {
          return <hr key={idx} className="border-border my-6" />
        }

        return (
          <p
            key={idx}
            className="text-xs sm:text-sm leading-relaxed text-fg-muted"
            dangerouslySetInnerHTML={{ __html: formatInlineMarkdown(block.text || '') }}
          />
        )
      })}
    </div>
  )
}

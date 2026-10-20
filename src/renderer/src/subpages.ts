/**
 * Hidden footer: a constant marker at the very bottom of every note file.
 *
 * On disk it looks like:
 *
 *   <body markdown>
 *
 *   ---
 *   ## Hidden
 *   [[Child Page]]
 *
 * Everything from the `---` + `## Hidden` marker to the end of file is the
 * hidden section. It is NEVER rendered anywhere — not in the note, not in
 * previews, not in find. It only exists in the file so subpages (plain notes
 * and JSON study children) stay linked to their parent and nest in the tree.
 * The BlockEditor only edits the body; right-click → Add appends `[[links]]`
 * to the footer instead of the body.
 */

export const HIDDEN_TITLE = 'Hidden'

/** The exact on-disk marker (kept constant so files stay greppable). */
export function hiddenMarker(): string {
  return `---\n## ${HIDDEN_TITLE}`
}

export interface HiddenSection {
  /** Raw hidden body (`[[links]]`), without the marker line. Never rendered. */
  raw: string
  /** `[[Page]]` targets in order. */
  pages: string[]
}

const WIKI_RE = /\[\[([^\]\n]+?)\]\]/g

/** Split full file content into body + hidden section (if present). */
export function splitHidden(content: string): { body: string; hidden: HiddenSection | null } {
  const normalized = content.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  let marker = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().toLowerCase() === `## ${HIDDEN_TITLE.toLowerCase()}`) {
      // Require a `---` rule directly above (allowing blank lines).
      let j = i - 1
      while (j >= 0 && !lines[j].trim()) j--
      if (j >= 0 && /^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[j])) {
        marker = j
        break
      }
    }
  }
  if (marker < 0) return { body: content, hidden: null }
  const body = lines.slice(0, marker).join('\n').trimEnd()
  const rawLines = lines.slice(marker + 2).join('\n')
  return { body, hidden: parseHiddenRaw(rawLines) }
}

export function parseHiddenRaw(raw: string): HiddenSection {
  const pages: string[] = []
  for (const line of raw.split('\n')) {
    WIKI_RE.lastIndex = 0
    let match: RegExpExecArray | null
    // Skip code spans so `[[x]]` in backticks stays literal.
    const clean = line.replace(/`[^`\n]+`/g, (s) => ' '.repeat(s.length))
    while ((match = WIKI_RE.exec(clean)) !== null) {
      const inner = match[1]
      const pipe = inner.indexOf('|')
      const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim()
      if (target) pages.push(target)
    }
  }
  return { raw, pages }
}

/** Serialize a hidden section (marker + page links). */
export function serializeHidden(pages: string[]): string {
  const out = [hiddenMarker(), '']
  const seen = new Set<string>()
  for (const title of pages) {
    const target = title.trim()
    if (!target || seen.has(target.toLowerCase())) continue
    seen.add(target.toLowerCase())
    out.push(`[[${target}]]`)
  }
  return out.join('\n') + '\n'
}

/** Recombine body + hidden parts into full file content. */
export function joinHidden(body: string, hidden: HiddenSection | null): string {
  const trimmed = body.trimEnd()
  if (!hidden) return body
  const rebuilt = serializeHidden(hidden.pages)
  return `${trimmed}${trimmed ? '\n\n' : ''}${rebuilt}`
}

/** Append a `[[Page]]` link to the hidden section (creates it if missing). */
export function addHiddenPage(content: string, pageTitle: string): string {
  const target = pageTitle.trim()
  if (!target) return content
  const { body, hidden } = splitHidden(content)
  const pages = hidden ? [...hidden.pages] : []
  if (!pages.some((p) => p.toLowerCase() === target.toLowerCase())) pages.push(target)
  return joinHidden(body, { raw: '', pages })
}

/** Remove a `[[Page]]` link from the hidden section (case-insensitive). */
export function removeHiddenPage(content: string, pageTitle: string): string {
  const { body, hidden } = splitHidden(content)
  if (!hidden) return content
  const needle = pageTitle.trim().toLowerCase()
  const pages = hidden.pages.filter((p) => p.toLowerCase() !== needle)
  return joinHidden(body, { raw: hidden.raw, pages })
}

const WIKI_TARGET_RE = /\[\[([^\]\n]+?)\]\]/g

/**
 * Retarget every `[[Old]]` / `[[Old|alias]]` link at a note rename, so the
 * renamed child stays parented (hidden footer) and inline embeds keep
 * working instead of spawning lookalike duplicates. Inline code spans are
 * left alone so `` `[[Old]]` `` literals never change.
 */
export function renameLinkTarget(content: string, oldTitle: string, newTitle: string): string {
  const oldNeedle = oldTitle.trim().toLowerCase()
  const next = newTitle.trim()
  if (!oldNeedle || !next) return content
  const parts = content.split(/(`[^`\n]+`)/g)
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(WIKI_TARGET_RE, (full, inner: string) => {
      const pipe = inner.indexOf('|')
      const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim()
      if (target.toLowerCase() !== oldNeedle) return full
      if (pipe < 0) return `[[${next}]]`
      return `[[${next}|${inner.slice(pipe + 1)}]]`
    })
  }
  return parts.join('')
}

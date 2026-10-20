import { splitHidden } from './subpages'

/**
 * Mapping between notes and vault files.
 *
 * Each note owns exactly one flat `.md` file named after its title
 * (`my-note.md`, `my-note-2.md` on collision). Titles stay human-readable in
 * the file manager; the store keeps the id <-> fileName mapping.
 */

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'untitled'
}

export function noteFileBase(title: string): string {
  return `${slugifyTitle(title)}.md`
}

/** Pick a name nobody else uses, adding a `-2`, `-3`, … suffix as needed. */
export function uniqueFileName(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) return desired
  const stem = desired.replace(/\.md$/i, '')
  let counter = 2
  let candidate = `${stem}-${counter}.md`
  while (taken.has(candidate)) {
    counter += 1
    candidate = `${stem}-${counter}.md`
  }
  return candidate
}

/** Recover a display title from a vault file name. */
export function titleFromFileName(fileName: string): string {
  const pretty = fileName.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim()
  return pretty || 'Untitled'
}

export interface WikiLink {
  /** Raw target as written, e.g. `My Note` in `[[My Note|alias]]`. */
  target: string
  /** Display text: the alias, or the target when there is none. */
  alias: string
}

const WIKI_RE = /\[\[([^\]\n]+?)\]\]/g

/**
 * Extract `[[Note]]` and `[[Note|alias]]` links from markdown source.
 * Code spans are skipped so `` `[[not-a-link]]` `` stays literal.
 */
export function parseWikiLinks(source: string): WikiLink[] {
  const withoutCode = source.replace(/`[^`\n]+`/g, (span) => ' '.repeat(span.length))
  const links: WikiLink[] = []
  WIKI_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = WIKI_RE.exec(withoutCode)) !== null) {
    const inner = match[1]
    const pipe = inner.indexOf('|')
    const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim()
    if (!target) continue
    const alias = (pipe < 0 ? inner : inner.slice(pipe + 1)).trim() || target
    links.push({ target, alias })
  }
  return links
}

/** Minimal note shape needed for link resolution (avoids a store import). */
export interface LinkableNote {
  id: string
  title: string
}

/**
 * Find the note a wiki-link points at, matching titles case-insensitively.
 * Blank titles resolve as "Untitled" (matching display), so clearing a title
 * never orphans the note from its parent's hidden links.
 */
export function resolveWikiTarget(target: string, notes: LinkableNote[]): string | null {
  const needle = target.trim().toLowerCase()
  if (!needle) return null
  return (
    notes.find((note) => (note.title.trim() || 'Untitled').toLowerCase() === needle)?.id ?? null
  )
}

/**
 * Order notes for the sidebar: the persisted manual order first, then any
 * notes not yet positioned (new or freshly imported), most-recently-edited
 * first — which is also exactly the legacy behavior when no manual order
 * exists yet.
 */
export function orderedNotes<T extends { id: string; updatedAt: number }>(
  notes: T[],
  noteOrder: string[]
): T[] {
  const byId = new Map(notes.map((note) => [note.id, note]))
  const known: T[] = []
  for (const id of noteOrder) {
    const note = byId.get(id)
    if (note) known.push(note)
  }
  const knownSet = new Set(known.map((note) => note.id))
  const missing = notes
    .filter((note) => !knownSet.has(note.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return [...missing, ...known]
}

export interface NoteGraph<T> {
  /** Resolved outgoing links per note id (deduped, self-links dropped). */
  children: Map<string, T[]>
  /**
   * Notes with no parent: no incoming link from outside their own cycle
   * group, in input order. A pure cycle (A↔B with no outside links) keeps
   * all its members at top level so nothing can vanish from the sidebar.
   */
  roots: T[]
}

/**
 * Build the sidebar tree: children per note plus cycle-safe roots.
 * Components are found with iterative Tarjan SCC, so even pathological
 * link graphs (mutual links, long cycles) always leave something visible.
 */
export function buildNoteGraph<T extends { id: string; title: string; content: string }>(
  notes: T[]
): NoteGraph<T> {
  const byId = new Map(notes.map((note) => [note.id, note]))
  const children = new Map<string, T[]>()
  // Hidden-footer links are the explicit parent record. If a note is parented
  // that way, ignore ordinary body `[[links]]` pointing at it; otherwise a
  // slash-created child (hidden link + inline link in the old parent) shows up
  // under both parents after being dragged elsewhere.
  const hiddenTargets = new Set<string>()
  for (const note of notes) {
    const hidden = splitHidden(note.content).hidden
    if (!hidden) continue
    for (const page of hidden.pages) {
      const id = resolveWikiTarget(page, notes)
      if (id && id !== note.id) hiddenTargets.add(id)
    }
  }
  const outgoing: number[][] = notes.map((note) => {
    const seen = new Set<string>()
    const kids: T[] = []
    const add = (target: string): void => {
      const id = resolveWikiTarget(target, notes)
      if (!id || id === note.id || seen.has(id)) return
      seen.add(id)
      const child = byId.get(id)
      if (child) kids.push(child)
    }
    const { body, hidden } = splitHidden(note.content)
    for (const link of parseWikiLinks(body)) {
      const id = resolveWikiTarget(link.target, notes)
      if (id && hiddenTargets.has(id)) continue
      add(link.target)
    }
    if (hidden) for (const page of hidden.pages) add(page)
    children.set(note.id, kids)
    return kids.map((kid) => notes.indexOf(kid))
  })

  // Iterative Tarjan SCC over integer indices (no recursion depth risk).
  const count = notes.length
  const indexOf: number[] = new Array<number>(count).fill(-1)
  const lowlink: number[] = new Array<number>(count).fill(0)
  const onStack: boolean[] = new Array<boolean>(count).fill(false)
  const stack: number[] = []
  const compOf: number[] = new Array<number>(count).fill(-1)
  let index = 0
  let compCount = 0

  for (let root = 0; root < count; root++) {
    if (indexOf[root] !== -1) continue
    const work: { node: number; next: number }[] = [{ node: root, next: 0 }]
    while (work.length > 0) {
      const frame = work[work.length - 1]
      const node = frame.node
      if (indexOf[node] === -1) {
        indexOf[node] = index
        lowlink[node] = index
        index++
        stack.push(node)
        onStack[node] = true
      }
      const succs = outgoing[node] ?? []
      if (frame.next < succs.length) {
        const next = succs[frame.next]
        frame.next++
        if (indexOf[next] === -1) {
          work.push({ node: next, next: 0 })
        } else if (onStack[next]) {
          lowlink[node] = Math.min(lowlink[node], indexOf[next])
        }
      } else {
        if (lowlink[node] === indexOf[node]) {
          let member = -1
          do {
            member = stack.pop() ?? -1
            if (member >= 0) {
              onStack[member] = false
              compOf[member] = compCount
            }
          } while (member !== node && member >= 0)
          compCount++
        }
        work.pop()
        if (work.length > 0) {
          const parent = work[work.length - 1].node
          lowlink[parent] = Math.min(lowlink[parent], lowlink[node])
        }
      }
    }
  }

  const compIncoming = new Set<number>()
  outgoing.forEach((succs, from) => {
    for (const to of succs) {
      if (compOf[from] !== compOf[to]) compIncoming.add(compOf[to])
    }
  })

  const roots = notes.filter((_, i) => !compIncoming.has(compOf[i]))
  return { children, roots }
}

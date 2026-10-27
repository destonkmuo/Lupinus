/**
 * Study children: flashcards (Quizlet-style sets), learn mode (same decks),
 * mindmaps, and quizzes (blank shell for now).
 *
 * Every set lives as a CHILD NOTE: the child note's body is basic JSON
 * (`{"type":"flashcards","cards":[...]}`), its title is the set name, and the
 * parent's `## Hidden` footer only keeps a `[[Child Title]]` link. Hidden is
 * never rendered — it only exists in the file so the tree nests.
 *
 * Lupinus will flesh out generation later; for now every collection is manually
 * editable key by key (term/definition, node label, …) through the same UI.
 */

export interface Flashcard {
  id: string
  /** Key / term (front of card). Manually editable. */
  front: string
  /** Definition / answer (back of card). Manually editable. */
  back: string
  /** Optional hint shown in Learn mode. */
  hint?: string
}

export interface MindmapNode {
  id: string
  label: string
  /** Null = root/central node. */
  parentId: string | null
  /** Manual drag offsets (px, content space) added to the auto-layout. */
  ox?: number
  oy?: number
}

export type StudyChildType = 'flashcards' | 'mindmap' | 'quiz'

export interface FlashcardsChild {
  type: 'flashcards'
  description: string
  /** Manually maintained list of keys + definitions. */
  cards: Flashcard[]
}

export interface MindmapChild {
  type: 'mindmap'
  nodes: MindmapNode[]
}

/** Quizzes stay blank on purpose — question bank lands later. */
export interface QuizChild {
  type: 'quiz'
  questions: unknown[]
}

export type StudyChild = FlashcardsChild | MindmapChild | QuizChild

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function cleanCards(raw: unknown): Flashcard[] | null {
  if (!Array.isArray(raw)) return null
  const out: Flashcard[] = []
  for (const item of raw) {
    if (!isRecord(item)) return null
    const id = typeof item.id === 'string' && item.id ? item.id : null
    if (!id) return null
    out.push({
      id,
      front: typeof item.front === 'string' ? item.front : '',
      back: typeof item.back === 'string' ? item.back : '',
      ...(typeof item.hint === 'string' && item.hint ? { hint: item.hint } : {})
    })
  }
  return out
}

function cleanNodes(raw: unknown): MindmapNode[] | null {
  if (!Array.isArray(raw)) return null
  const out: MindmapNode[] = []
  for (const item of raw) {
    if (!isRecord(item)) return null
    const id = typeof item.id === 'string' && item.id ? item.id : null
    if (!id) return null
    const parentId =
      item.parentId === null || (typeof item.parentId === 'string' && item.parentId)
        ? (item.parentId as string | null)
        : null
    if (
      item.parentId !== undefined &&
      item.parentId !== null &&
      typeof item.parentId !== 'string'
    ) {
      return null
    }
    const off = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : undefined
    const ox = off(item.ox)
    const oy = off(item.oy)
    out.push({
      id,
      label: typeof item.label === 'string' ? item.label : '',
      parentId,
      ...(ox !== undefined ? { ox } : {}),
      ...(oy !== undefined ? { oy } : {})
    })
  }
  // Must have exactly one root to render sanely.
  if (!out.some((n) => n.parentId === null)) return null
  return out
}

/**
 * Parse a note body as a study child. Returns null for ordinary markdown.
 * Strict on purpose: the whole trimmed body must be one JSON object with a
 * known `type`, so a markdown note that merely mentions JSON never matches.
 */
export function parseStudyChild(body: string): StudyChild | null {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') return null
  if (parsed.type === 'flashcards') {
    const cards = cleanCards(parsed.cards)
    if (!cards) return null
    return {
      type: 'flashcards',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      cards
    }
  }
  if (parsed.type === 'mindmap') {
    const nodes = cleanNodes(parsed.nodes)
    if (!nodes) return null
    return { type: 'mindmap', nodes }
  }
  if (parsed.type === 'quiz') {
    const questions = Array.isArray(parsed.questions) ? parsed.questions : []
    return { type: 'quiz', questions }
  }
  return null
}

export function newCardId(): string {
  return crypto.randomUUID()
}

export function blankFlashcardsBody(): string {
  return (
    JSON.stringify(
      {
        type: 'flashcards',
        description: '',
        cards: [
          { id: newCardId(), front: 'Term 1', back: 'Definition 1' },
          { id: newCardId(), front: 'Term 2', back: 'Definition 2' }
        ]
      } satisfies Omit<FlashcardsChild, 'type'> & { type: 'flashcards' },
      null,
      2
    ) + '\n'
  )
}

export function blankMindmapBody(): string {
  return (
    JSON.stringify(
      {
        type: 'mindmap',
        nodes: [{ id: newCardId(), label: 'Central idea', parentId: null }]
      } satisfies Omit<MindmapChild, 'type'> & { type: 'mindmap' },
      null,
      2
    ) + '\n'
  )
}

export function blankQuizBody(): string {
  return JSON.stringify({ type: 'quiz', questions: [] } satisfies QuizChild, null, 2) + '\n'
}

export function serializeFlashcards(data: FlashcardsChild): string {
  return (
    JSON.stringify(
      { type: 'flashcards', description: data.description, cards: data.cards },
      null,
      2
    ) + '\n'
  )
}

export function serializeMindmap(data: MindmapChild): string {
  return JSON.stringify({ type: 'mindmap', nodes: data.nodes }, null, 2) + '\n'
}

/** Fisher–Yates shuffle (study order, quiz options). */
export function shuffled<T>(items: T[]): T[] {
  const next = [...items]
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[next[i], next[j]] = [next[j], next[i]]
  }
  return next
}

/** Children of a mindmap node, in insertion order. */
export function childrenOfNodes(nodes: MindmapNode[], parentId: string | null): MindmapNode[] {
  return nodes.filter((n) => n.parentId === parentId)
}

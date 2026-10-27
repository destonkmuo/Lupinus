import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  childrenOfNodes,
  newCardId,
  parseStudyChild,
  serializeFlashcards,
  serializeMindmap,
  shuffled,
  type FlashcardsChild,
  type Flashcard,
  type MindmapChild,
  type MindmapNode
} from '../study'
import { splitHidden } from '../subpages'
import { useAppStore } from '../store/appStore'
import { PlusIcon, TrashIcon, XIcon } from './icons'

function useChildBody(noteId: string): string {
  const note = useAppStore((state) => state.notes.find((n) => n.id === noteId) ?? null)
  return splitHidden(note?.content ?? '').body
}

function updateFlashcards(
  noteId: string,
  mutate: (data: FlashcardsChild) => FlashcardsChild
): void {
  const state = useAppStore.getState()
  const current = state.notes.find((n) => n.id === noteId)
  if (!current) return
  const parsed = parseStudyChild(splitHidden(current.content).body)
  if (!parsed || parsed.type !== 'flashcards') return
  state.updateNote(noteId, {
    content: writeBodyPreservingHidden(current.content, serializeFlashcards(mutate(parsed)))
  })
}

function writeBodyPreservingHidden(full: string, body: string): string {
  const split = splitHidden(full)
  if (!split.hidden) return body
  return `${body.trimEnd()}\n\n---\n## Hidden\n${split.hidden.raw}`
}

function updateMindmap(noteId: string, mutate: (data: MindmapChild) => MindmapChild): void {
  const state = useAppStore.getState()
  const current = state.notes.find((n) => n.id === noteId)
  if (!current) return
  const parsed = parseStudyChild(splitHidden(current.content).body)
  if (!parsed || parsed.type !== 'mindmap') return
  state.updateNote(noteId, {
    content: writeBodyPreservingHidden(current.content, serializeMindmap(mutate(parsed)))
  })
}

/** Quizlet-style study + Learn mode + manual key/definition editor. */
export function FlashcardsChildView({ noteId }: { noteId: string }): React.JSX.Element {
  const body = useChildBody(noteId)
  const data = useMemo(() => parseStudyChild(body), [body]) as FlashcardsChild | null

  const [mode, setMode] = useState<'study' | 'learn' | 'edit'>('study')
  const [order, setOrder] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [known, setKnown] = useState<Set<string>>(new Set())
  // Terms index stays hidden at the top of the page; scrolling down brings
  // it in (or immediately, when the page is too short to scroll).
  // Subscription only — state lands in callbacks, never the body.
  const [pastTop, setPastTop] = useState(false)
  const termsAnchorRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const scroller = termsAnchorRef.current?.closest('.note__scroll')
    if (!(scroller instanceof HTMLElement)) return
    const check = (): void => {
      const max = scroller.scrollHeight - scroller.clientHeight
      setPastTop(scroller.scrollTop > 40 || max <= 4)
    }
    const frame = requestAnimationFrame(check)
    scroller.addEventListener('scroll', check, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', check)
    }
  }, [mode])

  const nudgeTermsIntoView = (): void => {
    const scroller = termsAnchorRef.current?.closest('.note__scroll')
    if (scroller instanceof HTMLElement) {
      scroller.scrollBy({ top: 240, behavior: 'smooth' })
    }
  }

  // Fresh study position per child / card set (render-time adjustment).
  const [deckKey, setDeckKey] = useState<string>(noteId)
  const fingerprint = data ? `${noteId}:${data.cards.map((c) => c.id).join(',')}` : noteId
  if (deckKey !== fingerprint) {
    setDeckKey(fingerprint)
    setOrder((data?.cards ?? []).map((c) => c.id))
    setIndex(0)
    setFlipped(false)
    setKnown(new Set())
    setPastTop(false)
  }

  const cards = useMemo(() => {
    if (!data) return []
    const byId = new Map(data.cards.map((c) => [c.id, c]))
    const ids = order.length > 0 ? order : data.cards.map((c) => c.id)
    return ids.map((id) => byId.get(id)).filter((c): c is Flashcard => c !== undefined)
  }, [data, order])

  const current = cards[Math.min(index, Math.max(cards.length - 1, 0))] ?? null

  if (!data) return <p className="study__muted">This page is not valid flashcards JSON.</p>

  const shuffle = (): void => {
    setOrder(shuffled(data.cards.map((c) => c.id)))
    setIndex(0)
    setFlipped(false)
  }

  const mark = (id: string, knew: boolean): void => {
    setKnown((prev) => {
      const next = new Set(prev)
      if (knew) next.add(id)
      else next.delete(id)
      return next
    })
    setFlipped(false)
    setIndex((i) => Math.min(i + 1, Math.max(cards.length - 1, 0)))
  }

  return (
    <>
      <div className="study__tabs" role="tablist" aria-label="Flashcard mode">
        {(['study', 'learn', 'edit'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={`study__tab${mode === m ? ' is-active' : ''}`}
            onClick={() => setMode(m)}
          >
            {m === 'study' ? 'Study' : m === 'learn' ? 'Learn' : `Edit (${data.cards.length})`}
          </button>
        ))}
      </div>
      <input
        className="study__deck-desc"
        value={data.description}
        placeholder="Add a description…"
        aria-label="Set description"
        onChange={(e) => updateFlashcards(noteId, (d) => ({ ...d, description: e.target.value }))}
      />
      {mode === 'study' ? (
        <div className="cards">
          <div className="cards__progress" aria-label="Study progress">
            <span>
              {cards.length === 0 ? 0 : Math.min(index + 1, cards.length)} / {cards.length}
            </span>
            <span className="cards__bar" aria-hidden="true">
              <span
                className="cards__fill"
                style={{
                  width: `${cards.length === 0 ? 0 : Math.min(100, ((index + 1) / cards.length) * 100)}%`
                }}
              />
            </span>
            <span>{known.size} known</span>
            <button type="button" className="btn btn--ghost" onClick={shuffle}>
              Shuffle
            </button>
          </div>
          {current ? (
            <>
              <button
                type="button"
                className={`flashcard${flipped ? ' is-flipped' : ''}`}
                onClick={() => setFlipped((f) => !f)}
                aria-label={flipped ? 'Show term' : 'Show definition'}
              >
                <span className="flashcard__face flashcard__face--front" aria-hidden={flipped}>
                  <span className="flashcard__side">Term</span>
                  <span className="flashcard__text">{current.front || '(empty)'}</span>
                </span>
                <span className="flashcard__face flashcard__face--back" aria-hidden={!flipped}>
                  <span className="flashcard__side">Definition</span>
                  <span className="flashcard__text">{current.back || '(empty)'}</span>
                </span>
                <span className="flashcard__hint">Click to flip</span>
              </button>
              <div className="cards__actions">
                <div className="cards__nav">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={index <= 0}
                    onClick={() => {
                      setIndex((i) => Math.max(0, i - 1))
                      setFlipped(false)
                    }}
                  >
                    ‹ Prev
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={index >= cards.length - 1}
                    onClick={() => {
                      setIndex((i) => Math.min(cards.length - 1, i + 1))
                      setFlipped(false)
                    }}
                  >
                    Next ›
                  </button>
                </div>
                <div className="cards__judge">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => current && mark(current.id, false)}
                  >
                    Still learning
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => current && mark(current.id, true)}
                  >
                    Got it
                  </button>
                </div>
              </div>
              <div ref={termsAnchorRef} className="terms-list-anchor" aria-hidden="true" />
              {pastTop ? (
                <div className="terms-list">
                  <p className="terms-list__head">Terms in this set · {data.cards.length}</p>
                  <div className="terms-list__scroll">
                    <ol className="terms-list__items">
                      {data.cards.map((card, i) => (
                        <li key={card.id} className="terms-list__row">
                          <span className="terms-list__num">{i + 1}</span>
                          <span className="terms-list__term">{card.front || '(empty)'}</span>
                          <span className="terms-list__def">{card.back || '(empty)'}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="terms-scroll-cue"
                  onClick={nudgeTermsIntoView}
                  aria-label="Scroll down to see all terms"
                >
                  <span aria-hidden="true">Scroll for all {data.cards.length} terms</span>
                  <span className="terms-scroll-cue__chev" aria-hidden="true">
                    ⌄
                  </span>
                </button>
              )}
            </>
          ) : (
            <p className="study__muted">
              No cards yet — switch to Edit and add keys + definitions.
            </p>
          )}
        </div>
      ) : mode === 'learn' ? (
        <LearnChildView noteId={noteId} />
      ) : (
        <div className="cards__editor">
          {data.cards.map((card, i) => (
            <div key={card.id} className="cards__row">
              <span className="cards__num">{i + 1}</span>
              <input
                value={card.front}
                placeholder="Term / key"
                aria-label={`Term ${i + 1}`}
                onChange={(e) =>
                  updateFlashcards(noteId, (d) => ({
                    ...d,
                    cards: d.cards.map((c) =>
                      c.id === card.id ? { ...c, front: e.target.value } : c
                    )
                  }))
                }
              />
              <input
                value={card.back}
                placeholder="Definition"
                aria-label={`Definition ${i + 1}`}
                onChange={(e) =>
                  updateFlashcards(noteId, (d) => ({
                    ...d,
                    cards: d.cards.map((c) =>
                      c.id === card.id ? { ...c, back: e.target.value } : c
                    )
                  }))
                }
              />
              <button
                type="button"
                className="icon-btn icon-btn--danger"
                title="Remove card"
                aria-label={`Remove card ${i + 1}`}
                onClick={() =>
                  updateFlashcards(noteId, (d) => ({
                    ...d,
                    cards: d.cards.filter((c) => c.id !== card.id)
                  }))
                }
              >
                <TrashIcon size={13} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() =>
              updateFlashcards(noteId, (d) => ({
                ...d,
                cards: [...d.cards, { id: newCardId(), front: '', back: '' }]
              }))
            }
          >
            <PlusIcon size={14} /> Add card
          </button>
        </div>
      )}
    </>
  )
}

interface Question {
  cardId: string
  prompt: string
  answer: string
  options: string[]
}

function buildRound(cards: Flashcard[]): Question[] {
  return shuffled(cards).map((card) => {
    const distractors = shuffled(cards.filter((c) => c.id !== card.id))
      .slice(0, 3)
      .map((c) => c.back || '(empty)')
    return {
      cardId: card.id,
      prompt: card.front || '(empty)',
      answer: card.back || '(empty)',
      options: shuffled([card.back || '(empty)', ...distractors])
    }
  })
}

/** Quizlet Learn-style rounds over one child note. */
export function LearnChildView({ noteId }: { noteId: string }): React.JSX.Element {
  const body = useChildBody(noteId)
  const data = useMemo(() => parseStudyChild(body), [body]) as FlashcardsChild | null

  const [round, setRound] = useState<Question[]>([])
  const [pos, setPos] = useState(0)
  const [picked, setPicked] = useState<string | null>(null)
  const [written, setWritten] = useState('')
  const [writtenMode, setWrittenMode] = useState(false)
  const [mastery, setMastery] = useState<Record<string, number>>({})

  const [learnKey, setLearnKey] = useState<string>(noteId)
  const fingerprint = data ? `${noteId}:${data.cards.map((c) => c.id).join(',')}` : noteId
  if (learnKey !== fingerprint) {
    setLearnKey(fingerprint)
    setRound(buildRound(data?.cards ?? []))
    setPos(0)
    setPicked(null)
    setWritten('')
    setMastery({})
  }

  const current = round[pos] ?? null
  const mastered = useMemo(() => Object.values(mastery).filter((v) => v >= 2).length, [mastery])
  const total = data?.cards.length ?? 0

  if (!data) return <p className="study__muted">This page is not valid flashcards JSON.</p>

  const answerChoice = (option: string): void => {
    if (!current || picked !== null) return
    setPicked(option)
    const correct = option === current.answer
    setMastery((prev) => ({
      ...prev,
      [current.cardId]: Math.max(0, (prev[current.cardId] ?? 0) + (correct ? 1 : -1))
    }))
  }

  const answerWritten = (): void => {
    if (!current || picked !== null) return
    const guess = written.trim().toLowerCase()
    const correct = guess === current.answer.trim().toLowerCase()
    setPicked(correct ? current.answer : `✕ ${written.trim() || '(empty)'}`)
    setMastery((prev) => ({
      ...prev,
      [current.cardId]: Math.max(0, (prev[current.cardId] ?? 0) + (correct ? 1 : -1))
    }))
  }

  const next = (): void => {
    setPicked(null)
    setWritten('')
    setPos((p) => Math.min(p + 1, Math.max(round.length - 1, 0)))
  }

  if (data.cards.length === 0) return <p className="study__muted">No terms yet.</p>

  return (
    <>
      <div className="cards__progress" aria-label="Learn progress">
        <span>
          Question {round.length === 0 ? 0 : Math.min(pos + 1, round.length)} / {round.length}
        </span>
        <span className="cards__bar" aria-hidden="true">
          <span
            className="cards__fill"
            style={{
              width: `${round.length === 0 ? 0 : Math.min(100, ((pos + 1) / round.length) * 100)}%`
            }}
          />
        </span>
        <span>
          {mastered} / {total} mastered
        </span>
        <label className="settings__check">
          <input
            type="checkbox"
            checked={writtenMode}
            onChange={(e) => {
              setWrittenMode(e.target.checked)
              setPicked(null)
              setWritten('')
            }}
          />
          Written
        </label>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            setRound(buildRound(data.cards))
            setPos(0)
            setPicked(null)
            setWritten('')
          }}
        >
          Restart
        </button>
      </div>
      {current && (
        <section key={current.cardId} className="learn__card" aria-live="polite">
          <p className="learn__prompt">{current.prompt}</p>
          {!writtenMode ? (
            <div className="learn__options">
              {current.options.map((option, i) => {
                const isAnswer = option === current.answer
                const isPicked = option === picked
                const cls =
                  picked === null
                    ? ''
                    : isAnswer
                      ? ' is-correct'
                      : isPicked
                        ? ' is-wrong'
                        : ' is-dim'
                return (
                  <button
                    key={`${current.cardId}-${option}`}
                    type="button"
                    className={`learn__option${cls}`}
                    style={{ animationDelay: `${Math.min(i, 5) * 55}ms` }}
                    disabled={picked !== null}
                    onClick={() => answerChoice(option)}
                  >
                    {option}
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="learn__written">
              <input
                value={written}
                placeholder="Type the definition…"
                aria-label="Type the definition"
                disabled={picked !== null}
                onChange={(e) => setWritten(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') answerWritten()
                }}
              />
              <button
                type="button"
                className="btn btn--primary"
                disabled={picked !== null}
                onClick={answerWritten}
              >
                Check
              </button>
            </div>
          )}
          {picked !== null && (
            <div className="learn__feedback">
              <span>{picked === current.answer ? 'Correct.' : `Answer: ${current.answer}`}</span>
              <button type="button" className="btn btn--primary" onClick={next}>
                {pos >= round.length - 1 ? 'Finish round' : 'Next'}
              </button>
            </div>
          )}
        </section>
      )}
    </>
  )
}

function layoutPositions(
  rootId: string,
  nodes: MindmapNode[]
): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>()
  let row = 0
  const walk = (id: string, depth: number): void => {
    const kids = nodes.filter((n) => n.parentId === id)
    if (kids.length === 0) {
      pos.set(id, { x: 150 + depth * 250, y: 64 + row * 76 })
      row++
      return
    }
    for (const kid of kids) walk(kid.id, depth + 1)
    const ys = kids.map((k) => pos.get(k.id)?.y ?? 0)
    pos.set(id, { x: 150 + depth * 250, y: (Math.min(...ys) + Math.max(...ys)) / 2 })
  }
  walk(rootId, 0)
  return pos
}

/** Soft tint per depth so branches read at a glance. */
function depthFill(depth: number): { fill: string; stroke: string } {
  if (depth === 1) return { fill: 'rgba(63,143,255,0.16)', stroke: 'rgba(63,143,255,0.6)' }
  if (depth === 2) return { fill: 'rgba(47,208,224,0.12)', stroke: 'rgba(47,208,224,0.55)' }
  if (depth >= 3) return { fill: 'rgba(255,255,255,0.05)', stroke: 'rgba(255,255,255,0.28)' }
  return { fill: 'rgba(255,255,255,0.06)', stroke: 'rgba(255,255,255,0.3)' }
}

const NODE_W = 176
const NODE_H = 48
const ROOT_W = 208
const ROOT_H = 56
const MIN_ZOOM = 0.3
const MAX_ZOOM = 2.5

function nodeBox(node: MindmapNode): { w: number; h: number } {
  return node.parentId === null ? { w: ROOT_W, h: ROOT_H } : { w: NODE_W, h: NODE_H }
}

/** Fit transform for a node list inside a canvas box. */
function fitTransformFor(
  nodes: MindmapNode[],
  cw: number,
  ch: number
): { x: number; y: number; k: number } | null {
  const root = nodes.find((n) => n.parentId === null)
  if (!root || cw <= 0 || ch <= 0) return null
  const pos = layoutPositions(root.id, nodes)
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const n of nodes) {
    const p = pos.get(n.id)
    if (!p) continue
    const { w, h } = nodeBox(n)
    // Manual drag offsets count toward the frame.
    const cx = p.x + (n.ox ?? 0)
    const cy = p.y + (n.oy ?? 0)
    minX = Math.min(minX, cx - w / 2)
    maxX = Math.max(maxX, cx + w / 2)
    minY = Math.min(minY, cy - h / 2)
    maxY = Math.max(maxY, cy + h / 2)
  }
  if (!Number.isFinite(minX)) return null
  const bw = Math.max(maxX - minX, 1)
  const bh = Math.max(maxY - minY, 1)
  const k = Math.min(1.5, Math.max(MIN_ZOOM, Math.min((cw - 96) / bw, (ch - 96) / bh)))
  return { k, x: (cw - bw * k) / 2 - minX * k, y: (ch - bh * k) / 2 - minY * k }
}

/** Notebook-style canvas: mouse-hold / one-finger drag pans, wheel / pinch
 * zooms, chevrons collapse branches, labels edit in place. No +/- chrome. */
export function MindmapChildView({ noteId }: { noteId: string }): React.JSX.Element {
  const body = useChildBody(noteId)
  const data = useMemo(() => parseStudyChild(body), [body]) as MindmapChild | null
  // The root pill IS the page title (renaming keeps hierarchy via the store).
  const noteTitle = useAppStore((state) => state.notes.find((n) => n.id === noteId)?.title ?? '')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [view, setView] = useState({ x: 72, y: 220, k: 1 })
  const [panning, setPanning] = useState(false)
  const [fittedFor, setFittedFor] = useState<string | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    id: number
    sx: number
    sy: number
    ox: number
    oy: number
    moved: boolean
    pan: boolean
  } | null>(null)
  const touchesRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{
    dist: number
    mx: number
    my: number
    k: number
    x: number
    y: number
  } | null>(null)
  const nodeDragRef = useRef<{
    id: string
    pid: number
    sx: number
    sy: number
    ox: number
    oy: number
    moved: boolean
  } | null>(null)
  const suppressClickRef = useRef(false)

  const root = data?.nodes.find((n) => n.parentId === null) ?? null

  // Visible nodes: descendants of collapsed branches stay in the JSON but
  // leave the canvas.
  const visible = useMemo(() => {
    if (!data) return []
    if (collapsed.size === 0) return data.nodes
    const hidden = new Set<string>()
    const stack = [...collapsed]
    while (stack.length > 0) {
      const cur = stack.pop() as string
      for (const n of data.nodes) {
        if (n.parentId === cur && !hidden.has(n.id)) {
          hidden.add(n.id)
          stack.push(n.id)
        }
      }
    }
    return data.nodes.filter((n) => !hidden.has(n.id))
  }, [data, collapsed])

  const positions = useMemo(
    () => (root ? layoutPositions(root.id, visible) : new Map<string, { x: number; y: number }>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [root?.id, visible]
  )
  const depths = useMemo(() => {
    const m = new Map<string, number>()
    const walk = (id: string, d: number): void => {
      if (m.has(id)) return
      m.set(id, d)
      for (const kid of childrenOfNodes(visible, id)) walk(kid.id, d + 1)
    }
    if (root) walk(root.id, 0)
    return m
  }, [root, visible])

  // Layout plus manual drag offsets: the single source for pills + edges.
  const finalPositions = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>()
    for (const n of visible) {
      const p = positions.get(n.id)
      if (p) m.set(n.id, { x: p.x + (n.ox ?? 0), y: p.y + (n.oy ?? 0) })
    }
    return m
  }, [visible, positions])

  // Fit once per note, past mount (async, like the sidebar rename signal).
  useLayoutEffect(() => {
    if (fittedFor === noteId) return
    const frame = requestAnimationFrame(() => {
      setFittedFor(noteId)
      const el = canvasRef.current
      if (!el) return
      const state = useAppStore.getState()
      const current = state.notes.find((n) => n.id === noteId)
      const parsed = parseStudyChild(splitHidden(current?.content ?? '').body)
      if (parsed?.type !== 'mindmap') return
      const t = fitTransformFor(parsed.nodes, el.clientWidth, el.clientHeight)
      if (t) setView(t)
    })
    return () => cancelAnimationFrame(frame)
  }, [noteId, fittedFor])

  // Wheel zoom (non-passive so the page never scrolls under the canvas).
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016))
      setView((v) => {
        const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor))
        const s = k / v.k
        return { k, x: mx - (mx - v.x) * s, y: my - (my - v.y) * s }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Node presses skip pointer capture (so their clicks land), which means a
  // press that ends off-canvas never reaches the canvas handlers — sweep it
  // here so gesture state can never go stale.
  useEffect(() => {
    const clear = (e: PointerEvent): void => {
      touchesRef.current.delete(e.pointerId)
      if (touchesRef.current.size < 2) pinchRef.current = null
      if (dragRef.current && dragRef.current.id === e.pointerId) {
        dragRef.current = null
        setPanning(false)
      }
      if (nodeDragRef.current && nodeDragRef.current.pid === e.pointerId) {
        nodeDragRef.current = null
      }
    }
    window.addEventListener('pointerup', clear)
    window.addEventListener('pointercancel', clear)
    return () => {
      window.removeEventListener('pointerup', clear)
      window.removeEventListener('pointercancel', clear)
    }
  }, [])

  if (!data || !root) return <p className="study__muted">This page is not valid mindmap JSON.</p>

  const fitVisible = (): void => {
    const el = canvasRef.current
    if (!el) return
    const t = fitTransformFor(visible, el.clientWidth, el.clientHeight)
    if (t) setView(t)
  }

  const zoomStep = (dir: 1 | -1): void => {
    const el = canvasRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const mx = rect.width / 2
    const my = rect.height / 2
    setView((v) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * (dir === 1 ? 1.25 : 0.8)))
      const s = k / v.k
      return { k, x: mx - (mx - v.x) * s, y: my - (my - v.y) * s }
    })
  }

  const onCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = canvasRef.current
    if (!el) return
    touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const inNode =
      typeof (e.target as Element).closest === 'function' &&
      (e.target as Element).closest('.mindmap__node-el') !== null
    const twoFinger = touchesRef.current.size === 2
    // Capture only for background pans and pinches: capturing node presses
    // retargets their click to the canvas and silently kills buttons.
    if (twoFinger || !inNode) {
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        // Already released; moves still arrive.
      }
    }
    if (twoFinger) {
      // Second finger: switch from pan to pinch, snapshotting the view.
      // An in-flight node drag stays committed live already — just drop it.
      nodeDragRef.current = null
      const [a, b] = [...touchesRef.current.values()]
      const drag = dragRef.current
      const snapX = drag ? drag.ox + (e.clientX - drag.sx) : view.x
      const snapY = drag ? drag.oy + (e.clientY - drag.sy) : view.y
      pinchRef.current = {
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
        k: view.k,
        x: snapX,
        y: snapY
      }
      dragRef.current = null
      setPanning(true)
      return
    }
    dragRef.current = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      ox: view.x,
      oy: view.y,
      moved: false,
      pan: !inNode
    }
  }

  const onCanvasPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (touchesRef.current.has(e.pointerId)) {
      touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }
    const el = canvasRef.current
    if (touchesRef.current.size === 2 && el) {
      const pinch = pinchRef.current
      if (!pinch) return
      const [a, b] = [...touchesRef.current.values()]
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
      const rect = el.getBoundingClientRect()
      const lx = (a.x + b.x) / 2 - rect.left
      const ly = (a.y + b.y) / 2 - rect.top
      const sx = pinch.mx - rect.left
      const sy = pinch.my - rect.top
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (pinch.k * dist) / pinch.dist))
      const s = k / pinch.k
      setView({ k, x: lx - (sx - pinch.x) * s, y: ly - (sy - pinch.y) * s })
      return
    }
    const drag = dragRef.current
    if (drag && drag.id === e.pointerId && drag.pan) {
      const dx = e.clientX - drag.sx
      const dy = e.clientY - drag.sy
      if (!drag.moved && Math.hypot(dx, dy) > 4) {
        drag.moved = true
        setPanning(true)
      }
      if (drag.moved) setView((v) => ({ ...v, x: drag.ox + dx, y: drag.oy + dy }))
      return
    }
    // Node dragging: live-write offsets (rounded, zero-stripped JSON).
    const nd = nodeDragRef.current
    if (nd && nd.pid === e.pointerId && touchesRef.current.size === 1) {
      const rawDx = e.clientX - nd.sx
      const rawDy = e.clientY - nd.sy
      if (!nd.moved && Math.hypot(rawDx, rawDy) > 5) nd.moved = true
      if (nd.moved) {
        const nx = Math.round(nd.ox + rawDx / view.k)
        const ny = Math.round(nd.oy + rawDy / view.k)
        updateMindmap(noteId, (d) => ({
          ...d,
          nodes: d.nodes.map((n) => {
            if (n.id !== nd.id) return n
            const next: MindmapNode = { ...n, ox: nx, oy: ny }
            if (nx === 0) delete next.ox
            if (ny === 0) delete next.oy
            return next
          })
        }))
      }
    }
  }

  const onCanvasPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    // Release capture before click dispatches, or button clicks (chevron,
    // add, delete) retarget to the canvas and silently die.
    const el = canvasRef.current
    if (el) {
      try {
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      } catch {
        // Already released; nothing to do.
      }
    }
    touchesRef.current.delete(e.pointerId)
    if (touchesRef.current.size < 2) pinchRef.current = null
    const nd = nodeDragRef.current
    if (nd && nd.pid === e.pointerId) {
      nodeDragRef.current = null
      // A real drag must not leak into the click that follows it.
      if (nd.moved) suppressClickRef.current = true
    }
    const drag = dragRef.current
    if (drag && drag.id === e.pointerId) {
      dragRef.current = null
      setPanning(false)
      if (!drag.moved && drag.pan) setSelectedId(null)
    }
    if (touchesRef.current.size === 0) setPanning(false)
  }

  const commitLabel = (nodeId: string, label: string): void => {
    updateMindmap(noteId, (d) => ({
      ...d,
      nodes: d.nodes.map((n) => (n.id === nodeId ? { ...n, label } : n))
    }))
  }

  const removeBranch = (nodeId: string): void => {
    const state = useAppStore.getState()
    const current = state.notes.find((n) => n.id === noteId)
    const parsed = parseStudyChild(splitHidden(current?.content ?? '').body)
    const parentId =
      parsed?.type === 'mindmap'
        ? (parsed.nodes.find((n) => n.id === nodeId)?.parentId ?? null)
        : null
    updateMindmap(noteId, (d) => {
      const drop = new Set<string>([nodeId])
      let grew = true
      while (grew) {
        grew = false
        for (const n of d.nodes) {
          if (n.parentId && drop.has(n.parentId) && !drop.has(n.id)) {
            drop.add(n.id)
            grew = true
          }
        }
      }
      return { ...d, nodes: d.nodes.filter((n) => !drop.has(n.id)) }
    })
    setCollapsed((prev) => {
      if (prev.size === 0) return prev
      const next = new Set(prev)
      next.delete(nodeId)
      const stack = [nodeId]
      while (stack.length > 0) {
        const cur = stack.pop() as string
        for (const m of data.nodes) {
          if (m.parentId === cur) {
            next.delete(m.id)
            stack.push(m.id)
          }
        }
      }
      return next
    })
    setEditingId((cur) => (cur === nodeId ? null : cur))
    setSelectedId(parentId)
  }

  const addChildTo = (parentId: string): void => {
    const id = newCardId()
    updateMindmap(noteId, (d) => ({
      ...d,
      nodes: [...d.nodes, { id, label: '', parentId }]
    }))
    setCollapsed((prev) => {
      if (!prev.has(parentId)) return prev
      const next = new Set(prev)
      next.delete(parentId)
      return next
    })
    setSelectedId(id)
    setEditingId(id)
    setDraft('')
  }

  const startEdit = (node: MindmapNode, initial?: string): void => {
    setSelectedId(node.id)
    setEditingId(node.id)
    setDraft(initial ?? node.label)
  }

  /** Clicks that end a node drag must not trigger (chevron/add/delete). */
  const swallowIfDragged = (): boolean => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return true
    }
    return false
  }

  const toggleCollapse = (nodeId: string): void => {
    setSelectedId(nodeId)
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  const hiddenCount = (nodeId: string): number => {
    if (!data || !collapsed.has(nodeId)) return 0
    let n = 0
    const stack = [nodeId]
    while (stack.length > 0) {
      const cur = stack.pop() as string
      for (const m of data.nodes) {
        if (m.parentId === cur) {
          n += 1
          stack.push(m.id)
        }
      }
    }
    return n
  }

  const edgePath = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    fw: number,
    tw: number
  ): string => {
    const x1 = from.x + fw / 2
    const x2 = to.x - tw / 2
    const dx = Math.max(48, (x2 - x1) / 2)
    return `M ${x1} ${from.y} C ${x1 + dx} ${from.y}, ${x2 - dx} ${to.y}, ${x2} ${to.y}`
  }

  return (
    <div
      className={`mindmap__canvas${panning ? ' is-panning' : ''}`}
      ref={canvasRef}
      role="application"
      aria-label="Mindmap canvas. Drag to pan, scroll or pinch to zoom."
      onPointerDown={onCanvasPointerDown}
      onPointerMove={onCanvasPointerMove}
      onPointerUp={onCanvasPointerUp}
      onPointerCancel={onCanvasPointerUp}
    >
      <div
        className="mindmap__viewport"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
      >
        <svg className="mindmap__edges" aria-hidden="true">
          {visible.map((node) => {
            if (!node.parentId) return null
            const from = finalPositions.get(node.parentId)
            const to = finalPositions.get(node.id)
            if (!from || !to) return null
            const fw = nodeBox(visible.find((n) => n.id === node.parentId) ?? node).w
            return (
              <path
                key={`e-${node.id}`}
                d={edgePath(from, to, fw, nodeBox(node).w)}
                fill="none"
                stroke="#a5b4fc"
                strokeOpacity={0.55}
                strokeWidth={2 / view.k}
                strokeLinecap="round"
              />
            )
          })}
        </svg>
        {visible.map((node) => {
          const p = finalPositions.get(node.id)
          if (!p) return null
          const isRoot = node.parentId === null
          const { w, h } = nodeBox(node)
          const depth = depths.get(node.id) ?? 0
          const tint = depthFill(depth)
          const kids = childrenOfNodes(visible, node.id)
          const isCollapsed = collapsed.has(node.id)
          const selected = selectedId === node.id
          const editing = editingId === node.id
          // The root pill IS the page title; everything else is a JSON label.
          const displayLabel = isRoot ? noteTitle.trim() || 'Untitled' : node.label || 'New idea'
          const commitEdit = (): void => {
            setEditingId(null)
            if (isRoot) {
              if (draft !== noteTitle) useAppStore.getState().updateNote(noteId, { title: draft })
            } else {
              commitLabel(node.id, draft)
            }
          }
          return (
            <div
              key={node.id}
              className={`mindmap__node-el${isRoot ? ' is-root' : ''}${selected ? ' is-selected' : ''}`}
              style={{
                left: p.x - w / 2,
                top: p.y - h / 2,
                width: w,
                minHeight: h,
                ...(isRoot ? {} : { background: tint.fill, borderColor: tint.stroke })
              }}
              onPointerDown={(e) => {
                setSelectedId(node.id)
                if (e.button !== 0 || editing) return
                const t = e.target as HTMLElement
                if (t.tagName === 'INPUT' || t.closest('button')) return
                nodeDragRef.current = {
                  id: node.id,
                  pid: e.pointerId,
                  sx: e.clientX,
                  sy: e.clientY,
                  ox: node.ox ?? 0,
                  oy: node.oy ?? 0,
                  moved: false
                }
              }}
              onDoubleClick={() => startEdit(node, isRoot ? noteTitle : node.label)}
              title={
                isRoot
                  ? `${displayLabel} · double-click to rename · drag to move`
                  : `${displayLabel} · double-click to edit · drag to move`
              }
            >
              {editing ? (
                <input
                  autoFocus
                  className="mindmap__edit"
                  value={draft}
                  aria-label={isRoot ? 'Page title' : 'Branch label'}
                  placeholder={isRoot ? 'Untitled' : 'New idea'}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                />
              ) : (
                <span className="mindmap__label">{displayLabel}</span>
              )}
              {kids.length > 0 && !editing && (
                <button
                  type="button"
                  className={`mindmap__chev${isCollapsed ? ' is-collapsed' : ''}`}
                  title={
                    isCollapsed ? `Expand (${hiddenCount(node.id)} hidden)` : 'Collapse branch'
                  }
                  aria-label={isCollapsed ? `Expand ${displayLabel}` : `Collapse ${displayLabel}`}
                  aria-expanded={!isCollapsed}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (swallowIfDragged()) return
                    toggleCollapse(node.id)
                  }}
                >
                  <span className="mindmap__chev-glyph" aria-hidden="true">
                    ‹
                  </span>
                </button>
              )}
              {selected && !editing && (
                <span className="mindmap__mini">
                  <button
                    type="button"
                    title="Add child branch"
                    aria-label={`Add child to ${displayLabel}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (swallowIfDragged()) return
                      addChildTo(node.id)
                    }}
                  >
                    <PlusIcon size={11} />
                  </button>
                  {!isRoot && (
                    <button
                      type="button"
                      title="Delete branch"
                      aria-label={`Delete ${displayLabel}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (swallowIfDragged()) return
                        removeBranch(node.id)
                      }}
                    >
                      <XIcon size={11} />
                    </button>
                  )}
                </span>
              )}
            </div>
          )
        })}
      </div>
      <div
        className="mindmap__zoom"
        role="group"
        aria-label="Canvas zoom"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button type="button" title="Fit to view" aria-label="Fit to view" onClick={fitVisible}>
          ⇅
        </button>
        <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomStep(1)}>
          +
        </button>
        <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomStep(-1)}>
          −
        </button>
      </div>
    </div>
  )
}

/** Quiz shell — blank on purpose. */
export function QuizChildView({ noteId }: { noteId: string }): React.JSX.Element {
  const body = useChildBody(noteId)
  const data = useMemo(() => parseStudyChild(body), [body])
  if (!data || data.type !== 'quiz') {
    return <p className="study__muted">This page is not valid quiz JSON.</p>
  }
  return (
    <div className="quiz__blank" role="status">
      <p className="quiz__blank-title">Quiz runner coming soon</p>
      <p className="study__muted">
        Blank shell linked as a child of its page. Lupinus will add question types, attempts, and
        grading here — the JSON shape stays <code>{'{"type":"quiz","questions":[]}'}</code>.
      </p>
      <ul className="quiz__todo">
        <li>Question bank (multiple choice / written / true-false)</li>
        <li>Attempts + scoring</li>
        <li>Link results back to the owning page</li>
      </ul>
    </div>
  )
}

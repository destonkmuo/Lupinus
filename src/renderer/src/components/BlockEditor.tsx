import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { joinBlocks, splitBlocks } from '../markdown'
import Markdown from './Markdown'
import RichBlockEditor from './RichBlockEditor'
import SlashMenu from './SlashMenu'
import { GripIcon } from './icons'
import type { ImageControls } from '../images'
import { blockKind, isRichKind } from '../richText'
import { filteredSlash, slashToken, type ChildKind, type SlashCommand } from '../slash'
import { beginSortableDrag, useSortableMakeSpace } from '../sortable'

export type { ChildKind } from '../slash'

/** Native DnD payload marking a drag as a block reorder (not a picture). */
const BLOCK_MIME = 'application/x-lupinus-block'

/** Selection-formatting actions (static: mapped in render, never rebuilt). */
const FORMAT_ITEMS: readonly { label: string; key: string; before: string; after: string }[] = [
  { label: 'Bold', key: 'Ctrl+B', before: '**', after: '**' },
  { label: 'Italic', key: 'Ctrl+I', before: '*', after: '*' },
  { label: 'Highlight', key: 'Ctrl+Shift+H', before: '==', after: '==' },
  { label: 'Strikethrough', key: 'Ctrl+Shift+X', before: '~~', after: '~~' },
  { label: 'Code', key: 'Ctrl+E', before: '`', after: '`' }
]

interface BlockEditorProps {
  /** Raw markdown for the whole note. */
  value: string
  onChange: (value: string) => void
  placeholder?: string
  images?: ImageControls
  /**
   * Child-page action: creates the child under the current note and returns
   * the `[[link]]` markdown to embed at the caret (null = failed).
   */
  onCreateChild?: (kind: ChildKind) => string | null
  /** Restore the caret into this block when the editor first mounts. */
  initialCaret?: { block: number; offset: number } | null
}

/**
 * Notion-style block editor.
 *
 * The document is shown as rendered markdown; clicking a block swaps just that
 * block for a rich editor that shows the formatted result (bold looks bold,
 * lists look like lists) while the note is stored as plain markdown. Code,
 * rules, and display math keep a raw textarea, where editing the source is the
 * expected behavior.
 *
 * Enter adds a newline inside the block, Shift+Enter splits a block, Tab
 * indents (never leaves the editor), Backspace at the start merges into the
 * previous one, Escape leaves edit mode.
 */
function BlockEditor({
  value,
  onChange,
  placeholder,
  images,
  onCreateChild,
  initialCaret
}: BlockEditorProps): React.JSX.Element {
  const [blocks, setBlocks] = useState<string[]>(() => splitBlocks(value))
  const restoreBlock =
    initialCaret && initialCaret.block >= 0 && initialCaret.block < blocks.length
      ? initialCaret.block
      : null
  const [active, setActive] = useState<number | null>(restoreBlock)
  // Multi-block selection: sorted list of selected row indices while NOT editing.
  // Shift+Click extends from the anchor, Cmd/Ctrl+Click toggles one row.
  const [selected, setSelected] = useState<number[]>([])
  // Merged edit: rows [from..to] shown as ONE textarea so the user can select
  // down to the character across block boundaries and delete/type natively.
  const [bulk, setBulk] = useState<{ from: number; to: number; text: string } | null>(null)
  const [dropHint, setDropHint] = useState<{ index: number; before: boolean } | null>(null)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [slash, setSlash] = useState<{ index: number; token: string } | null>(null)
  const [slashSel, setSlashSel] = useState(0)
  // Where a freshly mounted rich editor should drop its caret.
  const [caretHint, setCaretHint] = useState<'start' | 'end' | number>(
    restoreBlock !== null && initialCaret ? Math.max(0, initialCaret.offset) : 'end'
  )
  // Raw-markdown escape hatch: press-and-hold (or Shift+click) a block to edit
  // its markdown source instead of the formatted surface.
  const [rawMode, setRawMode] = useState(false)
  // Whether the edited block was rich when it was opened. A rich editor whose
  // typed content becomes a divider (`---`) stays mounted so Enter can commit
  // the rule, instead of swapping in a raw textarea mid-keystroke.
  const [activeRich, setActiveRich] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const caretRef = useRef<number | null>(
    restoreBlock !== null && initialCaret ? Math.max(0, initialCaret.offset) : null
  )
  const indentCaretRef = useRef<number | null>(null)
  // Press-and-hold (M1) on a rendered block opens its raw markdown source.
  const longPressTimer = useRef<number | null>(null)
  const longPressFired = useRef(false)
  const longPressStart = useRef<{ x: number; y: number } | null>(null)
  // Staged text selection (formatting keeps the inner text selected).
  const selRef = useRef<[number, number] | null>(null)
  // Custom selection menu (right-click on selected text).
  const [selMenu, setSelMenu] = useState<{ index: number; x: number; y: number } | null>(null)
  const syncedRef = useRef(value)
  const dragFrom = useRef<number | null>(null)
  // Anchor row for Shift+Click range extension.
  const anchorRef = useRef<number | null>(null)
  const bulkRef = useRef<HTMLTextAreaElement | null>(null)
  // Pre-move row rects keyed by block text, consumed once for the FLIP glide.
  const flipRef = useRef<Map<string, DOMRect[]> | null>(null)
  // Document-level undo/redo. The rich editor is uncontrolled and its DOM is
  // replaced on reseed, so the browser's native stack can't span blocks or
  // survive a reseed; we snapshot block arrays instead, coalescing a typing
  // burst into one step.
  const historyRef = useRef<{ past: string[][]; future: string[][] }>({ past: [], future: [] })
  const lastPushAtRef = useRef(0)
  const blocksRef = useRef(blocks)

  // Keep the latest committed blocks readable from stable callbacks.
  useEffect(() => {
    blocksRef.current = blocks
  }, [blocks])

  // Adopt changes made elsewhere (vault refresh, note switch) unless the user
  // is mid-edit. A genuine document swap starts a fresh history; the parent's
  // trailing-whitespace normalization (hidden-footer trimming) does not, so a
  // stray trailing space can't wipe undo.
  useEffect(() => {
    if (active !== null || bulk !== null) return
    if (value === syncedRef.current) return
    const incoming = splitBlocks(value)
    const trimLast = (bs: string[]): string[] =>
      bs.map((b, i) => (i === bs.length - 1 ? b.trimEnd() : b))
    const current = trimLast(blocksRef.current)
    const next = trimLast(incoming)
    if (current.length !== next.length || current.some((b, i) => b !== next[i])) {
      historyRef.current = { past: [], future: [] }
      lastPushAtRef.current = 0
    }
    setBlocks(incoming)
    syncedRef.current = value
    setSelected([])
    anchorRef.current = null
  }, [value, active, bulk])

  const commit = useCallback(
    (next: string[]) => {
      const prev = blocksRef.current
      const changed = prev.length !== next.length || prev.some((b, i) => b !== next[i])
      if (changed) {
        const now = Date.now()
        const history = historyRef.current
        // New undo step on a structural change or after a typing pause; rapid
        // same-length edits fold into the current step.
        if (next.length !== prev.length || now - lastPushAtRef.current > 500) {
          history.past.push(prev.slice())
          if (history.past.length > 200) history.past.shift()
          history.future.length = 0
          lastPushAtRef.current = now
        }
      }
      const text = joinBlocks(next)
      setBlocks(next)
      syncedRef.current = text
      onChange(text)
    },
    [onChange]
  )

  const restore = useCallback(
    (snapshot: string[]) => {
      const text = joinBlocks(snapshot)
      // Undo/redo drops edit/multi-select modes: the rich editor is
      // uncontrolled, so re-render it from the restored markdown instead of
      // leaving a stale DOM in place.
      setSelected([])
      anchorRef.current = null
      setBulk(null)
      setActive(null)
      setRawMode(false)
      setBlocks(snapshot)
      syncedRef.current = text
      lastPushAtRef.current = 0
      onChange(text)
    },
    [onChange]
  )

  const undo = useCallback(() => {
    const history = historyRef.current
    const prev = history.past.pop()
    if (prev === undefined) return
    history.future.push(blocksRef.current.slice())
    restore(prev)
  }, [restore])

  const redo = useCallback(() => {
    const history = historyRef.current
    const next = history.future.pop()
    if (next === undefined) return
    history.past.push(blocksRef.current.slice())
    restore(next)
  }, [restore])

  // Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z (or Ctrl+Y) to redo — but only while
  // the editor owns focus, so other inputs keep their native behaviour.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      const isUndo = key === 'z' && !event.shiftKey
      const isRedo = (key === 'z' && event.shiftKey) || key === 'y'
      if (!isUndo && !isRedo) return
      const container = containerRef.current
      if (!container || !container.contains(document.activeElement)) return
      event.preventDefault()
      event.stopPropagation()
      if (isUndo) undo()
      else redo()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [undo, redo])

  const clearMulti = useCallback(() => {
    setSelected([])
    anchorRef.current = null
    setBulk(null)
  }, [])

  /** Delete whole selected rows (block-granular). Char-level delete happens
   * inside the merged bulk textarea instead. */
  const deleteSelected = useCallback(() => {
    const sel = selected.slice().sort((a, b) => a - b)
    if (sel.length === 0) return
    const drop = new Set(sel)
    let next = blocks.filter((_, i) => !drop.has(i))
    if (next.length === 0) next = ['']
    commit(next)
    clearMulti()
    setActive(null)
  }, [blocks, commit, selected, clearMulti])

  /** Merge rows [from..to] into one textarea for char-precise editing. */
  const enterBulk = useCallback(
    (from: number, to: number, caret: number | null = null) => {
      const lo = Math.max(0, Math.min(from, to))
      const hi = Math.min(blocks.length - 1, Math.max(from, to))
      if (hi < lo) return
      setActive(null)
      setSelected([])
      anchorRef.current = null
      setBulk({ from: lo, to: hi, text: joinBlocks(blocks.slice(lo, hi + 1)) })
      if (caret !== null) caretRef.current = caret
    },
    [blocks]
  )

  const commitBulk = useCallback(
    (text: string) => {
      setBulk((current) => {
        if (!current) return current
        const parts = splitBlocks(text)
        const next = [...blocks.slice(0, current.from), ...parts, ...blocks.slice(current.to + 1)]
        const finalBlocks = next.length > 0 ? next : ['']
        commit(finalBlocks)
        caretRef.current = null
        // Land single-edit on the last touched piece for continued typing.
        window.requestAnimationFrame(() => {
          setCaretHint('end')
          const last = Math.min(current.from + parts.length - 1, finalBlocks.length - 1)
          setActiveRich(isRichKind(blockKind(finalBlocks[last] ?? '')))
          setActive(last)
        })
        return null
      })
    },
    [blocks, commit]
  )

  // Textareas only: rich blocks are contenteditables that own their own caret,
  // so every textarea-specific effect below simply no-ops for them.
  const editorFor = (index: number | null): HTMLTextAreaElement | null =>
    index === null
      ? null
      : (containerRef.current?.querySelector<HTMLTextAreaElement>(
          `textarea[data-block="${index}"]`
        ) ?? null)

  // Focus and place the caret after a structural change.
  useLayoutEffect(() => {
    const el = editorFor(active)
    if (!el) return
    if (document.activeElement !== el) el.focus()
    if (caretRef.current !== null) {
      el.setSelectionRange(caretRef.current, caretRef.current)
      caretRef.current = null
    }
    if (selRef.current !== null) {
      el.setSelectionRange(selRef.current[0], selRef.current[1])
      selRef.current = null
    }
  }, [active, rawMode])

  // Keep the focused block's textarea exactly as tall as its content.
  // Also restores the caret after a same-block Tab indent — or any same-block
  // commit that stages caretRef (slash-menu insert, Alt+Arrow landing here).
  useLayoutEffect(() => {
    const el = editorFor(active)
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    if (caretRef.current !== null && document.activeElement === el) {
      el.setSelectionRange(caretRef.current, caretRef.current)
      caretRef.current = null
    }
    if (selRef.current !== null && document.activeElement === el) {
      el.setSelectionRange(selRef.current[0], selRef.current[1])
      selRef.current = null
    }
    if (indentCaretRef.current !== null && document.activeElement === el) {
      el.setSelectionRange(indentCaretRef.current, indentCaretRef.current)
      indentCaretRef.current = null
    }
  }, [blocks, active])

  // Bulk textarea: autofocus + autosize, then place a staged caret.
  useLayoutEffect(() => {
    if (!bulk) return
    const el = bulkRef.current
    if (!el) return
    if (document.activeElement !== el) el.focus()
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    if (caretRef.current !== null) {
      const pos = Math.max(0, Math.min(caretRef.current, el.value.length))
      el.setSelectionRange(pos, pos)
      caretRef.current = null
    }
  }, [bulk])

  const setBlockText = (index: number, text: string): void => {
    const next = blocks.slice()
    next[index] = text
    commit(next)
  }

  // ---- rich (formatted) block callbacks -----------------------------------
  /** Shift+Enter / heading Enter / empty list item: replace this block's
   * markdown and open a new block below. */
  const splitRichBlock = (index: number, before: string, after: string): void => {
    const next = blocks.slice()
    next[index] = before
    next.splice(index + 1, 0, after)
    commit(next)
    setActiveRich(isRichKind(blockKind(after)))
    setCaretHint('start')
    setActive(index + 1)
  }

  /** Split this block into before / marked line / after (empty parts dropped). */
  const splitRichInto = (index: number, before: string, mid: string, after: string): void => {
    const parts: string[] = []
    let midIndex = index
    if (before !== '') {
      parts.push(before)
      midIndex = index + 1
    }
    parts.push(mid)
    if (after !== '') parts.push(after)
    const next = blocks.slice()
    next.splice(index, 1, ...parts)
    commit(next)
    setCaretHint('start')
    setActiveRich(isRichKind(blockKind(mid)))
    setActive(midIndex)
  }

  /** Backspace at the very start of a rich block: merge into the previous. */
  const mergeRichIntoPrev = (index: number): void => {
    if (index <= 0) return
    const next = blocks.slice()
    const caret = next[index - 1].length
    const merged = next[index - 1] + next[index]
    next.splice(index - 1, 2, merged)
    caretRef.current = caret
    commit(next)
    setActiveRich(isRichKind(blockKind(merged)))
    setActive(index - 1)
  }

  /** Arrow at a rich block's edge: hop to the neighbouring block. */
  const navigateRichBlock = (index: number, dir: 'up' | 'down'): void => {
    if (dir === 'up' && index > 0) {
      caretRef.current = (blocks[index - 1] ?? '').length
      setCaretHint('end')
      setActiveRich(isRichKind(blockKind(blocks[index - 1] ?? '')))
      setActive(index - 1)
    } else if (dir === 'down' && index < blocks.length - 1) {
      caretRef.current = 0
      setCaretHint('start')
      setActiveRich(isRichKind(blockKind(blocks[index + 1] ?? '')))
      setActive(index + 1)
    }
  }

  /** Alt+Arrow: reorder a rich block, keeping it open. */
  const moveRichBlock = (index: number, dir: 'up' | 'down'): void => {
    if (dir === 'up') moveBlock(index, index - 1, true)
    else moveBlock(index, index + 1, false)
  }

  /**
   * Wrap the selection (or a placeholder) in markers. Toggles off when the
   * selection is already wrapped. Leaves the inner text selected.
   */
  const wrapSelection = (index: number, before: string, after: string): void => {
    const el = editorFor(index)
    const text = blocks[index] ?? ''
    const start = el ? el.selectionStart : text.length
    const end = el ? el.selectionEnd : text.length
    const sel = text.slice(start, end)
    const wrapped =
      sel.length > 0 &&
      text.slice(Math.max(0, start - before.length), start) === before &&
      text.slice(end, end + after.length) === after
    if (wrapped) {
      const ns = start - before.length
      const next = blocks.slice()
      next[index] = text.slice(0, ns) + sel + text.slice(end + after.length)
      selRef.current = [ns, ns + sel.length]
      setSlash(null)
      setSelMenu(null)
      commit(next)
      return
    }
    const inner = sel || 'text'
    const next = blocks.slice()
    next[index] = text.slice(0, start) + before + inner + after + text.slice(end)
    const base = start + before.length
    selRef.current = [base, base + inner.length]
    setSlash(null)
    setSelMenu(null)
    commit(next)
  }

  const clampMenu = (x: number, y: number): { x: number; y: number } => ({
    x: Math.max(8, Math.min(x, window.innerWidth - 210)),
    y: Math.max(8, Math.min(y, window.innerHeight - 260))
  })

  /** Right-click on a non-empty selection opens the formatting menu. */
  const onTextContextMenu = (event: React.MouseEvent<HTMLTextAreaElement>, index: number): void => {
    const el = event.currentTarget
    if (el.selectionStart === el.selectionEnd) return // let native menu handle carets
    event.preventDefault()
    event.stopPropagation()
    const at = clampMenu(event.clientX, event.clientY)
    setSelMenu({ index, ...at })
  }

  const cutCopySelection = (index: number, cut: boolean): void => {
    const el = editorFor(index)
    if (!el || el.selectionStart === el.selectionEnd) return
    // execCommand edits the DOM in place; sync React state straight after.
    document.execCommand(cut ? 'cut' : 'copy')
    setBlockText(index, el.value)
    setSelMenu(null)
  }

  // After any reorder, glide rows from their old positions (FLIP) instead
  // of jumping. Keyed by block text; unmatched rows simply appear.
  useLayoutEffect(() => {
    const map = flipRef.current
    flipRef.current = null
    if (!map || !containerRef.current) return
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return
    }
    const used = new Map<string, number>()
    const rows = containerRef.current.querySelectorAll('.block-row')
    blocks.forEach((text, index) => {
      const el = rows[index] as HTMLElement | undefined
      if (!el) return
      const list = map.get(text)
      if (!list) return
      const seen = used.get(text) ?? 0
      used.set(text, seen + 1)
      const old = list[seen]
      if (!old) return
      const dy = old.top - el.getBoundingClientRect().top
      if (Math.abs(dy) > 2) {
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], {
          duration: 240,
          easing: 'cubic-bezier(0.32, 0.72, 0, 1)'
        })
      }
    })
  }, [blocks])

  /** Reorder blocks by drag or keyboard. The editing caret follows its block. */
  const moveBlock = (from: number, toIndex: number, before: boolean): void => {
    if (from === toIndex) return
    clearMulti()
    const next = blocks.slice()
    const [moved] = next.splice(from, 1)
    let insertAt = before ? toIndex : toIndex + 1
    if (from < insertAt) insertAt -= 1
    if (insertAt === from) return // dropped back where it was
    // Snapshot row positions for the FLIP glide after commit.
    const rows = containerRef.current?.querySelectorAll('.block-row')
    if (rows) {
      const map = new Map<string, DOMRect[]>()
      blocks.forEach((text, index) => {
        const el = rows[index] as HTMLElement | undefined
        if (!el) return
        const list = map.get(text) ?? []
        list.push(el.getBoundingClientRect())
        map.set(text, list)
      })
      flipRef.current = map
    }
    // Keep the caret when the block being edited is the one moving.
    if (active === from) {
      const editor = editorFor(active)
      if (editor) caretRef.current = editor.selectionStart
    }
    next.splice(insertAt, 0, moved)
    commit(next)
    if (active !== null) {
      setCaretHint('end')
      if (active === from) {
        setActive(insertAt)
        // Carry the height floor along with the block being edited.
        if (frozen && frozen.index === from) setFrozen({ index: insertAt, height: frozen.height })
      } else {
        const shifted = active - (from < active ? 1 : 0)
        setActive(shifted + (insertAt <= shifted ? 1 : 0))
      }
    }
  }

  const clearDrag = (): void => {
    dragFrom.current = null
    setDraggingId(null)
    setDropHint(null)
  }

  const onGripDragStart = (event: React.DragEvent<HTMLSpanElement>, index: number): void => {
    // Grips only render on rendered blocks, but never yank a block out from
    // under an in-flight structural change either.
    if (active !== null || bulk !== null) {
      event.preventDefault()
      return
    }
    clearMulti()
    dragFrom.current = index
    setDraggingId(index)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(BLOCK_MIME, String(index))
    const row = event.currentTarget.closest<HTMLElement>('.block-row')
    if (row) beginSortableDrag(event, row)
  }

  const hintFromEvent = (
    event: React.DragEvent<HTMLDivElement>,
    index: number
  ): { index: number; before: boolean } => {
    const box = event.currentTarget.getBoundingClientRect()
    return { index, before: event.clientY < box.top + box.height / 2 }
  }

  const onRowDragOver = (event: React.DragEvent<HTMLDivElement>, index: number): void => {
    if (dragFrom.current === null) return // picture drags belong to the note
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    const hint = hintFromEvent(event, index)
    setDropHint((prev) =>
      prev && prev.index === hint.index && prev.before === hint.before ? prev : hint
    )
  }

  const onRowDrop = (event: React.DragEvent<HTMLDivElement>, index: number): void => {
    if (dragFrom.current === null) return
    event.preventDefault()
    event.stopPropagation()
    const from = dragFrom.current
    const hint = hintFromEvent(event, index)
    clearDrag()
    moveBlock(from, hint.index, hint.before)
  }

  // Dropping on the empty area under the last block appends to the end.
  const onContainerDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (dragFrom.current === null) return
    if (event.target !== event.currentTarget) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropHint((prev) =>
      prev && prev.index === blocks.length - 1 && !prev.before
        ? prev
        : { index: blocks.length - 1, before: false }
    )
  }

  const onContainerDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (dragFrom.current === null) return
    if (event.target !== event.currentTarget) return
    event.preventDefault()
    event.stopPropagation()
    const from = dragFrom.current
    clearDrag()
    moveBlock(from, blocks.length - 1, false)
  }

  // Rendered Markdown carries paragraph/list/heading margins the editing
  // surface doesn't, so opening a block would jump the page. Freeze the
  // row at its rendered height while it is being edited instead.
  const [frozen, setFrozen] = useState<{ index: number; height: number } | null>(null)
  // The floor only applies while its row is the active one, so stale
  // measurements can never stick to the rendered view (no cleanup effect
  // needed — deactivation alone disables it).
  const frozenFor = (index: number): number | undefined =>
    frozen && frozen.index === index && active === index ? frozen.height : undefined
  const activate = (index: number, raw = false): void => {
    clearMulti()
    const view = containerRef.current?.querySelector<HTMLElement>(`[data-row="${index}"] .block`)
    const height = view?.offsetHeight ?? 0
    if (height > 0) setFrozen({ index, height })
    caretRef.current = blocks[index]?.length ?? 0
    setCaretHint('end')
    setRawMode(raw)
    setActiveRich(isRichKind(blockKind(blocks[index] ?? '')))
    setSlash(null)
    setActive(index)
  }

  // Press-and-hold (M1) on a rendered block edits its raw markdown source.
  // A quick click still opens the rich editor; dragging cancels the hold so
  // text selection is unaffected.
  const LONG_PRESS_MS = 350
  const cancelLongPress = (): void => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    longPressStart.current = null
  }
  const startLongPress = (index: number, event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    cancelLongPress()
    longPressFired.current = false
    longPressStart.current = { x: event.clientX, y: event.clientY }
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = null
      longPressFired.current = true
      anchorRef.current = index
      activate(index, true)
    }, LONG_PRESS_MS)
  }
  const onViewPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = longPressStart.current
    if (!start || longPressTimer.current === null) return
    if (Math.abs(event.clientX - start.x) > 6 || Math.abs(event.clientY - start.y) > 6) {
      cancelLongPress()
    }
  }

  useEffect(() => cancelLongPress, [])

  /** Row indices covered by the current native text selection, when it spans
   * more than one rendered row inside this editor. */
  const nativeRowRange = (): [number, number] | null => {
    const native = window.getSelection()
    if (
      !native ||
      native.isCollapsed ||
      !containerRef.current?.contains(native.anchorNode) ||
      !containerRef.current?.contains(native.focusNode)
    ) {
      return null
    }
    const rowFor = (node: Node | null): number | null => {
      if (!node) return null
      const el = node instanceof Element ? node : (node.parentElement as Element | null)
      const row = el?.closest?.('.block-row') as HTMLElement | null
      const n = row?.dataset.row ? Number(row.dataset.row) : NaN
      return Number.isFinite(n) ? n : null
    }
    const a = rowFor(native.anchorNode)
    const f = rowFor(native.focusNode)
    if (a === null || f === null || a === f) return null
    if (a < 0 || f < 0 || a >= blocks.length || f >= blocks.length) return null
    return [a, f]
  }

  /** Turn a native cross-row selection into the custom multi-selection so the
   * highlight survives mouseup (instead of opening an editor / new block). */
  const selectNativeRange = (range: [number, number]): void => {
    const lo = Math.min(range[0], range[1])
    const hi = Math.max(range[0], range[1])
    const rows: number[] = []
    for (let i = lo; i <= hi; i++) rows.push(i)
    setActive(null)
    setBulk(null)
    setSelected(rows)
    anchorRef.current = range[0]
    focusContainer()
  }

  /** Click on a rendered block: modifiers select, plain click edits.
   * A native drag-selection spanning rows becomes a multi-selection instead
   * of opening a single editor (which would destroy the selection). */
  const onViewClick = (event: React.MouseEvent, index: number): void => {
    // The press-and-hold already opened raw markdown; don't re-open the rich
    // editor on the click that follows the release.
    if (longPressFired.current) {
      longPressFired.current = false
      return
    }
    const nativeRange = nativeRowRange()
    if (nativeRange) {
      event.preventDefault()
      selectNativeRange(nativeRange)
      return
    }
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault()
      anchorRef.current = index
      setActive(null)
      setBulk(null)
      setSelected((prev) =>
        prev.includes(index)
          ? prev.filter((i) => i !== index)
          : [...prev, index].sort((a, b) => a - b)
      )
      focusContainer()
      return
    }
    anchorRef.current = index
    // Single click edits rich text directly; Shift+click drops into raw
    // markdown source editing for this block.
    activate(index, event.shiftKey)
  }

  const onGripClick = (event: React.MouseEvent, index: number): void => {
    event.stopPropagation()
    if (event.shiftKey && anchorRef.current !== null) {
      const lo = Math.min(anchorRef.current, index)
      const hi = Math.max(anchorRef.current, index)
      const range: number[] = []
      for (let i = lo; i <= hi; i++) range.push(i)
      setActive(null)
      setBulk(null)
      setSelected(range)
      return
    }
    anchorRef.current = index
    setActive(null)
    setBulk(null)
    setSelected((prev) =>
      prev.includes(index)
        ? prev.filter((i) => i !== index)
        : [...prev, index].sort((a, b) => a - b)
    )
    focusContainer()
  }

  /** Refresh the `/` menu from the caret; call on change/click/keys. */
  const refreshSlash = (index: number, value: string, caret: number): void => {
    const token = slashToken(value, caret)
    if (token === null) {
      if (slash !== null) setSlash(null)
      return
    }
    if (slash === null || slash.index !== index || slash.token !== token) {
      setSlashSel(0)
      setSlash({ index, token })
    }
  }

  const applySlash = (index: number, cmd: SlashCommand): void => {
    // Child actions create a subpage under the current note and embed its
    // `[[link]]` where the `/token` was.
    if (cmd.childKind) {
      const el = editorFor(index)
      const text = blocks[index] ?? ''
      const caret = el ? el.selectionStart : text.length
      const lineStart = text.lastIndexOf('\n', caret - 1) + 1
      const match = /(^|\s)\/[\w-]*$/.exec(text.slice(lineStart, caret))
      const link = onCreateChild?.(cmd.childKind) ?? null
      setSlash(null)
      if (!match || !link) return
      const slashStart = lineStart + match.index + match[1].length
      caretRef.current = slashStart + link.length
      const next = blocks.slice()
      next[index] = text.slice(0, slashStart) + link + text.slice(caret)
      commit(next)
      return
    }
    const el = editorFor(index)
    const text = blocks[index] ?? ''
    const caret = el ? el.selectionStart : text.length
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1
    const match = /(^|\s)\/[\w-]*$/.exec(text.slice(lineStart, caret))
    if (!match) {
      setSlash(null)
      return
    }
    const slashStart = lineStart + match.index + match[1].length
    const marker = cmd.insert.indexOf('|')
    const head =
      marker >= 0 ? cmd.insert.slice(0, marker) + cmd.insert.slice(marker + 1) : cmd.insert
    caretRef.current = slashStart + (marker >= 0 ? marker : head.length)
    const next = blocks.slice()
    next[index] = text.slice(0, slashStart) + head + text.slice(caret)
    setSlash(null)
    commit(next)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>, index: number): void => {
    const el = event.currentTarget

    // Selection menu open for this block: Esc closes it (stays editing).
    if (selMenu && selMenu.index === index && event.key === 'Escape') {
      event.preventDefault()
      setSelMenu(null)
      return
    }

    // Inline formatting: Ctrl/Cmd+B/I/E, Ctrl/Cmd+Shift+H/X. Work with the
    // `/` menu open too (it closes on format).
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase()
      const format: [string, string] | null =
        key === 'b' && !event.shiftKey
          ? ['**', '**']
          : key === 'i' && !event.shiftKey
            ? ['*', '*']
            : key === 'e' && !event.shiftKey
              ? ['`', '`']
              : key === 'h' && event.shiftKey
                ? ['==', '==']
                : key === 'x' && event.shiftKey
                  ? ['~~', '~~']
                  : null
      if (format) {
        event.preventDefault()
        wrapSelection(index, format[0], format[1])
        return
      }
    }

    // The `/` menu owns Enter/Tab/arrows/Esc while open.
    if (slash && slash.index === index) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlash(null)
        return
      }
      const items = filteredSlash(slash.token)
      if (items.length === 0) {
        // No match: dismiss and fall through to normal editing keys.
        setSlash(null)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashSel((sel) => (sel + 1) % items.length)
        return
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashSel((sel) => (sel - 1 + items.length) % items.length)
        return
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        applySlash(index, items[slashSel % items.length])
        return
      }
    }

    // Plain Enter stays inside the block (default newline). Shift+Enter
    // splits the block at the caret into a new block below.
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault()
      const caret = el.selectionStart
      const text = blocks[index]
      const next = blocks.slice()
      next[index] = text.slice(0, caret)
      next.splice(index + 1, 0, text.slice(caret))
      caretRef.current = 0
      commit(next)
      setActiveRich(true)
      setActive(index + 1)
      return
    }

    // Tab indents inside the editor instead of jumping focus to the sidebar
    // search box. Shift+Tab outdents when possible. Ctrl/Cmd+Tab is left
    // alone for the global tab switcher.
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      const text = blocks[index]
      const start = el.selectionStart
      const end = el.selectionEnd
      if (event.shiftKey) {
        const before = text.slice(0, start)
        const remove = before.endsWith('  ') ? 2 : before.endsWith('\t') ? 1 : 0
        if (remove === 0) return
        const nextText = text.slice(0, start - remove) + text.slice(end)
        indentCaretRef.current = start - remove
        setBlockText(index, nextText)
        return
      }
      const nextText = text.slice(0, start) + '  ' + text.slice(end)
      indentCaretRef.current = start + 2
      setBlockText(index, nextText)
      return
    }

    if (
      event.key === 'Backspace' &&
      el.selectionStart === 0 &&
      el.selectionEnd === 0 &&
      index > 0
    ) {
      event.preventDefault()
      const next = blocks.slice()
      const merged = next[index - 1] + next[index]
      const caret = next[index - 1].length
      next.splice(index - 1, 2, merged)
      caretRef.current = caret
      commit(next)
      setActive(index - 1)
      return
    }

    // Plain Up/Down at the block's edge passes into the neighboring block
    // (Notion-style); otherwise the caret moves within the textarea.
    // Shift+Arrow at the edge merges into a joint editor so a character
    // selection can continue across the block boundary natively.
    if (!event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const text = blocks[index] ?? ''
      const start = el.selectionStart
      const end = el.selectionEnd
      if (event.shiftKey) {
        if (event.key === 'ArrowDown' && end >= text.length && !text.slice(end).includes('\n')) {
          if (index < blocks.length - 1) {
            event.preventDefault()
            enterBulk(index, index + 1, start)
            return
          }
        }
        if (event.key === 'ArrowUp' && start <= 0 && !text.slice(0, start).includes('\n')) {
          if (index > 0) {
            event.preventDefault()
            const prevLen = (blocks[index - 1] ?? '').length
            enterBulk(index - 1, index, prevLen + 2 + start)
            return
          }
        }
      }
      if (start === end) {
        if (event.key === 'ArrowDown' && !text.slice(end).includes('\n')) {
          if (index < blocks.length - 1) {
            event.preventDefault()
            caretRef.current = Math.min(start, (blocks[index + 1] ?? '').length)
            setActive(index + 1)
          }
          return
        }
        if (event.key === 'ArrowUp' && !text.slice(0, start).includes('\n')) {
          if (index > 0) {
            event.preventDefault()
            caretRef.current = Math.min(start, (blocks[index - 1] ?? '').length)
            setActive(index - 1)
          }
          return
        }
      }
    }

    // Alt+Arrow reorders the block being edited, keeping focus and caret.
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      if (event.key === 'ArrowUp' && index > 0) {
        moveBlock(index, index - 1, true)
      } else if (event.key === 'ArrowDown' && index < blocks.length - 1) {
        moveBlock(index, index + 1, false)
      }
      return
    }

    if (event.key === 'Escape') {
      setActive(null)
    }
  }

  // Clicking the empty area under the last block appends one.
  const onContainerClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    // A drag-selection across rows releases over the container, not a row.
    // Keep that highlight as a multi-selection instead of clearing it.
    const nativeRange = nativeRowRange()
    if (nativeRange) {
      event.preventDefault()
      selectNativeRange(nativeRange)
      return
    }
    clearMulti()
    const next = blocks.slice()
    if (next[next.length - 1] !== '') next.push('')
    commit(next)
    caretRef.current = 0
    setCaretHint('start')
    setActiveRich(true)
    setActive(next.length - 1)
  }

  const focusContainer = (): void => {
    // Defer so the click's native selection settles first.
    window.requestAnimationFrame(() => containerRef.current?.focus({ preventScroll: true }))
  }

  const onContainerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (active !== null || bulk !== null || selected.length === 0) return
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      deleteSelected()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const sorted = selected.slice().sort((a, b) => a - b)
      enterBulk(sorted[0], sorted[sorted.length - 1])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      clearMulti()
    }
  }

  const onCopyCut = (event: React.ClipboardEvent<HTMLDivElement>, cut: boolean): void => {
    if (active !== null || bulk !== null || selected.length === 0) return
    const sorted = selected.slice().sort((a, b) => a - b)
    // Only hijack when the native selection is inside our rows; otherwise
    // let inputs/menus copy normally.
    const native = window.getSelection()
    if (
      native &&
      !native.isCollapsed &&
      containerRef.current &&
      native.anchorNode &&
      native.focusNode &&
      !containerRef.current.contains(native.anchorNode)
    ) {
      return
    }
    event.preventDefault()
    const text = joinBlocks(sorted.map((i) => blocks[i] ?? ''))
    event.clipboardData.setData('text/plain', text)
    if (cut) deleteSelected()
  }

  useSortableMakeSpace({
    rootRef: containerRef,
    activeId: draggingId !== null ? `block:${draggingId}` : null,
    hints: dropHint ? [{ id: `block:${dropHint.index}`, before: dropHint.before }] : []
  })

  return (
    <div
      className="blocks"
      ref={containerRef}
      data-sortable-list
      tabIndex={-1}
      onClick={onContainerClick}
      onKeyDown={onContainerKeyDown}
      onCopy={(event) => onCopyCut(event, false)}
      onCut={(event) => onCopyCut(event, true)}
      onDragOver={onContainerDragOver}
      onDrop={onContainerDrop}
    >
      {selected.length > 0 && active === null && bulk === null && (
        <p className="block-row__multibar" role="status">
          {selected.length} {selected.length === 1 ? 'block' : 'blocks'} selected — Enter to edit
          together · Delete to remove · Esc to clear · Shift+Click extends
        </p>
      )}
      {blocks.map((block, index) => {
        // Rows inside a merged bulk edit are replaced by the single textarea.
        if (bulk && index > bulk.from && index <= bulk.to) return null
        const hint =
          dropHint && dropHint.index === index
            ? dropHint.before
              ? ' block-row--drop-before'
              : ' block-row--drop-after'
            : ''
        const dragging = draggingId === index ? ' block-row--dragging' : ''
        const isSel = selected.includes(index) ? ' block-row--selected' : ''
        const isBulkFrom = bulk && bulk.from === index
        return (
          <div
            key={`row-${index}`}
            data-row={index}
            data-sortable-item
            data-sortable-id={`block:${index}`}
            className={`block-row${hint}${dragging}${isSel}`}
            style={frozenFor(index) !== undefined ? { minHeight: frozenFor(index) } : undefined}
            onDragOver={(event) => onRowDragOver(event, index)}
            onDrop={(event) => onRowDrop(event, index)}
          >
            {isBulkFrom && bulk ? (
              <textarea
                ref={bulkRef}
                data-bulk="true"
                className="block__input block__input--bulk"
                value={bulk.text}
                rows={3}
                spellCheck={false}
                aria-label={`Editing blocks ${bulk.from + 1} to ${bulk.to + 1} together`}
                onChange={(event) => {
                  const next = event.target.value
                  setBulk((prev) => (prev ? { ...prev, text: next } : prev))
                  // Keep autosized while typing.
                  event.target.style.height = 'auto'
                  event.target.style.height = `${event.target.scrollHeight}px`
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    commitBulk((event.currentTarget as HTMLTextAreaElement).value)
                    return
                  }
                  // Plain Escape/blur commits; Cmd+Enter commits and stays.
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    commitBulk((event.currentTarget as HTMLTextAreaElement).value)
                  }
                }}
                onBlur={(event) => commitBulk(event.currentTarget.value)}
              />
            ) : (
              <>
                {index !== active && (
                  <span
                    className="block__grip"
                    draggable
                    role="button"
                    title="Drag to move · Click to select · Shift+Click to extend"
                    aria-label={`Drag to move block ${index + 1}`}
                    onClick={(event) => onGripClick(event, index)}
                    onDragStart={(event) => onGripDragStart(event, index)}
                    onDragEnd={clearDrag}
                  >
                    <GripIcon size={15} />
                  </span>
                )}
                {index === active ? (
                  // A rich block that becomes a divider while typing keeps its
                  // rich editor (activeRich) so Enter can commit the rule;
                  // otherwise the live kind decides rich vs raw.
                  (blockKind(block) === 'rule' ? activeRich : isRichKind(blockKind(block))) &&
                  !rawMode ? (
                    <RichBlockEditor
                      key={`rich-${index}`}
                      index={index}
                      block={block}
                      placeholder={index === 0 ? placeholder : undefined}
                      onChange={(markdown) => setBlockText(index, markdown)}
                      onSplit={(before, after) => splitRichBlock(index, before, after)}
                      onSplitInto={(before, mid, after) => splitRichInto(index, before, mid, after)}
                      onMergePrev={() => mergeRichIntoPrev(index)}
                      onNavigate={(dir) => navigateRichBlock(index, dir)}
                      onMoveBlock={(dir) => moveRichBlock(index, dir)}
                      onEscape={() => setActive(null)}
                      onCreateChild={onCreateChild}
                      onRequestRaw={() => setRawMode(true)}
                      initialCaret={caretHint}
                    />
                  ) : (
                    <>
                      <textarea
                        key={`edit-${index}`}
                        data-block={index}
                        className="block__input"
                        value={block}
                        rows={1}
                        spellCheck={false}
                        placeholder={index === 0 ? placeholder : ''}
                        onChange={(event) => {
                          setBlockText(index, event.target.value)
                          refreshSlash(index, event.target.value, event.target.selectionStart)
                        }}
                        onClick={(event) =>
                          refreshSlash(
                            index,
                            event.currentTarget.value,
                            event.currentTarget.selectionStart
                          )
                        }
                        onKeyDown={(event) => {
                          onKeyDown(event, index)
                          if (
                            event.key !== 'Enter' &&
                            event.key !== 'Tab' &&
                            event.key !== 'Escape'
                          ) {
                            // Caret may have moved (arrows, typing filtered above).
                            const el = event.currentTarget
                            window.requestAnimationFrame(() => {
                              if (document.activeElement === el) {
                                refreshSlash(index, el.value, el.selectionStart)
                              }
                            })
                          }
                        }}
                        onBlur={() => setActive((current) => (current === index ? null : current))}
                        onContextMenu={(event) => onTextContextMenu(event, index)}
                      />
                      {slash !== null && slash.index === index && (
                        <SlashMenu
                          token={slash.token}
                          selected={slashSel}
                          onHover={setSlashSel}
                          onPick={(cmd) => applySlash(index, cmd)}
                        />
                      )}
                    </>
                  )
                ) : (
                  <div
                    key={`view-${index}`}
                    className="block markdown"
                    role="button"
                    tabIndex={-1}
                    title="Click to edit · Hold to edit markdown source"
                    onClick={(event) => onViewClick(event, index)}
                    onPointerDown={(event) => startLongPress(index, event)}
                    onPointerMove={onViewPointerMove}
                    onPointerUp={cancelLongPress}
                    onPointerLeave={cancelLongPress}
                    onPointerCancel={cancelLongPress}
                  >
                    {block.trim() ? (
                      <Markdown source={block} images={images} />
                    ) : index === 0 ? (
                      <span className="block__placeholder">{placeholder}</span>
                    ) : (
                      <span className="block__placeholder" aria-hidden="true" />
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )
      })}
      {selMenu && (
        <div
          className="note-menu__backdrop"
          aria-hidden="true"
          onClick={() => setSelMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setSelMenu(null)
          }}
        />
      )}
      {selMenu && (
        <div
          className="note-menu note-menu--fixed"
          role="menu"
          aria-label="Format selection"
          style={{ left: selMenu.x, top: selMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {FORMAT_ITEMS.map((item) => (
            <button
              key={item.label}
              type="button"
              className="note-menu__item"
              onClick={() => wrapSelection(selMenu.index, item.before, item.after)}
            >
              <span>{item.label}</span>
              <kbd className="note-menu__key">{item.key}</kbd>
            </button>
          ))}
          <div className="note-menu__sep" role="separator" />
          <button
            type="button"
            className="note-menu__item"
            onClick={() => cutCopySelection(selMenu.index, true)}
          >
            Cut
          </button>
          <button
            type="button"
            className="note-menu__item"
            onClick={() => cutCopySelection(selMenu.index, false)}
          >
            Copy
          </button>
        </div>
      )}
    </div>
  )
}

export default BlockEditor

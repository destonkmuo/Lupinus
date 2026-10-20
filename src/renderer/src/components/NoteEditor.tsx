import { useLayoutEffect, useRef, useState } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { BULLET, FENCE, HEADING, ORDERED, QUOTE, RULE, TASK } from '../markdown'
import { normalizeUrl, trimUrl, urlAtEnd } from '../links'
import { escapeAttr, escapeHtml, inlineFromDom, inlineToHtml, inlineTokenAtEnd } from '../richText'
import { resolveImageSrc, type ImageControls } from '../images'
import { resolveWikiTarget } from '../notes'
import { useAppStore } from '../store/appStore'
import {
  SLASH_COMMANDS,
  filteredSlash,
  slashToken,
  type ChildKind,
  type SlashCommand
} from '../slash'
import SlashMenu from './SlashMenu'

export type { ChildKind } from '../slash'

type LineKind =
  'paragraph' | 'heading' | 'quote' | 'bullet' | 'ordered' | 'task' | 'rule' | 'code' | 'math'

interface LineSpec {
  kind: LineKind
  text: string
  level?: number
  checked?: boolean
  lang?: string
}

interface RenderOptions {
  placeholder?: string
  images?: ImageControls
}

/** Line kinds that have no inline editable text. */
const ATOMIC: ReadonlySet<LineKind> = new Set(['rule', 'math'])
const LIST_KINDS: ReadonlySet<LineKind> = new Set(['bullet', 'ordered', 'task'])

/** Strip the leading block marker from a source line, keeping its content. */
function parseLines(source: string): LineSpec[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: LineSpec[] = []
  let i = 0

  while (i < lines.length) {
    const raw = lines[i]
    const trimmed = raw.trim()

    if (FENCE.test(raw)) {
      const lang = trimmed.slice(3).trim()
      const body: string[] = []
      i += 1
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      out.push({ kind: 'code', text: body.join('\n'), lang })
      continue
    }

    if (trimmed.startsWith('$$')) {
      if (trimmed.length > 4 && trimmed.endsWith('$$')) {
        out.push({ kind: 'math', text: trimmed.slice(2, -2).trim() })
        i += 1
        continue
      }
      if (trimmed === '$$') {
        const body: string[] = []
        i += 1
        while (i < lines.length) {
          const line = lines[i]
          const cut = line.trim()
          if (cut.endsWith('$$')) {
            body.push(cut.slice(0, -2))
            i += 1
            break
          }
          body.push(line)
          i += 1
        }
        out.push({ kind: 'math', text: body.join('\n').trim() })
        continue
      }
    }

    const heading = HEADING.exec(raw)
    if (heading) {
      out.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      i += 1
      continue
    }

    if (RULE.test(raw)) {
      out.push({ kind: 'rule', text: '' })
      i += 1
      continue
    }

    const task = TASK.exec(raw)
    if (task) {
      out.push({
        kind: 'task',
        text: task[2],
        checked: task[1].toLowerCase() === 'x'
      })
      i += 1
      continue
    }

    const bullet = BULLET.exec(raw)
    if (bullet) {
      out.push({ kind: 'bullet', text: bullet[1] })
      i += 1
      continue
    }

    const ordered = ORDERED.exec(raw)
    if (ordered) {
      out.push({ kind: 'ordered', text: ordered[1] })
      i += 1
      continue
    }

    const quote = QUOTE.exec(raw)
    if (quote) {
      out.push({ kind: 'quote', text: quote[1] })
      i += 1
      continue
    }

    out.push({ kind: 'paragraph', text: raw })
    i += 1
  }

  return out.length > 0 ? out : [{ kind: 'paragraph', text: '' }]
}

function mathAtomHtml(tex: string, display: boolean): string {
  let inner: string
  try {
    inner = katex.renderToString(tex, { displayMode: display, throwOnError: false })
  } catch {
    return `<code>${escapeHtml(tex)}</code>`
  }
  return `<span class="math${display ? ' math--display' : ''}" data-tex="${escapeAttr(
    tex
  )}" data-display="${display ? 'true' : 'false'}" contenteditable="false">${inner}</span>`
}

function imageAtomHtml(alt: string, src: string, images?: ImageControls): string | null {
  const url = resolveImageSrc(src)
  if (!url) return null
  const key = src.trim()
  const width = images?.widths[key]
  const side = images?.sides[key]
  const classes = `md-img${side ? ` md-img--${side}` : ''}`
  const style = width ? ` style="width:${Math.round(width)}px"` : ''
  return `<span class="${classes}" data-img-alt="${escapeAttr(
    alt
  )}" data-img-src="${escapeAttr(src)}" contenteditable="false"><img src="${escapeAttr(
    url
  )}" alt="${escapeAttr(alt)}"${style} draggable="false"></span>`
}

function inlineHtml(text: string, images?: ImageControls): string {
  return inlineToHtml(text, { image: (alt, src) => imageAtomHtml(alt, src, images) })
}

function renderLine(spec: LineSpec, index: number, options: RenderOptions): string {
  const base = `class="nl nl--${spec.kind}" data-line="${index}" data-kind="${spec.kind}"`
  const empty = spec.kind === 'paragraph' && spec.text.trim() === ''
  const placeholder =
    index === 0 && options.placeholder && empty
      ? ` data-placeholder="${escapeAttr(options.placeholder)}" data-empty="true"`
      : ''

  switch (spec.kind) {
    case 'heading': {
      const level = Math.max(1, Math.min(6, spec.level ?? 1))
      return `<div class="nl nl--heading nl--h${level}" data-line="${index}" data-kind="heading" data-level="${level}">${inlineHtml(
        spec.text,
        options.images
      )}</div>`
    }
    case 'quote':
      return `<div ${base}>${inlineHtml(spec.text, options.images)}</div>`
    case 'bullet':
      return `<div ${base}>${inlineHtml(spec.text, options.images)}</div>`
    case 'ordered':
      return `<div ${base} data-number="1">${inlineHtml(spec.text, options.images)}</div>`
    case 'task':
      return `<div ${base}><input type="checkbox" contenteditable="false"${
        spec.checked ? ' checked' : ''
      }>${inlineHtml(spec.text, options.images)}</div>`
    case 'rule':
      return `<div ${base} contenteditable="false"><hr></div>`
    case 'math':
      return `<div ${base} contenteditable="false">${mathAtomHtml(spec.text, true)}</div>`
    case 'code':
      return `<div ${base} data-lang="${escapeAttr(spec.lang ?? '')}"><pre class="nl__code">${escapeHtml(
        spec.text
      )}</pre></div>`
    default:
      return `<div ${base}${placeholder}>${inlineHtml(spec.text, options.images)}</div>`
  }
}

function renderDocument(source: string, options: RenderOptions): string {
  return parseLines(source)
    .map((spec, index) => renderLine(spec, index, options))
    .join('')
}

function lineKindOf(el: HTMLElement): LineKind {
  return (el.dataset.kind as LineKind | undefined) ?? 'paragraph'
}

function isAtomic(el: HTMLElement): boolean {
  return ATOMIC.has(lineKindOf(el))
}

function getLines(root: HTMLElement): HTMLElement[] {
  return Array.from(root.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('nl')
  )
}

function textHost(line: HTMLElement): HTMLElement {
  if (lineKindOf(line) === 'code') {
    return line.querySelector<HTMLElement>(':scope > pre') ?? line
  }
  return line
}

function lineTextOf(line: HTMLElement): string {
  const kind = lineKindOf(line)
  if (kind === 'rule') return ''
  if (kind === 'math') return line.querySelector<HTMLElement>('[data-tex]')?.dataset.tex ?? ''
  if (kind === 'code') return line.querySelector('pre')?.textContent ?? ''
  return inlineFromDom(line).replace(/\u200b/g, '')
}

function lineFromNode(node: Node | null): HTMLElement | null {
  if (!node) return null
  const el = node instanceof HTMLElement ? node : (node.parentElement ?? null)
  return el?.closest<HTMLElement>('.nl') ?? null
}

function previousLine(line: HTMLElement): HTMLElement | null {
  const prev = line.previousElementSibling
  return prev instanceof HTMLElement && prev.classList.contains('nl') ? prev : null
}

function nextLine(line: HTMLElement): HTMLElement | null {
  const next = line.nextElementSibling
  return next instanceof HTMLElement && next.classList.contains('nl') ? next : null
}

/** Previous line the caret can actually enter (rules and math blocks are atomic). */
function previousTextLine(line: HTMLElement): HTMLElement | null {
  let prev = previousLine(line)
  while (prev && isAtomic(prev)) prev = previousLine(prev)
  return prev
}

function nextTextLine(line: HTMLElement): HTMLElement | null {
  let next = nextLine(line)
  while (next && isAtomic(next)) next = nextLine(next)
  return next
}

function selectionInHost(host: HTMLElement): Range | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return null
  return range
}

function offsetAt(host: HTMLElement, container: Node, offset: number): number {
  if (!host.contains(container) && container !== host) return host.textContent?.length ?? 0
  const pre = document.createRange()
  pre.selectNodeContents(host)
  pre.setEnd(container, offset)
  return pre.toString().length
}

function caretOffset(host: HTMLElement): number {
  const range = selectionInHost(host)
  if (!range) return 0
  return offsetAt(host, range.startContainer, range.startOffset)
}

function locate(host: HTMLElement, offset: number): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  let remaining = offset
  let node = walker.nextNode()
  while (node) {
    const len = node.textContent?.length ?? 0
    if (remaining <= len) return { node, offset: remaining }
    remaining -= len
    node = walker.nextNode()
  }
  return null
}

function setCaretOffset(host: HTMLElement, offset: number): void {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  const at = locate(host, Math.max(0, offset))
  if (at) {
    range.setStart(at.node, at.offset)
    range.collapse(true)
  } else {
    range.selectNodeContents(host)
    range.collapse(false)
  }
  sel.removeAllRanges()
  sel.addRange(range)
}

function rangeAtOffsets(host: HTMLElement, start: number, end: number): Range {
  const range = document.createRange()
  const from = locate(host, Math.max(0, start))
  const to = locate(host, Math.max(0, end))
  if (from) range.setStart(from.node, from.offset)
  else {
    range.selectNodeContents(host)
    range.collapse(true)
  }
  if (to) range.setEnd(to.node, to.offset)
  else range.selectNodeContents(host)
  return range
}

function deleteOffsets(host: HTMLElement, start: number, end: number): void {
  rangeAtOffsets(host, start, end).deleteContents()
}

function insertTextAtCaret(text: string): void {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  const after = document.createRange()
  after.setStartAfter(node)
  after.collapse(true)
  sel.removeAllRanges()
  sel.addRange(after)
}

function focusRoot(root: HTMLElement): void {
  if (document.activeElement !== root) root.focus({ preventScroll: true })
}

function setLineKind(el: HTMLElement, kind: LineKind, level = 1): void {
  const previous = el.dataset.kind as LineKind | undefined

  if (previous === 'task' && kind !== 'task') {
    el.querySelector(':scope > input[type="checkbox"]')?.remove()
  }
  if (previous === 'code' && kind !== 'code') {
    const text = el.querySelector('pre')?.textContent ?? ''
    el.innerHTML = ''
    if (text) el.textContent = text
  }
  if ((previous === 'rule' || previous === 'math') && kind !== previous) {
    el.innerHTML = ''
  }

  el.className = `nl nl--${kind}`
  el.dataset.kind = kind
  delete el.dataset.level
  delete el.dataset.lang

  if (kind === 'heading') {
    el.dataset.level = String(level)
    el.classList.add(`nl--h${level}`)
  }

  if (kind === 'code') {
    if (!el.querySelector(':scope > pre')) {
      const text = el.textContent ?? ''
      el.innerHTML = ''
      const pre = document.createElement('pre')
      pre.className = 'nl__code'
      pre.textContent = text
      el.appendChild(pre)
    }
  }

  if (kind === 'rule' && !el.querySelector(':scope > hr')) {
    el.innerHTML = ''
    el.appendChild(document.createElement('hr'))
  }

  if (kind === 'task' && !el.querySelector(':scope > input[type="checkbox"]')) {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('contenteditable', 'false')
    el.insertBefore(input, el.firstChild)
  }

  if (ATOMIC.has(kind)) el.setAttribute('contenteditable', 'false')
  else el.removeAttribute('contenteditable')
}

function makeLine(kind: LineKind, level = 1): HTMLElement {
  const el = document.createElement('div')
  setLineKind(el, kind, level)
  return el
}

function toRule(line: HTMLElement): void {
  line.innerHTML = ''
  setLineKind(line, 'rule')
}

function toMath(line: HTMLElement, tex: string): void {
  line.innerHTML = mathAtomHtml(tex, true)
  setLineKind(line, 'math')
}

function toCode(line: HTMLElement, text: string, lang = ''): void {
  line.innerHTML = ''
  setLineKind(line, 'code')
  line.dataset.lang = lang
  const pre = line.querySelector<HTMLElement>(':scope > pre')
  if (pre) pre.textContent = text
}

function refreshLineMeta(root: HTMLElement, placeholder?: string): void {
  const lines = getLines(root)
  let ordered = 0
  lines.forEach((line, index) => {
    line.dataset.line = String(index)
    if (lineKindOf(line) === 'ordered') {
      ordered += 1
      line.dataset.number = String(ordered)
    } else {
      ordered = 0
    }
    if (
      index === 0 &&
      placeholder &&
      lineKindOf(line) === 'paragraph' &&
      lineTextOf(line).trim() === ''
    ) {
      line.dataset.placeholder = placeholder
      line.dataset.empty = 'true'
    } else {
      delete line.dataset.placeholder
      delete line.dataset.empty
    }
  })
}

function serializeLine(line: HTMLElement): string {
  const kind = lineKindOf(line)
  switch (kind) {
    case 'rule':
      return '---'
    case 'math': {
      const tex = line.querySelector<HTMLElement>('[data-tex]')?.dataset.tex ?? ''
      return `$$${tex}$$`
    }
    case 'code': {
      const lang = line.dataset.lang ?? ''
      const body = line.querySelector('pre')?.textContent ?? ''
      return `\`\`\`${lang}\n${body}\n\`\`\``
    }
    case 'heading': {
      const level = Math.max(1, Math.min(6, Number(line.dataset.level) || 1))
      return `${'#'.repeat(level)} ${lineTextOf(line).replace(/^\s+/, '')}`
    }
    case 'quote':
      return `> ${lineTextOf(line).replace(/^\s+/, '')}`
    case 'bullet':
      return `- ${lineTextOf(line).replace(/^\s+/, '')}`
    case 'ordered':
      return `${line.dataset.number ?? '1'}. ${lineTextOf(line).replace(/^\s+/, '')}`
    case 'task': {
      const checked = line.querySelector<HTMLInputElement>(
        ':scope > input[type="checkbox"]'
      )?.checked
      return `- [${checked ? 'x' : ' '}] ${lineTextOf(line).replace(/^\s+/, '')}`
    }
    default:
      return lineTextOf(line).replace(/\n+$/, '')
  }
}

function serializeEditor(root: HTMLElement): string {
  const lines = getLines(root)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (lineKindOf(lines[i]) !== 'code') {
      out.push(serializeLine(lines[i]))
      i += 1
      continue
    }
    // Adjacent code lines form one fenced block in the saved markdown.
    const lang = lines[i].dataset.lang ?? ''
    const body: string[] = []
    while (
      i < lines.length &&
      lineKindOf(lines[i]) === 'code' &&
      (lines[i].dataset.lang ?? '') === lang
    ) {
      body.push(lineTextOf(lines[i]))
      i += 1
    }
    out.push(`\`\`\`${lang}\n${body.join('\n')}\n\`\`\``)
  }
  return out.join('\n')
}

/** Browsers occasionally drop a bare text node or a nested block into a
 * contenteditable root; fold those back into the line model before saving. */
function normalizeLineStructure(root: HTMLElement): void {
  for (const child of Array.from(root.childNodes)) {
    if (child instanceof HTMLElement && child.classList.contains('nl')) continue
    if (child.nodeType === Node.TEXT_NODE && !(child.textContent ?? '').trim()) {
      child.remove()
      continue
    }
    const line = makeLine('paragraph')
    root.insertBefore(line, child)
    line.appendChild(child)
  }

  for (const line of getLines(root)) {
    if (lineKindOf(line) === 'code') continue
    const nested = Array.from(line.children).filter((child) => {
      if (!(child instanceof HTMLElement)) return false
      if (child.classList.contains('nl__code')) return false
      if (child.dataset.tex !== undefined) return false
      return ['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol'].includes(
        child.tagName.toLowerCase()
      )
    })
    let anchor: HTMLElement = line
    for (const block of nested) {
      const extra = makeLine('paragraph')
      while (block.firstChild) extra.appendChild(block.firstChild)
      block.remove()
      anchor.after(extra)
      anchor = extra
    }
  }

  if (getLines(root).length === 0) root.appendChild(makeLine('paragraph'))
}

interface NoteEditorProps {
  /** Raw markdown for the whole note body. */
  value: string
  onChange: (value: string) => void
  placeholder?: string
  images?: ImageControls
  /** Creates a child under this note and returns the markdown link to embed. */
  onCreateChild?: (kind: ChildKind) => string | null
  /** Restore the caret into this line when the editor first mounts. */
  initialCaret?: { block: number; offset: number } | null
}

/**
 * Edit-first note surface.
 *
 * The whole note is one always-editable contenteditable document. Markdown is
 * interpreted line by line, so a heading and a list can live in the same
 * paragraph without blank-line block boundaries. Markers are recognized as
 * they are typed (`#`, `- `, `> `, `[] `, `---`, `/command`) and immediately
 * render as formatted content. Native selection spans every line, so text can
 * be selected and deleted across the whole note.
 */
function NoteEditor({
  value,
  onChange,
  placeholder,
  images,
  onCreateChild,
  initialCaret
}: NoteEditorProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [slash, setSlash] = useState<{ token: string; x: number; y: number } | null>(null)
  const [slashSel, setSlashSel] = useState(0)
  const composingRef = useRef(false)
  const initializedRef = useRef(false)

  const imagesRef = useRef(images)
  const placeholderRef = useRef(placeholder)
  const onChangeRef = useRef(onChange)
  const onCreateChildRef = useRef(onCreateChild)

  useLayoutEffect(() => {
    imagesRef.current = images
    placeholderRef.current = placeholder
    onChangeRef.current = onChange
    onCreateChildRef.current = onCreateChild
  })

  const syncedRef = useRef(value)
  const presentRef = useRef(value)
  const historyRef = useRef<{ past: string[]; future: string[] }>({ past: [], future: [] })
  const lastPushAtRef = useRef(0)
  const burstStartRef = useRef(0)

  const render = (markdown: string): string =>
    renderDocument(markdown, {
      placeholder: placeholderRef.current,
      images: imagesRef.current
    })

  const focusStyles = (): void => {
    const root = rootRef.current
    if (root) focusRoot(root)
  }

  const currentLine = (): HTMLElement | null => {
    const root = rootRef.current
    const sel = window.getSelection()
    if (!root || !sel || sel.rangeCount === 0) return null
    const line = lineFromNode(sel.getRangeAt(0).startContainer)
    return line && root.contains(line) ? line : null
  }

  const placeCaret = (line: HTMLElement, where: 'start' | 'end' | number): void => {
    focusStyles()
    if (isAtomic(line)) {
      const sel = window.getSelection()
      if (!sel) return
      const range = document.createRange()
      range.setStartBefore(line)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
      return
    }
    const host = textHost(line)
    const length = host.textContent?.length ?? 0
    const offset = where === 'start' ? 0 : where === 'end' ? length : Math.min(where, length)
    setCaretOffset(host, offset)
  }

  const placeCaretAtLine = (index: number, offset: number): void => {
    const root = rootRef.current
    if (!root) return
    const lines = getLines(root)
    const line = lines[Math.max(0, Math.min(index, lines.length - 1))]
    if (!line) return
    placeCaret(line, offset)
  }

  const currentCaret = (): { line: number; offset: number } | null => {
    const root = rootRef.current
    const sel = window.getSelection()
    if (!root || !sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    const line = lineFromNode(range.startContainer)
    if (!line || !root.contains(line)) return null
    return {
      line: Number(line.dataset.line) || 0,
      offset: offsetAt(textHost(line), range.startContainer, range.startOffset)
    }
  }

  const applyMarkdown = (
    markdown: string,
    caret: { line: number; offset: number } | null
  ): void => {
    const root = rootRef.current
    if (!root) return
    root.innerHTML = render(markdown)
    refreshLineMeta(root, placeholderRef.current)
    syncedRef.current = markdown
    presentRef.current = markdown
    setSlash(null)
    if (caret) placeCaretAtLine(caret.line, caret.offset)
  }

  const commit = (structural = false): void => {
    const root = rootRef.current
    if (!root) return
    normalizeLineStructure(root)
    refreshLineMeta(root, placeholderRef.current)
    const next = serializeEditor(root)
    const now = Date.now()
    if (next !== presentRef.current) {
      const history = historyRef.current
      const pause = now - lastPushAtRef.current
      if (structural || pause > 600 || now - burstStartRef.current > 2000) {
        history.past.push(presentRef.current)
        if (history.past.length > 150) history.past.shift()
        history.future.length = 0
        burstStartRef.current = now
      }
      lastPushAtRef.current = now
      presentRef.current = next
      syncedRef.current = next
      onChangeRef.current(next)
    }
  }

  const undo = (): void => {
    const history = historyRef.current
    const previous = history.past.pop()
    if (previous === undefined) return
    const caret = currentCaret()
    history.future.push(presentRef.current)
    applyMarkdown(previous, caret)
    lastPushAtRef.current = 0
    burstStartRef.current = 0
    onChangeRef.current(previous)
  }

  const redo = (): void => {
    const history = historyRef.current
    const next = history.future.pop()
    if (next === undefined) return
    const caret = currentCaret()
    history.past.push(presentRef.current)
    applyMarkdown(next, caret)
    lastPushAtRef.current = 0
    burstStartRef.current = 0
    onChangeRef.current(next)
  }

  // Seed the document once. Fixing the HTML by hand (rather than rendering
  // React children) keeps the browser in charge of the caret while typing.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || initializedRef.current) return
    initializedRef.current = true
    root.innerHTML = render(value)
    refreshLineMeta(root, placeholderRef.current)
    syncedRef.current = value
    presentRef.current = value
    if (initialCaret) {
      focusRoot(root)
      placeCaretAtLine(initialCaret.block, initialCaret.offset)
    }
    // Only on mount: external updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Adopt document swaps from outside (vault refresh, note switch) while the
  // editor is idle. Typing itself always updates `syncedRef` first.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !initializedRef.current) return
    if (value === syncedRef.current) return
    if (root.contains(document.activeElement)) return
    applyMarkdown(value, null)
    historyRef.current = { past: [], future: [] }
    lastPushAtRef.current = 0
    burstStartRef.current = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const applyAutoLink = (line: HTMLElement): boolean => {
    const host = textHost(line)
    const range = selectionInHost(host)
    if (!range || !range.collapsed) return false
    const before = (() => {
      const pre = document.createRange()
      pre.selectNodeContents(host)
      pre.setEnd(range.startContainer, range.startOffset)
      return pre.toString()
    })()
    if (!/\s$/.test(before)) return false
    const hit = urlAtEnd(before)
    if (!hit) return false
    const url = trimUrl(hit.raw)
    const href = normalizeUrl(url)
    if (!href) return false
    const caret = caretOffset(host)
    const trailing = before.length - before.replace(/\s+$/, '').length
    const start = caret - trailing - hit.raw.length
    const target = rangeAtOffsets(host, start, start + hit.raw.length)
    const startHost =
      target.startContainer instanceof HTMLElement
        ? target.startContainer
        : target.startContainer.parentElement
    if (startHost?.closest('a')) return false
    const link = document.createElement('a')
    link.href = '#'
    link.dataset.href = href
    link.title = 'Ctrl/Cmd-click to open · double-click to edit source'
    link.textContent = url
    target.deleteContents()
    target.insertNode(link)
    const extra = hit.raw.slice(url.length)
    if (extra) link.after(document.createTextNode(extra))
    const after = document.createRange()
    after.setStartAfter(extra ? (link.nextSibling ?? link) : link)
    after.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(after)
    return true
  }

  const applyInlineFormat = (line: HTMLElement): boolean => {
    const host = textHost(line)
    const range = selectionInHost(host)
    if (!range || !range.collapsed) return false
    const before = (() => {
      const pre = document.createRange()
      pre.selectNodeContents(host)
      pre.setEnd(range.startContainer, range.startOffset)
      return pre.toString()
    })()
    const token = inlineTokenAtEnd(before)
    if (!token) return false
    const caret = before.length
    const target = rangeAtOffsets(host, caret - token.length, caret)
    const template = document.createElement('template')
    template.innerHTML = inlineHtml(token, imagesRef.current)
    const frag = template.content
    const last = frag.lastChild
    target.deleteContents()
    target.insertNode(frag)
    const after = document.createRange()
    if (last) after.setStartAfter(last)
    else after.setStart(target.startContainer, target.startOffset)
    after.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(after)
    return true
  }

  const applyMarkerRule = (line: HTMLElement): boolean => {
    const kind = lineKindOf(line)
    const host = textHost(line)
    const range = selectionInHost(host)
    if (!range || !range.collapsed) return false
    const caret = offsetAt(host, range.startContainer, range.startOffset)
    const text = host.textContent ?? ''

    if (kind === 'heading') {
      if (/^#{1,6}$/.test(text) && caret === text.length) {
        const level = Math.min(6, (Number(line.dataset.level) || 1) + text.length)
        setLineKind(line, 'heading', level)
        deleteOffsets(host, 0, text.length)
        setCaretOffset(host, 0)
        return true
      }
    }

    if (kind !== 'code') {
      const heading = /^(#{1,6})/.exec(text)
      if (heading && caret === heading[1].length) {
        if (!(heading[1].length === 6 && text[caret] === '#')) {
          setLineKind(line, 'heading', heading[1].length)
          deleteOffsets(host, 0, heading[1].length)
          setCaretOffset(host, 0)
          return true
        }
      }

      if (caret === text.length && /^(?:-{3,}|\*{3,}|_{3,})$/.test(text)) {
        toRule(line)
        const next = makeLine('paragraph')
        line.after(next)
        setCaretOffset(next, 0)
        return true
      }

      if (text.startsWith('>') && caret === 1) {
        setLineKind(line, 'quote')
        deleteOffsets(host, 0, 1)
        setCaretOffset(host, 0)
        return true
      }

      const bullet = /^[-*+]\s+/.exec(text)
      if (bullet && caret === bullet[0].length) {
        setLineKind(line, 'bullet')
        deleteOffsets(host, 0, bullet[0].length)
        setCaretOffset(host, 0)
        return true
      }

      const ordered = /^\d{1,9}\.\s+/.exec(text)
      if (ordered && caret === ordered[0].length) {
        setLineKind(line, 'ordered')
        deleteOffsets(host, 0, ordered[0].length)
        setCaretOffset(host, 0)
        return true
      }
    }

    if (kind === 'paragraph' || kind === 'bullet' || kind === 'ordered') {
      const task = /^(?:[-*+]\s+)?\[([ xX]?)\]\s+/.exec(text)
      if (task && caret === task[0].length) {
        setLineKind(line, 'task')
        const checkbox = line.querySelector<HTMLInputElement>(':scope > input[type="checkbox"]')
        if (checkbox) checkbox.checked = task[1].toLowerCase() === 'x'
        // The line element may have been rebuilt by setLineKind; re-read it.
        const nextHost = textHost(line)
        deleteOffsets(nextHost, 0, task[0].length)
        setCaretOffset(nextHost, 0)
        return true
      }
    }

    return false
  }

  const clearSlashToken = (line: HTMLElement): void => {
    const host = textHost(line)
    const range = selectionInHost(host)
    if (!range || !range.collapsed) return
    const before = (() => {
      const pre = document.createRange()
      pre.selectNodeContents(host)
      pre.setEnd(range.startContainer, range.startOffset)
      return pre.toString()
    })()
    const match = /(^|\s)\/([\w-]*)$/.exec(before)
    if (!match) return
    const start = (match.index ?? 0) + match[1].length
    deleteOffsets(host, start, before.length)
    setCaretOffset(host, start)
  }

  const insertPlainText = (text: string): void => {
    insertTextAtCaret(text)
  }

  const applyCommand = (cmd: SlashCommand, line: HTMLElement): void => {
    setSlash(null)
    if (cmd.childKind) {
      const link = onCreateChildRef.current?.(cmd.childKind) ?? null
      if (link) insertPlainText(link)
      return
    }

    switch (cmd.id) {
      case 'h1':
        setLineKind(line, 'heading', 1)
        break
      case 'h2':
        setLineKind(line, 'heading', 2)
        break
      case 'h3':
        setLineKind(line, 'heading', 3)
        break
      case 'bullet':
        setLineKind(line, 'bullet')
        break
      case 'numbered':
        setLineKind(line, 'ordered')
        break
      case 'todo':
        setLineKind(line, 'task')
        break
      case 'quote':
        setLineKind(line, 'quote')
        break
      case 'divider': {
        const next = makeLine('paragraph')
        line.after(next)
        toRule(line)
        placeCaret(next, 'start')
        break
      }
      case 'code': {
        const text = lineTextOf(line)
        toCode(line, text, 'js')
        placeCaret(line, 'end')
        break
      }
      case 'mathblock': {
        toMath(line, lineTextOf(line).trim() || 'x')
        const next = makeLine('paragraph')
        line.after(next)
        placeCaret(next, 'start')
        break
      }
      case 'math':
        insertPlainText('$x$')
        applyInlineFormat(line)
        break
      case 'image':
        insertPlainText('![image](url)')
        break
      case 'link':
        insertPlainText('[text](url)')
        break
      default:
        break
    }
  }

  const applyDirectSlash = (line: HTMLElement): boolean => {
    if (lineKindOf(line) !== 'paragraph') return false
    const host = textHost(line)
    const range = selectionInHost(host)
    if (!range || !range.collapsed) return false
    const before = (() => {
      const pre = document.createRange()
      pre.selectNodeContents(host)
      pre.setEnd(range.startContainer, range.startOffset)
      return pre.toString()
    })()
    const match = /(^|\s)\/([\w-]+)\s$/.exec(before)
    if (!match) return false
    const query = match[2].toLowerCase()
    const cmd = SLASH_COMMANDS.find((item) => item.id === query) ?? filteredSlash(query)[0]
    if (!cmd) return false
    const start = (match.index ?? 0) + match[1].length
    deleteOffsets(host, start, before.length)
    setCaretOffset(host, start)
    applyCommand(cmd, line)
    return true
  }

  const moveCaret = (line: HTMLElement, where: 'start' | 'end'): void => {
    placeCaret(line, where)
  }

  const createParagraphAfter = (line: HTMLElement): HTMLElement => {
    const next = makeLine('paragraph')
    line.after(next)
    placeCaret(next, 'start')
    return next
  }

  const splitLineAtCaret = (line: HTMLElement): void => {
    const kind = lineKindOf(line)
    if (isAtomic(line)) {
      createParagraphAfter(line)
      commit(true)
      return
    }
    const host = textHost(line)
    const range = selectionInHost(host)
    if (!range) return

    const text = lineTextOf(line)
    if (!text) {
      if (kind === 'heading' || kind === 'quote' || LIST_KINDS.has(kind)) {
        setLineKind(line, 'paragraph')
        placeCaret(line, 'start')
        commit(true)
        return
      }
    }

    const post = document.createRange()
    post.selectNodeContents(host)
    post.setStart(range.startContainer, range.startOffset)
    const fragment = post.extractContents()

    const nextKind: LineKind = kind === 'heading' ? 'paragraph' : kind
    const next = makeLine(nextKind)
    next.appendChild(fragment)
    line.after(next)
    placeCaret(next, 'start')
    commit(true)
  }

  const mergeBackward = (line: HTMLElement): void => {
    const root = rootRef.current
    const prev = previousLine(line)
    const kind = lineKindOf(line)

    if (!prev) {
      if (kind === 'rule' || kind === 'math') {
        const source = kind === 'math' ? `$$${lineTextOf(line)}$$` : '---'
        setLineKind(line, 'paragraph')
        line.textContent = source
        placeCaret(line, 'start')
      } else if (kind !== 'paragraph') {
        setLineKind(line, 'paragraph')
        placeCaret(line, 'start')
      }
      commit(true)
      return
    }

    const prevKind = lineKindOf(prev)

    if (prevKind === 'rule' || prevKind === 'math') {
      prev.remove()
      if (root && !line.isConnected) root.appendChild(line)
      placeCaret(line, 'start')
      commit(true)
      return
    }

    if (prevKind === 'code' || kind === 'code') {
      if (prevKind === 'code') {
        const pre = prev.querySelector<HTMLElement>(':scope > pre')
        if (pre) {
          const before = pre.textContent ?? ''
          pre.textContent = `${before}${lineTextOf(line)}`
          line.remove()
          focusStyles()
          setCaretOffset(pre, before.length)
        }
      } else {
        const host = textHost(prev)
        const caret = host.textContent?.length ?? 0
        const pre = line.querySelector(':scope > pre')
        if (pre) prev.appendChild(document.createTextNode(pre.textContent ?? ''))
        line.remove()
        placeCaret(prev, caret)
      }
      commit(true)
      return
    }

    const host = textHost(prev)
    const caret = host.textContent?.length ?? 0
    for (const node of Array.from(line.childNodes)) {
      if (node instanceof HTMLInputElement) continue
      prev.appendChild(node)
    }
    line.remove()
    placeCaret(prev, caret)
    commit(true)
  }

  const mergeForward = (line: HTMLElement): void => {
    const next = nextLine(line)
    if (!next) return
    const kind = lineKindOf(line)
    const nextKind = lineKindOf(next)

    if (nextKind === 'rule' || nextKind === 'math') {
      next.remove()
      commit(true)
      return
    }

    if (kind === 'rule' || kind === 'math') {
      line.remove()
      placeCaret(next, 'start')
      commit(true)
      return
    }

    if (kind === 'code' || nextKind === 'code') {
      if (kind === 'code') {
        const pre = line.querySelector<HTMLElement>(':scope > pre')
        if (pre) {
          const before = pre.textContent ?? ''
          pre.textContent = `${before}${lineTextOf(next)}`
          next.remove()
          focusStyles()
          setCaretOffset(pre, before.length)
        }
      } else {
        const host = textHost(line)
        const before = host.textContent?.length ?? 0
        const pre = next.querySelector(':scope > pre')
        if (pre) host.appendChild(document.createTextNode(pre.textContent ?? ''))
        next.remove()
        placeCaret(line, before)
      }
      commit(true)
      return
    }

    const host = textHost(line)
    const caret = host.textContent?.length ?? 0
    for (const node of Array.from(next.childNodes)) {
      if (node instanceof HTMLInputElement) continue
      line.appendChild(node)
    }
    next.remove()
    placeCaret(line, caret)
    commit(true)
  }

  /** Delete a selection spanning multiple lines as one operation, keeping the
   * prefix of the first line and the suffix of the last. */
  const deleteMultiLineSelection = (): boolean => {
    const root = rootRef.current
    const sel = window.getSelection()
    if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) return false
    const range = sel.getRangeAt(0)
    const startLine = lineFromNode(range.startContainer)
    const endLine = lineFromNode(range.endContainer)
    if (!startLine || !endLine || startLine === endLine) return false
    if (!root.contains(startLine) || !root.contains(endLine)) return false
    if (
      isAtomic(startLine) ||
      isAtomic(endLine) ||
      lineKindOf(startLine) === 'code' ||
      lineKindOf(endLine) === 'code'
    ) {
      return false
    }

    const prefix = document.createRange()
    prefix.selectNodeContents(startLine)
    prefix.setEnd(range.startContainer, range.startOffset)
    const prefixFragment = prefix.cloneContents()

    const suffix = document.createRange()
    suffix.selectNodeContents(endLine)
    suffix.setStart(range.endContainer, range.endOffset)
    const suffixFragment = suffix.cloneContents()

    let current: Element | null = startLine.nextElementSibling
    while (current) {
      const following = current.nextElementSibling
      if (current === endLine) {
        current.remove()
        break
      }
      current.remove()
      current = following
    }

    const checkbox = startLine.querySelector(':scope > input[type="checkbox"]')
    startLine.innerHTML = ''
    if (checkbox) startLine.appendChild(checkbox)
    startLine.appendChild(prefixFragment)
    startLine.appendChild(suffixFragment)

    const caret = prefixFragment.textContent?.length ?? 0
    placeCaret(startLine, caret)
    commit(true)
    return true
  }

  const wrapSelection = (tag: string): void => {
    const root = rootRef.current
    const sel = window.getSelection()
    if (!root || !sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (range.collapsed) return
    const startLine = lineFromNode(range.startContainer)
    const endLine = lineFromNode(range.endContainer)
    if (!startLine || !endLine || startLine !== endLine) return

    const existing =
      range.commonAncestorContainer instanceof HTMLElement
        ? range.commonAncestorContainer.closest(tag)
        : range.commonAncestorContainer.parentElement?.closest(tag)
    if (existing && startLine.contains(existing)) {
      const parent = existing.parentNode
      if (parent) {
        while (existing.firstChild) parent.insertBefore(existing.firstChild, existing)
        existing.remove()
        parent.normalize()
      }
      commit(true)
      return
    }

    const wrapper = document.createElement(tag)
    try {
      range.surroundContents(wrapper)
    } catch {
      wrapper.appendChild(range.extractContents())
      range.insertNode(wrapper)
    }
    const after = document.createRange()
    after.selectNodeContents(wrapper)
    sel.removeAllRanges()
    sel.addRange(after)
    commit(true)
  }

  const refreshSlash = (): void => {
    const line = currentLine()
    if (!line || isAtomic(line)) {
      setSlash((prev) => (prev ? null : prev))
      return
    }
    const host = textHost(line)
    const range = selectionInHost(host)
    if (!range || !range.collapsed) {
      setSlash((prev) => (prev ? null : prev))
      return
    }
    const token = slashToken(host.textContent ?? '', caretOffset(host))
    if (token === null) {
      setSlash((prev) => (prev ? null : prev))
      return
    }
    const rect = range.getBoundingClientRect()
    const box = line.getBoundingClientRect()
    const left = rect.width || rect.height ? rect.left : box.left + 12
    const top = rect.width || rect.height ? rect.bottom + 6 : box.bottom + 6
    const x = Math.max(8, Math.min(left, window.innerWidth - 310))
    const y = Math.max(8, Math.min(top, window.innerHeight - 330))
    const changedToken = slash?.token !== token
    setSlash((prev) =>
      prev && prev.token === token && prev.x === x && prev.y === y ? prev : { token, x, y }
    )
    if (changedToken) setSlashSel(0)
  }

  const applyRules = (line: HTMLElement): boolean => {
    if (lineKindOf(line) === 'code') return false
    if (applyDirectSlash(line)) return true
    if (applyMarkerRule(line)) return true
    if (applyInlineFormat(line)) return true
    if (applyAutoLink(line)) return true
    return false
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const root = rootRef.current
    if (!root) return
    const line = currentLine()
    const key = event.key

    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const lower = key.toLowerCase()
      if (lower === 'z') {
        event.preventDefault()
        event.stopPropagation()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (lower === 'y') {
        event.preventDefault()
        event.stopPropagation()
        redo()
        return
      }
      const tag =
        lower === 'b' && !event.shiftKey
          ? 'strong'
          : lower === 'i' && !event.shiftKey
            ? 'em'
            : lower === 'e' && !event.shiftKey
              ? 'code'
              : lower === 'h' && event.shiftKey
                ? 'mark'
                : lower === 'x' && event.shiftKey
                  ? 'del'
                  : null
      if (tag) {
        event.preventDefault()
        wrapSelection(tag)
        return
      }
    }

    if (slash) {
      if (key === 'Escape') {
        event.preventDefault()
        setSlash(null)
        return
      }
      const items = filteredSlash(slash.token)
      if (items.length === 0) {
        setSlash(null)
      } else if (key === 'ArrowDown') {
        event.preventDefault()
        setSlashSel((sel) => (sel + 1) % items.length)
        return
      } else if (key === 'ArrowUp') {
        event.preventDefault()
        setSlashSel((sel) => (sel - 1 + items.length) % items.length)
        return
      } else if (key === 'Enter' || key === 'Tab') {
        event.preventDefault()
        if (line) {
          clearSlashToken(line)
          applyCommand(items[slashSel % items.length], line)
        }
        commit(true)
        return
      }
    }

    if (key === 'Enter') {
      event.preventDefault()
      if (composingRef.current) return
      const selected = window.getSelection()
      if (selected && !selected.isCollapsed && selected.rangeCount > 0) {
        const range = selected.getRangeAt(0)
        const startLine = lineFromNode(range.startContainer)
        const endLine = lineFromNode(range.endContainer)
        if (startLine && endLine && startLine !== endLine) {
          if (!deleteMultiLineSelection()) range.deleteContents()
        } else {
          range.deleteContents()
        }
        const target = currentLine() ?? line
        if (target) splitLineAtCaret(target)
        commit(true)
        return
      }
      if (!line) {
        const last = getLines(root).at(-1)
        if (last) createParagraphAfter(last)
        commit(true)
        return
      }
      const kind = lineKindOf(line)
      if (kind === 'code') {
        if (event.metaKey || event.ctrlKey) {
          createParagraphAfter(line)
        } else {
          const host = textHost(line)
          const text = host.textContent ?? ''
          const at = caretOffset(host)
          host.textContent = text.slice(0, at)
          const next = makeLine('code')
          next.dataset.lang = line.dataset.lang ?? ''
          const nextHost = textHost(next)
          nextHost.textContent = text.slice(at)
          line.after(next)
          placeCaret(next, 0)
        }
        commit(true)
        return
      }
      if (kind === 'rule' || kind === 'math') {
        createParagraphAfter(line)
        commit(true)
        return
      }
      if (kind === 'paragraph') {
        const text = lineTextOf(line)
        const host = textHost(line)
        const atEnd = caretOffset(host) >= (host.textContent?.length ?? 0)
        if (atEnd && /^```[\w+-]*$/.test(text)) {
          toCode(line, '', text.slice(3))
          placeCaret(line, 'end')
          commit(true)
          return
        }
      }
      if (kind === 'quote' || LIST_KINDS.has(kind)) {
        if (lineTextOf(line).trim() === '') {
          setLineKind(line, 'paragraph')
          placeCaret(line, 'start')
          commit(true)
          return
        }
      }
      applyAutoLink(line)
      splitLineAtCaret(line)
      return
    }

    if (key === 'Backspace' || key === 'Delete') {
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) {
        if (deleteMultiLineSelection()) {
          event.preventDefault()
          return
        }
      } else if (line) {
        const kind = lineKindOf(line)
        const host = textHost(line)
        const offset = caretOffset(host)
        const length = host.textContent?.length ?? 0
        if (key === 'Backspace' && offset === 0) {
          event.preventDefault()
          const text = lineTextOf(line)
          const level = Number(line.dataset.level) || 1
          if (kind === 'heading' && level > 1 && !text) {
            setLineKind(line, 'heading', level - 1)
            placeCaret(line, 'start')
            commit(true)
            return
          }
          if (kind !== 'paragraph' && !text.trim()) {
            setLineKind(line, 'paragraph')
            placeCaret(line, 'start')
            commit(true)
            return
          }
          mergeBackward(line)
          return
        }
        if (key === 'Delete' && offset >= length) {
          event.preventDefault()
          mergeForward(line)
          return
        }
      }
    }

    if (key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      insertTextAtCaret('  ')
      commit(true)
      return
    }

    if (!event.altKey && (key === 'ArrowUp' || key === 'ArrowDown') && line) {
      const host = textHost(line)
      const offset = caretOffset(host)
      const length = host.textContent?.length ?? 0
      if (key === 'ArrowUp' && offset === 0) {
        const prev = previousTextLine(line)
        if (prev) {
          event.preventDefault()
          moveCaret(prev, 'end')
          return
        }
      }
      if (key === 'ArrowDown' && offset >= length) {
        const next = nextTextLine(line)
        if (next) {
          event.preventDefault()
          moveCaret(next, 'start')
          return
        }
        if (lineKindOf(line) === 'code') {
          event.preventDefault()
          createParagraphAfter(line)
          commit(true)
          return
        }
      }
    }

    if (key === 'Escape' && slash) {
      event.preventDefault()
      setSlash(null)
    }
  }

  const handleInput = (event: React.FormEvent<HTMLDivElement>): void => {
    const root = rootRef.current
    if (!root) return
    const native = event.nativeEvent as InputEvent
    if (composingRef.current || native.isComposing) {
      commit(false)
      return
    }
    normalizeLineStructure(root)
    const line = currentLine()
    const transformed = line ? applyRules(line) : false
    const type = native.inputType ?? ''
    const structural =
      transformed || (type !== '' && type !== 'insertText' && type !== 'insertCompositionText')
    commit(structural)
    refreshSlash()
  }

  const handleBeforeInput = (event: React.FormEvent<HTMLDivElement>): void => {
    const root = rootRef.current
    const native = event.nativeEvent as InputEvent
    if (!root || native.inputType !== 'insertText' || native.data === null) return
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
    const range = sel.getRangeAt(0)
    const startLine = lineFromNode(range.startContainer)
    const endLine = lineFromNode(range.endContainer)
    if (!startLine || !endLine || startLine === endLine) return
    if (!deleteMultiLineSelection()) return
    event.preventDefault()
    insertTextAtCaret(native.data)
    commit(true)
    refreshSlash()
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    const selected = window.getSelection()
    if (selected && !selected.isCollapsed && selected.rangeCount > 0) {
      const range = selected.getRangeAt(0)
      const startLine = lineFromNode(range.startContainer)
      const endLine = lineFromNode(range.endContainer)
      if (startLine && endLine && startLine !== endLine) {
        if (!deleteMultiLineSelection()) range.deleteContents()
      } else {
        range.deleteContents()
      }
    }
    const line = currentLine()
    if (!line) return
    if (lineKindOf(line) === 'code') {
      insertTextAtCaret(text)
      commit(true)
      return
    }
    const parts = text.replace(/\r\n?/g, '\n').split('\n')
    insertTextAtCaret(parts[0] ?? '')
    let anchor = line
    for (let i = 1; i < parts.length; i++) {
      const next = makeLine('paragraph')
      if (parts[i]) next.textContent = parts[i]
      anchor.after(next)
      anchor = next
    }
    placeCaret(anchor, 'end')
    commit(true)
    refreshSlash()
  }

  const editAtomic = (target: Element): boolean => {
    const math = target.closest<HTMLElement>('[data-tex]')
    if (math) {
      const tex = math.dataset.tex ?? ''
      const display = math.dataset.display === 'true'
      const token = display ? `$$${tex}$$` : `$${tex}$`
      const line = lineFromNode(math)
      if (line && lineKindOf(line) === 'math') {
        setLineKind(line, 'paragraph')
        line.textContent = token
        placeCaret(line, 'end')
      } else {
        const node = document.createTextNode(token)
        math.replaceWith(node)
        const sel = window.getSelection()
        const range = document.createRange()
        range.setStartAfter(node)
        range.collapse(true)
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
      commit(true)
      return true
    }

    const image = target.closest<HTMLElement>('[data-img-src]')
    if (image) {
      const src = image.dataset.imgSrc ?? ''
      const alt = image.dataset.imgAlt ?? ''
      const node = document.createTextNode(`![${alt}](${src})`)
      image.replaceWith(node)
      const sel = window.getSelection()
      const range = document.createRange()
      range.setStartAfter(node)
      range.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(range)
      commit(true)
      return true
    }

    const anchor = target.closest<HTMLAnchorElement>('a[data-href]')
    if (anchor) {
      const href = anchor.dataset.href ?? ''
      const text = anchor.textContent ?? ''
      const node = document.createTextNode(`[${text}](${href})`)
      anchor.replaceWith(node)
      const sel = window.getSelection()
      const range = document.createRange()
      range.setStartAfter(node)
      range.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(range)
      commit(true)
      return true
    }

    const wiki = target.closest<HTMLElement>('[data-wiki-target]')
    if (wiki) {
      const name = wiki.dataset.wikiTarget ?? ''
      if (!name) return true
      const state = useAppStore.getState()
      const live = state.notes.filter((note) => !note.deletedAt)
      const id = resolveWikiTarget(name, live)
      state.openNote(id ?? state.createNote(name))
      return true
    }

    const rule = target.closest<HTMLElement>('.nl--rule')
    if (rule) {
      setLineKind(rule, 'paragraph')
      rule.textContent = '---'
      placeCaret(rule, 'end')
      commit(true)
      return true
    }

    return false
  }

  return (
    <>
      <div
        ref={rootRef}
        className="blocks note-editor"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-multiline="true"
        aria-label="Note editor"
        data-placeholder={placeholder}
        onInput={handleInput}
        onBeforeInput={handleBeforeInput}
        onKeyDown={handleKeyDown}
        onKeyUp={refreshSlash}
        onMouseUp={refreshSlash}
        onClick={(event) => {
          const target = event.target
          if (target instanceof HTMLInputElement && target.type === 'checkbox') {
            window.setTimeout(() => commit(true), 0)
            return
          }
          if (target instanceof HTMLElement) {
            const anchor = target.closest('a')
            if (anchor && (event.metaKey || event.ctrlKey)) {
              const href = (anchor as HTMLElement).dataset.href ?? ''
              if (href) {
                event.preventDefault()
                window.open(href, '_blank', 'noopener')
                return
              }
            }
          }
          if (target === event.currentTarget) {
            const lines = getLines(event.currentTarget)
            const last = lines.at(-1)
            if (!last || lineTextOf(last).trim()) {
              const next = last ? createParagraphAfter(last) : makeLine('paragraph')
              if (!last) event.currentTarget.appendChild(next)
              commit(true)
            } else {
              placeCaret(last, 'end')
            }
          }
        }}
        onDoubleClick={(event) => {
          const target = event.target
          if (target instanceof Element && editAtomic(target)) {
            event.preventDefault()
          }
        }}
        onPaste={handlePaste}
        onBlur={() => {
          commit(false)
          setSlash(null)
        }}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
          commit(false)
          refreshSlash()
        }}
      />
      {slash && (
        <SlashMenu
          token={slash.token}
          selected={slashSel}
          fixedAt={{ x: slash.x, y: slash.y }}
          onHover={setSlashSel}
          onPick={(cmd) => {
            const line = currentLine()
            if (line) {
              clearSlashToken(line)
              applyCommand(cmd, line)
            }
            commit(true)
          }}
        />
      )}
    </>
  )
}

export default NoteEditor

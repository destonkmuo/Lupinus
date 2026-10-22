import { useLayoutEffect, useRef, useState } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import {
  BULLET,
  FENCE,
  HEADING,
  ORDERED,
  QUOTE,
  RULE,
  TASK,
  compactBlockContent,
  compactBlockLine,
  scanBlockMarkers
} from '../markdown'
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
import { beginSortableDrag, useSortableMakeSpace } from '../sortable'

export type { ChildKind } from '../slash'

/** Native DnD payload marking a drag as a block reorder (not a picture). */
const BLOCK_MIME = 'application/x-seemo-note-block'

type LineKind =
  'paragraph' | 'heading' | 'quote' | 'bullet' | 'ordered' | 'task' | 'rule' | 'code' | 'math'

interface LineSpec {
  kind: LineKind
  text: string
  level?: number
  checked?: boolean
  lang?: string
  /** Explicit block group (`{ … }`) this line belongs to. */
  block?: string
}

/** Unique id for a block created while editing. */
let blockGroupSeq = 0
function nextBlockId(): string {
  blockGroupSeq += 1
  return `blk-${Date.now().toString(36)}-${blockGroupSeq}`
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
  const { opens, closes } = scanBlockMarkers(lines)
  const out: LineSpec[] = []
  let block: string | undefined
  let blockSeq = 0
  let i = 0

  while (i < lines.length) {
    // Explicit block delimiters (`{` … `}`) are structure, not content.
    if (opens.has(i)) {
      block = `doc-${++blockSeq}`
      i += 1
      continue
    }
    if (closes.has(i)) {
      block = undefined
      i += 1
      continue
    }

    const raw = lines[i]
    const trimmed = raw.trim()

    // A compact one-line block: `{ - [ ] task }`.
    if (block === undefined) {
      const compact = compactBlockContent(raw)
      if (compact !== null) {
        const id = `doc-${++blockSeq}`
        const specs = parseLines(compact)
        out.push(...specs.map((spec) => ({ ...spec, block: id })))
        i += 1
        continue
      }
    }

    if (FENCE.test(raw)) {
      const lang = trimmed.slice(3).trim()
      const body: string[] = []
      i += 1
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      out.push({ kind: 'code', text: body.join('\n'), lang, block })
      continue
    }

    if (trimmed.startsWith('$$')) {
      if (trimmed.length > 4 && trimmed.endsWith('$$')) {
        out.push({ kind: 'math', text: trimmed.slice(2, -2).trim(), block })
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
        out.push({ kind: 'math', text: body.join('\n').trim(), block })
        continue
      }
    }

    const heading = HEADING.exec(raw)
    if (heading) {
      out.push({ kind: 'heading', level: heading[1].length, text: heading[2], block })
      i += 1
      continue
    }

    if (RULE.test(raw)) {
      out.push({ kind: 'rule', text: '', block })
      i += 1
      continue
    }

    const task = TASK.exec(raw)
    if (task) {
      out.push({
        kind: 'task',
        text: task[2],
        checked: task[1].toLowerCase() === 'x',
        block
      })
      i += 1
      continue
    }

    const bullet = BULLET.exec(raw)
    if (bullet) {
      out.push({ kind: 'bullet', text: bullet[1], block })
      i += 1
      continue
    }

    const ordered = ORDERED.exec(raw)
    if (ordered) {
      out.push({ kind: 'ordered', text: ordered[1], block })
      i += 1
      continue
    }

    const quote = QUOTE.exec(raw)
    if (quote) {
      out.push({ kind: 'quote', text: quote[1], block })
      i += 1
      continue
    }

    out.push({ kind: 'paragraph', text: raw, block })
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
  const block = spec.block ? ` data-block="${escapeAttr(spec.block)}"` : ''
  const base = `class="nl nl--${spec.kind}" data-line="${index}" data-kind="${spec.kind}"${block}`
  const empty = spec.kind === 'paragraph' && spec.text.trim() === ''
  const placeholder =
    index === 0 && options.placeholder && empty
      ? ` data-placeholder="${escapeAttr(options.placeholder)}" data-empty="true"`
      : ''

  switch (spec.kind) {
    case 'heading': {
      const level = Math.max(1, Math.min(6, spec.level ?? 1))
      return `<div class="nl nl--heading nl--h${level}" data-line="${index}" data-kind="heading" data-level="${level}"${block}>${inlineHtml(
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

function makeLine(kind: LineKind, level = 1, block?: string): HTMLElement {
  const el = document.createElement('div')
  setLineKind(el, kind, level)
  if (block) el.dataset.block = block
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
  decorateBlocks(root)
}

/** Grip glyph injected into the first row of every explicit block. */
const GRIP_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/>' +
  '<circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/>' +
  '<circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>'

/** A row that renders something, even when it carries no plain text. */
function lineHasContent(line: HTMLElement): boolean {
  const kind = lineKindOf(line)
  if (kind === 'rule' || kind === 'math' || kind === 'code') return true
  if (line.querySelector('img')) return true
  return lineTextOf(line).trim() !== ''
}

/** Empty blocks stay inert: no grip, no hover box, nothing to select. */
function blockHasContent(lines: HTMLElement[], start: number, end: number): boolean {
  for (let row = start; row <= end; row += 1) {
    if (lineHasContent(lines[row])) return true
  }
  return false
}

/** Stretch the editor's single selection box over the block's full run. */
function positionBlockHighlight(root: HTMLElement, id: string): void {
  const rows = getLines(root).filter((line) => line.dataset.block === id)
  if (!rows.length) return
  const first = rows[0]
  const last = rows[rows.length - 1]
  const rootRect = root.getBoundingClientRect()
  const firstRect = first.getBoundingClientRect()
  const lastRect = last.getBoundingClientRect()
  root.style.setProperty('--block-highlight-left', `${firstRect.left - rootRect.left}px`)
  root.style.setProperty('--block-highlight-top', `${firstRect.top - rootRect.top}px`)
  root.style.setProperty('--block-highlight-width', `${firstRect.width}px`)
  root.style.setProperty('--block-highlight-height', `${lastRect.bottom - firstRect.top}px`)
}

function clearBlockHighlight(root: HTMLElement): void {
  root.style.removeProperty('--block-highlight-left')
  root.style.removeProperty('--block-highlight-top')
  root.style.removeProperty('--block-highlight-width')
  root.style.removeProperty('--block-highlight-height')
}

/**
 * Paint explicit block runs: first/last markers, a drag handle on the first
 * row, and the single hover box. Blocks are contiguous rows sharing
 * `data-block`.
 */
function decorateBlocks(root: HTMLElement): void {
  const lines = getLines(root)
  lines.forEach((line, index) => {
    line.classList.remove('nl--block-first', 'nl--block-last', 'ne-block-hover')
    line.querySelector(':scope > .ne-block__grip')?.remove()
    line.dataset.sortableItem = ''
    line.dataset.sortableId = line.dataset.block ?? `line:${line.dataset.line ?? index}`
  })
  const hoverId = root.dataset.hoverBlock
  let hoverPainted = false
  let index = 0
  while (index < lines.length) {
    const id = lines[index].dataset.block
    if (!id) {
      index += 1
      continue
    }
    let end = index
    while (end + 1 < lines.length && lines[end + 1].dataset.block === id) end += 1
    const first = lines[index]
    const last = lines[end]
    const hasContent = blockHasContent(lines, index, end)
    first.classList.add('nl--block-first')
    if (hasContent && hoverId === id) {
      hoverPainted = true
      for (let row = index; row <= end; row += 1) lines[row].classList.add('ne-block-hover')
      positionBlockHighlight(root, id)
    }
    last.classList.add('nl--block-last')
    // An empty first row has no editable text to anchor a caret. Injecting a
    // grip there makes the browser jump to the previous row when the user
    // starts typing, so wait until the row has content.
    if (
      !hasContent ||
      (lineTextOf(first).trim() === '' && !isAtomic(first) && !first.querySelector(':scope > pre'))
    ) {
      index = end + 1
      continue
    }
    const grip = document.createElement('span')
    grip.className = 'ne-block__grip'
    grip.setAttribute('contenteditable', 'false')
    grip.setAttribute('draggable', 'true')
    grip.setAttribute('role', 'button')
    grip.setAttribute('tabindex', '-1')
    grip.setAttribute('title', 'Drag to move block · Alt+↑/↓')
    grip.setAttribute('aria-label', 'Move block')
    grip.innerHTML = GRIP_SVG
    first.insertBefore(grip, first.firstChild)
    index = end + 1
  }
  if (hoverId && !hoverPainted) {
    delete root.dataset.hoverBlock
    clearBlockHighlight(root)
  }
}

/** Markdown for one line, given the text to use (full line or a copy slice). */
function serializeLineText(line: HTMLElement, text: string): string {
  switch (lineKindOf(line)) {
    case 'heading': {
      const level = Math.max(1, Math.min(6, Number(line.dataset.level) || 1))
      return `${'#'.repeat(level)} ${text.replace(/^\s+/, '')}`
    }
    case 'quote':
      return `> ${text.replace(/^\s+/, '')}`
    case 'bullet':
      return `- ${text.replace(/^\s+/, '')}`
    case 'ordered':
      return `${line.dataset.number ?? '1'}. ${text.replace(/^\s+/, '')}`
    case 'task': {
      const checked = line.querySelector<HTMLInputElement>(
        ':scope > input[type="checkbox"]'
      )?.checked
      return `- [${checked ? 'x' : ' '}] ${text.replace(/^\s+/, '')}`
    }
    default:
      return text.replace(/\n+$/, '')
  }
}

function serializeLine(line: HTMLElement): string {
  const kind = lineKindOf(line)
  if (kind === 'rule') return '---'
  if (kind === 'math') {
    const tex = line.querySelector<HTMLElement>('[data-tex]')?.dataset.tex ?? ''
    return `$$${tex}$$`
  }
  if (kind === 'code') {
    const lang = line.dataset.lang ?? ''
    const body = line.querySelector('pre')?.textContent ?? ''
    return `\`\`\`${lang}\n${body}\n\`\`\``
  }
  return serializeLineText(line, lineTextOf(line))
}

/**
 * Markdown for the current DOM selection, so copy carries block markers with
 * it (`# Heading`, `- [ ] task`, fences, inline emphasis). Returns null when
 * there is nothing structural to customize (the browser's copy is used).
 */
function copySelectionMarkdown(root: HTMLElement, range: Range): string | null {
  const startLine = lineFromNode(range.startContainer)
  const endLine = lineFromNode(range.endContainer)
  if (!startLine || !endLine || !root.contains(startLine) || !root.contains(endLine)) return null
  const all = getLines(root)
  const a = all.indexOf(startLine)
  const b = all.indexOf(endLine)
  if (a < 0 || b < 0) return null
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)

  const sliceFor = (line: HTMLElement, first: boolean, last: boolean): string => {
    const kind = lineKindOf(line)
    if (kind === 'rule') return ''
    if (kind === 'math') return lineTextOf(line)
    const host = textHost(line)
    if (!first && !last) return lineTextOf(line)
    const pre = document.createRange()
    pre.selectNodeContents(host)
    if (first && host.contains(range.startContainer)) {
      pre.setStart(range.startContainer, range.startOffset)
    }
    if (last && host.contains(range.endContainer)) {
      pre.setEnd(range.endContainer, range.endOffset)
    }
    const fragment = pre.cloneContents()
    return kind === 'code' ? (fragment.textContent ?? '') : inlineFromDom(fragment)
  }

  const out: string[] = []
  for (let i = lo; i <= hi; i++) {
    const line = all[i]
    const kind = lineKindOf(line)
    if (kind === 'code') {
      // Adjacent code rows paste as one fenced block, matching the saved form.
      const lang = line.dataset.lang ?? ''
      const body: string[] = []
      let j = i
      while (j <= hi && lineKindOf(all[j]) === 'code') {
        body.push(sliceFor(all[j], j === lo, j === hi))
        j += 1
      }
      out.push(`\`\`\`${lang}\n${body.join('\n')}\n\`\`\``)
      i = j - 1
      continue
    }
    if (kind === 'rule' || kind === 'math') {
      out.push(serializeLine(line))
      continue
    }
    const text = sliceFor(line, i === lo, i === hi)
    // A structural marker with no selected text is noise (e.g. selecting from
    // the end of the previous line); plain blank rows are kept as spacing.
    if (!text && kind !== 'paragraph') continue
    out.push(serializeLineText(line, text))
  }
  return out.join('\n')
}

interface SerializedLine {
  markdown: string
  block?: string
}

function serializeEditor(root: HTMLElement): string {
  const lines = getLines(root)
  const entries: SerializedLine[] = []
  let i = 0
  while (i < lines.length) {
    const block = lines[i].dataset.block
    if (lineKindOf(lines[i]) !== 'code') {
      entries.push({ markdown: serializeLine(lines[i]), block })
      i += 1
      continue
    }
    // Adjacent code lines form one fenced block in the saved markdown.
    const lang = lines[i].dataset.lang ?? ''
    const body: string[] = []
    while (
      i < lines.length &&
      lineKindOf(lines[i]) === 'code' &&
      (lines[i].dataset.lang ?? '') === lang &&
      lines[i].dataset.block === block
    ) {
      body.push(lineTextOf(lines[i]))
      i += 1
    }
    entries.push({ markdown: `\`\`\`${lang}\n${body.join('\n')}\n\`\`\``, block })
  }

  // Wrap each contiguous explicit block in braces. Single structural rows use
  // the compact form (`{ - [ ] task }`); everything else stays multi-line.
  const out: string[] = []
  let runBlock: string | undefined
  let run: string[] = []
  const flush = (): void => {
    if (runBlock === undefined) {
      out.push(...run)
    } else {
      const compact = run.length === 1 ? compactBlockLine(run[0]) : null
      if (compact !== null) out.push(compact)
      else out.push('{', ...run, '}')
    }
    run = []
    runBlock = undefined
  }
  for (const entry of entries) {
    if (entry.block !== runBlock) {
      flush()
      runBlock = entry.block
    }
    run.push(entry.markdown)
  }
  flush()
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
      const extra = makeLine('paragraph', 1, line.dataset.block)
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
  // Rows being dragged by their block grip, plus the caret to restore.
  const dragBlockRef = useRef<{
    id: string
    lines: HTMLElement[]
    caret: { line: HTMLElement; offset: number } | null
  } | null>(null)
  const gripPressedRef = useRef<HTMLElement | null>(null)
  const [blockDrag, setBlockDrag] = useState<{
    id: string
    hint: { id: string; before: boolean } | null
  } | null>(null)

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
        const next = makeLine('paragraph', 1, line.dataset.block)
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
        const next = makeLine('paragraph', 1, line.dataset.block)
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
        const next = makeLine('paragraph', 1, line.dataset.block)
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
    const next = makeLine('paragraph', 1, line.dataset.block)
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
    const next = makeLine(nextKind, 1, line.dataset.block)
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

  /** Delete a live selection before a structural Enter, returning its caret row. */
  const deleteSelectionForSplit = (line: HTMLElement | null): HTMLElement | null => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return line
    const range = sel.getRangeAt(0)
    const startLine = lineFromNode(range.startContainer)
    const endLine = lineFromNode(range.endContainer)
    if (startLine && endLine && startLine !== endLine) {
      if (!deleteMultiLineSelection()) range.deleteContents()
    } else {
      range.deleteContents()
    }
    return currentLine() ?? line
  }

  /** Contiguous ungrouped rows around `line`; blank rows and blocks break it. */
  const looseRun = (line: HTMLElement): HTMLElement[] => {
    const all = getLines(rootRef.current as HTMLElement)
    const at = all.indexOf(line)
    if (at < 0) return [line]
    let start = at
    let end = at
    while (start > 0) {
      const prev = all[start - 1]
      if (prev.dataset.block || lineTextOf(prev).trim() === '') break
      start -= 1
    }
    while (end + 1 < all.length) {
      const next = all[end + 1]
      if (next.dataset.block || lineTextOf(next).trim() === '') break
      end += 1
    }
    return all.slice(start, end + 1)
  }

  /**
   * Shift+Enter: split the current block (or loose run) into two explicit
   * blocks at the caret, so each block stays a container of several lines.
   */
  const splitBlockAtCaret = (line: HTMLElement | null): void => {
    const root = rootRef.current
    if (!root) return
    if (!line) {
      const last = getLines(root).at(-1)
      const next = makeLine('paragraph', 1, nextBlockId())
      if (last) last.after(next)
      else root.appendChild(next)
      placeCaret(next, 'start')
      commit(true)
      return
    }

    const kind = lineKindOf(line)
    const existing = line.dataset.block
    const group = existing
      ? getLines(root).filter((el) => el.dataset.block === existing)
      : looseRun(line)
    const blockId = existing ?? nextBlockId()
    for (const el of group) el.dataset.block = blockId

    const host = textHost(line)
    let next: HTMLElement
    if (isAtomic(line) || kind === 'code') {
      next = makeLine('paragraph', 1, nextBlockId())
      line.after(next)
    } else {
      const fragment = document.createDocumentFragment()
      const range = selectionInHost(host)
      if (range) {
        const post = document.createRange()
        post.selectNodeContents(host)
        post.setStart(range.startContainer, range.startOffset)
        fragment.appendChild(post.extractContents())
        // A task row's checkbox is structural, not text; never duplicate it.
        fragment.querySelectorAll('input[type="checkbox"]').forEach((input) => input.remove())
      }
      const nextKind: LineKind = kind === 'heading' ? 'paragraph' : kind
      next = makeLine(nextKind, 1, nextBlockId())
      next.appendChild(fragment)
      line.after(next)
    }

    const newId = next.dataset.block as string
    const at = group.indexOf(line)
    for (const el of group.slice(at + 1)) el.dataset.block = newId
    // Commit first: decorating the new block injects its drag grip, which
    // would invalidate a caret placed before it. Put the caret in the new
    // block afterwards so Shift+Enter visibly moves editing out of the old one.
    commit(true)
    placeCaret(next, 'start')
  }

  /** Move block rows as one unit before `anchor` (null appends). */
  const moveRows = (rows: HTMLElement[], anchor: Node | null): void => {
    const root = rootRef.current
    if (!root) return
    const ref = anchor && root.contains(anchor) ? anchor : null
    for (const row of rows) root.insertBefore(row, ref)
  }

  /** Alt+Arrow: move the block under the caret over its neighbour. */
  const moveBlockByKeyboard = (line: HTMLElement, dir: 'up' | 'down'): void => {
    const root = rootRef.current
    const id = line.dataset.block
    if (!root || !id) return
    const all = getLines(root)
    const rows = all.filter((el) => el.dataset.block === id)
    if (rows.length === 0) return
    const first = all.indexOf(rows[0])
    const last = all.indexOf(rows[rows.length - 1])
    let anchor: Node | null = null
    if (dir === 'up') {
      if (first === 0) return
      const prev = all[first - 1]
      const prevId = prev.dataset.block
      if (prevId) {
        let at = first - 1
        while (at > 0 && all[at - 1].dataset.block === prevId) at -= 1
        anchor = all[at]
      } else {
        anchor = prev
      }
    } else {
      if (last === all.length - 1) return
      const next = all[last + 1]
      const nextId = next.dataset.block
      if (nextId) {
        let at = last + 1
        while (at < all.length - 1 && all[at + 1].dataset.block === nextId) at += 1
        anchor = all[at].nextSibling
      } else {
        anchor = next.nextSibling
      }
    }
    const caret = { line, offset: caretOffset(textHost(line)) }
    moveRows(rows, anchor)
    refreshLineMeta(root, placeholderRef.current)
    placeCaret(caret.line, caret.offset)
    commit(true)
  }

  const clearBlockDropMarks = (root: HTMLElement): void => {
    root.querySelectorAll<HTMLElement>('.nl--drop-before, .nl--drop-after').forEach((el) => {
      el.classList.remove('nl--drop-before', 'nl--drop-after')
    })
  }

  const endBlockDrag = (): void => {
    const root = rootRef.current
    if (root) {
      clearBlockDropMarks(root)
      root
        .querySelectorAll<HTMLElement>('.nl--dragging')
        .forEach((el) => el.classList.remove('nl--dragging'))
    }
    dragBlockRef.current = null
    gripPressedRef.current = null
    setBlockDrag(null)
  }

  const onBlockMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target
    gripPressedRef.current =
      target instanceof Element ? target.closest<HTMLElement>('.ne-block__grip') : null
  }

  const onBlockDragStart = (event: React.DragEvent<HTMLDivElement>): void => {
    const target = event.target
    const grip = target instanceof Element ? target.closest('.ne-block__grip') : null
    const root = rootRef.current
    const line = grip?.closest<HTMLElement>('.nl') ?? gripPressedRef.current
    gripPressedRef.current = null
    const id = line?.dataset.block
    if (!root || !line || !id) return
    const rows = getLines(root).filter((el) => el.dataset.block === id)
    if (rows.length === 0) return
    const active = currentLine()
    const caret =
      active && rows.includes(active)
        ? { line: active, offset: caretOffset(textHost(active)) }
        : null
    dragBlockRef.current = { id, lines: rows, caret }
    setBlockDrag({ id, hint: null })
    rows.forEach((el) => el.classList.add('nl--dragging'))
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(BLOCK_MIME, id)
    beginSortableDrag(event, rows[0], rows)
  }

  const onBlockDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    const drag = dragBlockRef.current
    const root = rootRef.current
    if (!drag || !root) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    clearBlockDropMarks(root)
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.nl') : null
    if (!target || !root.contains(target) || target.dataset.block === drag.id) {
      setBlockDrag((prev) => (prev && prev.hint ? { ...prev, hint: null } : prev))
      return
    }
    const rect = target.getBoundingClientRect()
    const before = event.clientY < rect.top + rect.height / 2
    target.classList.add(before ? 'nl--drop-before' : 'nl--drop-after')
    const targetId = target.dataset.sortableId
    if (targetId) {
      setBlockDrag((prev) =>
        prev
          ? prev.hint?.id === targetId && prev.hint.before === before
            ? prev
            : { ...prev, hint: { id: targetId, before } }
          : prev
      )
    }
  }

  const onBlockDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    const drag = dragBlockRef.current
    const root = rootRef.current
    if (!drag || !root) return
    event.preventDefault()
    event.stopPropagation()
    clearBlockDropMarks(root)
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.nl') : null
    if (!target || !root.contains(target) || target.dataset.block === drag.id) {
      endBlockDrag()
      return
    }
    const rect = target.getBoundingClientRect()
    const before = event.clientY < rect.top + rect.height / 2
    const targetId = target.dataset.block
    let edge = target
    if (targetId) {
      const rows = getLines(root).filter((el) => el.dataset.block === targetId)
      edge = before ? rows[0] : rows[rows.length - 1]
    }
    const anchor = before ? edge : edge.nextSibling
    if (anchor && drag.lines.includes(anchor as HTMLElement)) {
      endBlockDrag()
      return
    }
    const caret = drag.caret
    moveRows(drag.lines, anchor)
    refreshLineMeta(root, placeholderRef.current)
    if (caret) placeCaret(caret.line, caret.offset)
    endBlockDrag()
    commit(true)
  }

  const setHoveredBlock = (target: EventTarget | null): void => {
    const root = rootRef.current
    if (!root || !(target instanceof Element)) return
    const line = target.closest<HTMLElement>('.nl')
    if (!line || !root.contains(line)) return
    const id = line.dataset.block ?? ''
    if ((root.dataset.hoverBlock ?? '') === id) return
    const rows = id ? getLines(root).filter((el) => el.dataset.block === id) : []
    const hover = !!id && rows.some(lineHasContent)
    if (hover) root.dataset.hoverBlock = id
    else delete root.dataset.hoverBlock
    getLines(root).forEach((el) => {
      el.classList.toggle('ne-block-hover', hover && el.dataset.block === id)
    })
    if (hover) positionBlockHighlight(root, id)
    else clearBlockHighlight(root)
  }

  const clearHoveredBlock = (): void => {
    const root = rootRef.current
    if (!root || !root.dataset.hoverBlock) return
    delete root.dataset.hoverBlock
    clearBlockHighlight(root)
    root
      .querySelectorAll<HTMLElement>('.ne-block-hover')
      .forEach((el) => el.classList.remove('ne-block-hover'))
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

    // Shift+Enter creates a block boundary instead of another line: the caret
    // position splits the current block into two independently movable blocks.
    if (key === 'Enter' && event.shiftKey) {
      event.preventDefault()
      if (composingRef.current) return
      const target = deleteSelectionForSplit(line)
      splitBlockAtCaret(target)
      return
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
          const next = makeLine('code', 1, line.dataset.block)
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

    // Alt+Arrow reorders the explicit block under the caret.
    if (event.altKey && (key === 'ArrowUp' || key === 'ArrowDown') && line) {
      event.preventDefault()
      moveBlockByKeyboard(line, key === 'ArrowUp' ? 'up' : 'down')
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

  const handleCopy = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    const root = rootRef.current
    const sel = window.getSelection()
    if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (!root.contains(range.commonAncestorContainer)) return
    const markdown = copySelectionMarkdown(root, range)
    if (markdown === null) return
    event.clipboardData.setData('text/plain', markdown)
    event.preventDefault()
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
      const next = makeLine('paragraph', 1, line.dataset.block)
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

  useSortableMakeSpace({
    rootRef,
    activeId: blockDrag?.id ?? null,
    hints: blockDrag?.hint ? [blockDrag.hint] : []
  })

  return (
    <>
      <div
        ref={rootRef}
        className="blocks note-editor"
        data-sortable-list
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
        onMouseUp={() => {
          gripPressedRef.current = null
          refreshSlash()
        }}
        onMouseDown={onBlockMouseDown}
        onMouseOver={(event) => setHoveredBlock(event.target)}
        onMouseLeave={clearHoveredBlock}
        onDragStart={onBlockDragStart}
        onDragOver={onBlockDragOver}
        onDrop={onBlockDrop}
        onDragEnd={endBlockDrag}
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
        onCopy={handleCopy}
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

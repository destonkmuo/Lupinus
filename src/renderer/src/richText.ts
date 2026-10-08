/**
 * Rich-text bridge for the block editor.
 *
 * The note is still stored as plain markdown, but while a block is being
 * edited it is shown as *formatted* content (bold looks bold, lists look like
 * lists) instead of raw source. This module owns the two directions of that
 * translation:
 *
 *   markdown block  ──blockToEditableHtml──▶  editable HTML
 *   editable HTML   ──editableToMarkdown──▶   markdown block
 *
 * Only a safe, known subset is emitted (no raw user HTML), and widgets that
 * have no inline text form (math, images, wiki-links) become atomic,
 * non-editable chips that round-trip through data attributes.
 */

import katex from 'katex'
import { BULLET, FENCE, HEADING, ORDERED, QUOTE, RULE, TASK } from './markdown'

export type BlockKind =
  'code' | 'rule' | 'math' | 'heading' | 'quote' | 'task' | 'bullet' | 'ordered' | 'paragraph'

/** Block kinds the rich editor can show; everything else keeps raw editing. */
export function isRichKind(kind: BlockKind): boolean {
  return kind !== 'code' && kind !== 'rule' && kind !== 'math'
}

// A single pass over inline tokens. Code spans come first so their contents
// are never re-parsed for emphasis or math. Display math comes before inline
// math so `$$x$$` is never split into two `$` matches. Wiki-links come before
// md-links so that `[[a]]` is never misread. Inline `$…$` requires non-space
// edges so prices like `$5 and $6` stay text.
export const INLINE_RE =
  /(`[^`\n]+`)|(\$\$[^$\n]+\$\$)|(\$[^\s$](?:[^$\n]*[^\s$])?\$)|(\[\[[^\]\n]+\]\])|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(==[^=\n]+==)|(!?\[[^\]\n]*\]\([^)\n]*\))/g

/**
 * Smart arrows are intentionally NOT applied while editing: they are a
 * display-only transform in the renderer, and baking `→` into the source
 * would silently rewrite the user's `->`.
 */

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const escapeAttr = (text: string): string => escapeHtml(text).replace(/"/g, '&quot;')

/** Classify a block by its first line, mirroring the renderer's dispatch. */
export function blockKind(block: string): BlockKind {
  const first = block.split('\n')[0]
  if (FENCE.test(first)) return 'code'
  if (RULE.test(first)) return 'rule'
  const trimmed = block.trim()
  if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) return 'math'
  if (HEADING.test(first)) return 'heading'
  if (QUOTE.test(first)) return 'quote'
  if (TASK.test(first)) return 'task'
  if (BULLET.test(first)) return 'bullet'
  if (ORDERED.test(first)) return 'ordered'
  return 'paragraph'
}

function mathHtml(tex: string, display: boolean): string {
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

function tokenToHtml(token: string): string {
  if (token.startsWith('`')) return `<code>${escapeHtml(token.slice(1, -1))}</code>`
  if (token.startsWith('$$')) return mathHtml(token.slice(2, -2), true)
  if (token.startsWith('$')) return mathHtml(token.slice(1, -1), false)
  if (token.startsWith('[[')) {
    const inner = token.slice(2, -2)
    const pipe = inner.indexOf('|')
    const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim()
    const alias = (pipe < 0 ? inner : inner.slice(pipe + 1)).trim() || target
    return `<span class="md-wiki" data-wiki-target="${escapeAttr(
      target
    )}" data-wiki-alias="${escapeAttr(alias)}" contenteditable="false">${escapeHtml(alias)}</span>`
  }
  if (token.startsWith('**') || token.startsWith('__')) {
    return `<strong>${escapeHtml(token.slice(2, -2))}</strong>`
  }
  if (token.startsWith('~~')) return `<del>${escapeHtml(token.slice(2, -2))}</del>`
  if (token.startsWith('==')) return `<mark>${escapeHtml(token.slice(2, -2))}</mark>`
  if (token.startsWith('*') || token.startsWith('_')) {
    return `<em>${escapeHtml(token.slice(1, -1))}</em>`
  }
  if (token.startsWith('!')) {
    const link = /^!\[([^\]]*)\]\(([^)]*)\)$/.exec(token)
    if (!link) return escapeHtml(token)
    return `<span class="md-img" data-img-alt="${escapeAttr(link[1])}" data-img-src="${escapeAttr(
      link[2]
    )}" contenteditable="false">🖼 ${escapeHtml(link[1] || link[2])}</span>`
  }
  const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(token)
  if (link) {
    return `<a href="#" data-href="${escapeAttr(link[2])}">${escapeHtml(link[1] || link[2])}</a>`
  }
  return escapeHtml(token)
}

/** Inline markdown → editable inline HTML. */
export function inlineToHtml(text: string): string {
  let html = ''
  let last = 0
  let match: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > last) html += escapeHtml(text.slice(last, match.index))
    html += tokenToHtml(match[0])
    last = match.index + match[0].length
  }
  if (last < text.length) html += escapeHtml(text.slice(last))
  return html
}

/**
 * Live-format patterns: a complete inline token ending exactly at the caret.
 * Ordered most-specific first (bold before italic, display math before inline,
 * image before link) so a partial marker like `**a*` doesn't prematurely turn
 * into italics.
 */
const LIVE_INLINE: RegExp[] = [
  /`[^`\n]+`$/,
  /\$\$[^$\n]+\$\$$/,
  /(?<!\$)\$[^\s$](?:[^$\n]*[^\s$])?\$$/,
  /\[\[[^\]\n]+\]\]$/,
  /!\[[^\]\n]*\]\([^)\n]*\)$/,
  /(?<!!)\[[^\]\n]*\]\([^)\n]*\)$/,
  /(?<!\*)\*\*([^\n]+?)\*\*$/,
  /(?<!_)__([^\n]+?)__$/,
  /(?<!~)~~([^~\n]+?)~~$/,
  /(?<!=)==([^=\n]+?)==$/,
  /(?<!\*)\*(?!\*)([^*\n]+?)\*$/,
  /(?<!_)_(?!_)([^_\n]+?)_$/
]

/** The complete inline markdown token ending at the end of `text`, or null. */
export function inlineTokenAtEnd(text: string): string | null {
  for (const re of LIVE_INLINE) {
    const match = re.exec(text)
    if (match) return match[0]
  }
  return null
}

/** One line's inline DOM → inline markdown (no block structure). */
export function inlineFromDom(node: Node): string {
  let out = ''
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent ?? ''
      return
    }
    if (!(child instanceof HTMLElement)) return
    out += inlineElementToMarkdown(child)
  })
  return out
}

/**
 * One element's markdown, including its own markers around its contents.
 * (inlineFromDom only translates *children*, so callers handling elements
 * directly must go through here or formatting markers get silently dropped.)
 */
function inlineElementToMarkdown(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase()
  if (tag === 'br') return '\n'
  if (el.dataset.tex !== undefined) {
    const display = el.dataset.display === 'true'
    const fence = display ? '$$' : '$'
    return `${fence}${el.dataset.tex}${fence}`
  }
  if (el.dataset.imgSrc !== undefined) {
    return `![${el.dataset.imgAlt ?? ''}](${el.dataset.imgSrc})`
  }
  if (el.dataset.wikiTarget !== undefined) {
    const target = el.dataset.wikiTarget
    const alias = el.dataset.wikiAlias ?? ''
    return alias && alias !== target ? `[[${target}|${alias}]]` : `[[${target}]]`
  }
  const inner = inlineFromDom(el)
  if (tag === 'strong' || tag === 'b') return `**${inner}**`
  if (tag === 'em' || tag === 'i') return `*${inner}*`
  if (tag === 'del' || tag === 's' || tag === 'strike') return `~~${inner}~~`
  if (tag === 'mark') return `==${inner}==`
  if (tag === 'code') return `\`${inner}\``
  if (tag === 'a') return `[${inner}](${el.getAttribute('data-href') ?? ''})`
  return inner
}

/** Split a block element's contents into lines at `<br>` boundaries. */
function splitOnBr(el: Element): string[] {
  const lines: string[] = ['']
  el.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      lines[lines.length - 1] += child.textContent ?? ''
      return
    }
    if (!(child instanceof HTMLElement)) return
    if (child.tagName.toLowerCase() === 'br') {
      lines.push('')
      return
    }
    lines[lines.length - 1] += inlineElementToMarkdown(child)
  })
  return lines
}

/** Block-level tags start their own line(s); everything else is inline. */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'li',
  'section',
  'article',
  'header',
  'footer',
  'table',
  'hr'
])

/**
 * Every text line in a container, flattening block children. Adjacent inline
 * content (text runs, strong/em spans, chips, …) accumulates into one line;
 * only block boundaries and `<br>` split lines.
 */
function collectLines(el: Element): string[] {
  const out: string[] = []
  // Whether the last entry is still open to inline continuation.
  let open = false
  const pushInline = (text: string): void => {
    if (!text) return
    if (open && out.length > 0) out[out.length - 1] += text
    else out.push(text)
    open = true
  }
  const pushBlock = (lines: string[]): void => {
    for (const line of lines) out.push(line)
    open = false
  }
  el.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? ''
      if (text.trim()) pushInline(text)
      return
    }
    if (!(child instanceof HTMLElement)) return
    const tag = child.tagName.toLowerCase()
    if (tag === 'br') {
      out.push('')
      open = false
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      const lis: string[] = []
      Array.from(child.children).forEach((li) => {
        if (li.tagName.toLowerCase() === 'li') lis.push(inlineFromDom(li).replace(/\n+$/, ''))
      })
      pushBlock(lis)
      return
    }
    if (!BLOCK_TAGS.has(tag)) {
      pushInline(inlineElementToMarkdown(child))
      return
    }
    pushBlock(splitOnBr(child))
  })
  return out
}

/** List items with their checkbox state (tasks only). */
function listItems(el: Element): { text: string; checked: boolean | null }[] {
  const lis = Array.from(el.querySelectorAll('li'))
  if (lis.length === 0) {
    return collectLines(el)
      .filter((line) => line.trim())
      .map((text) => ({ text, checked: null }))
  }
  return lis.map((li) => {
    const input = li.querySelector(':scope > input[type="checkbox"]') as HTMLInputElement | null
    let text = ''
    li.childNodes.forEach((child) => {
      if (child instanceof HTMLInputElement) return
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent ?? ''
        return
      }
      if (child instanceof HTMLElement) text += inlineElementToMarkdown(child)
    })
    return { text, checked: input ? input.checked : null }
  })
}

/** Markdown block → editable HTML (block structure shown, markers hidden). */
export function blockToEditableHtml(block: string): string {
  const kind = blockKind(block)
  const lines = block.split('\n')
  switch (kind) {
    case 'heading': {
      const head = HEADING.exec(lines[0])
      const level = head ? head[1].length : 1
      return `<h${level}>${inlineToHtml(head ? head[2] : lines[0])}</h${level}>`
    }
    case 'quote': {
      const items = lines
        .map((line) => `<p>${inlineToHtml(QUOTE.exec(line)?.[1] ?? line)}</p>`)
        .join('')
      return `<blockquote>${items}</blockquote>`
    }
    case 'task': {
      const items = lines
        .map((line) => {
          const task = TASK.exec(line)
          const checked = task?.[1].toLowerCase() === 'x'
          return `<li class="markdown__task"><input type="checkbox" ${
            checked ? 'checked' : ''
          } contenteditable="false"><span>${inlineToHtml(task?.[2] ?? line)}</span></li>`
        })
        .join('')
      return `<ul class="markdown__tasks">${items}</ul>`
    }
    case 'bullet': {
      const items = lines
        .map((line) => `<li>${inlineToHtml(BULLET.exec(line)?.[1] ?? line)}</li>`)
        .join('')
      return `<ul>${items}</ul>`
    }
    case 'ordered': {
      const items = lines
        .map((line) => `<li>${inlineToHtml(ORDERED.exec(line)?.[1] ?? line)}</li>`)
        .join('')
      return `<ol>${items}</ol>`
    }
    default:
      // A wholly empty block stays empty so the editor can show its
      // placeholder via `:empty` (a lone `<p></p>` would defeat that).
      if (!block.trim()) return ''
      return lines.map((line) => `<p>${inlineToHtml(line)}</p>`).join('')
  }
}

export interface AutoFormatResult {
  /** The block rewritten in the detected format. */
  markdown: string
  kind: BlockKind
}

export interface MarkerMatch {
  kind: BlockKind
  /** The line normalized into that format. */
  markdown: string
  /** The text after the marker (empty when the marker was just typed). */
  content: string
}

/**
 * A marker typed at the very start of `line`, with the caret sitting right
 * after it (`caretInLine === line.length - content.length`) — the moment the
 * completing space lands. Returns null otherwise.
 */
export function markerAtLineStart(line: string, caretInLine: number): MarkerMatch | null {
  const result = (markdown: string, kind: BlockKind, content: string): MarkerMatch | null => {
    if (caretInLine !== line.length - content.length) return null
    return { kind, markdown, content }
  }

  // Task before bullet: `- [ ] ` and bare `[ ] ` / `[] ` both become tasks.
  const task = /^(?:[-*+]\s+)?\[([ xX]?)\]\s+(.*)$/.exec(line)
  if (task) {
    const checked = task[1].toLowerCase() === 'x' ? 'x' : ' '
    return result(`- [${checked}] ${task[2]}`, 'task', task[2])
  }

  const heading = /^(#{1,6})\s+(.*)$/.exec(line)
  if (heading) return result(`${heading[1]} ${heading[2]}`, 'heading', heading[2])

  const quote = /^>\s(.*)$/.exec(line)
  if (quote) return result(quote[1] ? `> ${quote[1]}` : '>', 'quote', quote[1])

  const bullet = /^[-*+]\s+(.*)$/.exec(line)
  if (bullet) return result(`- ${bullet[1]}`, 'bullet', bullet[1])

  const ordered = /^\d+\.\s+(.*)$/.exec(line)
  if (ordered) return result(`1. ${ordered[1]}`, 'ordered', ordered[1])

  return null
}

/**
 * Google-Docs-style input rule. The keystroke that completes a marker at the
 * start of the block's first line (`# `, `- `, `1. `, `> `, `[] `) — caret
 * sitting right after it — returns the block rewritten in that format, so the
 * editor can reseed to it immediately and keep the caret live in the formatted
 * block. Returns null when no marker was just typed, the caret is elsewhere on
 * the line, or the block is already that kind (its marker is structural, not
 * literal, so re-converting would reseed on every keystroke).
 */
export function autoFormatBlock(
  block: string,
  currentKind: BlockKind,
  caretOffset: number
): AutoFormatResult | null {
  const [first = '', ...rest] = block.split('\n')
  // Only a marker typed on the first line triggers here; later lines are
  // handled by splitting the block instead (see the editor's line splitter).
  if (caretOffset > first.length) return null
  const marker = markerAtLineStart(first, caretOffset)
  if (!marker || marker.kind === currentKind) return null
  return { markdown: [marker.markdown, ...rest].join('\n'), kind: marker.kind }
}

/** Editable HTML → markdown block. */
export function editableToMarkdown(el: HTMLElement, kind: BlockKind): string {
  switch (kind) {
    case 'heading': {
      const head = el.querySelector('h1, h2, h3, h4, h5, h6')
      if (!head) return collectLines(el).join('\n')
      const level = Number(head.tagName[1]) || 1
      return `${'#'.repeat(level)} ${inlineFromDom(head)}`
    }
    case 'quote': {
      const lines = collectLines(el)
      return (lines.length ? lines : ['']).map((line) => (line ? `> ${line}` : '>')).join('\n')
    }
    case 'task': {
      const items = listItems(el)
      return (items.length ? items : [{ text: '', checked: false }])
        .map((item) => `- [${item.checked ? 'x' : ' '}] ${item.text}`)
        .join('\n')
    }
    case 'bullet': {
      const items = listItems(el)
      return (items.length ? items : [{ text: '', checked: null }])
        .map((item) => `- ${item.text}`)
        .join('\n')
    }
    case 'ordered': {
      const items = listItems(el)
      return (items.length ? items : [{ text: '', checked: null }])
        .map((item, index) => `${index + 1}. ${item.text}`)
        .join('\n')
    }
    default:
      return collectLines(el).join('\n').replace(/\n+$/, '')
  }
}

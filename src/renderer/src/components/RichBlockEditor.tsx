import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  autoFormatBlock,
  blockKind,
  blockToEditableHtml,
  editableToMarkdown,
  inlineToHtml,
  inlineTokenAtEnd,
  markerAtLineStart,
  type BlockKind
} from '../richText'
import { RULE } from '../markdown'
import { normalizeUrl, trimUrl, urlAtEnd, urlOnly } from '../links'
import { filteredSlash, slashToken, type ChildKind, type SlashCommand } from '../slash'
import SlashMenu from './SlashMenu'
import { XIcon } from './icons'

/** Block-level tags that each hold their own logical markdown line. */
const LINE_BLOCK_TAGS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'li',
  'section',
  'article',
  'header',
  'footer',
  'table',
  'hr',
  'pre'
])

interface RichBlockEditorProps {
  /** Row index; used by the parent for focus lookups. */
  index: number
  /** Raw markdown for this block. */
  block: string
  placeholder?: string
  /** Commit the serialized markdown for this block. */
  onChange: (markdown: string) => void
  /** Replace this block's markdown and open a new block below. */
  onSplit: (beforeMarkdown: string, afterMarkdown: string) => void
  /**
   * Replace this block with up to three: the lines before the caret's line,
   * that line in its own format, and the lines after (empty parts dropped).
   */
  onSplitInto: (before: string, mid: string, after: string) => void
  /** Backspace at the very start: merge into the previous block. */
  onMergePrev: () => void
  /** Arrow at the block edge: move to the neighbouring block. */
  onNavigate: (dir: 'up' | 'down') => void
  /** Alt+Arrow: reorder this block. */
  onMoveBlock: (dir: 'up' | 'down') => void
  /** Escape: leave edit mode. */
  onEscape: () => void
  /** Slash child actions (new page / flashcards / …). */
  onCreateChild?: (kind: ChildKind) => string | null
  /** Shift+click: fall back to editing this block's raw markdown. */
  onRequestRaw?: () => void
  /** Where to drop the caret when the editor first mounts. */
  initialCaret?: 'start' | 'end' | number
}

/** Character offset of the caret within `el`'s text. */
function getCaretOffset(el: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return 0
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer)) return 0
  const pre = document.createRange()
  pre.selectNodeContents(el)
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString().length
}

/** Text before the caret within `el`. */
function textBeforeCaret(el: HTMLElement): string {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return ''
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer)) return ''
  const pre = document.createRange()
  pre.selectNodeContents(el)
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString()
}

/** Locate a character offset inside `el` as a DOM position. */
function locate(el: HTMLElement, offset: number): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
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

function setCaretOffset(el: HTMLElement, offset: number): void {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  const at = locate(el, offset)
  if (at) {
    range.setStart(at.node, at.offset)
    range.collapse(true)
  } else {
    range.selectNodeContents(el)
    range.collapse(false)
  }
  sel.removeAllRanges()
  sel.addRange(range)
}

function rangeAtOffsets(el: HTMLElement, start: number, end: number): Range {
  const range = document.createRange()
  const s = locate(el, start)
  const e = locate(el, end)
  if (s) range.setStart(s.node, s.offset)
  else {
    range.selectNodeContents(el)
    range.collapse(true)
  }
  if (e) range.setEnd(e.node, e.offset)
  else range.selectNodeContents(el)
  return range
}

function fragmentToMarkdown(fragment: DocumentFragment, kind: BlockKind): string {
  const div = document.createElement('div')
  div.appendChild(fragment)
  return editableToMarkdown(div, kind)
}

function closestWithin(node: Node | null, tag: string, root: HTMLElement): HTMLElement | null {
  let cur: Node | null = node
  while (cur && cur !== root) {
    if (cur instanceof HTMLElement && cur.tagName.toLowerCase() === tag) return cur
    cur = cur.parentNode
  }
  return null
}

function unwrap(el: HTMLElement): void {
  const parent = el.parentNode
  if (!parent) return
  while (el.firstChild) parent.insertBefore(el.firstChild, el)
  parent.removeChild(el)
  parent.normalize()
}

/**
 * Notion-style rich block editor: while a block is active it shows the
 * *formatted* result (bold, lists, quotes, checkboxes) rather than raw
 * markdown. Every edit is re-serialized to markdown immediately, so the note
 * (and the `.md` file) stays plain text under the WYSIWYG surface.
 *
 * The DOM is intentionally uncontrolled while editing — the browser owns the
 * caret and structure; React only seeds the initial HTML and reads it back on
 * input/blur.
 */
function RichBlockEditor({
  index,
  block,
  placeholder,
  onChange,
  onSplit,
  onSplitInto,
  onMergePrev,
  onNavigate,
  onMoveBlock,
  onEscape,
  onCreateChild,
  onRequestRaw,
  initialCaret = 'end'
}: RichBlockEditorProps): React.JSX.Element {
  const [seed, setSeed] = useState(() => ({
    html: blockToEditableHtml(block),
    kind: blockKind(block),
    key: 0
  }))
  const [slash, setSlash] = useState<string | null>(null)
  const [slashSel, setSlashSel] = useState(0)
  const [linkDialog, setLinkDialog] = useState<{
    text: string
    url: string
    editing: boolean
  } | null>(null)
  const linkRangeRef = useRef<Range | null>(null)
  const linkEditingRef = useRef<HTMLAnchorElement | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const caretRef = useRef<'start' | 'end' | number>(initialCaret)
  // The browser owns the DOM while typing: seeded HTML is applied only on
  // mount/reseed, never on unrelated re-renders, or React would stomp
  // in-flight edits back to the seed. (html always changes with key, so both
  // in deps is exact; the equality guard skips no-op writes.)
  const applySeed = useCallback(
    (node: HTMLDivElement | null) => {
      ref.current = node
      if (node && node.innerHTML !== seed.html) node.innerHTML = seed.html
    },
    [seed.key, seed.html]
  )

  const commit = useCallback(() => {
    const el = ref.current
    if (!el) return
    onChange(editableToMarkdown(el, seed.kind))
  }, [onChange, seed.kind])

  const refreshSlash = (): void => {
    const el = ref.current
    if (!el) return
    const token = slashToken(textBeforeCaret(el), getCaretOffset(el))
    if (token === null) {
      if (slash !== null) setSlash(null)
      return
    }
    if (slash === null || slash !== token) {
      setSlashSel(0)
      setSlash(token)
    }
  }

  // Focus and place the caret whenever the editor (re)seeds.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    if (typeof caretRef.current === 'number') {
      setCaretOffset(el, caretRef.current)
      caretRef.current = 'end'
      return
    }
    // List/quote reseeds have no text node to measure against when empty, so
    // target the item/paragraph directly; otherwise the caret would land
    // outside the structure and typing would escape it.
    const atStart = caretRef.current === 'start'
    const lis = el.querySelectorAll('li')
    const li = atStart ? lis[0] : lis[lis.length - 1]
    const quotes = el.querySelectorAll('blockquote p')
    const quote = atStart ? quotes[0] : quotes[quotes.length - 1]
    const host = li ?? quote ?? el.querySelector('blockquote')
    if (host) {
      const target = li ? (li.querySelector('span') ?? li) : host
      const range = document.createRange()
      range.selectNodeContents(target)
      range.collapse(atStart)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    } else {
      setCaretOffset(el, atStart ? 0 : (el.textContent ?? '').length)
    }
    caretRef.current = 'end'
  }, [seed.key])

  const insertTextAtCaret = useCallback((text: string) => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const node = document.createTextNode(text)
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }, [])

  const insertHtmlAtCaret = useCallback((html: string) => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const template = document.createElement('template')
    template.innerHTML = html
    const last = template.content.lastChild
    range.insertNode(template.content)
    if (last) {
      range.setStartAfter(last)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }, [])

  /** Delete the `/token` immediately before the caret. */
  const removeSlashToken = useCallback(() => {
    const el = ref.current
    if (!el) return
    const offset = getCaretOffset(el)
    const token = slashToken(textBeforeCaret(el), offset)
    if (token === null) return
    rangeAtOffsets(el, Math.max(0, offset - token.length - 1), offset).deleteContents()
  }, [])

  /** Swap this block's markdown wholesale and re-render its editable HTML. */
  const reseed = useCallback(
    (markdown: string) => {
      const kind = blockKind(markdown)
      onChange(markdown)
      caretRef.current = 'end'
      setSeed({ html: blockToEditableHtml(markdown), kind, key: Date.now() })
    },
    [onChange]
  )

  /**
   * Live inline formatting: when a delimiter just closed right before the
   * caret (`**bold**`, `*it*`, `` `code` ``, `~~x~~`, `==x==`, `$x$`,
   * `[[wiki]]`, `[t](u)`, `![a](u)`), swap that run for its formatted HTML in
   * place and keep typing after it.
   */
  const applyInlineFormat = useCallback((): boolean => {
    const el = ref.current
    if (!el) return false
    const caret = getCaretOffset(el)
    const token = inlineTokenAtEnd(textBeforeCaret(el))
    if (!token) return false
    const range = rangeAtOffsets(el, caret - token.length, caret)
    range.deleteContents()
    const template = document.createElement('template')
    template.innerHTML = inlineToHtml(token)
    const last = template.content.lastChild
    range.insertNode(template.content)
    const after = document.createRange()
    if (last) after.setStartAfter(last)
    else after.setStart(range.startContainer, range.startOffset)
    after.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(after)
    commit()
    return true
  }, [commit])

  /**
   * Turn a URL at the caret into a real link. While typing we wait for a
   * whitespace boundary so `x.co` isn't linked before `x.com` is finished;
   * on Enter/blur/paste the URL can end the text directly.
   */
  const applyAutoLink = useCallback((requireBoundary = false): boolean => {
    const el = ref.current
    if (!el) return false
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return false
    const anchorNode = sel.anchorNode
    const host =
      anchorNode instanceof HTMLElement ? anchorNode : (anchorNode?.parentElement ?? null)
    if (host?.closest('a')) return false
    const before = textBeforeCaret(el)
    if (requireBoundary && !/\s$/.test(before)) return false
    const hit = urlAtEnd(before)
    if (!hit) return false
    const url = trimUrl(hit.raw)
    const href = normalizeUrl(url)
    if (!href) return false
    const caret = getCaretOffset(el)
    const trailing = /\s$/.test(before) ? before.length - before.replace(/\s+$/, '').length : 0
    const start = caret - trailing - hit.raw.length
    const existing = rangeAtOffsets(el, start, start + hit.raw.length)
    // Never wrap text that already lives inside a link: doing so nests anchors
    // and serializes into `[[url](url)](url)` spaghetti.
    const startHost =
      existing.startContainer instanceof HTMLElement
        ? existing.startContainer
        : existing.startContainer.parentElement
    if (startHost?.closest('a')) return false
    const link = document.createElement('a')
    link.href = '#'
    link.dataset.href = href
    link.title = 'Double-click to edit · Ctrl/Cmd-click to open'
    link.textContent = url
    existing.deleteContents()
    existing.insertNode(link)
    // The DOM now differs in length only by any trimmed punctuation; put the
    // caret back where the user left it (after the trailing space, if any).
    const newCaret = caret - (hit.raw.length - url.length)
    const restored = rangeAtOffsets(el, newCaret, newCaret)
    sel.removeAllRanges()
    sel.addRange(restored)
    return true
  }, [])

  /**
   * A marker typed at the start of a line in an already-typed block ends the
   * block: the lines above stay put and the marked line starts its own block
   * of that kind (plus any lines after it). Returns false when not applicable.
   */
  const applyLineMarkerSplit = useCallback((): boolean => {
    if (seed.kind !== 'paragraph' && seed.kind !== 'quote') return false
    const el = ref.current
    if (!el) return false
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return false
    const range = sel.getRangeAt(0)
    if (!el.contains(range.startContainer)) return false
    // Group top-level nodes into logical lines the way the markdown is
    // serialized: block elements each start a line, runs of text/inline nodes
    // accumulate into one.
    const groups: Node[][] = []
    let current: Node[] = []
    const flush = (): void => {
      if (current.length > 0) {
        groups.push(current)
        current = []
      }
    }
    for (const child of Array.from(el.childNodes)) {
      if (child instanceof HTMLElement) {
        const tag = child.tagName.toLowerCase()
        if (tag === 'br' || LINE_BLOCK_TAGS.has(tag)) {
          flush()
          groups.push([child])
          continue
        }
      }
      if (
        child.nodeType === Node.TEXT_NODE &&
        !(child.textContent ?? '').trim() &&
        current.length === 0
      ) {
        continue
      }
      current.push(child)
    }
    flush()
    if (groups.length < 2) return false
    let idx = -1
    let caretInLine = 0
    for (let i = 0; i < groups.length; i++) {
      let offset = 0
      let hit = false
      for (const node of groups[i]) {
        if (node === range.startContainer) {
          offset += range.startOffset
          hit = true
          break
        }
        if (node.contains(range.startContainer)) {
          const pre = document.createRange()
          pre.selectNodeContents(node)
          pre.setEnd(range.startContainer, range.startOffset)
          offset += pre.toString().length
          hit = true
          break
        }
        offset += (node.textContent ?? '').length
      }
      if (hit) {
        idx = i
        caretInLine = offset
        break
      }
    }
    if (idx < 0) return false
    const lineText = groups[idx].map((node) => node.textContent ?? '').join('')
    const marker = markerAtLineStart(lineText, caretInLine)
    if (!marker || marker.kind === seed.kind) return false
    const mdLines = editableToMarkdown(el, seed.kind).split('\n')
    if (idx >= mdLines.length) return false
    const before = mdLines.slice(0, idx).join('\n')
    const after = mdLines.slice(idx + 1).join('\n')
    onSplitInto(before, marker.markdown, after)
    return true
  }, [onSplitInto, seed.kind])

  const closeLinkDialog = useCallback(() => {
    linkEditingRef.current = null
    linkRangeRef.current = null
    setLinkDialog(null)
  }, [])

  /** Open the add/edit-link dialog, remembering the caret for new links. */
  const openLinkDialog = useCallback((editing?: HTMLAnchorElement) => {
    setSlash(null)
    if (editing) {
      linkEditingRef.current = editing
      linkRangeRef.current = null
      setLinkDialog({
        text: editing.textContent ?? '',
        url: editing.dataset.href ?? '',
        editing: true
      })
      return
    }
    linkEditingRef.current = null
    const sel = window.getSelection()
    linkRangeRef.current =
      sel && sel.rangeCount > 0 && ref.current?.contains(sel.anchorNode)
        ? sel.getRangeAt(0).cloneRange()
        : null
    setLinkDialog({ text: '', url: '', editing: false })
  }, [])

  const applyLink = (): void => {
    if (!linkDialog) return
    let url = linkDialog.url.trim()
    if (!url) return
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('/') && !url.startsWith('#')) {
      url = `https://${url}`
    }
    if (/^javascript:/i.test(url)) return
    const text = (linkDialog.text.trim() || url)
      .replaceAll('[', ' ')
      .replaceAll(']', ' ')
      .replaceAll('\n', ' ')
      .trim()
    const safeUrl = url.replace(/[)\s]/g, '')
    const editing = linkEditingRef.current

    if (editing?.isConnected) {
      editing.textContent = text
      editing.dataset.href = safeUrl
    } else {
      const range = linkRangeRef.current
      if (range) {
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      } else {
        const el = ref.current
        if (el) {
          el.focus()
          setCaretOffset(el, el.textContent?.length ?? 0)
        }
      }
      insertHtmlAtCaret(inlineToHtml(`[${text}](${safeUrl})`))
    }
    commit()
    closeLinkDialog()
  }

  const applySlash = useCallback(
    (cmd: SlashCommand) => {
      const el = ref.current
      if (!el) return
      setSlash(null)
      if (cmd.childKind) {
        const link = onCreateChild?.(cmd.childKind) ?? null
        if (!link) return
        removeSlashToken()
        insertTextAtCaret(link)
        commit()
        return
      }
      removeSlashToken()
      if (cmd.id === 'link') {
        openLinkDialog()
        return
      }
      if (cmd.id === 'image') {
        insertHtmlAtCaret(inlineToHtml('![image](url)'))
        commit()
        return
      }
      if (cmd.id === 'math') {
        insertHtmlAtCaret(inlineToHtml('$x$'))
        commit()
        return
      }
      const lines = editableToMarkdown(el, seed.kind)
        .split('\n')
        .map((line) => line.replace(/^\s*(?:#{1,6}|[-*+]|\d+\.|>)\s+/, ''))
      const text = lines.join(' ').trim()
      let markdown: string
      switch (cmd.id) {
        case 'h1':
          markdown = `# ${text}`
          break
        case 'h2':
          markdown = `## ${text}`
          break
        case 'h3':
          markdown = `### ${text}`
          break
        case 'bullet':
          markdown = lines.map((line) => `- ${line}`).join('\n')
          break
        case 'numbered':
          markdown = lines.map((line, i) => `${i + 1}. ${line}`).join('\n')
          break
        case 'todo':
          markdown = lines.map((line) => `- [ ] ${line}`).join('\n')
          break
        case 'quote':
          markdown = lines.map((line) => `> ${line}`).join('\n')
          break
        case 'divider':
          markdown = '---'
          break
        case 'code':
          markdown = '```js\n\n```'
          break
        case 'mathblock':
          markdown = '$$\n\n$$'
          break
        default:
          markdown = text
      }
      reseed(markdown)
    },
    [
      commit,
      insertHtmlAtCaret,
      insertTextAtCaret,
      onCreateChild,
      openLinkDialog,
      removeSlashToken,
      reseed,
      seed.kind
    ]
  )

  const wrapSelection = useCallback(
    (tag: string) => {
      const el = ref.current
      if (!el) return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      if (range.collapsed) return
      const existing = closestWithin(range.commonAncestorContainer, tag, el)
      if (existing) {
        unwrap(existing)
        commit()
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
      commit()
    },
    [commit]
  )

  const splitBlock = useCallback(
    (nextKind: BlockKind) => {
      const el = ref.current
      const sel = window.getSelection()
      if (!el || !sel || sel.rangeCount === 0) return
      // Treat links as atomic when splitting: put the caret after the link so
      // the whole link stays in this block and the new block starts empty.
      const initial = sel.getRangeAt(0)
      const link =
        closestWithin(initial.startContainer, 'a', el) ??
        closestWithin(initial.endContainer, 'a', el)
      if (link) {
        const afterLink = document.createRange()
        afterLink.setStartAfter(link)
        afterLink.collapse(true)
        sel.removeAllRanges()
        sel.addRange(afterLink)
      }
      const range = sel.getRangeAt(0)
      const pre = document.createRange()
      pre.selectNodeContents(el)
      pre.setEnd(range.startContainer, range.startOffset)
      const post = document.createRange()
      post.selectNodeContents(el)
      post.setStart(range.endContainer, range.endOffset)
      const before = fragmentToMarkdown(pre.cloneContents(), seed.kind)
      const after = fragmentToMarkdown(post.cloneContents(), nextKind)
      onSplit(before, after)
    },
    [onSplit, seed.kind]
  )

  const currentLi = useCallback((): HTMLElement | null => {
    const el = ref.current
    const sel = window.getSelection()
    if (!el || !sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    let node: Node | null = range.startContainer
    while (node && node !== el) {
      if (node instanceof HTMLElement && node.tagName.toLowerCase() === 'li') return node
      node = node.parentNode
    }
    // An empty item can leave the caret at the list boundary (between <li>s)
    // rather than inside the <li>; map the caret offset back onto an item.
    const anchor =
      range.startContainer instanceof HTMLElement
        ? range.startContainer
        : range.startContainer.parentElement
    const list = anchor?.closest('ul, ol')
    if (list && el.contains(list)) {
      const items = Array.from(list.children).filter(
        (child): child is HTMLElement => child.tagName.toLowerCase() === 'li'
      )
      if (items.length > 0) {
        const index = Math.max(0, Math.min(range.startOffset, items.length - 1))
        return items[index]
      }
    }
    return null
  }, [])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const el = event.currentTarget

    // The `/` menu owns Enter/Tab/arrows/Esc while open.
    if (slash !== null) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlash(null)
        return
      }
      const items = filteredSlash(slash)
      if (items.length === 0) {
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
        applySlash(items[slashSel % items.length])
        return
      }
    }

    // Inline formatting shortcuts.
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const key = event.key.toLowerCase()
      const tag =
        key === 'b' && !event.shiftKey
          ? 'strong'
          : key === 'i' && !event.shiftKey
            ? 'em'
            : key === 'e' && !event.shiftKey
              ? 'code'
              : key === 'h' && event.shiftKey
                ? 'mark'
                : key === 'x' && event.shiftKey
                  ? 'del'
                  : null
      if (tag) {
        event.preventDefault()
        wrapSelection(tag)
        return
      }
    }

    const isList = seed.kind === 'bullet' || seed.kind === 'ordered' || seed.kind === 'task'

    if (event.key === 'Enter') applyAutoLink()

    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault()
      // Shift+Enter splits the block: headings and list items drop into a new
      // paragraph block instead of continuing their current kind.
      splitBlock(seed.kind === 'heading' || isList ? 'paragraph' : seed.kind)
      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      // Divider input rule: a line containing only `---` (or `***`/`___`) plus
      // Enter turns into a divider and opens a fresh paragraph below, the way
      // Google Docs inserts a horizontal line.
      if (seed.kind === 'paragraph' && RULE.test(editableToMarkdown(el, seed.kind).trim())) {
        event.preventDefault()
        onSplit('---', '')
        return
      }
      if (seed.kind === 'heading') {
        event.preventDefault()
        splitBlock('paragraph')
        return
      }
      if (isList) {
        const lis = Array.from(el.querySelectorAll('li'))
        const li = currentLi() ?? (lis.length === 1 ? lis[0] : null)
        if (!li) return
        event.preventDefault()
        if (!(li.textContent ?? '').trim()) {
          // Empty item: leave the list, leaving a plain line where the bullet
          // was. The last item turns the block into an empty paragraph in
          // place; earlier items open a fresh paragraph block below the list.
          li.remove()
          const remaining = el.querySelectorAll('li')
          if (remaining.length === 0) {
            reseed('')
          } else {
            onSplit(editableToMarkdown(el, seed.kind), '')
          }
          return
        }
        // Otherwise start the next item, splitting the current one at the
        // caret so mid-item Enter keeps the text order.
        const sel = window.getSelection()
        if (!sel || sel.rangeCount === 0) return
        const range = sel.getRangeAt(0)
        const host = seed.kind === 'task' ? (li.querySelector('span') ?? li) : li
        const post = document.createRange()
        post.selectNodeContents(host)
        if (host.contains(range.startContainer)) {
          post.setStart(range.startContainer, range.startOffset)
        } else {
          post.collapse(false)
        }
        const rest = post.extractContents()
        const newLi = document.createElement('li')
        if (seed.kind === 'task') {
          newLi.className = 'markdown__task'
          const checkbox = document.createElement('input')
          checkbox.type = 'checkbox'
          checkbox.setAttribute('contenteditable', 'false')
          newLi.appendChild(checkbox)
          const span = document.createElement('span')
          span.appendChild(rest)
          newLi.appendChild(span)
        } else {
          newLi.appendChild(rest)
        }
        li.after(newLi)
        const target = seed.kind === 'task' ? (newLi.querySelector('span') ?? newLi) : newLi
        const caret = document.createRange()
        caret.selectNodeContents(target)
        caret.collapse(true)
        sel.removeAllRanges()
        sel.addRange(caret)
        commit()
        return
      }
      return
    }

    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      if (event.shiftKey) {
        const offset = getCaretOffset(el)
        if (offset === 0) return
        const text = textBeforeCaret(el)
        const remove = text.endsWith('  ') ? 2 : text.endsWith(' ') ? 1 : 0
        if (remove === 0) return
        rangeAtOffsets(el, offset - remove, offset).deleteContents()
        commit()
        return
      }
      insertTextAtCaret('  ')
      commit()
      return
    }

    if (
      event.key === 'Backspace' &&
      !event.shiftKey &&
      getCaretOffset(el) === 0 &&
      !textBeforeCaret(el)
    ) {
      const li = currentLi()
      if (li && !(li.textContent ?? '').trim()) {
        event.preventDefault()
        li.remove()
        if (el.querySelectorAll('li').length === 0) onChange('')
        else onChange(editableToMarkdown(el, seed.kind))
        return
      }
      event.preventDefault()
      onMergePrev()
      return
    }

    if (!event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const offset = getCaretOffset(el)
      const total = (el.textContent ?? '').length
      if (event.key === 'ArrowUp' && offset === 0) {
        event.preventDefault()
        onNavigate('up')
        return
      }
      if (event.key === 'ArrowDown' && offset >= total) {
        event.preventDefault()
        onNavigate('down')
        return
      }
    }

    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      onMoveBlock(event.key === 'ArrowUp' ? 'up' : 'down')
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      commit()
      onEscape()
    }
  }

  const onInput = (): void => {
    const el = ref.current
    if (el) {
      // Google-Docs-style input rules: a marker typed at the start of the line
      // converts the block to that format immediately and keeps the caret live
      // in the formatted block, so typing continues in that format.
      const auto = autoFormatBlock(editableToMarkdown(el, seed.kind), seed.kind, getCaretOffset(el))
      if (auto) {
        setSlash(null)
        reseed(auto.markdown)
        return
      }
      // A marker on a later line ends the block and starts a new one.
      if (applyLineMarkerSplit()) return
      // Inline input rules: format `**bold**`, `*it*`, `code`, … the moment
      // the closing delimiter is typed.
      if (applyInlineFormat()) return
      // Bare domains become links once a word boundary is typed (`x.com `).
      if (applyAutoLink(true)) {
        commit()
        return
      }
    }
    commit()
    refreshSlash()
  }

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const text = event.clipboardData.getData('text/plain')
    const bare = urlOnly(text)
    const href = bare ? normalizeUrl(bare) : undefined
    if (bare && href) {
      insertHtmlAtCaret(inlineToHtml(`[${bare}](${href})`))
    } else {
      insertTextAtCaret(text)
    }
    commit()
  }

  return (
    <>
      <div
        key={seed.key}
        ref={applySeed}
        data-block={index}
        className={`block markdown rblock rblock--${seed.kind}`}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-multiline="true"
        aria-label="Edit block"
        data-placeholder={placeholder}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onBlur={() => {
          applyAutoLink()
          commit()
          setSlash(null)
        }}
        onPaste={onPaste}
        onClick={(event) => {
          const target = event.target
          // Shift+click: hand off to raw markdown editing for this block.
          if (event.shiftKey) {
            event.preventDefault()
            commit()
            onRequestRaw?.()
            return
          }
          // Links stay inert while editing: plain click places the caret,
          // double-click edits them, and Cmd/Ctrl-click opens them.
          const anchor = target instanceof HTMLElement ? target.closest('a') : null
          if (anchor) {
            event.preventDefault()
            const href = anchor.dataset.href ?? ''
            if ((event.metaKey || event.ctrlKey) && href) {
              window.open(href, '_blank', 'noopener')
            } else if (event.detail === 2) {
              commit()
              openLinkDialog(anchor)
            }
            return
          }
          // Toggling a task checkbox is a content change; commit it.
          if (target instanceof HTMLElement && target.matches('input[type="checkbox"]')) {
            window.setTimeout(commit, 0)
          }
        }}
      />
      {slash !== null && (
        <SlashMenu
          token={slash}
          selected={slashSel}
          onHover={setSlashSel}
          onPick={(cmd) => applySlash(cmd)}
        />
      )}
      {linkDialog &&
        createPortal(
          <div
            className="dlg-overlay"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeLinkDialog()
            }}
          >
            <form
              className="dlg link-dlg"
              onSubmit={(event) => {
                event.preventDefault()
                applyLink()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  closeLinkDialog()
                }
              }}
            >
              <div className="dlg__head">
                <h2 className="dlg__title">{linkDialog.editing ? 'Edit link' : 'Add link'}</h2>
                <button
                  type="button"
                  className="dlg__x"
                  aria-label="Close"
                  onClick={closeLinkDialog}
                >
                  <XIcon size={15} />
                </button>
              </div>
              <label className="dlg__field">
                <span className="dlg__label">Text</span>
                <input
                  className="dlg__input"
                  value={linkDialog.text}
                  placeholder="Link text"
                  autoFocus
                  onChange={(event) =>
                    setLinkDialog((dialog) =>
                      dialog ? { ...dialog, text: event.target.value } : dialog
                    )
                  }
                />
              </label>
              <label className="dlg__field">
                <span className="dlg__label">URL</span>
                <input
                  className="dlg__input"
                  value={linkDialog.url}
                  placeholder="https://example.com"
                  onChange={(event) =>
                    setLinkDialog((dialog) =>
                      dialog ? { ...dialog, url: event.target.value } : dialog
                    )
                  }
                />
              </label>
              <div className="dlg__actions">
                <span className="dlg__spacer" />
                <button type="button" className="btn btn--ghost" onClick={closeLinkDialog}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={!linkDialog.url.trim()}
                >
                  {linkDialog.editing ? 'Save' : 'Add link'}
                </button>
              </div>
            </form>
          </div>,
          document.body
        )}
    </>
  )
}

export default RichBlockEditor

import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { resolveImageSrc, type ImageControls, type ImageSide } from '../images'
import { BULLET, FENCE, HEADING, ORDERED, QUOTE, RULE, TASK, splitBlocks } from '../markdown'
import { normalizeUrl, splitLinks } from '../links'
import { resolveWikiTarget } from '../notes'
import { useAppStore } from '../store/appStore'
import CodeBlock from './CodeBlock'

/**
 * Minimal markdown renderer for notes.
 *
 * Supports: headings, bold/italic/strikethrough, inline code, fenced code,
 * links, images, unordered/ordered/task lists, blockquotes, horizontal
 * rules, and LaTeX math (`$…$` inline, `$$…$$` display). Output is React
 * elements (never raw HTML) except KaTeX spans, whose markup is generated
 * by the KaTeX library itself (user input is escaped, never passed through),
 * so note content still cannot inject markup.
 */

// A single pass over inline tokens. Code spans come first so their contents
// are never re-parsed for emphasis or math. Display math comes before inline
// math so `$$x$$` is never split into two `$` matches. Wiki-links come before
// md-links so that `[[a]]` is never misread (it can't match the md-link shape
// anyway, which requires `](`, but explicit ordering keeps it obvious).
// Inline `$…$` requires non-space edges so prices like `$5 and $6` stay text.
const INLINE_RE =
  /(`[^`\n]+`)|(\$\$[^$\n]+\$\$)|(\$[^\s$](?:[^$\n]*[^\s$])?\$)|(\[\[[^\]\n]+\]\])|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(==[^=\n]+==)|(!?\[[^\]\n]*\]\([^)\n]*\))/g

/**
 * Smart arrows: `->` renders as → and friends. Applied only to plain-text
 * runs (never code spans, math, or link targets), so pasted code stays intact.
 * Longest shapes first so `<-->` wins over `<-`.
 */
const SMART_ARROWS_RE = /<-->|<=>|<->|-->|==>|<--|<==|->|<-|=>|<=/g
const SMART_ARROWS: Record<string, string> = {
  '<-->': '⟷',
  '<=>': '⟺',
  '<->': '↔',
  '-->': '⟶',
  '==>': '⟹',
  '<--': '⟵',
  '<==': '⟸',
  '->': '→',
  '<-': '←',
  '=>': '⇒',
  '<=': '⇐'
}

function smartArrows(text: string): string {
  return text.replace(SMART_ARROWS_RE, (match) => SMART_ARROWS[match] ?? match)
}

const SAFE_URL = /^(https?:\/\/|mailto:|#|\/)/i

function safeUrl(url: string): string | undefined {
  const trimmed = url.trim()
  return SAFE_URL.test(trimmed) ? trimmed : undefined
}

/**
 * Image with a corner resize handle. Width lives locally while dragging and
 * commits on release (double-click resets to natural size). Pointer and
 * click events never leave the handle, so resizing inside a note block
 * doesn't flip the block into edit mode.
 */
export function ResizableImage({
  url,
  alt,
  width,
  onCommitWidth
}: {
  url: string
  alt: string
  width?: number
  onCommitWidth: (w: number | null) => void
}): React.JSX.Element {
  const [w, setW] = useState<number | null>(width ?? null)
  const liveRef = useRef<number | null>(width ?? null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  // Adopt committed widths from elsewhere; never fight an active drag.
  useEffect(() => {
    if (!dragRef.current) {
      liveRef.current = width ?? null
      setW(width ?? null)
    }
  }, [width])

  const onHandleDown = (event: React.PointerEvent<HTMLSpanElement>): void => {
    event.stopPropagation()
    event.preventDefault()
    const startW = wrapRef.current?.querySelector('img')?.getBoundingClientRect().width ?? 200
    dragRef.current = { startX: event.clientX, startW }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // As above: direct-dispatched moves still arrive without capture.
    }
  }

  const onHandleMove = (event: React.PointerEvent<HTMLSpanElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const max = wrapRef.current?.parentElement?.clientWidth || 1600
    const next = Math.min(
      Math.max(48, Math.round(drag.startW + (event.clientX - drag.startX))),
      max
    )
    liveRef.current = next
    setW(next)
  }

  const onHandleUp = (): void => {
    if (!dragRef.current) return
    dragRef.current = null
    onCommitWidth(liveRef.current)
  }

  return (
    <span ref={wrapRef} className="rimg" style={w ? { width: w } : undefined}>
      <img
        src={url}
        alt={alt}
        loading="lazy"
        draggable={false}
        style={w ? { width: '100%' } : undefined}
      />
      <span
        className="rimg__handle"
        title="Drag to resize · double-click for natural size"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.stopPropagation()
          liveRef.current = null
          setW(null)
          onCommitWidth(null)
        }}
      />
    </span>
  )
}

/**
 * Docked (unlocked) picture: lives in the text flow with the text wrapping
 * around it, so it can never overlap content. Dragging lifts a ghost; on
 * drop the note page re-docks the markdown at the target block. The corner
 * still resizes, and the toolbar switches sides or locks back inline.
 */
function DockedImage({
  url,
  alt,
  width,
  side,
  src,
  images
}: {
  url: string
  alt: string
  width?: number
  side: ImageSide
  src: string
  images?: ImageControls
}): React.JSX.Element {
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const movedRef = useRef(false)
  const suppressRef = useRef(false)

  const pickTarget = (
    clientX: number,
    clientY: number
  ): { blockIndex: number; above: boolean; side: ImageSide } | null => {
    const container = document.querySelector('.blocks')
    const doc = document.querySelector('.note__doc')
    if (!container || !doc) return null
    const crect = container.getBoundingClientRect()
    if (clientY < crect.top - 8 || clientY > crect.bottom + 8) return null
    let index = 0
    let above = true
    let best = Number.POSITIVE_INFINITY
    Array.from(container.children).forEach((kid, i) => {
      const rect = (kid as HTMLElement).getBoundingClientRect()
      if (rect.height <= 0) return
      const mid = rect.top + rect.height / 2
      const dist = Math.abs(clientY - mid)
      if (dist < best) {
        best = dist
        index = i
        above = clientY < mid
      }
    })
    const drect = doc.getBoundingClientRect()
    const rel = (clientX - drect.left) / Math.max(1, drect.width)
    const atSide: ImageSide = rel < 0.33 ? 'left' : rel > 0.67 ? 'right' : 'center'
    return { blockIndex: index, above, side: atSide }
  }

  const onDown = (event: React.PointerEvent<HTMLSpanElement>): void => {
    if ((event.target as HTMLElement).closest('button, input, textarea, .rimg__handle')) return
    startRef.current = { x: event.clientX, y: event.clientY }
    movedRef.current = false
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic or already-released pointers have nothing to capture;
      // moves dispatched straight at the wrapper still arrive.
    }
  }

  const onMove = (event: React.PointerEvent<HTMLSpanElement>): void => {
    const start = startRef.current
    if (!start) return
    if (!movedRef.current) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return
      movedRef.current = true
    }
    setGhost({ x: event.clientX, y: event.clientY })
  }

  const cancelDrag = (): void => {
    startRef.current = null
    movedRef.current = false
    setGhost(null)
  }

  const finishDrag = (event: React.PointerEvent<HTMLSpanElement>): void => {
    const wasMove = movedRef.current
    const target = wasMove ? pickTarget(event.clientX, event.clientY) : null
    cancelDrag()
    if (!wasMove) return
    // Swallow the click that follows a drag so the block doesn't flip open.
    suppressRef.current = true
    images?.onCommitMove(src, target)
  }

  return (
    <span
      className={`md-img md-img--${side}`}
      title="Drag to move · corner to resize"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={finishDrag}
      onPointerCancel={cancelDrag}
      onClick={(event) => {
        if (suppressRef.current) {
          event.stopPropagation()
          suppressRef.current = false
        }
      }}
    >
      <ResizableImage
        url={url}
        alt={alt}
        width={width}
        onCommitWidth={(w) => images?.onCommitWidth(src, w)}
      />
      {images && (
        <span className="md-img__tools">
          {(['left', 'center', 'right'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={side === option}
              className={`md-img__tool${side === option ? ' is-active' : ''}`}
              title={`Wrap ${option}`}
              onClick={(event) => {
                event.stopPropagation()
                images.onSetSide(src, option)
              }}
            >
              {option[0].toUpperCase()}
            </button>
          ))}
          <button
            type="button"
            className="md-img__tool"
            title="Lock back inline"
            onClick={(event) => {
              event.stopPropagation()
              images.onLock(src)
            }}
          >
            Lock
          </button>
        </span>
      )}
      {ghost && (
        <span className="md-ghost" style={{ left: ghost.x, top: ghost.y }} aria-hidden="true">
          <img
            src={url}
            alt=""
            draggable={false}
            style={width ? { width: Math.min(width, 280) } : undefined}
          />
        </span>
      )}
    </span>
  )
}

/** LaTeX math rendered by KaTeX. Falls back to a code span on failure. */
function MathTex({ tex, display }: { tex: string; display: boolean }): React.JSX.Element {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false })
    } catch {
      return null
    }
  }, [tex, display])
  if (html === null) return <code>{tex}</code>
  return (
    <span
      className={display ? 'math math--display' : 'math'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/** A `[[Note]]` / `[[Note|alias]]` link: opens the note, or creates it. */
function WikiLink({ target, alias }: { target: string; alias: string }): React.JSX.Element {
  const notes = useAppStore((state) => state.notes)
  const live = notes.filter((note) => !note.deletedAt)
  const resolved = resolveWikiTarget(target, live)
  return (
    <button
      type="button"
      className={`markdown__wiki${resolved ? '' : ' markdown__wiki--missing'}`}
      title={resolved ? `Open ${target}` : `Create ${target}`}
      onClick={() => {
        const { notes, openNote, createNote } = useAppStore.getState()
        const live = notes.filter((note) => !note.deletedAt)
        const id = resolveWikiTarget(target, live)
        openNote(id ?? createNote(target))
      }}
    >
      {alias}
    </button>
  )
}

function renderInline(text: string, prefix: string, images?: ImageControls): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let index = 0
  let autoKey = 0
  let match: RegExpExecArray | null

  // Plain runs may contain bare URLs (`x.com`); render those as links too.
  const pushText = (value: string): void => {
    for (const part of splitLinks(value)) {
      if (!part.value) continue
      const href = part.url ? normalizeUrl(part.value) : undefined
      if (part.url && href) {
        nodes.push(
          <a key={`${prefix}-auto-${autoKey++}`} href={href} target="_blank" rel="noreferrer">
            {part.value}
          </a>
        )
      } else {
        nodes.push(smartArrows(part.value))
      }
    }
  }

  INLINE_RE.lastIndex = 0
  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > last) {
      pushText(text.slice(last, match.index))
    }

    const token = match[0]
    const key = `${prefix}-${index++}`

    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('$$')) {
      nodes.push(<MathTex key={key} tex={token.slice(2, -2)} display />)
    } else if (token.startsWith('$')) {
      nodes.push(<MathTex key={key} tex={token.slice(1, -1)} display={false} />)
    } else if (token.startsWith('[[')) {
      const inner = token.slice(2, -2)
      const pipe = inner.indexOf('|')
      const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim()
      const alias = (pipe < 0 ? inner : inner.slice(pipe + 1)).trim() || target
      if (target) {
        nodes.push(<WikiLink key={key} target={target} alias={alias} />)
      } else {
        nodes.push(token)
      }
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{smartArrows(token.slice(2, -2))}</strong>)
    } else if (token.startsWith('~~')) {
      nodes.push(<del key={key}>{smartArrows(token.slice(2, -2))}</del>)
    } else if (token.startsWith('==')) {
      nodes.push(<mark key={key}>{smartArrows(token.slice(2, -2))}</mark>)
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(<em key={key}>{smartArrows(token.slice(1, -1))}</em>)
    } else if (token.startsWith('!')) {
      const link = /^!\[([^\]]*)\]\(([^)]*)\)$/.exec(token)
      const raw = link?.[2] ?? ''
      const url = link ? resolveImageSrc(raw) : undefined
      if (!link || !url) {
        nodes.push(token)
      } else {
        const src = raw.trim()
        const side = images?.sides[src]
        if (!side) {
          nodes.push(
            <span key={key} className="md-img">
              <ResizableImage
                url={url}
                alt={link[1]}
                width={images?.widths[src]}
                onCommitWidth={(w) => images?.onCommitWidth(src, w)}
              />
              {images && (
                <button
                  type="button"
                  className="md-img__float"
                  title="Unlock — wrap text around it"
                  onClick={(event) => {
                    event.stopPropagation()
                    // Dock on the half that was clicked, like a word
                    // processor dropping the picture to a side.
                    const box = event.currentTarget
                      .closest('.md-img')
                      ?.querySelector('img')
                      ?.getBoundingClientRect()
                    const dock: ImageSide =
                      box && event.clientX < box.left + box.width / 2 ? 'left' : 'right'
                    images.onToggleFloat(src, dock)
                  }}
                >
                  Unlock
                </button>
              )}
            </span>
          )
        } else {
          nodes.push(
            <DockedImage
              key={key}
              url={url}
              alt={link[1]}
              width={images?.widths[src]}
              side={side}
              src={src}
              images={images}
            />
          )
        }
      }
    } else {
      const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(token)
      const url = link ? safeUrl(link[2]) : undefined
      if (link && url) {
        nodes.push(
          <a key={key} href={url} target="_blank" rel="noreferrer">
            {link[1] || url}
          </a>
        )
      } else {
        nodes.push(token)
      }
    }

    last = match.index + token.length
  }

  if (last < text.length) {
    pushText(text.slice(last))
  }
  return nodes
}

function heading(level: number, children: ReactNode, key: string): ReactNode {
  switch (level) {
    case 1:
      return <h1 key={key}>{children}</h1>
    case 2:
      return <h2 key={key}>{children}</h2>
    case 3:
      return <h3 key={key}>{children}</h3>
    case 4:
      return <h4 key={key}>{children}</h4>
    case 5:
      return <h5 key={key}>{children}</h5>
    default:
      return <h6 key={key}>{children}</h6>
  }
}

/** Render one already-split block. */
function renderBlock(block: string, key: number, images?: ImageControls): ReactNode {
  const lines = block.split('\n')
  const first = lines[0]

  if (FENCE.test(first)) {
    const lang = first.trim().slice(3).trim()
    const hasClose = lines.length > 1 && FENCE.test(lines[lines.length - 1])
    const body = lines.slice(1, hasClose ? -1 : undefined)
    return <CodeBlock key={key} code={body.join('\n')} lang={lang} />
  }

  if (RULE.test(first)) {
    return <hr key={key} />
  }

  // Display math block: `$$…$$` (single or multi-line, no blank lines inside).
  const trimmed = block.trim()
  if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) {
    return <MathTex key={key} tex={trimmed.slice(2, -2).trim()} display />
  }

  const head = HEADING.exec(first)
  if (head) {
    return heading(head[1].length, renderInline(head[2], `h${key}`, images), `b${key}`)
  }

  if (QUOTE.test(first)) {
    const body = lines.map((line) => QUOTE.exec(line)?.[1] ?? line)
    return <blockquote key={key}>{renderInline(body.join(' '), `q${key}`, images)}</blockquote>
  }

  if (TASK.test(first)) {
    return (
      <ul key={key} className="markdown__tasks">
        {lines.map((line, index) => {
          const task = TASK.exec(line)
          if (!task) return null
          return (
            <li key={index} className="markdown__task">
              <input type="checkbox" checked={task[1].toLowerCase() === 'x'} readOnly />
              <span>{renderInline(task[2], `t${key}-${index}`, images)}</span>
            </li>
          )
        })}
      </ul>
    )
  }

  if (BULLET.test(first)) {
    return (
      <ul key={key}>
        {lines.map((line, index) => {
          const item = BULLET.exec(line)
          return <li key={index}>{renderInline(item?.[1] ?? line, `u${key}-${index}`, images)}</li>
        })}
      </ul>
    )
  }

  if (ORDERED.test(first)) {
    return (
      <ol key={key}>
        {lines.map((line, index) => {
          const item = ORDERED.exec(line)
          return <li key={index}>{renderInline(item?.[1] ?? line, `o${key}-${index}`, images)}</li>
        })}
      </ol>
    )
  }

  // Paragraph — single newlines within a block become line breaks.
  return (
    <p key={key}>
      {lines.map((text, line) => (
        <span key={line}>
          {renderInline(text, `p${key}-${line}`, images)}
          {line < lines.length - 1 ? <br /> : null}
        </span>
      ))}
    </p>
  )
}

/** Render one markdown document as React elements. */
function Markdown({
  source,
  images
}: {
  source: string
  images?: ImageControls
}): React.JSX.Element {
  return <>{splitBlocks(source).map((block, index) => renderBlock(block, index, images))}</>
}

export default Markdown

import { useEffect, useMemo, useRef, useState } from 'react'
import BlockEditor, { type ChildKind } from '../components/BlockEditor'
import FindBar from '../components/FindBar'
import { FlashcardsChildView, MindmapChildView, QuizChildView } from '../components/StudyChild'
import { BLOCK_START, joinBlocks, splitBlocks } from '../markdown'
import { addHiddenPage, joinHidden, splitHidden } from '../subpages'
import { blankFlashcardsBody, blankMindmapBody, blankQuizBody, parseStudyChild } from '../study'
import {
  contentImageSrcs,
  importDroppedPicture,
  type ImageControls,
  type ImageSide
} from '../images'

import { FileTextIcon, CardsIcon, MindmapIcon, QuizIcon, MoreIcon } from '../components/icons'
import { useAppStore, type ImageLayout } from '../store/appStore'

/** Stable empty layout so memo deps don't churn. */
const NO_LAYOUT: Record<string, ImageLayout> = {}

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function Note({ noteId }: { noteId: string }): React.JSX.Element {
  const note = useAppStore((state) => state.notes.find((n) => n.id === noteId) ?? null)
  const updateNote = useAppStore((state) => state.updateNote)
  const deleteNote = useAppStore((state) => state.deleteNote)
  const imageLayout = useAppStore((state) => state.imageLayout)

  const [dropActive, setDropActive] = useState(false)
  const [dropStatus, setDropStatus] = useState<{ msg: string; error: boolean } | null>(null)
  const dropStatusTimer = useRef<number | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [pageMenu, setPageMenu] = useState<{ x: number; y: number } | null>(null)
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null)
  const noteRef = useRef<HTMLElement>(null)

  // Ctrl/Cmd+F opens find-in-note. preventDefault stops the (absent) native
  // find so the shortcut never feels dead.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'f'
      ) {
        event.preventDefault()
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // A new note starts with a closed find bar (render-time adjustment for
  // prop change; no effect needed).
  const [findNoteId, setFindNoteId] = useState(noteId)
  if (findNoteId !== noteId) {
    setFindNoteId(noteId)
    setFindOpen(false)
  }

  // Drop results surface in the UI (success and failure alike) so a silent
  // drop is impossible: if nothing lands, the banner says why.
  const flashDropStatus = (msg: string, error: boolean): void => {
    setDropStatus({ msg, error })
    if (dropStatusTimer.current !== null) window.clearTimeout(dropStatusTimer.current)
    dropStatusTimer.current = window.setTimeout(() => setDropStatus(null), 5000)
  }

  useEffect(
    () => () => {
      if (dropStatusTimer.current !== null) window.clearTimeout(dropStatusTimer.current)
    },
    []
  )

  // Autosave title/body to the vault file, debounced past typing bursts.
  const saveId = note?.id
  const saveTitle = note?.title
  const saveContent = note?.content
  useEffect(() => {
    if (!saveId) return
    const timer = setTimeout(() => {
      void useAppStore.getState().saveNoteToVault(saveId)
    }, 600)
    return () => clearTimeout(timer)
  }, [saveId, saveTitle, saveContent])

  const edited = useMemo(() => (note ? relativeTime(note.updatedAt) : ''), [note])

  // Hidden footer is never rendered: the editor only touches the body, and
  // right-click → Add appends `[[links]]` to the footer instead of the body.
  const body = useMemo(() => splitHidden(note?.content ?? '').body, [note?.content])

  // Esc closes the page menu and the header options menu.
  useEffect(() => {
    if (!pageMenu && !headerMenu) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setPageMenu(null)
        setHeaderMenu(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pageMenu, headerMenu])

  /** Create an individual child of this note (page or JSON study set). */
  const createChild = (kind: ChildKind): { id: string; title: string } | null => {
    const state = useAppStore.getState()
    const parent = state.notes.find((n) => n.id === noteId)
    if (!parent || parent.deletedAt) return null
    if (kind === 'page') {
      const childId = state.createNote('Untitled page', null, parent.spaceId)
      const child = useAppStore.getState().notes.find((n) => n.id === childId)
      const title = child?.title.trim() || 'Untitled page'
      state.updateNote(noteId, { content: addHiddenPage(parent.content, title) })
      return { id: childId, title }
    }
    const base = (parent.title.trim() || 'Untitled').slice(0, 40)
    const title =
      kind === 'flashcards'
        ? `${base} set`
        : kind === 'mindmap'
          ? `${base} mindmap`
          : `${base} quiz`
    const childBody =
      kind === 'mindmap'
        ? blankMindmapBody()
        : kind === 'quiz'
          ? blankQuizBody()
          : blankFlashcardsBody()
    const childId = state.createNote(title, null, parent.spaceId)
    state.updateNote(childId, { content: childBody })
    const child = useAppStore.getState().notes.find((n) => n.id === childId)
    const finalTitle = child?.title.trim() || title
    state.updateNote(noteId, { content: addHiddenPage(parent.content, finalTitle) })
    return { id: childId, title: finalTitle }
  }

  const addSubpage = (): void => {
    const created = createChild('page')
    if (created) useAppStore.getState().openNote(created.id)
  }

  const addStudyApp = (kind: 'flashcards' | 'mindmap' | 'quiz'): void => {
    const created = createChild(kind)
    if (created) useAppStore.getState().openNote(created.id)
  }

  /** Slash-command path: create the child and embed its link at the caret. */
  const insertChildLink = (kind: ChildKind): string | null => {
    const created = createChild(kind)
    return created ? `[[${created.title}]]` : null
  }

  const layout = imageLayout[noteId] ?? NO_LAYOUT
  const srcsInContent = useMemo(() => contentImageSrcs(body), [body])

  // Docked pictures: side + width by raw source. Entries whose source left
  // the markdown are ignored until it returns.
  const docked = useMemo(() => {
    const sides: Record<string, ImageSide> = {}
    const widths: Record<string, number> = {}
    for (const [src, entry] of Object.entries(layout)) {
      if (!srcsInContent.has(src)) continue
      if (entry.side === 'left' || entry.side === 'right' || entry.side === 'center') {
        sides[src] = entry.side
      }
      if (typeof entry.w === 'number') widths[src] = entry.w
    }
    return { sides, widths }
  }, [layout, srcsInContent])

  // A child note whose body is basic JSON renders its study UI instead of
  // the markdown editor. Hidden footers never render anywhere.
  const studyChild = useMemo(() => parseStudyChild(body), [body])

  const toggleFloat = (src: string, side: ImageSide = 'right'): void => {
    const state = useAppStore.getState()
    if (state.imageLayout[noteId]?.[src]?.side) state.clearImageFloat(noteId, src)
    else state.setImageSide(noteId, src, side)
  }
  const commitWidth = (src: string, w: number | null): void => {
    useAppStore.getState().setImageSize(noteId, src, w)
  }
  const commitMove = (
    src: string,
    target: { blockIndex: number; above: boolean; side: ImageSide } | null
  ): void => {
    if (!target) return
    const state = useAppStore.getState()
    const current = state.notes.find((n) => n.id === noteId)
    if (!current || current.deletedAt) return
    const split = splitHidden(current.content)
    const blocks = splitBlocks(split.body)
    // Locate the dragged line (first occurrence wins; duplicate sources
    // share one layout entry anyway).
    let from = -1
    let lineAt = -1
    for (let i = 0; i < blocks.length; i++) {
      const at = blocks[i].split('\n').findIndex((line) => line.includes(`](${src})`))
      if (at >= 0) {
        from = i
        lineAt = at
        break
      }
    }
    if (from < 0) return
    const sourceLines = blocks[from].split('\n')
    const [imgLine] = sourceLines.splice(lineAt, 1)
    if (sourceLines.some((line) => line.trim())) blocks[from] = sourceLines.join('\n')
    else blocks.splice(from, 1)
    if (blocks.length === 0) {
      state.updateNote(noteId, { content: joinHidden(imgLine, split.hidden) })
      state.setImageSide(noteId, src, target.side)
      return
    }
    let to = target.blockIndex
    if (from < to) to -= 1
    to = Math.max(0, Math.min(to, blocks.length - 1))
    // Merge into plain paragraphs; anything structured (lists, quotes, code)
    // gets the picture as its own adjacent block instead.
    const dest = blocks[to].split('\n')[0] ?? ''
    if (BLOCK_START.test(dest)) {
      blocks.splice(target.above ? to : to + 1, 0, imgLine)
    } else {
      const lines = blocks[to].split('\n')
      if (target.above) lines.unshift(imgLine)
      else lines.push(imgLine)
      blocks[to] = lines.join('\n')
    }
    state.setImageSide(noteId, src, target.side)
    state.updateNote(noteId, { content: joinHidden(joinBlocks(blocks), split.hidden) })
    // Commit any in-progress edit first so the rewrite renders immediately.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }
  const imagesControls = useMemo<ImageControls>(
    () => ({
      docked: new Set(Object.keys(docked.sides)),
      sides: docked.sides,
      widths: docked.widths,
      onToggleFloat: toggleFloat,
      onCommitWidth: commitWidth,
      onSetSide: (src, side) => useAppStore.getState().setImageSide(noteId, src, side),
      onLock: (src) => useAppStore.getState().clearImageFloat(noteId, src),
      onCommitMove: commitMove
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docked, noteId]
  )

  if (!note) {
    return (
      <main className="note note--empty">
        <FileTextIcon size={28} />
        <p>Select a note from the sidebar, or create a new one.</p>
      </main>
    )
  }

  const appendBlocks = (blocks: string[]): void => {
    // Study children hold JSON, not markdown — never append blocks to them.
    if (blocks.length === 0 || !note || studyChild) return
    const split = splitHidden(note.content)
    const trimmed = split.body.trimEnd()
    const nextBody = `${trimmed}${trimmed ? '\n\n' : ''}${blocks.join('\n\n')}\n`
    updateNote(note.id, { content: joinHidden(nextBody, split.hidden) })
  }

  const dragTypes = (event: React.DragEvent): string[] => Array.from(event.dataTransfer.types ?? [])

  // Highlight ring only for plausible picture drags. The drop itself is
  // allowed more liberally (see below): some platforms report an empty type
  // list on dragover while still delivering Files on drop.
  const isPictureDrag = (event: React.DragEvent): boolean =>
    dragTypes(event).some((type) => type === 'Files' || type === 'text/uri-list')

  const onDropPictures = async (event: React.DragEvent): Promise<void> => {
    event.preventDefault()
    setDropActive(false)
    // End any in-progress block edit first: the editor only adopts outside
    // changes while unfocused, so without this a mid-edit drop would land in
    // the store yet stay invisible until the next blur.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const blocks: string[] = []
    const dropped = Array.from(event.dataTransfer.files ?? [])
    console.info(`[note] drop: ${dropped.length} file(s)`)
    const failures: string[] = []
    for (const file of dropped) {
      try {
        blocks.push(await importDroppedPicture(file))
      } catch (error) {
        console.error('[note] picture drop failed', error)
        failures.push(error instanceof Error ? error.message : `${file.name} (import failed)`)
      }
    }
    // Image/link drags from browsers arrive as a URL list. Plain-text drags
    // are ignored so a text selection never becomes a picture.
    const urls = event.dataTransfer
      .getData('text/uri-list')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^https?:\/\//i.test(line))
    for (const url of urls) {
      let alt = 'image'
      try {
        alt = new URL(url).hostname || alt
      } catch {
        // keep the fallback label
      }
      blocks.push(`![${alt}](${url})`)
    }
    if (blocks.length > 0) {
      appendBlocks(blocks)
      flashDropStatus(`Added ${blocks.length} picture${blocks.length === 1 ? '' : 's'}`, false)
    } else if (dropped.length > 0 || urls.length > 0) {
      flashDropStatus(`Couldn't add the drop: ${failures.join('; ') || 'unknown reason'}`, true)
    } else {
      flashDropStatus('The drop arrived with no files — try the picture button instead', true)
    }
  }

  return (
    <main
      ref={noteRef}
      className={`note${studyChild ? ' note--study' : ''}`}
      onDragOver={(event) => {
        const types = dragTypes(event)
        const plausible =
          types.length === 0 || types.some((t) => t === 'Files' || t === 'text/uri-list')
        // Plain-text drags keep native behavior (moving selected text);
        // everything else is a drop candidate so onDrop always fires.
        if (!plausible) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        if (isPictureDrag(event)) setDropActive(true)
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(event) => void onDropPictures(event)}
    >
      <header className="note__bar">
        <span className="note__meta">
          Edited {edited}
          {note.fileName ? ` · ${note.fileName}` : ''}
        </span>
        <div className="note__actions">
          <button
            type="button"
            className="icon-btn"
            title="Note options"
            aria-label="Note options"
            aria-haspopup="menu"
            aria-expanded={headerMenu !== null}
            onClick={(event) => {
              if (headerMenu) {
                setHeaderMenu(null)
              } else {
                const rect = event.currentTarget.getBoundingClientRect()
                setHeaderMenu({
                  x: Math.max(8, Math.min(rect.right - 170, window.innerWidth - 180)),
                  y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 280))
                })
              }
            }}
          >
            <MoreIcon size={15} />
          </button>
        </div>
      </header>

      {headerMenu && (
        <>
          <div
            className="note-menu__backdrop"
            aria-hidden="true"
            onClick={() => setHeaderMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault()
              setHeaderMenu(null)
            }}
          />
          <div
            className="note-menu note-menu--fixed"
            role="menu"
            aria-label="Note options"
            style={{ left: headerMenu.x, top: headerMenu.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            {!studyChild && (
              <>
                <p className="tabmenu__label">Add child</p>
                <button
                  type="button"
                  className="note-menu__item"
                  onClick={() => {
                    setHeaderMenu(null)
                    addSubpage()
                  }}
                >
                  <FileTextIcon size={14} />
                  New page
                </button>
                <button
                  type="button"
                  className="note-menu__item"
                  onClick={() => {
                    setHeaderMenu(null)
                    addStudyApp('flashcards')
                  }}
                >
                  <CardsIcon size={14} />
                  New flashcards
                </button>
                <button
                  type="button"
                  className="note-menu__item"
                  onClick={() => {
                    setHeaderMenu(null)
                    addStudyApp('mindmap')
                  }}
                >
                  <MindmapIcon size={14} />
                  New mindmap
                </button>
                <button
                  type="button"
                  className="note-menu__item"
                  onClick={() => {
                    setHeaderMenu(null)
                    addStudyApp('quiz')
                  }}
                >
                  <QuizIcon size={14} />
                  New quiz (blank)
                </button>
              </>
            )}
            <button
              type="button"
              className="note-menu__item note-menu__item--danger"
              onClick={() => {
                setHeaderMenu(null)
                const label = note.title.trim() || 'Untitled'
                if (
                  window.confirm(`Delete "${label}"? You can restore it from Trash within 30 days.`)
                ) {
                  deleteNote(note.id)
                }
              }}
            >
              Delete note
            </button>
          </div>
        </>
      )}

      {dropStatus && (
        <p className={`note__drop-status${dropStatus.error ? ' is-error' : ''}`} role="status">
          {dropStatus.msg}
        </p>
      )}

      <div className={`note__scroll${dropActive ? ' is-drop-target' : ''}`}>
        <div
          className="note__doc"
          onContextMenu={(event) => {
            // Right-click a markdown page to add individual children.
            // Study (JSON) children take no subpages — leave native menu.
            if (studyChild) return
            // Right-click anywhere in the page offers Hidden-footer inserts.
            // Let text inputs keep their native menu on small clicks? No —
            // page-level Add actions are more useful here.
            event.preventDefault()
            setPageMenu({
              x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)),
              y: Math.max(8, Math.min(event.clientY, window.innerHeight - 280))
            })
          }}
        >
          {/* Mindmaps carry their title as the root pill on the canvas. */}
          {!(studyChild && studyChild.type === 'mindmap') && (
            <input
              className="note__title"
              value={note.title}
              placeholder="Untitled"
              spellCheck={false}
              onChange={(event) => updateNote(note.id, { title: event.target.value })}
              onKeyDown={(event) => {
                // Keep Tab inside the note: jump into the body editor instead of
                // tabbing back to the sidebar search box. Ctrl/Cmd+Tab stays
                // reserved for the global tab switcher.
                if (
                  event.key === 'Tab' &&
                  !event.shiftKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.altKey
                ) {
                  event.preventDefault()
                  const blocks = document.querySelector('.blocks')
                  const editor = blocks?.querySelector<HTMLTextAreaElement>('textarea')
                  if (editor) {
                    editor.focus()
                  } else {
                    ;(blocks?.querySelector<HTMLElement>('.block') as HTMLElement | null)?.click()
                  }
                }
              }}
            />
          )}

          {studyChild ? (
            <div className={`study study--child study--${studyChild.type}`}>
              <div className="study__inner study__inner--child">
                {studyChild.type === 'flashcards' ? (
                  <FlashcardsChildView noteId={note.id} />
                ) : studyChild.type === 'mindmap' ? (
                  <MindmapChildView noteId={note.id} />
                ) : (
                  <QuizChildView noteId={note.id} />
                )}
              </div>
            </div>
          ) : (
            <BlockEditor
              value={body}
              onChange={(nextBody) => {
                const current = useAppStore.getState().notes.find((n) => n.id === note.id)
                const split = splitHidden(current?.content ?? '')
                updateNote(note.id, { content: joinHidden(nextBody, split.hidden) })
              }}
              placeholder="Write anything…  # heading · - list · **bold** · $math$ · ```js runs · Shift+Enter new block"
              images={imagesControls}
              onCreateChild={insertChildLink}
            />
          )}
        </div>
      </div>

      {pageMenu && (
        <>
          <div
            className="note-menu__backdrop"
            aria-hidden="true"
            onClick={() => setPageMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault()
              setPageMenu(null)
            }}
          />
          <div
            className="note-menu note-menu--fixed"
            role="menu"
            aria-label="Add to this page"
            style={{ left: pageMenu.x, top: pageMenu.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <p className="tabmenu__label">Add to this page</p>
            <button
              type="button"
              className="note-menu__item"
              onClick={() => {
                setPageMenu(null)
                addSubpage()
              }}
            >
              <FileTextIcon size={14} />
              New page
            </button>
            <button
              type="button"
              className="note-menu__item"
              onClick={() => {
                setPageMenu(null)
                addStudyApp('flashcards')
              }}
            >
              <CardsIcon size={14} />
              New flashcards
            </button>
            <button
              type="button"
              className="note-menu__item"
              onClick={() => {
                setPageMenu(null)
                addStudyApp('mindmap')
              }}
            >
              <MindmapIcon size={14} />
              New mindmap
            </button>
            <button
              type="button"
              className="note-menu__item"
              onClick={() => {
                setPageMenu(null)
                addStudyApp('quiz')
              }}
            >
              <QuizIcon size={14} />
              New quiz (blank)
            </button>
          </div>
        </>
      )}

      {findOpen && note && !studyChild && (
        <FindBar scope={noteRef} content={body} onClose={() => setFindOpen(false)} />
      )}
    </main>
  )
}

export default Note

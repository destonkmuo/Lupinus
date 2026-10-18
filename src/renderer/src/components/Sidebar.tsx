import { useEffect, useMemo, useRef, useState } from 'react'
import { isInlineNav } from '../nav'
import { buildNoteGraph, orderedNotes } from '../notes'
import { blankFlashcardsBody, blankMindmapBody, blankQuizBody, parseStudyChild } from '../study'
import { addHiddenPage, splitHidden } from '../subpages'
import { importDroppedPicture } from '../images'
import {
  LOCAL_CALENDAR_ID,
  expandItemDates,
  itemStartTime,
  todayISO,
  type CalendarItem
} from '../planner'
import { formatTime12h } from '../time'
import {
  SIDEBAR_DEFAULT_WIDTH,
  TAB_GROUP_COLORS,
  TRASH_RETENTION_MS,
  clampSidebarWidth,
  useAppStore,
  type NavKey,
  type Note
} from '../store/appStore'
import {
  CalendarIcon,
  CardsIcon,
  ChevronDownIcon,
  ExclamationIcon,
  FileTextIcon,
  MindmapIcon,
  PlusIcon,
  QuizIcon,
  RestoreIcon,
  SearchIcon,
  BookmarkIcon,
  TrashIcon,
  XIcon
} from './icons'

// macOS floats the traffic lights over the sidebar, so the search sits below a
// slim status band reserved for them. Elsewhere the frame is native and the
// band would only waste vertical space, so the status bubble rides in the
// search row and everything shifts up.
const IS_MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

/** "9:00 AM" from an event start (all-day events have no time part). */
function formatEventTime(item: CalendarItem): string {
  const time = itemStartTime(item)
  if (!time) return 'All day'
  return formatTime12h(time)
}

/** Quick-pick emoji palette for spaces and note icons. */
const ICON_EMOJIS = [
  '📝',
  '🏠',
  '💼',
  '🎯',
  '📚',
  '🧠',
  '🎨',
  '🧪',
  '🌱',
  '💡',
  '⭐',
  '🔖',
  '🗂️',
  '🧭',
  '🏋️',
  '🍳',
  '🎵',
  '✈️'
] as const

/** Default dot color: the app's accent blue (theme-aware). */
const SPACE_DOT_DEFAULT = 'var(--accent)'

/** Horizontal swipe distance (px) that commits a space switch. */
const SWIPE_PX = 55
/** Quiet gap (ms) that marks the end of one swipe gesture. */
const SWIPE_GAP_MS = 100
/** Space-swap slide duration (ms); mirrors the CSS. */
const SWAP_MS = 240

/**
 * Sidebar pages float above the notes: clicking the open page's entry again
 * dismisses its window (toggle), so the sidebar doubles as the close control.
 */
function toggleNav(key: NavKey): void {
  const state = useAppStore.getState()
  if (state.activeNav === key) state.closeNav()
  else state.openNav(key)
}

/**
 * Today at a glance: today's calendar events (local + enabled subscriptions,
 * recurrence-aware) above today's tasks (due today or overdue). Replaces the
 * old "upcoming events" placeholder, which never showed anything actionable.
 */
function TodaySection(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const calendarItems = useAppStore((state) => state.calendarItems)
  const subscriptions = useAppStore((state) => state.subscriptions)
  const localCalendarColor = useAppStore((state) => state.localCalendarColor)
  const plannerReady = useAppStore((state) => state.plannerReady)
  const tasks = useAppStore((state) => state.tasks)
  const toggleTask = useAppStore((state) => state.toggleTask)

  const today = todayISO()

  const events = useMemo(() => {
    const colors = new Map<string, string>([[LOCAL_CALENDAR_ID, localCalendarColor]])
    const items: CalendarItem[] = [...calendarItems]
    for (const sub of subscriptions) {
      if (!sub.enabled) continue
      colors.set(sub.id, sub.color)
      items.push(...sub.events)
    }
    const rows: { id: string; title: string; time: string; sort: string; color: string }[] = []
    for (const item of items) {
      if (expandItemDates(item, today, today).length === 0) continue
      rows.push({
        id: item.id,
        title: item.summary.trim() || 'Untitled',
        time: formatEventTime(item),
        sort: item.start.dateTime ?? `${today}T99:99`,
        color: colors.get(item.calendarId) ?? localCalendarColor
      })
    }
    rows.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0))
    return rows
  }, [calendarItems, subscriptions, localCalendarColor, today])

  const todaysTasks = useMemo(
    () =>
      tasks
        .filter((task) => task.status !== 'completed' && task.due !== null && task.due <= today)
        .sort((a, b) => ((a.due ?? '') + (a.time ?? '') < (b.due ?? '') + (b.time ?? '') ? -1 : 1)),
    [tasks, today]
  )

  const dismissed = useAppStore((state) => state.dismissedTodayEvents)
  const dismissTodayEvent = useAppStore((state) => state.dismissTodayEvent)
  const showAllTodayEvents = useAppStore((state) => state.showAllTodayEvents)
  const visibleEvents = events.filter((event) => !dismissed.includes(event.id))
  const hiddenCount = events.length - visibleEvents.length
  const count = visibleEvents.length + todaysTasks.length

  return (
    <section className={`sidebar__events${open ? '' : ' is-collapsed'}`} aria-label="Today">
      <div className="sidebar__section-head sidebar__today-head">
        <button
          type="button"
          className="sidebar__section-head--toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="sidebar__section-title">Today</span>
          {count > 0 && (
            <span key={count} className="sidebar__today-count">
              {count}
            </span>
          )}
          <ChevronDownIcon size={14} className={`sidebar__chevron${open ? ' is-open' : ''}`} />
        </button>
        <button
          type="button"
          className="sidebar__icon-btn"
          title="Open calendar"
          aria-label="Open calendar"
          onClick={() => toggleNav('calendar')}
        >
          <CalendarIcon size={14} />
        </button>
      </div>
      {/* Kept mounted for the expand/collapse glide; inert while shut. */}
      <div className="sidebar__today-body" inert={!open}>
        <div className="sidebar__today-body-inner">
          {visibleEvents.length > 0 && <p className="sidebar__today-group">Events</p>}
          {visibleEvents.map((event) => (
            <div
              key={event.id}
              className="sidebar__today-row"
              title={`${event.title} · ${event.time}`}
            >
              <button
                type="button"
                className="sidebar__today-open"
                aria-label={`Open ${event.title} in calendar`}
                onClick={() => toggleNav('calendar')}
              >
                <span className="sidebar__today-dot" style={{ background: event.color }} />
                <span className="sidebar__today-time">{event.time}</span>
                <span className="sidebar__label">{event.title}</span>
              </button>
              <button
                type="button"
                className="sidebar__icon-btn sidebar__today-hide"
                title={`Hide ${event.title} from Today`}
                aria-label={`Hide ${event.title} from Today`}
                onClick={() => dismissTodayEvent(event.id)}
              >
                <XIcon size={12} />
              </button>
            </div>
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              className="sidebar__today-hidden"
              onClick={() => showAllTodayEvents()}
            >
              {hiddenCount} hidden · Show
            </button>
          )}
          {todaysTasks.length > 0 && <p className="sidebar__today-group">Tasks</p>}
          {todaysTasks.map((task) => (
            <div key={task.id} className="sidebar__today-row" title={task.title}>
              <input
                type="checkbox"
                className="sidebar__today-check"
                checked={false}
                aria-label={`Mark done: ${task.title || 'Untitled'}`}
                onChange={() => toggleTask(task.id)}
              />
              <span className="sidebar__label">{task.title.trim() || 'Untitled'}</span>
              {task.time && <span className="sidebar__today-time">{formatTime12h(task.time)}</span>}
              {task.due !== null && task.due < today && (
                <span
                  className="sidebar__today-overdue"
                  title="Overdue"
                  aria-label="Overdue"
                  role="img"
                >
                  <ExclamationIcon size={12} />
                </span>
              )}
            </div>
          ))}
          {count === 0 && (
            <p className="sidebar__empty">{plannerReady ? 'Nothing on for today.' : 'Loading…'}</p>
          )}
        </div>
      </div>
    </section>
  )
}

function Sidebar(): React.JSX.Element {
  const activeTab = useAppStore(
    (state) => state.tabs.find((t) => t.id === state.activeTabId) ?? null
  )
  // Nav destinations float above the notes: the sidebar selection tracks
  // which floating window (if any) is open.
  const activeNav = useAppStore((state) => state.activeNav)
  const notes = useAppStore((state) => state.notes)
  const spaces = useAppStore((state) => state.spaces)
  const activeSpaceId = useAppStore((state) => state.activeSpaceId)
  const setActiveSpace = useAppStore((state) => state.setActiveSpace)
  const moveSpace = useAppStore((state) => state.moveSpace)
  const createSpace = useAppStore((state) => state.createSpace)
  const updateSpace = useAppStore((state) => state.updateSpace)
  const deleteSpace = useAppStore((state) => state.deleteSpace)
  const noteOrder = useAppStore((state) => state.noteOrder)
  const query = useAppStore((state) => state.query)
  const coreState = useAppStore((state) => state.coreState)
  const openNoteInCurrentTab = useAppStore((state) => state.openNoteInCurrentTab)
  const openNoteNewTab = useAppStore((state) => state.openNoteNewTab)
  const updateNote = useAppStore((state) => state.updateNote)
  const setNoteEmoji = useAppStore((state) => state.setNoteEmoji)
  const toggleBookmark = useAppStore((state) => state.toggleBookmark)
  const bookmarks = useAppStore((state) => state.bookmarks)
  const setQuery = useAppStore((state) => state.setQuery)
  const createNote = useAppStore((state) => state.createNote)
  const deleteNote = useAppStore((state) => state.deleteNote)
  const moveNote = useAppStore((state) => state.moveNote)
  const noteSections = useAppStore((state) => state.noteSections)
  const noteSection = useAppStore((state) => state.noteSection)
  const createSection = useAppStore((state) => state.createSection)
  const renameSection = useAppStore((state) => state.renameSection)
  const deleteSection = useAppStore((state) => state.deleteSection)
  const moveSection = useAppStore((state) => state.moveSection)
  const setNoteSection = useAppStore((state) => state.setNoteSection)
  const restoreNote = useAppStore((state) => state.restoreNote)
  const destroyNote = useAppStore((state) => state.destroyNote)
  const emptyTrash = useAppStore((state) => state.emptyTrash)
  const sidebarWidth = useAppStore((state) => state.sidebarWidth)
  const setSidebarWidth = useAppStore((state) => state.setSidebarWidth)
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed)

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; before: boolean } | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [sectionDraggingId, setSectionDraggingId] = useState<string | null>(null)
  const [sectionDropHint, setSectionDropHint] = useState<{ id: string; before: boolean } | null>(
    null
  )
  const [noteOverSection, setNoteOverSection] = useState<string | null>(null)
  const [dropNoteId, setDropNoteId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ noteId: string; x: number; y: number } | null>(null)
  const [childMenu, setChildMenu] = useState<{ noteId: string; x: number; y: number } | null>(null)
  const [spaceMenu, setSpaceMenu] = useState<{ x: number; y: number } | null>(null)
  const [spaceItemMenu, setSpaceItemMenu] = useState<{
    spaceId: string
    x: number
    y: number
  } | null>(null)
  // null = creating a new space; an id = editing that space.
  const [spaceEditor, setSpaceEditor] = useState<{ spaceId: string | null } | null>(null)
  const [spaceName, setSpaceName] = useState('')
  const [spaceEmoji, setSpaceEmoji] = useState('')
  // Explicit dot color ('' = automatic). Only used in dot mode.
  const [spaceDot, setSpaceDot] = useState('')
  // Note icon editor: an id + the emoji being picked ('' = default page icon).
  const [noteIconEditor, setNoteIconEditor] = useState<{ noteId: string } | null>(null)
  const [noteIconEmoji, setNoteIconEmoji] = useState('')
  const [spaceDraggingId, setSpaceDraggingId] = useState<string | null>(null)
  const [spaceDropHint, setSpaceDropHint] = useState<{ id: string; before: boolean } | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)

  const openSpaceEditor = (spaceId: string | null): void => {
    setSpaceItemMenu(null)
    setSpaceMenu(null)
    const space = spaceId ? spaces.find((s) => s.id === spaceId) : null
    setSpaceName(space?.name ?? '')
    setSpaceEmoji(space?.emoji ?? '')
    setSpaceDot(space?.dotColor ?? '')
    setSpaceEditor({ spaceId })
  }

  const saveSpace = (): void => {
    if (!spaceEditor) return
    // Blank keeps the old name on edit; on create the store numbers it
    // ("Space 1", "Space 2", …).
    const name = spaceName.trim()
    // Empty emoji = dot mode: the spacebar shows a plain dot instead.
    // Empty dotColor = automatic color.
    const emoji = spaceEmoji.trim()
    const dotColor = spaceDot.trim()
    if (spaceEditor.spaceId) updateSpace(spaceEditor.spaceId, { name, emoji, dotColor })
    else createSpace(name, emoji, dotColor)
    setSpaceEditor(null)
  }

  const openNoteIconEditor = (note: Note): void => {
    setMenu(null)
    setNoteIconEmoji(note.emoji?.trim() ?? '')
    setNoteIconEditor({ noteId: note.id })
  }

  const saveNoteIcon = (): void => {
    if (!noteIconEditor) return
    setNoteEmoji(noteIconEditor.noteId, noteIconEmoji)
    setNoteIconEditor(null)
  }

  // Favorites are cross-space: jumping to one swaps the active space first,
  // then opens the note in that space's tab bar.
  const openFavorite = (note: Note): void => {
    const spaceId = note.spaceId ?? spaces[0]?.id
    if (spaceId && spaceId !== activeSpaceId) setActiveSpace(spaceId)
    openNoteInCurrentTab(note.id)
  }

  // `height` is the expected menu height so the clamp doesn't shove a short
  // menu (e.g. the space actions) far up from the cursor near the bottom.
  const clampMenu = (x: number, y: number, height = 300): { x: number; y: number } => ({
    x: Math.max(8, Math.min(x, window.innerWidth - 190)),
    y: Math.max(8, Math.min(y, window.innerHeight - height))
  })

  const openMenuAt = (noteId: string, x: number, y: number): void => {
    const at = clampMenu(x, y)
    setMenu({ noteId, ...at })
  }
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null)
  const [renameNoteDraft, setRenameNoteDraft] = useState('')
  const [resizing, setResizing] = useState(false)
  const dragIdRef = useRef<string | null>(null)
  const sectionDragRef = useRef<string | null>(null)
  const asideRef = useRef<HTMLElement>(null)
  const spaceCarouselRef = useRef<HTMLDivElement>(null)
  const spaceDragRef = useRef<string | null>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  // One swipe gesture = one switch: accumulate horizontal deltas, fire once
  // past the threshold, then swallow the rest of the burst (trackpad momentum)
  // until a short gap marks the next gesture.
  const swipeRef = useRef({ accum: 0, fired: false, lastAt: 0 })
  // The outgoing space's frozen markup, shown sliding out during a swap.
  const [swap, setSwap] = useState<{ html: string; dir: 'next' | 'prev' } | null>(null)
  const resizeStartRef = useRef({ x: 0, width: 0 })

  useEffect(() => {
    const container = spaceCarouselRef.current
    if (!container) return
    const button = [...container.querySelectorAll<HTMLElement>('[data-space-id]')].find(
      (el) => el.dataset.spaceId === activeSpaceId
    )
    if (!button) return
    const strip = container.getBoundingClientRect()
    const rect = button.getBoundingClientRect()
    const left =
      container.scrollLeft + (rect.left - strip.left) - (container.clientWidth - rect.width) / 2
    container.scrollTo({ left, behavior: 'smooth' })
  }, [activeSpaceId, spaces.length])

  // The note row stays lit while its tab is visible: always in note view,
  // and behind floating windows — but not under Home/SeeMO's full-size views.
  const activeNoteId =
    activeTab?.kind === 'note' && (activeNav === null || !isInlineNav(activeNav))
      ? activeTab.noteId
      : null
  const needle = query.trim().toLowerCase()

  const matchesQuery = (note: Note): boolean =>
    !needle ||
    note.title.toLowerCase().includes(needle) ||
    note.content.toLowerCase().includes(needle)

  // Outgoing `[[links]]` per note (deduped, self-links dropped).
  // Top level shows roots only: a note with a parent lives nested under it,
  // never beside it. While searching, fall back to a flat match list so
  // results are never hidden inside collapsed parents.
  const liveNotes = useMemo(
    () =>
      notes.filter((note) => !note.deletedAt && (note.spaceId ?? spaces[0]?.id) === activeSpaceId),
    [notes, spaces, activeSpaceId]
  )
  const graph = useMemo(
    () => buildNoteGraph(orderedNotes(liveNotes, noteOrder)),
    [liveNotes, noteOrder]
  )
  const visibleNotes = (needle ? orderedNotes(liveNotes, noteOrder) : graph.roots).filter(
    matchesQuery
  )
  // Favorites are global (every space), in the order they were bookmarked.
  const favoriteNotes = useMemo(
    () =>
      bookmarks
        .map((id) => notes.find((note) => note.id === id))
        .filter((note): note is Note => note !== undefined && !note.deletedAt),
    [bookmarks, notes]
  )

  // Trash lives in the spacebar now: whole-vault list, newest first.
  const [nowMs] = useState(() => Date.now())
  const trashed = useMemo(
    () =>
      notes
        .filter((note) => note.deletedAt)
        .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)),
    [notes]
  )
  const daysLeft = (deletedAt: number, now: number): string => {
    const days = Math.max(
      0,
      Math.ceil((deletedAt + TRASH_RETENTION_MS - now) / (24 * 60 * 60 * 1000))
    )
    return days <= 0 ? 'today' : `${days}d`
  }
  const noteLabel = (note: Note): string => note.title.trim() || 'Untitled'

  const toggleExpand = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const clearDrag = (): void => {
    dragIdRef.current = null
    setDraggingId(null)
    setDropHint(null)
    setNoteOverSection(null)
  }

  const clearSectionDrag = (): void => {
    sectionDragRef.current = null
    setSectionDraggingId(null)
    setSectionDropHint(null)
  }

  // Valid section for a note within the active space, or null when ungrouped
  // (unknown or cross-space ids fall out, so a note never goes missing).
  const sectionOf = (noteId: string): string | null => {
    const id = noteSection[noteId]
    if (id === undefined) return null
    const section = noteSections.find((s) => s.id === id)
    return section && section.spaceId === activeSpaceId ? id : null
  }

  const positionAbove = (event: React.DragEvent<HTMLElement>): boolean => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY - rect.top < rect.height / 2
  }

  const positionFromEvent = (event: React.DragEvent<HTMLLIElement>): boolean => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY - rect.top < rect.height / 2
  }

  const onNoteDrop = (event: React.DragEvent<HTMLLIElement>, noteId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    const dragId = dragIdRef.current
    clearDrag()
    if (dragId && dragId !== noteId) {
      // Adopt the target's section when dragging across dividers.
      if (sectionOf(dragId) !== sectionOf(noteId)) setNoteSection(dragId, sectionOf(noteId))
      moveNote(dragId, noteId, positionFromEvent(event))
    }
  }

  const isPictureDragTypes = (types: Iterable<string> | ArrayLike<string>): boolean =>
    Array.from(types as ArrayLike<string>).some(
      (type) => type === 'Files' || type === 'text/uri-list'
    )

  // Dropping pictures straight onto a row appends them to that note
  // (handy when it isn't open). Files validate in main; URLs need http(s).
  const onRowDropPictures = async (event: React.DragEvent, noteId: string): Promise<void> => {
    event.preventDefault()
    event.stopPropagation()
    setDropNoteId(null)
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const blocks: string[] = []
    for (const file of Array.from(event.dataTransfer.files ?? [])) {
      try {
        blocks.push(await importDroppedPicture(file))
      } catch (error) {
        console.error('[sidebar] picture drop failed', error)
      }
    }
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
    if (blocks.length === 0) return
    const target = useAppStore.getState().notes.find((n) => n.id === noteId)
    if (!target || target.deletedAt) return
    const body = target.content.trimEnd()
    useAppStore
      .getState()
      .updateNote(noteId, { content: `${body}${body ? '\n\n' : ''}${blocks.join('\n\n')}\n` })
  }

  // Drop a dragged note on open space: pull it out of its section (if any)
  // and pin it at the end of the order.
  const ungroupDrop = (): void => {
    const dragId = dragIdRef.current
    clearDrag()
    if (dragId) {
      setNoteSection(dragId, null)
      moveNote(dragId, null, false)
    }
  }

  const onListDrop = (event: React.DragEvent<HTMLUListElement>): void => {
    // Only fires for empty list space; note drops stop propagation above.
    // (Stop here too so the pane catch-all below doesn't double-handle it.)
    event.preventDefault()
    event.stopPropagation()
    ungroupDrop()
  }

  // Open background anywhere in the notes pane (gaps between sections and
  // padding): rows, dividers, and lists stop propagation when they handle a
  // drop, so reaching here means genuinely open space.
  const onPaneDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    ungroupDrop()
  }

  // Drop a note onto a section: file it there, pinned after that section's
  // last root so it lands inside the group.
  const assignToSection = (dragId: string, sectionId: string | null): void => {
    const peers = visibleNotes.filter((n) => n.id !== dragId && sectionOf(n.id) === sectionId)
    setNoteSection(dragId, sectionId)
    if (peers.length > 0) moveNote(dragId, peers[peers.length - 1].id, false)
    else moveNote(dragId, null, false)
  }

  const onSectionDrop = (event: React.DragEvent<HTMLDivElement>, sectionId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    const secDrag = sectionDragRef.current
    const noteDrag = dragIdRef.current
    clearDrag()
    clearSectionDrag()
    // Divider-on-divider reorders sections; note-on-divider files the note.
    if (secDrag && secDrag !== sectionId) {
      moveSection(secDrag, sectionId, positionAbove(event))
    } else if (noteDrag) {
      assignToSection(noteDrag, sectionId)
    }
  }

  const onSectionListDrop = (event: React.DragEvent<HTMLUListElement>, sectionId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    const noteDrag = dragIdRef.current
    clearDrag()
    if (noteDrag) assignToSection(noteDrag, sectionId)
  }

  const newSection = (): void => {
    const id = createSection()
    const created = useAppStore.getState().noteSections.find((s) => s.id === id)
    setRenameDraft(created?.title ?? 'New section')
    setRenamingId(id)
  }

  const commitRename = (): void => {
    if (renamingId) renameSection(renamingId, renameDraft)
    setRenamingId(null)
  }

  const toggleCollapsed = (id: string): void => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const confirmDeleteSection = (id: string, title: string): void => {
    if (window.confirm(`Delete section "${title}"? Its notes stay under Notes.`)) {
      deleteSection(id)
    }
  }

  const startRenameNote = (note: Note): void => {
    setMenu(null)
    setRenamingNoteId(note.id)
    setRenameNoteDraft(note.title)
  }

  const commitRenameNote = (): void => {
    const id = renamingNoteId
    setRenamingNoteId(null)
    if (!id) return
    const live = useAppStore.getState().notes.find((n) => n.id === id)
    const title = renameNoteDraft.trim()
    if (live && !live.deletedAt && title !== live.title) updateNote(id, { title })
  }

  const trashNote = (note: Note): void => {
    const label = note.title.trim() || 'Untitled'
    if (window.confirm(`Delete "${label}"? You can restore it from Trash within 30 days.`)) {
      deleteNote(note.id)
    }
  }

  /** Add an individual child (page or JSON study app) under a note. */
  const createChildFor = (
    parentId: string,
    kind: 'page' | 'flashcards' | 'mindmap' | 'quiz'
  ): void => {
    const state = useAppStore.getState()
    const parent = state.notes.find((n) => n.id === parentId)
    if (!parent || parent.deletedAt) return
    let title = 'Untitled page'
    let body: string | null = null
    if (kind !== 'page') {
      const base = (parent.title.trim() || 'Untitled').slice(0, 40)
      title =
        kind === 'mindmap' ? `${base} mindmap` : kind === 'quiz' ? `${base} quiz` : `${base} set`
      body =
        kind === 'mindmap'
          ? blankMindmapBody()
          : kind === 'quiz'
            ? blankQuizBody()
            : blankFlashcardsBody()
    }
    const childId = state.createNote(title)
    if (body) state.updateNote(childId, { content: body })
    const child = useAppStore.getState().notes.find((n) => n.id === childId)
    state.updateNote(parentId, {
      content: addHiddenPage(parent.content, child?.title.trim() || title)
    })
    setMenu(null)
    setChildMenu(null)
    state.openNote(childId)
  }

  const searchInputRef = useRef<HTMLInputElement>(null)

  // Ctrl+K focuses sidebar search, per the ^K chip. Either logical
  // modifier counts so OS-level Ctrl/Cmd swaps keep working. Skipped while
  // Spotlight owns the keyboard; expands a collapsed sidebar first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'k'
      ) {
        if (document.querySelector('.spotlight')) return
        event.preventDefault()
        const state = useAppStore.getState()
        if (state.sidebarCollapsed) {
          state.setSidebarCollapsed(false)
          // Retry past the collapse transition: the sidebar stays
          // visibility:hidden (unfocusable) until the slide finishes.
          window.setTimeout(() => searchInputRef.current?.focus(), 300)
        } else {
          searchInputRef.current?.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Esc closes the row/space menus, the space editor, and the trash popover.
  useEffect(() => {
    if (!menu && !childMenu && !spaceMenu && !spaceItemMenu && !spaceEditor && !trashOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenu(null)
        setChildMenu(null)
        setSpaceMenu(null)
        setSpaceItemMenu(null)
        setSpaceEditor(null)
        setTrashOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu, childMenu, spaceMenu, spaceItemMenu, spaceEditor, trashOpen])

  const expandAll = (): void => {
    setExpandedIds(new Set(visibleNotes.map((n) => n.id)))
    setCollapsedIds(new Set())
  }

  const collapseAll = (): void => {
    setExpandedIds(new Set())
    setCollapsedIds(
      new Set(noteSections.filter((s) => s.spaceId === activeSpaceId).map((s) => s.id))
    )
  }

  // Split view for a note: reuse a background tab for it, or open a fresh
  // one beside the current tab when it is already showing the note.
  // Nav views don't render splits, so splitting from a page first returns
  // to the note tabs (keeping the previous note primary).
  const splitNote = (noteId: string): void => {
    const state = useAppStore.getState()
    const prevActive = state.activeTabId
    const background = state.tabs.find(
      (t) => t.kind === 'note' && t.noteId === noteId && t.id !== prevActive
    )
    if (background) {
      if (state.activeNav !== null) {
        const prevTab = state.tabs.find((t) => t.id === prevActive)
        if (prevTab) state.setActiveTab(prevTab.id)
        else state.setActiveTab(background.id)
        if (useAppStore.getState().activeTabId === background.id) return
      }
      state.setSplitTab(background.id)
      return
    }
    const id = state.openNoteNewTab(noteId)
    if (!id) return
    if (prevActive) state.setActiveTab(prevActive)
    if (useAppStore.getState().activeTabId !== id) state.setSplitTab(id)
  }

  // New pages arrive with a rename signal: open the inline field on the row.
  // Deferred a frame so the rename state lands as an event-style update.
  const renamingSignal = useAppStore((state) => state.renamingNoteId)
  useEffect(() => {
    if (!renamingSignal) return
    const frame = requestAnimationFrame(() => {
      const { notes: live, setRenamingNoteId: clear } = useAppStore.getState()
      clear(null)
      const note = live.find((n) => n.id === renamingSignal)
      if (!note || note.deletedAt) return
      setRenamingNoteId(note.id)
      setRenameNoteDraft(note.title)
      document.querySelector(`[data-note-row="${note.id}"]`)?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [renamingSignal])

  // Sidebar edge drag: paint live via the DOM for 60fps, commit to the
  // store (and persistence) once on release.
  const onResizeStart = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeStartRef.current = {
      x: event.clientX,
      width: asideRef.current?.offsetWidth ?? sidebarWidth
    }
    setResizing(true)
  }

  const onResizeMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizing) return
    const next = clampSidebarWidth(
      resizeStartRef.current.width + (event.clientX - resizeStartRef.current.x)
    )
    if (asideRef.current) asideRef.current.style.width = `${next}px`
  }

  const onResizeEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizing) return
    setResizing(false)
    setSidebarWidth(
      clampSidebarWidth(resizeStartRef.current.width + (event.clientX - resizeStartRef.current.x))
    )
    // Hand width back to the store value so later renders stay in sync.
    if (asideRef.current) asideRef.current.style.width = ''
  }

  // Notion-style tree: a note with outgoing [[links]] expands to reveal those
  // child pages nested beneath it. Only top-level rows are draggable; nested
  // rows are link views into the same flat order. `ancestors` guards cycles.
  // Study children render their app icon; custom note emoji win over the
  // default page icon.
  const renderTree = (note: Note, depth: number, ancestors: string[]): React.JSX.Element => {
    const studyType = parseStudyChild(splitHidden(note.content).body)?.type ?? null
    const noteEmoji = note.emoji?.trim() ?? ''
    const NoteIcon =
      studyType === 'flashcards'
        ? CardsIcon
        : studyType === 'mindmap'
          ? MindmapIcon
          : studyType === 'quiz'
            ? QuizIcon
            : FileTextIcon
    const kids = (graph.children.get(note.id) ?? []).filter(
      (kid) => !ancestors.includes(kid.id) && matchesQuery(kid)
    )
    const isOpen = expandedIds.has(note.id)
    const hint = depth === 0 && dropHint?.id === note.id ? dropHint : null
    const dragAttrs =
      depth === 0
        ? {
            draggable: true as const,
            onDragStart: (event: React.DragEvent<HTMLLIElement>): void => {
              dragIdRef.current = note.id
              setDraggingId(note.id)
              event.dataTransfer.effectAllowed = 'move'
            },
            onDragEnd: () => {
              clearDrag()
              setDropNoteId(null)
            },
            onDragOver: (event: React.DragEvent<HTMLLIElement>): void => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              if (dragIdRef.current && dragIdRef.current !== note.id) {
                setDropHint({ id: note.id, before: positionFromEvent(event) })
              }
              if (isPictureDragTypes(event.dataTransfer.types ?? [])) {
                setDropNoteId(note.id)
              }
            },
            onDragLeave: () => setDropNoteId(null),
            onDrop: (event: React.DragEvent<HTMLLIElement>): void => {
              // Internal reorders (note/section drags) keep working when the
              // platform reports no types; anything carrying files or URLs
              // from outside the app is a picture drop.
              const internal = dragIdRef.current !== null || sectionDragRef.current !== null
              const external =
                event.dataTransfer.files.length > 0 ||
                event.dataTransfer.getData('text/uri-list').trim().length > 0
              if (external && !internal) void onRowDropPictures(event, note.id)
              else onNoteDrop(event, note.id)
              setDropNoteId(null)
            }
          }
        : {}
    const renaming = renamingNoteId === note.id
    return (
      <li
        key={note.id}
        {...dragAttrs}
        className={`sidebar__note${draggingId === note.id && depth === 0 ? ' sidebar__note--dragging' : ''}${hint ? (hint.before ? ' sidebar__note--drop-before' : ' sidebar__note--drop-after') : ''}${dropNoteId === note.id ? ' is-drop-target' : ''}`}
      >
        <div
          data-note-row={note.id}
          className={`sidebar__row sidebar__row--note${
            activeNoteId === note.id ? ' is-active' : ''
          }`}
          onContextMenu={(event) => {
            if (renamingNoteId === note.id) return
            event.preventDefault()
            openMenuAt(note.id, event.clientX, event.clientY)
          }}
        >
          {kids.length > 0 ? (
            <button
              type="button"
              className={`sidebar__twisty${isOpen ? ' is-open' : ''}`}
              aria-expanded={isOpen}
              aria-label={
                isOpen
                  ? `Collapse ${note.title || 'Untitled'}`
                  : `Expand ${note.title || 'Untitled'}`
              }
              onClick={() => toggleExpand(note.id)}
            >
              <ChevronDownIcon size={20} />
            </button>
          ) : (
            <span className="sidebar__twisty sidebar__twisty--spacer" aria-hidden="true" />
          )}
          {renaming ? (
            <input
              className="sidebar__row-input"
              autoFocus
              value={renameNoteDraft}
              placeholder="Untitled"
              aria-label="Note name"
              onChange={(event) => setRenameNoteDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitRenameNote()
                if (event.key === 'Escape') setRenamingNoteId(null)
              }}
              onBlur={commitRenameNote}
            />
          ) : (
            <button
              type="button"
              className="sidebar__note-main"
              onClick={() => openNoteInCurrentTab(note.id)}
              title={note.title ? note.title : 'Untitled'}
            >
              {noteEmoji ? (
                <span className="note-emoji" aria-hidden="true">
                  {noteEmoji}
                </span>
              ) : (
                <NoteIcon size={15} />
              )}
              <span className="sidebar__label">{note.title.trim() || 'Untitled'}</span>
            </button>
          )}
          <div className="sidebar__note-actions">
            {!studyType && (
              <button
                type="button"
                className="sidebar__icon-btn"
                title="Add child"
                aria-label={`Add child to ${note.title.trim() || 'Untitled'}`}
                aria-expanded={childMenu?.noteId === note.id}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  if (childMenu?.noteId === note.id) {
                    setChildMenu(null)
                  } else {
                    setMenu(null)
                    setChildMenu({
                      noteId: note.id,
                      ...clampMenu(rect.right - 170, rect.bottom + 4, 210)
                    })
                  }
                }}
              >
                <PlusIcon size={15} />
              </button>
            )}
            {!(renamingNoteId === note.id) && (
              <button
                type="button"
                className="sidebar__icon-btn sidebar__icon-btn--danger"
                title={`Delete ${note.title.trim() || 'Untitled'}`}
                aria-label={`Delete ${note.title.trim() || 'Untitled'}`}
                onClick={() => trashNote(note)}
              >
                <TrashIcon size={14} />
              </button>
            )}
          </div>
        </div>
        {kids.length > 0 && isOpen && (
          <ul className="sidebar__notes sidebar__notes--nested">
            {kids.map((kid) => renderTree(kid, depth + 1, [...ancestors, note.id]))}
          </ul>
        )}
      </li>
    )
  }

  // One custom section: draggable divider header plus its notes. Dividers
  // reorder against each other; notes dropped on the header or its list get
  // filed into the section.
  const renderSection = (section: { id: string; title: string }): React.JSX.Element => {
    const roots = visibleNotes.filter((note) => sectionOf(note.id) === section.id)
    const collapsed = collapsedIds.has(section.id)
    const renaming = renamingId === section.id
    const hint = sectionDropHint?.id === section.id ? sectionDropHint : null
    return (
      <div key={section.id} className="sidebar__section-block">
        <div
          draggable={!renaming}
          onDragStart={(event) => {
            sectionDragRef.current = section.id
            setSectionDraggingId(section.id)
            event.dataTransfer.effectAllowed = 'move'
          }}
          onDragEnd={clearSectionDrag}
          onDragOver={(event) => {
            if (sectionDragRef.current && sectionDragRef.current !== section.id) {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setSectionDropHint({ id: section.id, before: positionAbove(event) })
            } else if (dragIdRef.current) {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setNoteOverSection(section.id)
            }
          }}
          onDragLeave={() => setNoteOverSection(null)}
          onDrop={(event) => onSectionDrop(event, section.id)}
          className={`sidebar__divider${sectionDraggingId === section.id ? ' sidebar__divider--dragging' : ''}${hint ? (hint.before ? ' sidebar__divider--drop-before' : ' sidebar__divider--drop-after') : ''}${noteOverSection === section.id ? ' is-note-target' : ''}`}
        >
          {renaming ? (
            <input
              className="sidebar__divider-input"
              autoFocus
              value={renameDraft}
              aria-label="Section name"
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitRename()
                if (event.key === 'Escape') setRenamingId(null)
              }}
              onBlur={commitRename}
            />
          ) : (
            <button
              type="button"
              className="sidebar__divider-main"
              title="Collapse · double-click to rename · drag to reorder"
              onClick={() => toggleCollapsed(section.id)}
              onDoubleClick={() => {
                setRenameDraft(section.title)
                setRenamingId(section.id)
              }}
            >
              <ChevronDownIcon
                size={13}
                className={`sidebar__chevron${collapsed ? '' : ' is-open'}`}
              />
              <span className="sidebar__label">{section.title}</span>
            </button>
          )}
          <button
            type="button"
            className="sidebar__icon-btn"
            title={`Add note to ${section.title}`}
            aria-label={`Add note to ${section.title}`}
            onClick={() => createNote(undefined, section.id)}
          >
            <PlusIcon size={14} />
          </button>
          <button
            type="button"
            className="sidebar__icon-btn sidebar__icon-btn--danger"
            title={`Delete section ${section.title}`}
            aria-label={`Delete section ${section.title}`}
            onClick={() => confirmDeleteSection(section.id, section.title)}
          >
            <TrashIcon size={14} />
          </button>
        </div>
        {!collapsed && (
          <ul
            className="sidebar__notes"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onSectionListDrop(event, section.id)}
          >
            {roots.map((note) => renderTree(note, 0, []))}
          </ul>
        )}
      </div>
    )
  }

  // Dividers are independent per space: only the active space's show.
  const spaceSections = noteSections.filter((section) => section.spaceId === activeSpaceId)
  const ungrouped = visibleNotes.filter((note) => sectionOf(note.id) === null)
  const activeSpaceIndex = spaces.findIndex((space) => space.id === activeSpaceId)
  const activeSpace = activeSpaceIndex >= 0 ? spaces[activeSpaceIndex] : null
  const activeSpaceNumber = activeSpaceIndex >= 0 ? activeSpaceIndex + 1 : 0
  // The Notes header names the active space (falling back to its number when
  // unnamed); with no spaces at all it stays "Notes".
  const notesTitle =
    activeSpace != null ? activeSpace.name.trim() || `Space ${activeSpaceNumber}` : 'Notes'

  // Clear the sliding-out pane once its exit animation has run.
  useEffect(() => {
    if (!swap) return
    const timer = window.setTimeout(() => setSwap(null), SWAP_MS + 60)
    return () => window.clearTimeout(timer)
  }, [swap])

  // Switch to a space, freezing the current pane so it can slide out.
  const goToSpace = (id: string, dir: 'next' | 'prev'): void => {
    if (id === activeSpaceId || !spaces.some((space) => space.id === id)) return
    const html = paneRef.current?.innerHTML ?? ''
    setSwap({ html, dir })
    setActiveSpace(id)
  }

  // Step one space (dir +1 = next, -1 = previous), wrapping around.
  const stepSpace = (step: 1 | -1): void => {
    if (spaces.length < 2) return
    const index = spaces.findIndex((space) => space.id === activeSpaceId)
    if (index < 0) return
    const next = spaces[(index + step + spaces.length) % spaces.length]
    if (next) goToSpace(next.id, step > 0 ? 'next' : 'prev')
  }

  // Trackpad two-finger horizontal swipe.
  const onSpaceWheel = (event: React.WheelEvent<HTMLElement>): void => {
    if (spaces.length < 2) return
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, [contenteditable="true"], pre, .tabbar__list')) return
    const now = event.timeStamp
    const gesture = swipeRef.current
    if (now - gesture.lastAt > SWIPE_GAP_MS) {
      gesture.accum = 0
      gesture.fired = false
    }
    gesture.lastAt = now
    if (gesture.fired) return
    gesture.accum += event.deltaX
    if (Math.abs(gesture.accum) < SWIPE_PX) return
    gesture.fired = true
    stepSpace(gesture.accum > 0 ? 1 : -1)
  }

  return (
    <aside
      ref={asideRef}
      className={`sidebar${resizing ? ' sidebar--resizing' : ''}${sidebarCollapsed ? ' sidebar--collapsed' : ''}`}
      aria-label="Navigation and notes"
      aria-hidden={sidebarCollapsed || undefined}
      style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
      onWheel={onSpaceWheel}
      onTouchStart={(event) => {
        touchStartRef.current = null
        if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]'))
          return
        const touch = event.touches[0]
        touchStartRef.current = { x: touch.clientX, y: touch.clientY }
      }}
      onTouchEnd={(event) => {
        const start = touchStartRef.current
        touchStartRef.current = null
        if (!start || spaces.length < 2) return
        const touch = event.changedTouches[0]
        const dx = touch.clientX - start.x
        const dy = touch.clientY - start.y
        if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.3) return
        stepSpace(dx < 0 ? 1 : -1)
      }}
    >
      <div className="sidebar__top">
        {IS_MAC && (
          <div className="sidebar__statusrow">
            <button
              type="button"
              key={coreState}
              className={`sidebar__state sidebar__state--${coreState} sidebar__status`}
              title={`Core: ${coreState} · open SeeMO`}
              aria-label={`Core status: ${coreState} · open SeeMO`}
              onClick={() => useAppStore.getState().openNav('agent')}
            />
          </div>
        )}
        <label className="sidebar__search">
          <SearchIcon size={15} />
          <input
            ref={searchInputRef}
            type="search"
            className="sidebar__search-input"
            placeholder="Search or ask"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {!IS_MAC && (
          <button
            type="button"
            key={coreState}
            className={`sidebar__state sidebar__state--${coreState} sidebar__status sidebar__status--inline`}
            title={`Core: ${coreState} · open SeeMO`}
            aria-label={`Core status: ${coreState} · open SeeMO`}
            onClick={() => useAppStore.getState().openNav('agent')}
          />
        )}
      </div>

      <div
        className="sidebar__scroll"
        onContextMenu={(event) => {
          const target = event.target as HTMLElement
          if (
            target.closest(
              '[data-note-row], .sidebar__events, nav, button, input, textarea, .note-menu'
            )
          ) {
            return
          }
          event.preventDefault()
          const at = clampMenu(event.clientX, event.clientY)
          setSpaceMenu(at)
        }}
      >
        <TodaySection />

        {favoriteNotes.length > 0 && (
          <div className="sidebar__favorites" role="group" aria-label="Favorites">
            {favoriteNotes.map((note) => {
              const label = note.title.trim() || 'Untitled'
              const space = spaces.find((s) => s.id === note.spaceId)
              const emoji = note.emoji?.trim() ?? ''
              const isCurrent = activeTab?.noteId === note.id
              return (
                <button
                  key={note.id}
                  type="button"
                  className={`sidebar__fav${isCurrent ? ' is-active' : ''}`}
                  title={`${label}${space ? ` · ${space.name}` : ''}`}
                  aria-label={`${label}${isCurrent ? ', open' : ''}`}
                  onClick={() => openFavorite(note)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    openMenuAt(note.id, event.clientX, event.clientY)
                  }}
                >
                  {emoji ? (
                    <span className="sidebar__fav-emoji" aria-hidden="true">
                      {emoji}
                    </span>
                  ) : (
                    <FileTextIcon size={22} />
                  )}
                </button>
              )
            })}
          </div>
        )}

        <div className="sidebar__section">
          <div className="sidebar__section-head">
            {activeSpace ? (
              <button
                type="button"
                className="sidebar__section-title"
                title={`Space ${activeSpaceNumber} of ${spaces.length} — ${activeSpace.name} · double-click to rename`}
                aria-label={`Rename space ${activeSpace.name}`}
                onDoubleClick={() => openSpaceEditor(activeSpace.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  openSpaceEditor(activeSpace.id)
                }}
              >
                {notesTitle}
              </button>
            ) : (
              <span className="sidebar__section-title" title="Notes">
                {notesTitle}
              </span>
            )}
            <button
              type="button"
              className="sidebar__icon-btn"
              title={activeSpace ? `New note in ${activeSpace.name}` : 'New note'}
              aria-label={activeSpace ? `New note in ${activeSpace.name}` : 'New note'}
              onClick={() => createNote()}
            >
              <PlusIcon size={22} />
            </button>
          </div>

          <div className="sidebar__space-swap">
            {swap && (
              <div
                className={`sidebar__space-exit is-out-${swap.dir}`}
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: swap.html }}
              />
            )}
            <div
              key={activeSpaceId}
              ref={paneRef}
              className={`sidebar__space-pane is-in-${swap ? swap.dir : 'none'}${
                draggingId ? ' is-dragging' : ''
              }`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={onPaneDrop}
            >
              {needle ? (
                visibleNotes.length === 0 ? (
                  <p className="sidebar__empty">No notes match your search.</p>
                ) : (
                  <ul
                    className="sidebar__notes"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={onListDrop}
                  >
                    {visibleNotes.map((note) => renderTree(note, 0, []))}
                  </ul>
                )
              ) : (
                <>
                  {spaceSections.map((section) => renderSection(section))}
                  {ungrouped.length === 0 && spaceSections.length === 0 ? (
                    <p className="sidebar__empty">No notes yet — create one.</p>
                  ) : (
                    <ul
                      className="sidebar__notes"
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={onListDrop}
                    >
                      {ungrouped.map((note) => renderTree(note, 0, []))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {(menu ||
        childMenu ||
        spaceMenu ||
        spaceItemMenu ||
        spaceEditor ||
        noteIconEditor ||
        trashOpen) && (
        <div
          className="note-menu__backdrop"
          aria-hidden="true"
          onClick={() => {
            setMenu(null)
            setChildMenu(null)
            setSpaceMenu(null)
            setSpaceItemMenu(null)
            setSpaceEditor(null)
            setNoteIconEditor(null)
            setTrashOpen(false)
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenu(null)
            setChildMenu(null)
            setSpaceMenu(null)
            setSpaceItemMenu(null)
            setSpaceEditor(null)
            setNoteIconEditor(null)
            setTrashOpen(false)
          }}
        />
      )}
      {spaceMenu && (
        <div
          className="note-menu note-menu--fixed"
          role="menu"
          aria-label="Notes actions"
          style={{ left: spaceMenu.x, top: spaceMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className="note-menu__item"
            onClick={() => {
              setSpaceMenu(null)
              createNote()
            }}
          >
            New page
          </button>
          <button
            type="button"
            className="note-menu__item"
            onClick={() => {
              setSpaceMenu(null)
              newSection()
            }}
          >
            New section
          </button>
          <button type="button" className="note-menu__item" onClick={() => openSpaceEditor(null)}>
            New space
          </button>
          <button
            type="button"
            className="note-menu__item"
            onClick={() => {
              setSpaceMenu(null)
              expandAll()
            }}
          >
            Expand all
          </button>
          <button
            type="button"
            className="note-menu__item"
            onClick={() => {
              setSpaceMenu(null)
              collapseAll()
            }}
          >
            Collapse all
          </button>
        </div>
      )}
      {spaceItemMenu &&
        (() => {
          const targetSpace = spaces.find((space) => space.id === spaceItemMenu.spaceId)
          if (!targetSpace) return null
          return (
            <div
              className="note-menu note-menu--fixed"
              role="menu"
              aria-label={`Actions for ${targetSpace.name}`}
              style={{ left: spaceItemMenu.x, top: spaceItemMenu.y }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                type="button"
                className="note-menu__item"
                onClick={() => openSpaceEditor(targetSpace.id)}
              >
                Rename or change emoji
              </button>
              <button
                type="button"
                className="note-menu__item note-menu__item--danger"
                onClick={() => {
                  setSpaceItemMenu(null)
                  if (window.confirm(`Delete “${targetSpace.name}”?`)) deleteSpace(targetSpace.id)
                }}
              >
                Delete space
              </button>
            </div>
          )
        })()}
      {spaceEditor && (
        <div
          className="space-editor"
          role="dialog"
          aria-modal="true"
          aria-label={spaceEditor.spaceId ? 'Edit space' : 'New space'}
        >
          <div className="space-editor__head">
            {spaceEmoji.trim() ? (
              <span className="space-editor__glyph" aria-hidden="true">
                {spaceEmoji}
              </span>
            ) : (
              <span className="space-editor__glyph space-editor__glyph--dot" aria-hidden="true">
                <span
                  className="space-editor__dot"
                  style={spaceDot ? { background: spaceDot } : undefined}
                />
              </span>
            )}
            <input
              className="space-editor__name"
              autoFocus
              value={spaceName}
              placeholder="Space name"
              aria-label="Space name"
              maxLength={40}
              onChange={(event) => setSpaceName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveSpace()
              }}
            />
          </div>
          <div className="space-editor__emojis" role="group" aria-label="Choose an emoji">
            <button
              type="button"
              className={`space-editor__emoji space-editor__emoji--none${spaceEmoji.trim() === '' ? ' is-active' : ''}`}
              aria-label="No emoji (dot)"
              aria-pressed={spaceEmoji.trim() === ''}
              title="No emoji — show a dot"
              onClick={() => setSpaceEmoji('')}
            >
              <span className="space-editor__dot" aria-hidden="true" />
            </button>
            {ICON_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className={`space-editor__emoji${spaceEmoji === emoji ? ' is-active' : ''}`}
                aria-label={emoji}
                aria-pressed={spaceEmoji === emoji}
                onClick={() => setSpaceEmoji(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
          <input
            className="space-editor__custom"
            value={spaceEmoji}
            placeholder="Or type an emoji (empty for dot)"
            aria-label="Custom emoji"
            maxLength={8}
            onChange={(event) => setSpaceEmoji(event.target.value)}
          />
          {spaceEmoji.trim() === '' && (
            <div className="space-editor__colors" role="group" aria-label="Dot color">
              <span className="space-editor__colors-label">Dot color</span>
              <div className="space-editor__swatches">
                <button
                  type="button"
                  className={`space-editor__swatch space-editor__swatch--auto${spaceDot === '' ? ' is-active' : ''}`}
                  aria-label="Automatic dot color"
                  aria-pressed={spaceDot === ''}
                  title="Automatic"
                  onClick={() => setSpaceDot('')}
                />
                {TAB_GROUP_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`space-editor__swatch${spaceDot === color ? ' is-active' : ''}`}
                    style={{ background: color }}
                    aria-label={`Dot color ${color}`}
                    aria-pressed={spaceDot === color}
                    onClick={() => setSpaceDot(color)}
                  />
                ))}
              </div>
            </div>
          )}
          <div className="space-editor__actions">
            {spaceEditor.spaceId && (
              <button
                type="button"
                className="space-editor__btn space-editor__btn--danger"
                title="Delete space"
                onClick={() => {
                  setSpaceEditor(null)
                  if (window.confirm('Delete this space?')) deleteSpace(spaceEditor.spaceId!)
                }}
              >
                Delete
              </button>
            )}
            <button
              type="button"
              className="space-editor__btn"
              onClick={() => setSpaceEditor(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="space-editor__btn space-editor__btn--primary"
              onClick={saveSpace}
            >
              {spaceEditor.spaceId ? 'Save' : 'Create'}
            </button>
          </div>
        </div>
      )}
      {noteIconEditor &&
        (() => {
          const target = notes.find((n) => n.id === noteIconEditor.noteId)
          if (!target) return null
          const label = target.title.trim() || 'Untitled'
          const draft = noteIconEmoji.trim()
          return (
            <div
              className="space-editor"
              role="dialog"
              aria-modal="true"
              aria-label={`Icon for ${label}`}
            >
              <div className="space-editor__head">
                <span className="space-editor__glyph" aria-hidden="true">
                  {draft || <FileTextIcon size={20} />}
                </span>
                <span className="space-editor__note-label" title={label}>
                  {label}
                </span>
              </div>
              <div className="space-editor__emojis" role="group" aria-label="Choose an icon">
                <button
                  type="button"
                  className={`space-editor__emoji space-editor__emoji--none${draft === '' ? ' is-active' : ''}`}
                  aria-label="Default page icon"
                  aria-pressed={draft === ''}
                  title="Default page icon"
                  onClick={() => setNoteIconEmoji('')}
                >
                  <FileTextIcon size={16} />
                </button>
                {ICON_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className={`space-editor__emoji${draft === emoji ? ' is-active' : ''}`}
                    aria-label={emoji}
                    aria-pressed={draft === emoji}
                    onClick={() => setNoteIconEmoji(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <input
                className="space-editor__custom"
                value={noteIconEmoji}
                placeholder="Or type an emoji (empty for default)"
                aria-label="Custom emoji"
                maxLength={8}
                onChange={(event) => setNoteIconEmoji(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') saveNoteIcon()
                }}
              />
              <div className="space-editor__actions">
                <button
                  type="button"
                  className="space-editor__btn"
                  onClick={() => setNoteIconEditor(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="space-editor__btn space-editor__btn--primary"
                  onClick={saveNoteIcon}
                >
                  Save
                </button>
              </div>
            </div>
          )
        })()}
      {childMenu &&
        (() => {
          const target = notes.find((n) => n.id === childMenu.noteId)
          if (!target || target.deletedAt) return null
          return (
            <div
              className="note-menu note-menu--fixed"
              role="menu"
              aria-label={`Add child to ${target.title.trim() || 'Untitled'}`}
              style={{ left: childMenu.x, top: childMenu.y }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <p className="tabmenu__label">Add child</p>
              <button
                type="button"
                className="note-menu__item"
                onClick={() => createChildFor(target.id, 'page')}
              >
                <FileTextIcon size={14} />
                New page
              </button>
              <button
                type="button"
                className="note-menu__item"
                onClick={() => createChildFor(target.id, 'flashcards')}
              >
                <CardsIcon size={14} />
                New flashcards
              </button>
              <button
                type="button"
                className="note-menu__item"
                onClick={() => createChildFor(target.id, 'mindmap')}
              >
                <MindmapIcon size={14} />
                New mindmap
              </button>
              <button
                type="button"
                className="note-menu__item"
                onClick={() => createChildFor(target.id, 'quiz')}
              >
                <QuizIcon size={14} />
                New quiz (blank)
              </button>
            </div>
          )
        })()}
      {menu &&
        (() => {
          const target = notes.find((n) => n.id === menu.noteId)
          if (!target || target.deletedAt) return null
          const label = target.title.trim() || 'Untitled'
          const isBookmarked = bookmarks.includes(target.id)
          const isStudyChild = parseStudyChild(splitHidden(target.content).body) !== null
          return (
            <div
              className="note-menu note-menu--fixed"
              role="menu"
              aria-label={`Actions for ${label}`}
              style={{ left: menu.x, top: menu.y }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                type="button"
                className="note-menu__item"
                onClick={() => {
                  setMenu(null)
                  openNoteNewTab(target.id)
                }}
              >
                Open in new tab
              </button>
              <button
                type="button"
                className="note-menu__item"
                onClick={() => {
                  setMenu(null)
                  splitNote(target.id)
                }}
              >
                Split view
              </button>
              <button
                type="button"
                className="note-menu__item"
                onClick={() => startRenameNote(target)}
              >
                Rename
              </button>
              <button
                type="button"
                className="note-menu__item"
                onClick={() => openNoteIconEditor(target)}
              >
                <FileTextIcon size={14} />
                Change icon
              </button>
              <button
                type="button"
                className="note-menu__item"
                onClick={() => {
                  setMenu(null)
                  toggleBookmark(target.id)
                }}
              >
                <BookmarkIcon size={14} />
                {isBookmarked ? 'Remove from Favorites' : 'Add to Favorites'}
              </button>
              {!isStudyChild && (
                <>
                  <p className="tabmenu__label">Add child</p>
                  <button
                    type="button"
                    className="note-menu__item"
                    onClick={() => createChildFor(target.id, 'page')}
                  >
                    <FileTextIcon size={14} />
                    New page
                  </button>
                  <button
                    type="button"
                    className="note-menu__item"
                    onClick={() => createChildFor(target.id, 'flashcards')}
                  >
                    <CardsIcon size={14} />
                    New flashcards
                  </button>
                  <button
                    type="button"
                    className="note-menu__item"
                    onClick={() => createChildFor(target.id, 'mindmap')}
                  >
                    <MindmapIcon size={14} />
                    New mindmap
                  </button>
                  <button
                    type="button"
                    className="note-menu__item"
                    onClick={() => createChildFor(target.id, 'quiz')}
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
                  setMenu(null)
                  trashNote(target)
                }}
              >
                Delete
              </button>
            </div>
          )
        })()}
      <div className="sidebar__spacebar is-carousel">
        <button
          type="button"
          className={`sidebar__trash-btn${trashOpen ? ' is-active' : ''}`}
          title="Trash"
          aria-label="Trash"
          aria-haspopup="dialog"
          aria-expanded={trashOpen}
          onClick={() => setTrashOpen((value) => !value)}
        >
          <TrashIcon size={16} />
        </button>
        <div
          className="sidebar__space-icons"
          ref={spaceCarouselRef}
          role="group"
          aria-label="Spaces"
        >
          {spaces.map((space, index) => {
            const distance = Math.abs(index - activeSpaceIndex)
            const circularDistance = Math.min(distance, spaces.length - distance)
            return (
              <button
                key={space.id}
                type="button"
                data-space-id={space.id}
                draggable
                className={`sidebar__space-icon${space.id === activeSpaceId ? ' is-active' : ''} is-distance-${Math.min(circularDistance, 3)}${spaceDraggingId === space.id ? ' is-dragging' : ''}${spaceDropHint?.id === space.id ? (spaceDropHint.before ? ' is-drop-before' : ' is-drop-after') : ''}`}
                title={space.emoji.trim() ? `${space.emoji} ${space.name}` : space.name}
                aria-label={`${space.name}${space.id === activeSpaceId ? ', current space' : ''}`}
                aria-pressed={space.id === activeSpaceId}
                onClick={() => goToSpace(space.id, index > activeSpaceIndex ? 'next' : 'prev')}
                onDragStart={(event) => {
                  spaceDragRef.current = space.id
                  setSpaceDraggingId(space.id)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', space.id)
                }}
                onDragEnd={() => {
                  spaceDragRef.current = null
                  setSpaceDraggingId(null)
                  setSpaceDropHint(null)
                }}
                onDragOver={(event) => {
                  if (!spaceDragRef.current || spaceDragRef.current === space.id) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  const rect = event.currentTarget.getBoundingClientRect()
                  setSpaceDropHint({
                    id: space.id,
                    before: event.clientX < rect.left + rect.width / 2
                  })
                }}
                onDragLeave={() =>
                  setSpaceDropHint((hint) => (hint?.id === space.id ? null : hint))
                }
                onDrop={(event) => {
                  event.preventDefault()
                  const dragId = spaceDragRef.current
                  spaceDragRef.current = null
                  setSpaceDraggingId(null)
                  setSpaceDropHint(null)
                  if (!dragId || dragId === space.id) return
                  const rect = event.currentTarget.getBoundingClientRect()
                  moveSpace(dragId, space.id, event.clientX < rect.left + rect.width / 2)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  // Anchor the menu just above the icon so it reads as
                  // attached to it (the bar sits at the very bottom).
                  const rect = event.currentTarget.getBoundingClientRect()
                  const menuW = 176
                  const menuH = 88
                  setSpaceItemMenu({
                    spaceId: space.id,
                    x: Math.max(8, Math.min(rect.left, window.innerWidth - menuW - 8)),
                    y: Math.max(8, rect.top - menuH - 6)
                  })
                }}
              >
                {space.emoji.trim() ? (
                  <span aria-hidden="true">{space.emoji}</span>
                ) : (
                  <span
                    className="sidebar__space-dot"
                    style={{ background: space.dotColor || SPACE_DOT_DEFAULT }}
                    aria-hidden="true"
                  />
                )}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          className="sidebar__space-add"
          title="Create space"
          aria-label="Create space"
          onClick={() => openSpaceEditor(null)}
        >
          <PlusIcon size={18} />
        </button>
      </div>

      {trashOpen && (
        <div
          className="rail-menu rail-menu--trash rail-menu--sidebar"
          role="dialog"
          aria-label="Trash"
        >
          <div className="rail-menu__head rail-menu__head--trash">
            <span className="rail-menu__name">Trash</span>
            <span className="rail-menu__count">{trashed.length}</span>
            {trashed.length > 0 && (
              <button
                type="button"
                className="rail-menu__empty"
                title="Destroy everything in Trash forever"
                onClick={() => {
                  if (
                    window.confirm(
                      `Destroy all ${trashed.length} trashed note${trashed.length === 1 ? '' : 's'} forever? This cannot be undone.`
                    )
                  )
                    emptyTrash()
                }}
              >
                Empty
              </button>
            )}
          </div>
          <div className="rail-menu__list">
            {trashed.length === 0 ? (
              <p className="rail-menu__none">Trash is empty.</p>
            ) : (
              trashed.map((note) => (
                <div key={note.id} className="rail-trash-row" title={noteLabel(note)}>
                  {note.emoji?.trim() ? (
                    <span className="note-emoji" aria-hidden="true">
                      {note.emoji.trim()}
                    </span>
                  ) : (
                    <FileTextIcon size={13} />
                  )}
                  <span className="rail-trash-row__title">{noteLabel(note)}</span>
                  <span className="rail-trash-row__days">
                    {daysLeft(note.deletedAt ?? nowMs, nowMs)}
                  </span>
                  <button
                    type="button"
                    className="rail-trash-row__btn"
                    title={`Restore ${noteLabel(note)}`}
                    aria-label={`Restore ${noteLabel(note)}`}
                    onClick={() => {
                      restoreNote(note.id)
                      openNoteInCurrentTab(note.id)
                      setTrashOpen(false)
                    }}
                  >
                    <RestoreIcon size={13} />
                  </button>
                  <button
                    type="button"
                    className="rail-trash-row__btn rail-trash-row__btn--danger"
                    title={`Delete ${noteLabel(note)} forever`}
                    aria-label={`Delete ${noteLabel(note)} forever`}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Destroy "${noteLabel(note)}" forever? This cannot be undone.`
                        )
                      )
                        destroyNote(note.id)
                    }}
                  >
                    <TrashIcon size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div
        className="sidebar__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        title="Drag to resize (double-click to reset)"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
      />
    </aside>
  )
}

export default Sidebar

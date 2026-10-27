import { useEffect, useMemo, useRef, useState } from 'react'
import { isInlineNav, NAV_BY_KEY, sidebarViewFor, type SidebarView } from '../nav'
import { markSpaceSwipe } from '../gestures'
import {
  buildNoteGraph,
  orderedNotes,
  parseWikiLinks,
  resolveWikiTarget,
  type NoteGraph
} from '../notes'
import { blankFlashcardsBody, blankMindmapBody, blankQuizBody, parseStudyChild } from '../study'
import { addHiddenPage, joinHidden, splitHidden } from '../subpages'
import { importDroppedPicture } from '../images'
import { pdfFileForNote } from '../pdf'
import { importPdfFiles, importPdfFromDialog, isPdfFile } from '../pdfImport'
import { beginSortableDrag, useSortableMakeSpace } from '../sortable'
import {
  LOCAL_CALENDAR_ID,
  addMonths,
  expandItemDates,
  isTaskDone,
  itemStartTime,
  monthGrid,
  monthLabel,
  parseISODate,
  toISODate,
  todayISO,
  type CalendarItem
} from '../planner'
import { formatTime12h } from '../time'

import {
  SIDEBAR_DEFAULT_WIDTH,
  TAB_GROUP_COLORS,
  TRASH_RETENTION_MS,
  clampSidebarWidth,
  bookmarkToken,
  useAppStore,
  type NavKey,
  type Note,
  type NoteDivider,
  type NoteSection,
  type TaskFilter
} from '../store/appStore'
import {
  AlarmIcon,
  CalendarIcon,
  CardsIcon,
  ChatIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExclamationIcon,
  FileTextIcon,
  GraphIcon,
  MailIcon,
  MindmapIcon,
  PdfIcon,
  PlusIcon,
  QuizIcon,
  RestoreIcon,
  SearchIcon,
  SettingsIcon,
  SidebarToggleIcon,
  StopwatchIcon,
  TimerIcon,
  BookmarkIcon,
  TrashIcon,
  XIcon
} from './icons'

/** Remove `[[Child]]` / `![[Child]]` mentions from a note body (code-safe). */
function stripChildLinks(content: string, childTitle: string): string {
  const needle = childTitle.trim().toLowerCase()
  if (!needle) return content
  const parts = content.split(/(`[^`\n]+`)/g)
  const wiki = /(!?)\[\[([^\]\n]+?)\]\]/g
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(wiki, (full, _bang: string, inner: string) => {
      const pipe = inner.indexOf('|')
      const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim()
      return target.toLowerCase() === needle ? '' : full
    })
  }
  return parts.join('')
}

// macOS floats the traffic lights over the sidebar, so the chrome band starts
// to their right. Elsewhere the frame is native and the band starts at the
// sidebar's left edge.

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

/** A resolved favorite: a rail page or a note, ready to render as a cube. */
type FavoriteItem =
  | {
      kind: 'nav'
      key: NavKey
      label: string
      icon: (props: { size?: number }) => React.JSX.Element
    }
  | { kind: 'note'; note: Note }

/** Reorder token for a favorite (matches the store's `bookmarkToken`). */
function favoriteToken(item: FavoriteItem): string {
  return item.kind === 'nav'
    ? bookmarkToken({ kind: 'nav', key: item.key })
    : bookmarkToken({ kind: 'note', id: item.note.id })
}

/** Horizontal swipe distance (px) that commits a space switch. */
const SWIPE_PX = 55
/** Quiet gap (ms) that marks the end of one swipe gesture. */
const SWIPE_GAP_MS = 50

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
          {count === 0 && (
            <p className="sidebar__empty">{plannerReady ? 'Nothing on for today.' : 'Loading…'}</p>
          )}
        </div>
      </div>
    </section>
  )
}

/** Shared section heading for the contextual sidebar bodies. */
function ContextHead({
  title,
  action
}: {
  title: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="sidebar-context__head">
      <span className="sidebar-context__title">{title}</span>
      {action}
    </div>
  )
}

/** Compact month grid plus the local/subscribed calendar list. */
function CalendarSidebar(): React.JSX.Element {
  const calendarItems = useAppStore((state) => state.calendarItems)
  const subscriptions = useAppStore((state) => state.subscriptions)
  const localCalendarName = useAppStore((state) => state.localCalendarName)
  const localCalendarColor = useAppStore((state) => state.localCalendarColor)
  const updateSubscription = useAppStore((state) => state.updateSubscription)
  const cursor = useAppStore((state) => state.calendarCursor)
  const setCursor = useAppStore((state) => state.setCalendarCursor)
  const openDay = useAppStore((state) => state.openDay)
  const openNav = useAppStore((state) => state.openNav)

  const { year, month } = parseISODate(cursor)
  const days = monthGrid(year, month)
  const first = days[0]
  const last = days[days.length - 1]
  const today = todayISO()

  const eventDates = new Set<string>()
  const items: CalendarItem[] = [...calendarItems]
  for (const sub of subscriptions) {
    if (sub.enabled) items.push(...sub.events)
  }
  for (const item of items) {
    for (const date of expandItemDates(item, first, last)) eventDates.add(date)
  }

  const shiftMonth = (delta: number): void => {
    const next = addMonths(year, month, delta)
    setCursor(toISODate(next.year, next.month, 1))
  }

  return (
    <>
      <section className="sidebar-context__section" aria-label="Mini calendar">
        <div className="sidebar-context__month">
          <button
            type="button"
            className="sidebar__icon-btn"
            aria-label="Previous month"
            title="Previous month"
            onClick={() => shiftMonth(-1)}
          >
            <ChevronLeftIcon size={15} />
          </button>
          <button
            type="button"
            className="sidebar-context__month-label"
            title="Open calendar"
            onClick={() => openNav('calendar')}
          >
            {monthLabel(year, month)}
          </button>
          <button
            type="button"
            className="sidebar__icon-btn"
            aria-label="Next month"
            title="Next month"
            onClick={() => shiftMonth(1)}
          >
            <ChevronRightIcon size={15} />
          </button>
        </div>
        <div className="sidebar-context__weekdays" aria-hidden="true">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
            <span key={`${day}-${index}`}>{day}</span>
          ))}
        </div>
        <div className="sidebar-context__month-grid">
          {days.map((date) => {
            const { month: cellMonth, day } = parseISODate(date)
            const outside = cellMonth !== month
            return (
              <button
                key={date}
                type="button"
                className={`sidebar-context__day${outside ? ' is-outside' : ''}${date === today ? ' is-today' : ''}${date === cursor ? ' is-selected' : ''}`}
                aria-label={date}
                aria-pressed={date === cursor}
                onClick={() => openDay(date)}
              >
                <span>{day}</span>
                {eventDates.has(date) && <span className="sidebar-context__day-dot" />}
              </button>
            )
          })}
        </div>
      </section>

      <section className="sidebar-context__section" aria-label="Calendars">
        <ContextHead
          title="Calendars"
          action={
            <button
              type="button"
              className="sidebar__icon-btn"
              aria-label="Open calendar"
              title="Open calendar"
              onClick={() => openNav('calendar')}
            >
              <PlusIcon size={17} />
            </button>
          }
        />
        <ul className="sidebar-context__list">
          <li className="sidebar-context__cal">
            <span
              className="sidebar-context__dot"
              style={{ background: localCalendarColor }}
              aria-hidden="true"
            />
            <span className="sidebar-context__label">{localCalendarName}</span>
            <span className="sidebar-context__meta">Local</span>
          </li>
          {subscriptions.map((sub) => (
            <li key={sub.id} className="sidebar-context__cal">
              <span
                className="sidebar-context__dot"
                style={{ background: sub.color }}
                aria-hidden="true"
              />
              <span className="sidebar-context__label" title={sub.name}>
                {sub.name}
              </span>
              <input
                type="checkbox"
                className="sidebar-context__check"
                checked={sub.enabled}
                aria-label={`${sub.enabled ? 'Hide' : 'Show'} ${sub.name}`}
                onChange={() => updateSubscription(sub.id, { enabled: !sub.enabled })}
              />
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}

/** Task filters that drive the Tasks page, plus the routine lists. */
function TasksSidebar(): React.JSX.Element {
  const tasks = useAppStore((state) => state.tasks)
  const routines = useAppStore((state) => state.routines)
  const taskFilter = useAppStore((state) => state.taskFilter)
  const setTaskFilter = useAppStore((state) => state.setTaskFilter)
  const openNav = useAppStore((state) => state.openNav)
  const today = todayISO()

  const open = tasks.filter((task) => !isTaskDone(task))
  const filters: { id: TaskFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All tasks', count: open.length },
    { id: 'today', label: 'Today', count: open.filter((task) => task.due === today).length },
    {
      id: 'overdue',
      label: 'Overdue',
      count: open.filter((task) => task.due !== null && task.due < today).length
    },
    {
      id: 'completed',
      label: 'Completed',
      count: tasks.filter((task) => isTaskDone(task)).length
    }
  ]

  const choose = (filter: TaskFilter): void => {
    setTaskFilter(filter)
    openNav('tasks')
  }

  return (
    <>
      <section className="sidebar-context__section" aria-label="Task filters">
        <ContextHead title="Filters" />
        <ul className="sidebar-context__list">
          {filters.map((filter) => (
            <li key={filter.id}>
              <button
                type="button"
                className={`sidebar-context__row${taskFilter === filter.id ? ' is-active' : ''}`}
                aria-pressed={taskFilter === filter.id}
                onClick={() => choose(filter.id)}
              >
                <span className="sidebar-context__label">{filter.label}</span>
                <span className="sidebar-context__count">{filter.count}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="sidebar-context__section" aria-label="Task lists">
        <ContextHead
          title="Lists"
          action={
            <button
              type="button"
              className="sidebar__icon-btn"
              aria-label="Open tasks"
              title="Open tasks"
              onClick={() => openNav('tasks')}
            >
              <PlusIcon size={17} />
            </button>
          }
        />
        {routines.length === 0 ? (
          <p className="sidebar__empty">No routines yet.</p>
        ) : (
          <ul className="sidebar-context__list">
            {routines.map((routine) => {
              const done = routine.steps.filter((step) => step.done).length
              return (
                <li key={routine.id}>
                  <button
                    type="button"
                    className="sidebar-context__row"
                    onClick={() => choose('all')}
                  >
                    <span className="sidebar-context__label" title={routine.title}>
                      {routine.title.trim() || 'Untitled routine'}
                    </span>
                    <span className="sidebar-context__count">
                      {routine.steps.length === 0 ? '—' : `${done}/${routine.steps.length}`}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </>
  )
}

function GraphSidebar(): React.JSX.Element {
  const spaces = useAppStore((state) => state.spaces)
  const notes = useAppStore((state) => state.notes)
  const activeSpaceId = useAppStore((state) => state.activeSpaceId)
  const setActiveSpace = useAppStore((state) => state.setActiveSpace)
  const openNav = useAppStore((state) => state.openNav)

  return (
    <section className="sidebar-context__section" aria-label="Graph spaces">
      <ContextHead
        title="Spaces"
        action={
          <button
            type="button"
            className="sidebar__icon-btn"
            aria-label="Open graph"
            title="Open graph"
            onClick={() => openNav('graph')}
          >
            <GraphIcon size={16} />
          </button>
        }
      />
      <ul className="sidebar-context__list">
        {spaces.map((space) => {
          const count = notes.filter(
            (note) => !note.deletedAt && (note.spaceId ?? spaces[0]?.id) === space.id
          ).length
          return (
            <li key={space.id}>
              <button
                type="button"
                className={`sidebar-context__row${space.id === activeSpaceId ? ' is-active' : ''}`}
                onClick={() => {
                  setActiveSpace(space.id)
                  openNav('graph')
                }}
              >
                <span className="sidebar-context__glyph" aria-hidden="true">
                  {space.emoji.trim() || '•'}
                </span>
                <span className="sidebar-context__label">{space.name}</span>
                <span className="sidebar-context__count">{count}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function ChatSidebar(): React.JSX.Element {
  const messages = useAppStore((state) => state.messages)
  const clearChat = useAppStore((state) => state.clearChat)
  const openNav = useAppStore((state) => state.openNav)
  const recent = messages.slice(-6).reverse()

  return (
    <section className="sidebar-context__section" aria-label="Recent chat">
      <ContextHead
        title="Recent"
        action={
          messages.length > 0 ? (
            <button type="button" className="sidebar-context__text-btn" onClick={clearChat}>
              Clear
            </button>
          ) : undefined
        }
      />
      {recent.length === 0 ? (
        <div className="sidebar-context__empty">
          <ChatIcon size={24} />
          <p>No messages yet.</p>
          <button type="button" className="sidebar-context__cta" onClick={() => openNav('agent')}>
            Start a chat
          </button>
        </div>
      ) : (
        <ul className="sidebar-context__list">
          {recent.map((message) => (
            <li key={message.id}>
              <button
                type="button"
                className="sidebar-context__row sidebar-context__row--stacked"
                onClick={() => openNav('agent')}
              >
                <span className="sidebar-context__meta">
                  {message.role === 'user' ? 'You' : 'SeeMO'}
                </span>
                <span className="sidebar-context__label">{message.text.trim() || '…'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function MiscSidebar(): React.JSX.Element {
  const alarms = useAppStore((state) => state.alarms)
  const timers = useAppStore((state) => state.timers)
  const stopwatches = useAppStore((state) => state.stopwatches)
  const openNav = useAppStore((state) => state.openNav)
  const rows = [
    { label: 'Alarms', count: alarms.length, icon: AlarmIcon },
    { label: 'Timers', count: timers.length, icon: TimerIcon },
    { label: 'Stopwatches', count: stopwatches.length, icon: StopwatchIcon }
  ]

  return (
    <section className="sidebar-context__section" aria-label="Tools">
      <ContextHead title="Tools" />
      <ul className="sidebar-context__list">
        {rows.map((row) => {
          const Icon = row.icon
          return (
            <li key={row.label}>
              <button
                type="button"
                className="sidebar-context__row"
                onClick={() => openNav('misc')}
              >
                <Icon size={15} />
                <span className="sidebar-context__label">{row.label}</span>
                <span className="sidebar-context__count">{row.count}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function ContextEmpty({
  icon,
  title,
  body
}: {
  icon: React.ReactNode
  title: string
  body: string
}): React.JSX.Element {
  return (
    <div className="sidebar-context__empty">
      {icon}
      <p className="sidebar-context__empty-title">{title}</p>
      <p>{body}</p>
    </div>
  )
}

function SidebarContext({ view }: { view: Exclude<SidebarView, 'notes'> }): React.JSX.Element {
  if (view === 'calendar') return <CalendarSidebar />
  if (view === 'tasks') return <TasksSidebar />
  if (view === 'graph') return <GraphSidebar />
  if (view === 'chat') return <ChatSidebar />
  if (view === 'misc') return <MiscSidebar />
  if (view === 'mail') {
    return (
      <ContextEmpty
        icon={<MailIcon size={24} />}
        title="Mail"
        body="Your inbox, folders, and filters will live here."
      />
    )
  }
  return (
    <ContextEmpty
      icon={<SettingsIcon size={24} />}
      title="Settings"
      body="Open Settings in the main view to adjust the app."
    />
  )
}

function Sidebar(): React.JSX.Element {
  const activeTab = useAppStore(
    (state) => state.tabs.find((t) => t.id === state.activeTabId) ?? null
  )
  // Nav destinations float above the notes: the sidebar selection tracks
  // which floating window (if any) is open.
  const activeNav = useAppStore((state) => state.activeNav)
  const sidebarView = sidebarViewFor(activeNav)
  const openNav = useAppStore((state) => state.openNav)
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
  const moveBookmark = useAppStore((state) => state.moveBookmark)
  const bookmarks = useAppStore((state) => state.bookmarks)
  const setQuery = useAppStore((state) => state.setQuery)
  const createNote = useAppStore((state) => state.createNote)
  const deleteNote = useAppStore((state) => state.deleteNote)
  const moveNote = useAppStore((state) => state.moveNote)
  const moveNoteToSpace = useAppStore((state) => state.moveNoteToSpace)
  const noteSections = useAppStore((state) => state.noteSections)
  const noteSection = useAppStore((state) => state.noteSection)
  const noteDividers = useAppStore((state) => state.noteDividers)
  const createSection = useAppStore((state) => state.createSection)
  const createDivider = useAppStore((state) => state.createDivider)
  const moveDivider = useAppStore((state) => state.moveDivider)
  const deleteDivider = useAppStore((state) => state.deleteDivider)
  const renameSection = useAppStore((state) => state.renameSection)
  const deleteSection = useAppStore((state) => state.deleteSection)
  const moveSection = useAppStore((state) => state.moveSection)
  const setSectionOrder = useAppStore((state) => state.setSectionOrder)
  const setNoteSection = useAppStore((state) => state.setNoteSection)
  const restoreNote = useAppStore((state) => state.restoreNote)
  const destroyNote = useAppStore((state) => state.destroyNote)
  const emptyTrash = useAppStore((state) => state.emptyTrash)
  const sidebarWidth = useAppStore((state) => state.sidebarWidth)
  const setSidebarWidth = useAppStore((state) => state.setSidebarWidth)
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)
  const goBackTab = useAppStore((state) => state.goBackTab)
  const goForwardTab = useAppStore((state) => state.goForwardTab)
  const tabHistory = useAppStore((state) => state.tabHistory)
  const historyIndex = useAppStore((state) => state.historyIndex)
  const canGoBack = historyIndex > 0
  const canGoForward = historyIndex >= 0 && historyIndex < tabHistory.length - 1

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; before: boolean } | null>(null)
  const [childDropId, setChildDropId] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [sectionDraggingId, setSectionDraggingId] = useState<string | null>(null)
  const [sectionDropHint, setSectionDropHint] = useState<{ id: string; before: boolean } | null>(
    null
  )
  const [dividerDraggingId, setDividerDraggingId] = useState<string | null>(null)
  const [dividerDropHint, setDividerDropHint] = useState<{ id: string; before: boolean } | null>(
    null
  )
  const [selectedDividerId, setSelectedDividerId] = useState<string | null>(null)
  const [dividerMenu, setDividerMenu] = useState<{
    dividerId: string
    x: number
    y: number
  } | null>(null)
  const [noteOverSection, setNoteOverSection] = useState<string | null>(null)
  const [dropNoteId, setDropNoteId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ noteId: string; x: number; y: number } | null>(null)
  const [navMenu, setNavMenu] = useState<{ key: NavKey; x: number; y: number } | null>(null)
  const [favDragging, setFavDragging] = useState<string | null>(null)
  const [favDropHint, setFavDropHint] = useState<{ token: string; before: boolean } | null>(null)
  const favDragRef = useRef<string | null>(null)
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
  const [pdfDropSpaceId, setPdfDropSpaceId] = useState<string | null>(null)
  const [pdfStatus, setPdfStatus] = useState<{ msg: string; error: boolean } | null>(null)
  const pdfStatusTimer = useRef<number | null>(null)
  // Trash lives in the rail now; the popover itself stays here (fixed
  // positioning), so the rail only flips this shared flag.
  const trashOpen = useAppStore((state) => state.trashOpen)
  const setTrashOpen = useAppStore((state) => state.setTrashOpen)
  const sidebarWidgets = useAppStore((state) => state.sidebarWidgets)
  const sidebarWidgetOrder = useAppStore((state) => state.sidebarWidgetOrder)
  const widgetOrder = (key: 'today' | 'favorites' | 'notes'): number => {
    const at = sidebarWidgetOrder.indexOf(key)
    return at < 0 ? 0 : at
  }

  useEffect(
    () => () => {
      if (pdfStatusTimer.current !== null) window.clearTimeout(pdfStatusTimer.current)
    },
    []
  )

  const flashPdfStatus = (msg: string, error: boolean): void => {
    setPdfStatus({ msg, error })
    if (pdfStatusTimer.current !== null) window.clearTimeout(pdfStatusTimer.current)
    pdfStatusTimer.current = window.setTimeout(() => setPdfStatus(null), 5000)
  }

  const importPdfs = async (files: File[], spaceId: string): Promise<boolean> => {
    const pdfs = files.filter(isPdfFile)
    if (pdfs.length === 0) return false
    try {
      const count = await importPdfFiles(pdfs, spaceId)
      flashPdfStatus(`Added ${count} PDF${count === 1 ? '' : 's'}`, false)
    } catch (error) {
      console.error('[sidebar] PDF import failed', error)
      flashPdfStatus(error instanceof Error ? error.message : 'Could not add the PDF.', true)
    }
    return true
  }

  const importPdfPicker = async (spaceId?: string): Promise<void> => {
    try {
      if (await importPdfFromDialog(spaceId)) flashPdfStatus('PDF added', false)
    } catch (error) {
      console.error('[sidebar] PDF import failed', error)
      flashPdfStatus(error instanceof Error ? error.message : 'Could not add the PDF.', true)
    }
  }

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

  // Favorites are cross-space for notes: jumping to one swaps the active space
  // first, then opens the note. Rail pages just switch the active view.
  const openFavorite = (item: FavoriteItem): void => {
    if (item.kind === 'nav') {
      openNav(item.key)
      return
    }
    const spaceId = item.note.spaceId ?? spaces[0]?.id
    if (spaceId && spaceId !== activeSpaceId) setActiveSpace(spaceId)
    openNoteInCurrentTab(item.note.id)
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

  // Drop side for a grid tile: above the row's middle means "before", and
  // within the same row the left half also means "before".
  const favoriteDropBefore = (event: React.DragEvent<HTMLButtonElement>): boolean => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (event.clientY < rect.top + rect.height / 2) return true
    return event.clientY < rect.bottom && event.clientX < rect.left + rect.width / 2
  }

  const favoriteDragProps = (
    token: string
  ): {
    draggable: true
    onDragStart: (event: React.DragEvent<HTMLButtonElement>) => void
    onDragEnd: () => void
    onDragOver: (event: React.DragEvent<HTMLButtonElement>) => void
    onDragLeave: () => void
    onDrop: (event: React.DragEvent<HTMLButtonElement>) => void
  } => ({
    draggable: true,
    onDragStart: (event) => {
      favDragRef.current = token
      setFavDragging(token)
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', token)
      beginSortableDrag(event, event.currentTarget)
    },
    onDragEnd: () => {
      favDragRef.current = null
      setFavDragging(null)
      setFavDropHint(null)
    },
    onDragOver: (event) => {
      if (!favDragRef.current || favDragRef.current === token) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setFavDropHint({ token, before: favoriteDropBefore(event) })
    },
    onDragLeave: () => setFavDropHint((hint) => (hint?.token === token ? null : hint)),
    onDrop: (event) => {
      event.preventDefault()
      const dragToken = favDragRef.current
      favDragRef.current = null
      setFavDragging(null)
      setFavDropHint(null)
      if (!dragToken || dragToken === token) return
      moveBookmark(dragToken, token, favoriteDropBefore(event))
    }
  })
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null)
  const [renameNoteDraft, setRenameNoteDraft] = useState('')
  const [resizing, setResizing] = useState(false)
  const dragIdRef = useRef<string | null>(null)
  const sectionDragRef = useRef<string | null>(null)
  const dividerDragRef = useRef<string | null>(null)
  const asideRef = useRef<HTMLElement>(null)
  const spaceCarouselRef = useRef<HTMLDivElement>(null)
  const spaceDragRef = useRef<string | null>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  // One swipe gesture = one switch: accumulate horizontal deltas, fire once
  // past the threshold, then swallow the rest of the burst (trackpad momentum)
  // until a short gap marks the next gesture.
  const swipeRef = useRef({ accum: 0, fired: false, lastAt: 0 })
  const resizeStartRef = useRef({ x: 0, width: 0 })

  const sortableHints = [
    ...(dropHint ? [{ id: `note:${dropHint.id}`, before: dropHint.before }] : []),
    ...(sectionDropHint
      ? [{ id: `section:${sectionDropHint.id}`, before: sectionDropHint.before }]
      : []),
    ...(dividerDropHint
      ? [{ id: `divider:${dividerDropHint.id}`, before: dividerDropHint.before }]
      : []),
    ...(favDropHint ? [{ id: `fav:${favDropHint.token}`, before: favDropHint.before }] : []),
    ...(spaceDropHint ? [{ id: `space:${spaceDropHint.id}`, before: spaceDropHint.before }] : [])
  ]
  useSortableMakeSpace({
    rootRef: asideRef,
    activeId: draggingId
      ? `note:${draggingId}`
      : sectionDraggingId
        ? `section:${sectionDraggingId}`
        : dividerDraggingId
          ? `divider:${dividerDraggingId}`
          : favDragging
            ? `fav:${favDragging}`
            : spaceDraggingId
              ? `space:${spaceDraggingId}`
              : null,
    hints: sortableHints
  })

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
    note.fileName.toLowerCase().includes(needle) ||
    note.content.toLowerCase().includes(needle)

  // Every space stays mounted and laid out side by side, so switching is a
  // horizontal slide of the whole track rather than a freeze/snapshot swap.
  // Outgoing `[[links]]` per note (deduped, self-links dropped). Top level
  // shows roots only: a note with a parent lives nested under it, never beside
  // it. While searching, fall back to a flat match list so results are never
  // hidden inside collapsed parents.
  const spaceViews = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const views = new Map<string, { graph: NoteGraph<Note>; visible: Note[] }>()
    for (const space of spaces) {
      const live = notes.filter(
        (note) => !note.deletedAt && (note.spaceId ?? spaces[0]?.id) === space.id
      )
      const graph = buildNoteGraph(orderedNotes(live, noteOrder))
      const visible = (needle ? orderedNotes(live, noteOrder) : graph.roots).filter(
        (note) =>
          !needle ||
          note.title.toLowerCase().includes(needle) ||
          note.content.toLowerCase().includes(needle)
      )
      views.set(space.id, { graph, visible })
    }
    return views
  }, [spaces, notes, noteOrder, query])
  // Favorites are global: rail pages and notes, in bookmark order. Pages come
  // from the nav registry; notes resolve against the vault and drop out when
  // trashed/deleted.
  const favoriteItems = useMemo(
    () =>
      bookmarks.flatMap((bookmark): FavoriteItem[] => {
        if (bookmark.kind === 'nav') {
          const nav = NAV_BY_KEY[bookmark.key]
          if (!nav) return []
          // Match the rail: the chat page shows the chat bubble, not the agent.
          const icon = bookmark.key === 'agent' ? ChatIcon : nav.icon
          return [{ kind: 'nav', key: bookmark.key, label: nav.label, icon }]
        }
        const note = notes.find((n) => n.id === bookmark.id)
        if (!note || note.deletedAt) return []
        return [{ kind: 'note', note }]
      }),
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
    setChildDropId(null)
    setNoteOverSection(null)
  }

  const clearSectionDrag = (): void => {
    sectionDragRef.current = null
    setSectionDraggingId(null)
    setSectionDropHint(null)
    setDropHint(null)
  }

  const clearDividerDrag = (): void => {
    dividerDragRef.current = null
    setDividerDraggingId(null)
    setDividerDropHint(null)
    setDropHint(null)
  }

  /** Notes that belong to a divider container ('' = top level). */
  const notesInContainer = (container: string, spaceId: string = activeSpaceId): Note[] =>
    (spaceViews.get(spaceId)?.visible ?? []).filter((note) =>
      container === ''
        ? sectionOf(note.id, spaceId) === null
        : sectionOf(note.id, spaceId) === container
    )

  /** Append order for a divider at the end of a container. */
  const endOrder = (container: string, spaceId: string = activeSpaceId): number =>
    notesInContainer(container, spaceId).length + 0.5

  // Valid section for a note within its space, or null when ungrouped
  // (unknown or cross-space ids fall out, so a note never goes missing).
  const sectionOf = (noteId: string, spaceId: string = activeSpaceId): string | null => {
    const id = noteSection[noteId]
    if (id === undefined) return null
    const section = noteSections.find((s) => s.id === id)
    return section && section.spaceId === spaceId ? id : null
  }

  const positionAbove = (event: React.DragEvent<HTMLElement>): boolean => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY - rect.top < rect.height / 2
  }

  const positionFromEvent = (event: React.DragEvent<HTMLLIElement>): boolean => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY - rect.top < rect.height / 2
  }

  /** Sections reserve the first slots in a space, so notes rank after them. */
  const topLevelBase = (spaceId: string = activeSpaceId): number =>
    noteSections.filter((section) => section.spaceId === spaceId).length

  /** Rank for a section dropped above/below a top-level note. */
  const sectionRankAtNote = (spaceId: string, noteIndex: number, before: boolean): number =>
    topLevelBase(spaceId) + noteIndex + (before ? -0.5 : 0.5)

  /** Rank that lands a section after every top-level item in a space. */
  const sectionEndRank = (spaceId: string): number => {
    const sections = noteSections.filter((section) => section.spaceId === spaceId)
    const ungrouped = (spaceViews.get(spaceId)?.visible ?? []).filter(
      (note) => sectionOf(note.id, spaceId) === null
    )
    const noteEnd = topLevelBase(spaceId) + ungrouped.length
    return Math.max(noteEnd, ...sections.map((section) => section.order)) + 0.5
  }

  /** True when the pointer sits in the middle band of a row: nest it there. */
  const isChildDrop = (event: React.DragEvent<HTMLElement>): boolean => {
    const rect = event.currentTarget.getBoundingClientRect()
    const y = event.clientY - rect.top
    return y > rect.height * 0.3 && y < rect.height * 0.7
  }

  /**
   * Remove a note from its recorded parents (hidden footer). Slash-created
   * children also have an inline `[[Child]]` in the old parent's body; strip
   * that too, otherwise the tree still shows the note under both parents.
   */
  const detachFromParents = (childId: string, keepParentId?: string): void => {
    const state = useAppStore.getState()
    const all = state.notes.filter((n) => !n.deletedAt)
    const child = all.find((n) => n.id === childId)
    if (!child) return
    const childTitle = child.title.trim() || 'Untitled'
    const needle = childTitle.toLowerCase()
    for (const note of all) {
      if (note.id === childId || note.id === keepParentId) continue
      const { body, hidden } = splitHidden(note.content)
      if (!hidden) continue
      if (!hidden.pages.some((p) => p.trim().toLowerCase() === needle)) continue
      const pages = hidden.pages.filter((p) => p.trim().toLowerCase() !== needle)
      const next = joinHidden(stripChildLinks(body, childTitle), { raw: '', pages })
      if (next === note.content) continue
      state.updateNote(note.id, { content: next })
      void state.saveNoteToVault(note.id)
    }
  }

  /**
   * Make `dragId` a child of `parentId` by adding `[[Child]]` to the parent's
   * hidden footer and removing it from any previous parent's footer.
   */
  const reparentNote = (dragId: string, parentId: string): void => {
    const state = useAppStore.getState()
    const all = state.notes.filter((n) => !n.deletedAt)
    const child = all.find((n) => n.id === dragId)
    const parent = all.find((n) => n.id === parentId)
    if (!child || !parent) return
    const childTitle = child.title.trim() || 'Untitled'
    // Refuse moves that would create a cycle (parent is already a descendant).
    const byId = new Map(all.map((n) => [n.id, n]))
    const seen = new Set([dragId])
    const queue = [dragId]
    while (queue.length > 0) {
      const cur = queue.shift() as string
      const note = byId.get(cur)
      if (!note) continue
      for (const link of parseWikiLinks(note.content)) {
        const id = resolveWikiTarget(link.target, all)
        if (!id || seen.has(id)) continue
        if (id === parentId) return
        seen.add(id)
        queue.push(id)
      }
    }
    const nextParent = addHiddenPage(parent.content, childTitle)
    if (nextParent !== parent.content) {
      state.updateNote(parentId, { content: nextParent })
      void state.saveNoteToVault(parentId)
    }
    detachFromParents(dragId, parentId)
  }

  const onNoteDrop = (event: React.DragEvent<HTMLLIElement>, noteId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    const dragId = dragIdRef.current
    clearDrag()
    if (dragId && dragId !== noteId) {
      // Dropping on an edge puts the note back at top level; a nested note
      // must detach from its old parent first.
      detachFromParents(dragId)
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
    const files = Array.from(event.dataTransfer.files ?? [])
    const pdfs = files.filter(isPdfFile)
    if (pdfs.length > 0) {
      const target = useAppStore.getState().notes.find((n) => n.id === noteId)
      if (!target || target.deletedAt) return
      try {
        const count = await importPdfFiles(pdfs, target.spaceId ?? activeSpaceId)
        flashPdfStatus(`Added ${count} PDF${count === 1 ? '' : 's'}`, false)
      } catch (error) {
        console.error('[sidebar] PDF drop failed', error)
        flashPdfStatus(error instanceof Error ? error.message : 'Could not add the PDF.', true)
      }
      return
    }
    const blocks: string[] = []
    for (const file of files) {
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
      detachFromParents(dragId)
      setNoteSection(dragId, null)
      moveNote(dragId, null, false)
    }
  }

  const onListDrop = (event: React.DragEvent<HTMLUListElement>, spaceId: string): void => {
    // Only fires for empty list space; note drops stop propagation above.
    // (Stop here too so the pane catch-all below doesn't double-handle it.)
    event.preventDefault()
    event.stopPropagation()
    const files = Array.from(event.dataTransfer.files ?? [])
    if (files.length > 0) {
      void importPdfs(files, spaceId).then((handled) => {
        if (!handled) flashPdfStatus('Drop a PDF here to add it to this space.', true)
      })
      return
    }
    if (sectionDragRef.current) {
      const dragId = sectionDragRef.current
      clearSectionDrag()
      setSectionOrder(dragId, sectionEndRank(spaceId))
      return
    }
    if (dividerDragRef.current) {
      const dragId = dividerDragRef.current
      clearDividerDrag()
      moveDivider(dragId, '', endOrder(''))
      return
    }
    ungroupDrop()
  }

  // Open background anywhere in the notes pane (gaps between sections and
  // padding): rows, dividers, and lists stop propagation when they handle a
  // drop, so reaching here means genuinely open space.
  const onPaneDrop = (event: React.DragEvent<HTMLDivElement>, spaceId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    const files = Array.from(event.dataTransfer.files ?? [])
    if (files.length > 0) {
      void importPdfs(files, spaceId).then((handled) => {
        if (!handled) flashPdfStatus('Drop a PDF here to add it to this space.', true)
      })
      return
    }
    if (sectionDragRef.current) {
      const dragId = sectionDragRef.current
      clearSectionDrag()
      setSectionOrder(dragId, sectionEndRank(spaceId))
      return
    }
    if (dividerDragRef.current) {
      const dragId = dividerDragRef.current
      clearDividerDrag()
      moveDivider(dragId, '', endOrder(''))
      return
    }
    ungroupDrop()
  }

  // Drop a note onto a section: file it there, pinned after that section's
  // last root so it lands inside the group.
  const assignToSection = (dragId: string, sectionId: string | null): void => {
    detachFromParents(dragId)
    const peers = (spaceViews.get(activeSpaceId)?.visible ?? []).filter(
      (n) => n.id !== dragId && sectionOf(n.id) === sectionId
    )
    setNoteSection(dragId, sectionId)
    if (peers.length > 0) moveNote(dragId, peers[peers.length - 1].id, false)
    else moveNote(dragId, null, false)
  }

  const onSectionDrop = (event: React.DragEvent<HTMLDivElement>, sectionId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    const secDrag = sectionDragRef.current
    const noteDrag = dragIdRef.current
    const divDrag = dividerDragRef.current
    clearDrag()
    clearSectionDrag()
    clearDividerDrag()
    // Divider-on-divider reorders sections; a line divider dropped on the
    // header joins the section; note-on-divider files the note.
    if (secDrag && secDrag !== sectionId) {
      moveSection(secDrag, sectionId, positionAbove(event))
    } else if (divDrag) {
      moveDivider(divDrag, sectionId, endOrder(sectionId))
    } else if (noteDrag) {
      assignToSection(noteDrag, sectionId)
    }
  }

  const onSectionListDrop = (event: React.DragEvent<HTMLUListElement>, sectionId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    const noteDrag = dragIdRef.current
    const divDrag = dividerDragRef.current
    clearDrag()
    clearDividerDrag()
    if (divDrag) moveDivider(divDrag, sectionId, endOrder(sectionId))
    else if (noteDrag) assignToSection(noteDrag, sectionId)
  }

  const newSection = (): void => {
    const id = createSection()
    const created = useAppStore.getState().noteSections.find((s) => s.id === id)
    setRenameDraft(created?.title ?? 'New section')
    setRenamingId(id)
  }

  // A plain line divider: no title, no rename — just a draggable separator
  // that can sit between notes, inside a section, or among a note's children.
  const newDivider = (): void => {
    const id = createDivider('')
    // Drop it after the last top-level note so it's visible immediately.
    moveDivider(id, '', endOrder(''))
    setSelectedDividerId(id)
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
    // Persist the parent's hidden footer immediately: opening the child
    // unmounts the parent editor and cancels its debounced autosave.
    void state.saveNoteToVault(parentId)
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
    if (
      !menu &&
      !navMenu &&
      !childMenu &&
      !spaceMenu &&
      !spaceItemMenu &&
      !spaceEditor &&
      !trashOpen &&
      !dividerMenu
    )
      return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenu(null)
        setNavMenu(null)
        setChildMenu(null)
        setSpaceMenu(null)
        setSpaceItemMenu(null)
        setSpaceEditor(null)
        setTrashOpen(false)
        setDividerMenu(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    menu,
    navMenu,
    childMenu,
    spaceMenu,
    spaceItemMenu,
    spaceEditor,
    trashOpen,
    dividerMenu,
    setTrashOpen
  ])

  // A selected divider can be removed with Backspace/Delete. Ignore the key
  // while typing so inline renames and search keep their normal behavior.
  useEffect(() => {
    if (!selectedDividerId) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Backspace' && event.key !== 'Delete') return
      const active = document.activeElement as HTMLElement | null
      if (
        active &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
      )
        return
      event.preventDefault()
      deleteDivider(selectedDividerId)
      setSelectedDividerId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedDividerId, deleteDivider])

  // Clicking outside the selected divider clears the selection.
  useEffect(() => {
    if (!selectedDividerId) return
    const onDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement
      if (!target.closest(`[data-divider-row="${selectedDividerId}"]`)) {
        setSelectedDividerId(null)
      }
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [selectedDividerId])

  const expandAll = (): void => {
    setExpandedIds(new Set((spaceViews.get(activeSpaceId)?.visible ?? []).map((n) => n.id)))
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
  // A plain line divider row. Selectable (Backspace removes it), draggable
  // between notes, and a drop target for other dividers.
  const renderDivider = (divider: NoteDivider): React.JSX.Element => {
    const isSelected = selectedDividerId === divider.id
    const hint = dividerDropHint?.id === divider.id ? dividerDropHint : null
    return (
      <li
        key={divider.id}
        data-divider-row={divider.id}
        data-sortable-item
        data-sortable-id={`divider:${divider.id}`}
        className={`sidebar__divider-row${dividerDraggingId === divider.id ? ' is-dragging' : ''}${isSelected ? ' is-selected' : ''}${hint ? (hint.before ? ' is-drop-before' : ' is-drop-after') : ''}`}
        draggable
        onDragStart={(event) => {
          dividerDragRef.current = divider.id
          setDividerDraggingId(divider.id)
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', divider.id)
          beginSortableDrag(event, event.currentTarget)
        }}
        onDragEnd={() => clearDividerDrag()}
        onClick={(event) => {
          event.stopPropagation()
          setSelectedDividerId(divider.id)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setSelectedDividerId(divider.id)
          setDividerMenu({
            dividerId: divider.id,
            ...clampMenu(event.clientX, event.clientY, 60)
          })
        }}
        onDragOver={(event) => {
          if (dividerDragRef.current && dividerDragRef.current !== divider.id) {
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = 'move'
            setDropHint(null)
            setSectionDropHint(null)
            setDividerDropHint({ id: divider.id, before: positionAbove(event) })
          } else if (dragIdRef.current) {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
          }
        }}
        onDragLeave={() =>
          setDividerDropHint((current) => (current?.id === divider.id ? null : current))
        }
        onDrop={(event) => {
          if (!dividerDragRef.current) return
          event.preventDefault()
          event.stopPropagation()
          const dragId = dividerDragRef.current
          if (dragId === divider.id) {
            clearDividerDrag()
            return
          }
          const before = positionAbove(event)
          clearDividerDrag()
          moveDivider(dragId, divider.container, divider.order + (before ? -0.25 : 0.25))
        }}
      >
        <span className="sidebar__divider-rule" aria-hidden="true" />
        <div className="sidebar__divider-actions">
          <button
            type="button"
            className="sidebar__icon-btn sidebar__icon-btn--danger"
            title="Delete divider"
            aria-label="Delete divider"
            onClick={(event) => {
              event.stopPropagation()
              deleteDivider(divider.id)
              setSelectedDividerId(null)
            }}
          >
            <XIcon size={13} />
          </button>
        </div>
      </li>
    )
  }

  // Interleave a container's dividers with its notes (notes rank as 0,1,2…;
  // dividers use fractional orders so they can sit *between* notes).
  const withDividers = (
    container: string,
    listNotes: Note[],
    spaceId: string,
    renderNote: (note: Note, index: number) => React.JSX.Element
  ): React.JSX.Element[] => {
    const items = listNotes.map((note, index) => ({
      rank: index,
      node: renderNote(note, index)
    }))
    for (const divider of noteDividers) {
      if (divider.spaceId !== spaceId || divider.container !== container) continue
      items.push({ rank: divider.order, node: renderDivider(divider) })
    }
    items.sort((a, b) => a.rank - b.rank)
    return items.map((item) => item.node)
  }

  // child pages nested beneath it. Only top-level rows are draggable; nested
  // rows are link views into the same flat order. `ancestors` guards cycles.
  // Study children render their app icon; custom note emoji win over the
  // default page icon.
  const renderTree = (
    note: Note,
    depth: number,
    ancestors: string[],
    container: string,
    index: number,
    spaceId: string
  ): React.JSX.Element => {
    const noteBody = splitHidden(note.content).body
    const studyType = parseStudyChild(noteBody)?.type ?? null
    const pdfType = pdfFileForNote(note)
    const noteEmoji = note.emoji?.trim() ?? ''
    const NoteIcon =
      studyType === 'flashcards'
        ? CardsIcon
        : studyType === 'mindmap'
          ? MindmapIcon
          : studyType === 'quiz'
            ? QuizIcon
            : pdfType
              ? PdfIcon
              : FileTextIcon
    const graph = spaceViews.get(spaceId)?.graph
    const kids = (graph?.children.get(note.id) ?? []).filter(
      (kid) => !ancestors.includes(kid.id) && matchesQuery(kid)
    )
    const isOpen = expandedIds.has(note.id)
    const hint = dropHint?.id === note.id ? dropHint : null
    const dragAttrs = {
      draggable: true,
      onDragStart: (event: React.DragEvent<HTMLLIElement>): void => {
        // Nested rows are inside their parent's draggable row: without this,
        // the dragstart bubbles and the parent overwrites the dragged id.
        event.stopPropagation()
        dragIdRef.current = note.id
        setDraggingId(note.id)
        event.dataTransfer.effectAllowed = 'move'
        beginSortableDrag(
          event,
          event.currentTarget,
          event.currentTarget.querySelector<HTMLElement>('.sidebar__row') ?? event.currentTarget
        )
      },
      onDragEnd: () => {
        clearDrag()
        setDropNoteId(null)
      },
      onDragOver: (event: React.DragEvent<HTMLLIElement>): void => {
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        if (dividerDragRef.current) {
          setChildDropId(null)
          setSectionDropHint(null)
          setDividerDropHint(null)
          setDropHint({ id: note.id, before: positionFromEvent(event) })
        } else if (sectionDragRef.current && depth === 0 && !needle && container === '') {
          setChildDropId(null)
          setSectionDropHint(null)
          setDropHint({ id: note.id, before: positionFromEvent(event) })
        } else if (dragIdRef.current && dragIdRef.current !== note.id) {
          setSectionDropHint(null)
          // Middle of the row = make the dragged note a child of this one;
          // top/bottom edges keep the usual before/after reorder.
          if (depth > 0 || isChildDrop(event)) {
            setDropHint(null)
            setChildDropId(note.id)
          } else {
            setChildDropId(null)
            setDropHint({ id: note.id, before: positionFromEvent(event) })
          }
        }
        if (isPictureDragTypes(event.dataTransfer.types ?? [])) {
          setDropNoteId(note.id)
        }
      },
      onDragLeave: (event: React.DragEvent<HTMLLIElement>) => {
        event.stopPropagation()
        setDropNoteId(null)
        setChildDropId(null)
      },
      onDrop: (event: React.DragEvent<HTMLLIElement>): void => {
        // A section dropped on a top-level row takes that note's slot,
        // letting sections sit between and around notes.
        if (sectionDragRef.current && depth === 0 && !needle && container === '') {
          event.preventDefault()
          event.stopPropagation()
          const dragId = sectionDragRef.current
          const before = positionFromEvent(event)
          clearSectionDrag()
          setSectionOrder(dragId, sectionRankAtNote(spaceId, index, before))
          setDropNoteId(null)
          return
        }
        // A line divider dropped on a row lands before/after that note
        // in the same container (top level, section, or children).
        if (dividerDragRef.current) {
          event.preventDefault()
          event.stopPropagation()
          const dragId = dividerDragRef.current
          const before = positionFromEvent(event)
          clearDividerDrag()
          moveDivider(dragId, container, index + (before ? -0.5 : 0.5))
          setDropNoteId(null)
          return
        }
        const dragId = dragIdRef.current
        if (dragId && dragId !== note.id && (depth > 0 || isChildDrop(event))) {
          event.preventDefault()
          event.stopPropagation()
          clearDrag()
          reparentNote(dragId, note.id)
          // Keep the new child visible under a previously collapsed parent.
          setExpandedIds((prev) => new Set(prev).add(note.id))
          setDropNoteId(null)
          return
        }
        // Internal reorders (note/section drags) keep working when the
        // platform reports no types; anything carrying files or URLs
        // from outside the app is a picture drop.
        const internal = dragIdRef.current !== null || sectionDragRef.current !== null
        const external =
          event.dataTransfer.files.length > 0 ||
          event.dataTransfer.getData('text/uri-list').trim().length > 0
        if (external && !internal) void onRowDropPictures(event, note.id)
        else if (depth === 0) onNoteDrop(event, note.id)
        setDropNoteId(null)
      }
    }
    const renaming = renamingNoteId === note.id
    return (
      <li
        key={note.id}
        {...dragAttrs}
        data-sortable-item
        data-sortable-id={`note:${note.id}`}
        className={`sidebar__note${draggingId === note.id ? ' sidebar__note--dragging' : ''}${hint ? (hint.before ? ' sidebar__note--drop-before' : ' sidebar__note--drop-after') : ''}${childDropId === note.id ? ' sidebar__note--drop-child' : ''}${dropNoteId === note.id ? ' is-drop-target' : ''}`}
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
            {!studyType && !pdfType && (
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
          <ul
            className="sidebar__notes sidebar__notes--nested"
            data-sortable-list
            onDragOver={(event) => {
              event.preventDefault()
              if (dragIdRef.current && dragIdRef.current !== note.id) setChildDropId(note.id)
            }}
            onDrop={(event) => {
              if (dividerDragRef.current) {
                event.preventDefault()
                event.stopPropagation()
                const dragId = dividerDragRef.current
                clearDividerDrag()
                moveDivider(dragId, note.id, kids.length + 0.5)
                return
              }
              const dragId = dragIdRef.current
              if (!dragId) return
              event.preventDefault()
              event.stopPropagation()
              clearDrag()
              if (dragId !== note.id) reparentNote(dragId, note.id)
              setExpandedIds((prev) => new Set(prev).add(note.id))
            }}
          >
            {withDividers(note.id, kids, spaceId, (kid, kidIndex) =>
              renderTree(kid, depth + 1, [...ancestors, note.id], note.id, kidIndex, spaceId)
            )}
          </ul>
        )}
      </li>
    )
  }

  // One custom section: draggable divider header plus its notes. Dividers
  // reorder against each other; notes dropped on the header or its list get
  // filed into the section.
  const renderSection = (
    section: { id: string; title: string },
    spaceId: string
  ): React.JSX.Element => {
    const roots = (spaceViews.get(spaceId)?.visible ?? []).filter(
      (note) => sectionOf(note.id, spaceId) === section.id
    )
    const collapsed = collapsedIds.has(section.id)
    const renaming = renamingId === section.id
    const hint = sectionDropHint?.id === section.id ? sectionDropHint : null
    return (
      <li
        key={section.id}
        className="sidebar__section-block"
        data-sortable-item
        data-sortable-id={`section:${section.id}`}
      >
        <div
          draggable={!renaming}
          onDragStart={(event) => {
            sectionDragRef.current = section.id
            setSectionDraggingId(section.id)
            event.dataTransfer.effectAllowed = 'move'
            beginSortableDrag(
              event,
              event.currentTarget.closest<HTMLElement>('li') ?? event.currentTarget,
              event.currentTarget
            )
          }}
          onDragEnd={clearSectionDrag}
          onDragOver={(event) => {
            if (sectionDragRef.current && sectionDragRef.current !== section.id) {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setDropHint(null)
              setSectionDropHint({ id: section.id, before: positionAbove(event) })
            } else if (dragIdRef.current || dividerDragRef.current) {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              const last = roots.filter((note) => note.id !== dragIdRef.current).at(-1)
              setDropHint(last ? { id: last.id, before: false } : null)
              setNoteOverSection(section.id)
            }
          }}
          onDragLeave={() => {
            setNoteOverSection(null)
            setDropHint(null)
          }}
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
              title="Collapse · double-click to rename · drag to reorder or place between notes"
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
            data-sortable-list
            onDragOver={(event) => {
              event.preventDefault()
              if (dragIdRef.current || dividerDragRef.current) {
                const last = roots.filter((note) => note.id !== dragIdRef.current).at(-1)
                setDropHint(last ? { id: last.id, before: false } : null)
              }
            }}
            onDrop={(event) => onSectionListDrop(event, section.id)}
          >
            {withDividers(section.id, roots, spaceId, (note, noteIndex) =>
              renderTree(note, 0, [], section.id, noteIndex, spaceId)
            )}
          </ul>
        )}
      </li>
    )
  }

  // Sections, top-level notes, and line dividers share one ranked list so a
  // section can sit above, below, or between notes.
  const renderTopLevel = (
    spaceId: string,
    sections: NoteSection[],
    ungrouped: Note[]
  ): React.JSX.Element => {
    const base = sections.length
    const items = [
      ...sections.map((section) => ({
        rank: section.order,
        node: renderSection(section, spaceId)
      })),
      ...ungrouped.map((note, noteIndex) => ({
        rank: base + noteIndex,
        node: renderTree(note, 0, [], '', noteIndex, spaceId)
      })),
      ...noteDividers
        .filter((divider) => divider.spaceId === spaceId && divider.container === '')
        .map((divider) => ({ rank: base + divider.order, node: renderDivider(divider) }))
    ]
    if (items.length === 0) return <p className="sidebar__empty">No notes yet — create one.</p>
    items.sort((a, b) => a.rank - b.rank)
    return (
      <ul
        className="sidebar__notes"
        data-sortable-list
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => onListDrop(event, spaceId)}
      >
        {items.map((item) => item.node)}
      </ul>
    )
  }

  const activeSpaceIndex = spaces.findIndex((space) => space.id === activeSpaceId)
  const activeSpace = activeSpaceIndex >= 0 ? spaces[activeSpaceIndex] : null
  const activeSpaceNumber = activeSpaceIndex >= 0 ? activeSpaceIndex + 1 : 0
  // The Notes header names the active space (falling back to its number when
  // unnamed); with no spaces at all it stays "Notes".
  const notesTitle =
    activeSpace != null ? activeSpace.name.trim() || `Space ${activeSpaceNumber}` : 'Notes'

  // Switch to a space; the track's transform reveals its pane.
  const goToSpace = (id: string): void => {
    if (id === activeSpaceId || !spaces.some((space) => space.id === id)) return
    setActiveSpace(id)
  }

  // Step one space (dir +1 = next, -1 = previous), wrapping around.
  const stepSpace = (step: 1 | -1): void => {
    if (spaces.length < 2) return
    const index = spaces.findIndex((space) => space.id === activeSpaceId)
    if (index < 0) return
    const next = spaces[(index + step + spaces.length) % spaces.length]
    if (next) {
      // Claim the gesture: the content's page-history swipe must ignore the
      // same trackpad motion while the space switch settles.
      markSpaceSwipe()
      goToSpace(next.id)
    }
  }

  // Trackpad two-finger horizontal swipe.
  const onSpaceWheel = (event: React.WheelEvent<HTMLElement>): void => {
    if (spaces.length < 2) return
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
    const target = event.target as HTMLElement
    if (
      target.closest(
        'input, textarea, [contenteditable="true"], pre, .tabbar__list, .sidebar__favorites'
      )
    )
      return
    // The sidebar owns horizontal swipes here; never let one reach page history.
    event.stopPropagation()
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
        if (
          (event.target as HTMLElement).closest(
            'input, textarea, [contenteditable="true"], .sidebar__favorites'
          )
        )
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
        <div className="sidebar__chrome">
          <button
            type="button"
            className="sidebar__chrome-btn"
            title="Collapse sidebar (Ctrl+S)"
            aria-label="Collapse sidebar"
            onClick={toggleSidebar}
          >
            <SidebarToggleIcon size={16} />
          </button>
          <button
            type="button"
            className="sidebar__chrome-btn"
            title="Back to the previous tab"
            aria-label="Back to the previous tab"
            disabled={!canGoBack}
            onClick={goBackTab}
          >
            <ChevronLeftIcon size={16} />
          </button>
          <button
            type="button"
            className="sidebar__chrome-btn"
            title="Forward to the next tab"
            aria-label="Forward to the next tab"
            disabled={!canGoForward}
            onClick={goForwardTab}
          >
            <ChevronRightIcon size={16} />
          </button>
          <button
            type="button"
            key={coreState}
            className={`sidebar__state sidebar__state--${coreState} sidebar__status sidebar__status--chrome`}
            title={`Core: ${coreState} · open SeeMO`}
            aria-label={`Core status: ${coreState} · open SeeMO`}
            onClick={() => useAppStore.getState().openNav('agent')}
          />
        </div>
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
        {sidebarView === 'notes' ? (
          <>
            {sidebarWidgets.today && (
              <div className="sidebar__widget" style={{ order: widgetOrder('today') }}>
                <TodaySection />
              </div>
            )}

            {sidebarWidgets.favorites && favoriteItems.length > 0 && (
              <div
                className="sidebar__favorites"
                data-sortable-list
                data-sortable-axis="x"
                style={{ order: widgetOrder('favorites') }}
                role="group"
                aria-label="Favorites"
              >
                {favoriteItems.map((item) => {
                  const token = favoriteToken(item)
                  const dragClass = `${favDragging === token ? ' is-dragging' : ''}${
                    favDropHint?.token === token
                      ? favDropHint.before
                        ? ' is-drop-before'
                        : ' is-drop-after'
                      : ''
                  }`
                  if (item.kind === 'nav') {
                    const Icon = item.icon
                    const isCurrent = activeNav === item.key
                    return (
                      <button
                        key={`nav:${item.key}`}
                        type="button"
                        data-sortable-item
                        data-sortable-id={`fav:${token}`}
                        className={`sidebar__fav${isCurrent ? ' is-active' : ''}${dragClass}`}
                        title={item.label}
                        aria-label={`${item.label}${isCurrent ? ', open' : ''}`}
                        onClick={() => openFavorite(item)}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setNavMenu({ key: item.key, x: event.clientX, y: event.clientY })
                        }}
                        {...favoriteDragProps(token)}
                      >
                        <Icon size={17} />
                      </button>
                    )
                  }
                  const { note } = item
                  const label = note.title.trim() || 'Untitled'
                  const space = spaces.find((s) => s.id === note.spaceId)
                  const emoji = note.emoji?.trim() ?? ''
                  const pdf = pdfFileForNote(note)
                  const isCurrent = activeTab?.noteId === note.id
                  return (
                    <button
                      key={`note:${note.id}`}
                      type="button"
                      data-sortable-item
                      data-sortable-id={`fav:${token}`}
                      className={`sidebar__fav${isCurrent ? ' is-active' : ''}${dragClass}`}
                      title={`${label}${space ? ` · ${space.name}` : ''}`}
                      aria-label={`${label}${isCurrent ? ', open' : ''}`}
                      onClick={() => openFavorite(item)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        openMenuAt(note.id, event.clientX, event.clientY)
                      }}
                      {...favoriteDragProps(token)}
                    >
                      {emoji ? (
                        <span className="sidebar__fav-emoji" aria-hidden="true">
                          {emoji}
                        </span>
                      ) : pdf ? (
                        <PdfIcon size={17} />
                      ) : (
                        <FileTextIcon size={17} />
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            {sidebarWidgets.notes && (
              <div className="sidebar__section" style={{ order: widgetOrder('notes') }}>
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
                    title={activeSpace ? `Import PDF into ${activeSpace.name}` : 'Import PDF'}
                    aria-label={activeSpace ? `Import PDF into ${activeSpace.name}` : 'Import PDF'}
                    onClick={() => void importPdfPicker(activeSpaceId || undefined)}
                  >
                    <PdfIcon size={17} />
                  </button>
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

                {pdfStatus && (
                  <p className={`sidebar__pdf-status${pdfStatus.error ? ' is-error' : ''}`}>
                    {pdfStatus.msg}
                  </p>
                )}

                <div className="sidebar__space-swap">
                  <div
                    className="sidebar__space-track"
                    style={{
                      transform: `translateX(-${activeSpaceIndex < 0 ? 0 : activeSpaceIndex * 100}%)`
                    }}
                  >
                    {(spaces.length > 0 ? spaces : [{ id: '', name: '', emoji: '' }]).map(
                      (space) => {
                        const visible = spaceViews.get(space.id)?.visible ?? []
                        const sections = noteSections.filter(
                          (section) => section.spaceId === space.id
                        )
                        const ungrouped = visible.filter(
                          (note) => sectionOf(note.id, space.id) === null
                        )
                        const isActive = space.id === activeSpaceId
                        return (
                          <div
                            key={space.id}
                            className={`sidebar__space-pane${draggingId && isActive ? ' is-dragging' : ''}`}
                            aria-hidden={isActive ? undefined : true}
                            inert={!isActive}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => onPaneDrop(event, space.id)}
                          >
                            {needle ? (
                              visible.length === 0 ? (
                                <p className="sidebar__empty">No notes match your search.</p>
                              ) : (
                                <ul
                                  className="sidebar__notes"
                                  data-sortable-list
                                  onDragOver={(event) => event.preventDefault()}
                                  onDrop={(event) => onListDrop(event, space.id)}
                                >
                                  {visible.map((note, noteIndex) =>
                                    renderTree(note, 0, [], '', noteIndex, space.id)
                                  )}
                                </ul>
                              )
                            ) : (
                              renderTopLevel(space.id, sections, ungrouped)
                            )}
                          </div>
                        )
                      }
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="sidebar-context">
            <SidebarContext view={sidebarView} />
          </div>
        )}
      </div>

      {(menu ||
        navMenu ||
        childMenu ||
        spaceMenu ||
        spaceItemMenu ||
        spaceEditor ||
        noteIconEditor ||
        trashOpen ||
        dividerMenu) && (
        <div
          className="note-menu__backdrop"
          aria-hidden="true"
          onClick={() => {
            setMenu(null)
            setNavMenu(null)
            setChildMenu(null)
            setSpaceMenu(null)
            setSpaceItemMenu(null)
            setSpaceEditor(null)
            setNoteIconEditor(null)
            setTrashOpen(false)
            setDividerMenu(null)
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenu(null)
            setNavMenu(null)
            setChildMenu(null)
            setSpaceMenu(null)
            setSpaceItemMenu(null)
            setSpaceEditor(null)
            setNoteIconEditor(null)
            setTrashOpen(false)
            setDividerMenu(null)
          }}
        />
      )}
      {dividerMenu &&
        (() => {
          const target = noteDividers.find((divider) => divider.id === dividerMenu.dividerId)
          if (!target) return null
          return (
            <div
              className="note-menu note-menu--fixed"
              role="menu"
              aria-label="Divider actions"
              style={{ left: dividerMenu.x, top: dividerMenu.y }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                type="button"
                className="note-menu__item note-menu__item--danger"
                onClick={() => {
                  deleteDivider(target.id)
                  setSelectedDividerId(null)
                  setDividerMenu(null)
                }}
              >
                <TrashIcon size={14} />
                Delete divider
              </button>
            </div>
          )
        })()}
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
          <button
            type="button"
            className="note-menu__item"
            onClick={() => {
              setSpaceMenu(null)
              newDivider()
            }}
          >
            New divider
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
              <span className="space-editor__glyph glyph-mono" aria-hidden="true">
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
          <div className="space-editor__section">
            <span className="space-editor__section-label">Icon</span>
            <div className="space-editor__emojis" role="group" aria-label="Choose an icon">
              <button
                type="button"
                className={`space-editor__emoji space-editor__emoji--none${spaceEmoji.trim() === '' ? ' is-active' : ''}`}
                aria-label="No icon (dot)"
                aria-pressed={spaceEmoji.trim() === ''}
                title="No icon — show a dot"
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
                  <span className="glyph-mono">{emoji}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-editor__section">
            <span className="space-editor__section-label">Emoji</span>
            <input
              className="space-editor__custom"
              value={spaceEmoji}
              placeholder="Type or paste an emoji (empty for dot)"
              aria-label="Type an emoji"
              maxLength={8}
              onChange={(event) => setSpaceEmoji(event.target.value)}
            />
          </div>
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
                <span className="space-editor__glyph glyph-mono" aria-hidden="true">
                  {draft || <FileTextIcon size={20} />}
                </span>
                <span className="space-editor__note-label" title={label}>
                  {label}
                </span>
              </div>
              <div className="space-editor__section">
                <span className="space-editor__section-label">Icon</span>
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
                      <span className="glyph-mono">{emoji}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-editor__section">
                <span className="space-editor__section-label">Emoji</span>
                <input
                  className="space-editor__custom"
                  value={noteIconEmoji}
                  placeholder="Type or paste an emoji (empty for default)"
                  aria-label="Type an emoji"
                  maxLength={8}
                  onChange={(event) => setNoteIconEmoji(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') saveNoteIcon()
                  }}
                />
              </div>
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
      {navMenu &&
        (() => {
          const nav = NAV_BY_KEY[navMenu.key]
          if (!nav) return null
          const Icon = navMenu.key === 'agent' ? ChatIcon : nav.icon
          const at = clampMenu(navMenu.x, navMenu.y, 100)
          return (
            <div
              className="note-menu note-menu--fixed"
              role="menu"
              aria-label={`Actions for ${nav.label}`}
              style={{ left: at.x, top: at.y }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                type="button"
                className="note-menu__item"
                onClick={() => {
                  setNavMenu(null)
                  openNav(navMenu.key)
                }}
              >
                <Icon size={14} />
                Open {nav.label}
              </button>
              <button
                type="button"
                className="note-menu__item"
                onClick={() => {
                  setNavMenu(null)
                  toggleBookmark({ kind: 'nav', key: navMenu.key })
                }}
              >
                <BookmarkIcon size={14} />
                Remove from Favorites
              </button>
            </div>
          )
        })()}
      {menu &&
        (() => {
          const target = notes.find((n) => n.id === menu.noteId)
          if (!target || target.deletedAt) return null
          const label = target.title.trim() || 'Untitled'
          const isBookmarked = bookmarks.some(
            (bookmark) => bookmark.kind === 'note' && bookmark.id === target.id
          )
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
                  toggleBookmark({ kind: 'note', id: target.id })
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
        <div
          className="sidebar__space-icons"
          data-sortable-list
          data-sortable-axis="x"
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
                data-sortable-item
                data-sortable-id={`space:${space.id}`}
                draggable
                className={`sidebar__space-icon${space.id === activeSpaceId ? ' is-active' : ''} is-distance-${Math.min(circularDistance, 3)}${spaceDraggingId === space.id ? ' is-dragging' : ''}${spaceDropHint?.id === space.id ? (spaceDropHint.before ? ' is-drop-before' : ' is-drop-after') : ''}${pdfDropSpaceId === space.id ? ' is-pdf-drop' : ''}`}
                title={space.emoji.trim() ? `${space.emoji} ${space.name}` : space.name}
                aria-label={`${space.name}${space.id === activeSpaceId ? ', current space' : ''}`}
                aria-pressed={space.id === activeSpaceId}
                onClick={() => goToSpace(space.id)}
                onDragStart={(event) => {
                  spaceDragRef.current = space.id
                  setSpaceDraggingId(space.id)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', space.id)
                  beginSortableDrag(event, event.currentTarget)
                }}
                onDragEnd={() => {
                  spaceDragRef.current = null
                  setSpaceDraggingId(null)
                  setSpaceDropHint(null)
                }}
                onDragOver={(event) => {
                  if (spaceDragRef.current) {
                    if (spaceDragRef.current === space.id) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    const rect = event.currentTarget.getBoundingClientRect()
                    setSpaceDropHint({
                      id: space.id,
                      before: event.clientX < rect.left + rect.width / 2
                    })
                    return
                  }
                  const hasFiles = Array.from(event.dataTransfer.types ?? []).some(
                    (type) => type === 'Files'
                  )
                  if (dragIdRef.current || hasFiles) {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = dragIdRef.current ? 'move' : 'copy'
                    setPdfDropSpaceId(space.id)
                  }
                }}
                onDragLeave={() => {
                  setSpaceDropHint((hint) => (hint?.id === space.id ? null : hint))
                  setPdfDropSpaceId((id) => (id === space.id ? null : id))
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (spaceDragRef.current) {
                    const dragId = spaceDragRef.current
                    spaceDragRef.current = null
                    setSpaceDraggingId(null)
                    setSpaceDropHint(null)
                    if (!dragId || dragId === space.id) return
                    const rect = event.currentTarget.getBoundingClientRect()
                    moveSpace(dragId, space.id, event.clientX < rect.left + rect.width / 2)
                    return
                  }
                  const noteId = dragIdRef.current
                  if (noteId) {
                    clearDrag()
                    setPdfDropSpaceId(null)
                    if (space.id !== activeSpaceId) {
                      moveNoteToSpace(noteId, space.id)
                      flashPdfStatus(`Moved to ${space.name}`, false)
                    }
                    return
                  }
                  const files = Array.from(event.dataTransfer.files ?? [])
                  setPdfDropSpaceId(null)
                  if (files.length === 0) return
                  void importPdfs(files, space.id).then((handled) => {
                    if (!handled) {
                      flashPdfStatus('Drop a PDF here to add it to this space.', true)
                    }
                  })
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
                  <span className="glyph-mono" aria-hidden="true">
                    {space.emoji}
                  </span>
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
      </div>

      {trashOpen && (
        <div className="rail-menu rail-menu--trash" role="dialog" aria-label="Trash">
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

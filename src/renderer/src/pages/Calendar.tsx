import { useMemo, useState } from 'react'
import { LOCAL_CALENDAR_ID, TASK_COLOR, type CalendarItem } from '../planner'
import { useAppStore } from '../store/appStore'
import {
  CALENDAR_COLORS,
  addDays,
  addMonths,
  defaultCalendarColor,
  expandItemDates,
  formatDayLabel,
  formatTime,
  fromISODate,
  isTaskDone,
  itemEndTime,
  itemStartTime,
  layoutDayColumns,
  minutesOf,
  monthGrid,
  monthLabel,
  normalizeTimeInput,
  parseISODate,
  todayISO,
  toISODate,
  toTimeString,
  weekRange
} from '../planner'
import PlannerDialog, {
  type DialogKind,
  type PlannerDialogTarget
} from '../components/PlannerDialog'
import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  TaskIcon,
  XIcon
} from '../components/icons'

type EntryKind = 'event' | 'task'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_CELL_LIMIT = 3
const HOUR_HEIGHT = 48

interface DayEntry {
  key: string
  title: string
  kind: EntryKind
  done: boolean
  color: string
  startMin: number | null
  endMin: number | null
  location: string
  recurring: boolean
  readOnly: boolean
  open: () => void
}

interface SourceView {
  id: string
  name: string
  color: string
  enabled: boolean
  readOnly: boolean
  error: string | null
}

function Calendar(): React.JSX.Element {
  const calendarItems = useAppStore((state) => state.calendarItems)
  const tasks = useAppStore((state) => state.tasks)
  const subscriptions = useAppStore((state) => state.subscriptions)
  const localCalendarColor = useAppStore((state) => state.localCalendarColor)
  const plannerReady = useAppStore((state) => state.plannerReady)
  const plannerError = useAppStore((state) => state.plannerError)
  const openNav = useAppStore((state) => state.openNav)

  const view = useAppStore((state) => state.calendarView)
  const setView = useAppStore((state) => state.setCalendarView)
  const cursor = useAppStore((state) => state.calendarCursor)
  const setCursor = useAppStore((state) => state.setCalendarCursor)

  const [dialog, setDialog] = useState<PlannerDialogTarget | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  const today = todayISO()
  const openCount = tasks.filter((t) => !isTaskDone(t)).length

  const sources: SourceView[] = useMemo(
    () => [
      {
        id: LOCAL_CALENDAR_ID,
        name: 'SeeMO',
        color: localCalendarColor,
        enabled: true,
        readOnly: false,
        error: null
      },
      ...subscriptions.map((sub) => ({
        id: sub.id,
        name: sub.name,
        color: sub.color,
        enabled: sub.enabled,
        readOnly: true,
        error: sub.error
      }))
    ],
    [localCalendarColor, subscriptions]
  )

  // Expand every visible calendar (recurrences included) across the range the
  // current view can show, so month overflow cells are covered too.
  const [rangeStart, rangeEnd] = useMemo(() => {
    if (view === 'month') {
      const { year, month } = parseISODate(cursor)
      const cells = monthGrid(year, month)
      return [cells[0], cells[cells.length - 1]] as const
    }
    if (view === 'week') {
      const week = weekRange(cursor)
      return [week[0], week[6]] as const
    }
    return [cursor, cursor] as const
  }, [view, cursor])

  const entriesByDate = useMemo(() => {
    const map = new Map<string, DayEntry[]>()
    const push = (date: string, entry: DayEntry): void => {
      const list = map.get(date)
      if (list) list.push(entry)
      else map.set(date, [entry])
    }

    const itemsFor = (id: string): CalendarItem[] =>
      id === LOCAL_CALENDAR_ID
        ? calendarItems
        : (subscriptions.find((s) => s.id === id)?.events ?? [])

    for (const source of sources) {
      if (!isSourceVisible(source, hidden)) continue
      for (const item of itemsFor(source.id)) {
        for (const occurrence of expandItemDates(item, rangeStart, rangeEnd)) {
          const start = itemStartTime(item)
          const end = itemEndTime(item)
          push(occurrence, {
            key: `${item.id}@${occurrence}`,
            title: item.summary || 'Untitled',
            kind: 'event',
            done: false,
            color: source.color,
            startMin: start ? minutesOf(start) : null,
            endMin: end ? minutesOf(end) : null,
            location: item.location,
            recurring: item.recurrence.length > 0,
            readOnly: source.readOnly,
            open: () => (source.readOnly ? undefined : setDialog({ mode: 'edit-item', item }))
          })
        }
      }
    }

    for (const task of tasks) {
      if (!task.due) continue
      // Normalize defensively: a time written before input sanitization must
      // degrade to untimed, never to a NaN block.
      const taskStart = task.time ? normalizeTimeInput(task.time) : null
      push(task.due, {
        key: `task-${task.id}`,
        title: task.title || 'Untitled',
        kind: 'task',
        done: isTaskDone(task),
        color: TASK_COLOR,
        startMin: taskStart ? minutesOf(taskStart) : null,
        endMin: null,
        location: task.location,
        recurring: false,
        readOnly: false,
        open: () => setDialog({ mode: 'edit-task', item: task })
      })
    }

    // All-day first, then by start time.
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.startMin === null && b.startMin !== null) return -1
        if (a.startMin !== null && b.startMin === null) return 1
        return (a.startMin ?? 0) - (b.startMin ?? 0)
      })
    }
    return map
  }, [sources, calendarItems, subscriptions, tasks, rangeStart, rangeEnd, hidden])

  const configured = sources.filter((s) => s.id !== LOCAL_CALENDAR_ID)

  const shift = (delta: number): void => {
    if (view === 'month') {
      const { year, month } = parseISODate(cursor)
      const next = addMonths(year, month, delta)
      setCursor(toISODate(next.year, next.month, 1))
    } else if (view === 'week') {
      setCursor(addDays(cursor, delta * 7))
    } else {
      setCursor(addDays(cursor, delta))
    }
  }

  const headerTitle = (): string => {
    if (view === 'month') {
      const { year, month } = parseISODate(cursor)
      return monthLabel(year, month)
    }
    if (view === 'week') {
      const [start, end] = [weekRange(cursor)[0], weekRange(cursor)[6]]
      const a = parseISODate(start)
      const b = parseISODate(end)
      const left = new Date(a.year, a.month - 1, 1).toLocaleString('en-US', { month: 'short' })
      const right = new Date(b.year, b.month - 1, 1).toLocaleString('en-US', { month: 'short' })
      return a.month === b.month
        ? `${left} ${a.year}`
        : `${left} ${a.day} – ${right} ${b.day}, ${b.year}`
    }
    const { year, month, day } = parseISODate(cursor)
    return `${fromISODate(cursor).toLocaleString('en-US', { weekday: 'long' })}, ${new Date(year, month - 1, day).toLocaleString('en-US', { month: 'long' })} ${day}`
  }

  const openCreate = (kind: DialogKind, date: string, startTime?: string | null): void => {
    setDialog({ mode: 'create', kind, date, startTime: startTime ?? null })
  }

  const openDay = (date: string): void => {
    setCursor(date)
    setView('day')
  }

  return (
    <main className="cal">
      <header className="cal__header">
        <h1 className="cal__title">{headerTitle()}</h1>
        <div className="cal__header-actions">
          <div className="cal__nav">
            <button
              type="button"
              className="cal__navbtn"
              aria-label="Previous"
              onClick={() => shift(-1)}
            >
              <ChevronLeftIcon size={16} />
            </button>
            <button type="button" className="cal__navbtn" onClick={() => setCursor(today)}>
              Today
            </button>
            <button
              type="button"
              className="cal__navbtn"
              aria-label="Next"
              onClick={() => shift(1)}
            >
              <ChevronRightIcon size={16} />
            </button>
          </div>
          <div className="cal__seg" role="group" aria-label="Calendar view">
            {(['month', 'week', 'day'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`cal__seg-btn${view === value ? ' is-active' : ''}`}
                onClick={() => setView(value)}
              >
                {value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
          <div className="cal__cals">
            <button
              type="button"
              className={`btn btn--ghost${panelOpen ? ' is-active' : ''}`}
              aria-expanded={panelOpen}
              title="Calendars"
              onClick={() => setPanelOpen((open) => !open)}
            >
              <CalendarIcon size={15} />
              Calendars
            </button>
            {panelOpen && (
              <CalendarsPanel
                sources={sources}
                hidden={hidden}
                onToggleHidden={(id) =>
                  setHidden((prev) => {
                    const next = new Set(prev)
                    if (next.has(id)) next.delete(id)
                    else next.add(id)
                    return next
                  })
                }
                onClose={() => setPanelOpen(false)}
              />
            )}
          </div>
          <button
            type="button"
            className="btn btn--ghost"
            title="Open the task list"
            onClick={() => openNav('tasks')}
          >
            <TaskIcon size={15} />
            Tasks{openCount > 0 ? ` (${openCount})` : ''}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => openCreate('event', cursor)}
          >
            <PlusIcon size={15} />
            Create
          </button>
        </div>
      </header>

      {plannerError && (
        <p className="cal__error" role="alert">
          {plannerError}
        </p>
      )}
      {!plannerReady ? (
        <p className="cal__empty">Loading calendar…</p>
      ) : view === 'month' ? (
        <MonthView
          cursor={cursor}
          today={today}
          entriesByDate={entriesByDate}
          onOpenDay={openDay}
          onCreate={(date) => openCreate('event', date)}
        />
      ) : (
        <TimeGridView
          dates={view === 'week' ? weekRange(cursor) : [cursor]}
          today={today}
          entriesByDate={entriesByDate}
          showWeekday={view === 'week'}
          onCreate={(date, startTime) => openCreate('event', date, startTime)}
          onOpenDay={openDay}
        />
      )}

      {configured.length > 0 && (
        <p className="cal__legend">
          {sources.map((source) => (
            <span key={source.id} className="cal__legend-item">
              <span className="cal__legend-dot" style={{ background: source.color }} />
              {source.name}
            </span>
          ))}
          <span className="cal__legend-item">
            <span className="cal__legend-dot" style={{ background: TASK_COLOR }} />
            Task
          </span>
        </p>
      )}

      {dialog && <PlannerDialog target={dialog} onClose={() => setDialog(null)} />}
    </main>
  )
}

/** Color/visibility/add controls for every calendar. */
function CalendarsPanel({
  sources,
  hidden,
  onToggleHidden,
  onClose
}: {
  sources: SourceView[]
  hidden: Set<string>
  onToggleHidden: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const subscriptions = useAppStore((state) => state.subscriptions)
  const localCalendarColor = useAppStore((state) => state.localCalendarColor)
  const setLocalCalendarColor = useAppStore((state) => state.setLocalCalendarColor)
  const updateSubscription = useAppStore((state) => state.updateSubscription)
  const removeSubscription = useAppStore((state) => state.removeSubscription)
  const refreshSubscription = useAppStore((state) => state.refreshSubscription)
  const addSubscription = useAppStore((state) => state.addSubscription)

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [color, setColor] = useState(() => defaultCalendarColor(subscriptions.length + 1))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const subscribe = async (): Promise<void> => {
    if (!url.trim()) {
      setError('Paste an .ics feed URL first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await addSubscription({ name, url, color })
      setName('')
      setUrl('')
      setColor(defaultCalendarColor(subscriptions.length + 2))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not subscribe.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="cal-cals__backdrop" onClick={onClose} />
      <div className="cal-cals" role="dialog" aria-label="Calendars">
        <div className="cal-cals__head">
          <span>Calendars</span>
          <button type="button" className="dlg__x" aria-label="Close" onClick={onClose}>
            <XIcon size={14} />
          </button>
        </div>

        {sources.map((source) => {
          const sub = subscriptions.find((s) => s.id === source.id)
          const swatch = sub ? sub.color : localCalendarColor
          return (
            <div key={source.id} className="cal-cals__row">
              <button
                type="button"
                className={`cal-cals__toggle${hidden.has(source.id) ? ' is-off' : ''}`}
                aria-pressed={!hidden.has(source.id)}
                title={hidden.has(source.id) ? 'Show' : 'Hide'}
                onClick={() => onToggleHidden(source.id)}
              >
                <span className="cal-cals__dot" style={{ background: swatch }} />
              </button>
              <span className="cal-cals__name">
                {source.name}
                {source.readOnly && <em className="cal-cals__badge">subscribed</em>}
              </span>
              <select
                className="cal-cals__color"
                aria-label={`${source.name} color`}
                value={swatch}
                onChange={(event) =>
                  sub
                    ? updateSubscription(sub.id, { color: event.target.value })
                    : setLocalCalendarColor(event.target.value)
                }
              >
                {CALENDAR_COLORS.map((hex) => (
                  <option key={hex} value={hex}>
                    {hex}
                  </option>
                ))}
              </select>
              {sub && (
                <>
                  <button
                    type="button"
                    className="cal-cals__icon"
                    title="Refresh"
                    aria-label={`Refresh ${sub.name}`}
                    onClick={() => void refreshSubscription(sub.id)}
                  >
                    ⟳
                  </button>
                  <button
                    type="button"
                    className="cal-cals__icon cal-cals__icon--danger"
                    title="Unsubscribe"
                    aria-label={`Unsubscribe ${sub.name}`}
                    onClick={() => removeSubscription(sub.id)}
                  >
                    <XIcon size={13} />
                  </button>
                </>
              )}
              {sub?.error && <span className="cal-cals__error">{sub.error}</span>}
            </div>
          )
        })}

        <div className="cal-cals__add">
          <span className="dlg__label">Subscribe to a calendar</span>
          <input
            className="dlg__input"
            placeholder="Name (e.g. CS Classes)"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <input
            className="dlg__input"
            placeholder="https://…/basic.ics"
            value={url}
            spellCheck={false}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void subscribe()
            }}
          />
          <div className="cal-cals__add-row">
            <div className="cal-cals__swatches" role="group" aria-label="Color">
              {CALENDAR_COLORS.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  className={`cal-cals__swatch${color === hex ? ' is-active' : ''}`}
                  style={{ background: hex }}
                  aria-label={hex}
                  onClick={() => setColor(hex)}
                />
              ))}
            </div>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => void subscribe()}
            >
              {busy ? 'Subscribing…' : 'Subscribe'}
            </button>
          </div>
          <p className="dlg__hint">
            Read-only http(s) .ics feed. Recurring classes come through as weekly events.
          </p>
          {error && (
            <p className="cal-cals__error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </>
  )
}

/** A calendar draws when it is enabled and not hidden by the user. */
function isSourceVisible(source: SourceView, hidden: Set<string>): boolean {
  return source.enabled && !hidden.has(source.id)
}

function entryClass(entry: DayEntry): string {
  return `cal-chip cal-chip--${entry.kind}${entry.done ? ' is-done' : ''}${entry.readOnly ? ' is-readonly' : ''}`
}

function EntryIcon({ kind }: { kind: EntryKind }): React.JSX.Element {
  if (kind === 'task') return <TaskIcon size={11} />
  return <CalendarIcon size={11} />
}

function MonthView({
  cursor,
  today,
  entriesByDate,
  onOpenDay,
  onCreate
}: {
  cursor: string
  today: string
  entriesByDate: Map<string, DayEntry[]>
  onOpenDay: (date: string) => void
  onCreate: (date: string) => void
}): React.JSX.Element {
  const { year, month } = parseISODate(cursor)
  const cells = monthGrid(year, month)
  return (
    <div className="cal-month" role="grid" aria-label="Month view">
      {WEEKDAYS.map((day) => (
        <div key={day} className="cal-dow">
          {day}
        </div>
      ))}
      {cells.map((date) => {
        const { month: cellMonth } = parseISODate(date)
        const entries = entriesByDate.get(date) ?? []
        const visible = entries.slice(0, MONTH_CELL_LIMIT)
        const extra = entries.length - visible.length
        return (
          <div
            key={date}
            role="gridcell"
            className={`cal-cell${date === today ? ' is-today' : ''}${cellMonth !== month ? ' is-dim' : ''}`}
            onClick={() => onCreate(date)}
          >
            <span className="cal-cell__date">{parseISODate(date).day}</span>
            <div className="cal-cell__entries">
              {visible.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className={entryClass(entry)}
                  style={{ background: entry.color }}
                  title={`${entry.title}${entry.location ? ` · ${entry.location}` : ''}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    entry.open()
                  }}
                >
                  {entry.startMin !== null && (
                    <span className="cal-chip__time">
                      {formatTime(toTimeString(entry.startMin))}
                    </span>
                  )}
                  <span className="cal-chip__title">{entry.title}</span>
                  {entry.recurring && <span className="cal-chip__repeat">⟳</span>}
                  <span className="cal-chip__icon">
                    <EntryIcon kind={entry.kind} />
                  </span>
                </button>
              ))}
              {extra > 0 && (
                <button
                  type="button"
                  className="cal-more"
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenDay(date)
                  }}
                >
                  +{extra} more
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function TimeGridView({
  dates,
  today,
  entriesByDate,
  showWeekday,
  onCreate,
  onOpenDay
}: {
  dates: string[]
  today: string
  entriesByDate: Map<string, DayEntry[]>
  showWeekday: boolean
  onCreate: (date: string, startTime: string | null) => void
  onOpenDay: (date: string) => void
}): React.JSX.Element {
  const hours = Array.from({ length: 24 }, (_, hour) => hour)
  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes()

  const slotTime = (event: React.MouseEvent<HTMLDivElement>): string => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 0.999)
    return toTimeString(Math.floor((ratio * 24 * 60) / 30) * 30)
  }

  return (
    <div className="cal-week">
      <div className="cal-week__head">
        <div className="cal-week__gutter" />
        {dates.map((date) => {
          const { day } = parseISODate(date)
          return (
            <button
              key={date}
              type="button"
              className={`cal-week__day${date === today ? ' is-today' : ''}`}
              onClick={() => showWeekday && onOpenDay(date)}
              title={showWeekday ? formatDayLabel(date) : undefined}
            >
              {showWeekday && (
                <span className="cal-week__dow">{formatDayLabel(date).split(',')[0]}</span>
              )}
              <span className="cal-week__date">{day}</span>
            </button>
          )
        })}
      </div>

      <div className="cal-week__allday">
        <div className="cal-week__gutter cal-week__gutter--label">All-day</div>
        {dates.map((date) => {
          const allDay = (entriesByDate.get(date) ?? []).filter((e) => e.startMin === null)
          return (
            <div key={date} className="cal-week__allday-col" onClick={() => onCreate(date, null)}>
              {allDay.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className={entryClass(entry)}
                  style={{ background: entry.color }}
                  onClick={(event) => {
                    event.stopPropagation()
                    entry.open()
                  }}
                >
                  <span className="cal-chip__title">{entry.title}</span>
                  <span className="cal-chip__icon">
                    <EntryIcon kind={entry.kind} />
                  </span>
                </button>
              ))}
            </div>
          )
        })}
      </div>

      <div className="cal-week__scroll">
        <div className="cal-grid">
          <div className="cal-grid__gutter">
            {hours.map((hour) => (
              <div key={hour} className="cal-hour" style={{ height: HOUR_HEIGHT }}>
                <span>
                  {hour === 0
                    ? ''
                    : `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`}
                </span>
              </div>
            ))}
          </div>
          {dates.map((date) => {
            const timed = (entriesByDate.get(date) ?? []).filter((e) => e.startMin !== null)
            const blocks = layoutDayColumns(timed, (entry) => ({
              startMin: entry.startMin ?? 0,
              endMin: entry.endMin ?? (entry.startMin ?? 0) + 30
            }))
            return (
              <div
                key={date}
                className="cal-col"
                style={{ height: HOUR_HEIGHT * 24 }}
                onClick={(event) => onCreate(date, slotTime(event))}
              >
                {hours.map((hour) => (
                  <div key={hour} className="cal-col__hour" style={{ height: HOUR_HEIGHT }} />
                ))}
                {date === today && (
                  <div
                    className="cal-now"
                    style={{ top: `${(nowMin / 1440) * 100}%` }}
                    title="Now"
                  />
                )}
                {blocks.map((block) => {
                  const top = (block.startMin / 1440) * 100
                  const heightPct = Math.max(((block.endMin - block.startMin) / 1440) * 100, 2.2)
                  const startLabel = toTimeString(block.startMin)
                  return (
                    <button
                      key={block.item.key}
                      type="button"
                      className={`cal-block cal-block--${block.item.kind}${block.item.done ? ' is-done' : ''}`}
                      style={{
                        top: `${top}%`,
                        height: `calc(${heightPct}% - 2px)`,
                        left: `calc(${(block.lane / block.lanes) * 100}% + 2px)`,
                        width: `calc(${100 / block.lanes}% - 4px)`,
                        background: block.item.color
                      }}
                      title={`${block.item.title} · ${formatTimeRangeSafe(startLabel)}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        block.item.open()
                      }}
                    >
                      <span className="cal-block__title">
                        {block.item.recurring && '⟳ '}
                        {block.item.title}
                      </span>
                      {block.item.location && (
                        <span className="cal-block__meta">{block.item.location}</span>
                      )}
                      <span className="cal-block__icon">
                        <EntryIcon kind={block.item.kind} />
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function formatTimeRangeSafe(start: string): string {
  return formatTime(start)
}

export default Calendar

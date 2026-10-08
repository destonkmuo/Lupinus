import { useEffect, useMemo, useRef } from 'react'
import {
  AgentIcon,
  AlarmIcon,
  CalendarIcon,
  FileTextIcon,
  GraphIcon,
  TaskIcon,
  PlusIcon,
  SettingsIcon
} from '../components/icons'
import { NAV_LABELS } from '../nav'
import Reveal from '../components/Reveal'
import { parseWikiLinks, resolveWikiTarget } from '../notes'
import { addDays, expandItemDates, formatDayLabel, todayISO, type CalendarItem } from '../planner'
import { parseStudyChild } from '../study'
import { splitHidden } from '../subpages'
import { useAppStore, type NavKey } from '../store/appStore'

function previewFor(content: string): string {
  const body = splitHidden(content).body.trim()
  const child = parseStudyChild(body)
  if (child?.type === 'flashcards') {
    return `Flashcards · ${child.cards.length} ${child.cards.length === 1 ? 'term' : 'terms'}`
  }
  if (child?.type === 'mindmap') {
    return `Mindmap · ${child.nodes.length} ${child.nodes.length === 1 ? 'node' : 'nodes'}`
  }
  if (child?.type === 'quiz') return 'Quiz · blank shell'
  return body.replace(/[#*`>_~-]/g, '').slice(0, 90) || 'Empty note'
}

/** "14:30" -> "2:30 PM". */
function formatClock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm
  const suffix = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`
}

/** "2024-…" timestamps to a short relative label. */
function relTime(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

interface Capability {
  key: NavKey
  title: string
  body: string
  color: string
  icon: (props: { size?: number }) => React.JSX.Element
}

const CAPABILITIES: Capability[] = [
  {
    key: 'agent',
    title: 'SeeMO Agent',
    body: 'Talk or type — wake word, voice replies, and chat with memory.',
    color: '#b284ff',
    icon: AgentIcon
  },
  {
    key: 'calendar',
    title: 'Calendar',
    body: 'Events, recurring classes, and subscribed ICS feeds in one view.',
    color: '#3f8fff',
    icon: CalendarIcon
  },
  {
    key: 'tasks',
    title: 'Tasks',
    body: 'One shared list with due dates, times, and checkboxes.',
    color: '#2fd066',
    icon: TaskIcon
  },
  {
    key: 'graph',
    title: 'Graph',
    body: 'Your note web — nodes color-coded by links, sized by content.',
    color: '#f98b3f',
    icon: GraphIcon
  },
  {
    key: 'misc',
    title: 'Timers & Alarm',
    body: 'Alarm clock, countdown timer, and stopwatch with custom sounds.',
    color: '#ffbe5a',
    icon: AlarmIcon
  },
  {
    key: 'settings',
    title: 'Vault & Backup',
    body: 'Plain markdown files on disk, GitHub sync, and app settings.',
    color: '#9aa4b2',
    icon: SettingsIcon
  }
]

function Home(): React.JSX.Element {
  const notes = useAppStore((state) => state.notes)
  const tasks = useAppStore((state) => state.tasks)
  const toggleTask = useAppStore((state) => state.toggleTask)
  const calendarItems = useAppStore((state) => state.calendarItems)
  const subscriptions = useAppStore((state) => state.subscriptions)
  const vaultPath = useAppStore((state) => state.vaultPath)
  const vaultReady = useAppStore((state) => state.vaultReady)
  const createNote = useAppStore((state) => state.createNote)
  const openNote = useAppStore((state) => state.openNote)
  const openNav = useAppStore((state) => state.openNav)

  const scrollRef = useRef<HTMLElement | null>(null)

  // The homepage magnetically settles onto section starts when a scroll
  // finishes, instead of hijacking the wheel. Native scrolling stays free
  // (tall sections never trap), then the browser's own smooth scrolling
  // glides to the nearest section. A debounce covers platforms without
  // scrollend; grabbing the wheel mid-glide hands control back to the user.
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let snapping = false
    let snapTarget: number | null = null
    let settleTimer = 0

    const offsets = (): number[] =>
      Array.from(scroller.querySelectorAll<HTMLElement>('.home__hero, .home__inner > .reveal')).map(
        (el) => el.offsetTop
      )

    // offsetTop is relative to the positioned .home scroller and ignores the
    // Reveal transform, so offsets stay put as sections fade in.
    const glideTo = (to: number): void => {
      const max = scroller.scrollHeight - scroller.clientHeight
      const target = Math.max(0, Math.min(to, max))
      if (Math.abs(target - scroller.scrollTop) < 1) return
      snapping = true
      snapTarget = target
      scroller.scrollTo({ top: target, behavior: 'smooth' })
    }

    const settle = (): void => {
      if (snapping) {
        if (snapTarget !== null && Math.abs(scroller.scrollTop - snapTarget) <= 2) {
          snapping = false
          snapTarget = null
        }
        return
      }
      const list = offsets()
      if (list.length === 0) return
      const top = scroller.scrollTop
      const max = scroller.scrollHeight - scroller.clientHeight
      // Parked at the very bottom: leave the footer readable instead of
      // yanking back up to the last section.
      if (top >= max - 4) return
      // The strong end flips at the midpoint: up top the hero dominates, down
      // low the bottom sections dominate. Squared bias so each end holds its
      // half decisively instead of hovering in between.
      const upperHalf = max <= 0 || top / max < 0.5
      let best = 0
      let dist = Infinity
      for (let i = 0; i < list.length; i += 1) {
        const d = Math.abs(list[i] - top)
        const weight = (i + 1) * (i + 1)
        const biased = upperHalf ? d * weight : d / weight
        if (biased < dist) {
          dist = biased
          best = i
        }
      }
      glideTo(list[best])
    }

    const scheduleSettle = (): void => {
      window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(() => {
        if (!snapping) settle()
      }, 180)
    }

    const onScrollEnd = (): void => settle()

    // The user grabbed the wheel/touch mid-glide: stop our animation and let
    // the native gesture take over. (Re-assigning the current position aborts
    // the in-flight smooth scroll; the wheel's own delta then applies on top
    // since we never preventDefault.)
    const interrupt = (): void => {
      if (!snapping) return
      snapping = false
      snapTarget = null
      const current = scroller.scrollTop
      scroller.scrollTop = current
    }

    scroller.addEventListener('scrollend', onScrollEnd)
    scroller.addEventListener('scroll', scheduleSettle, { passive: true })
    scroller.addEventListener('wheel', interrupt, { passive: true })
    scroller.addEventListener('touchmove', interrupt, { passive: true })
    return () => {
      scroller.removeEventListener('scrollend', onScrollEnd)
      scroller.removeEventListener('scroll', scheduleSettle)
      scroller.removeEventListener('wheel', interrupt)
      scroller.removeEventListener('touchmove', interrupt)
      window.clearTimeout(settleTimer)
    }
  }, [])

  const today = todayISO()
  const hour = new Date().getHours()
  const greeting =
    hour < 5
      ? 'Up late'
      : hour < 12
        ? 'Good morning'
        : hour < 18
          ? 'Good afternoon'
          : 'Good evening'
  const dateStr = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })

  const openTasks = useMemo(() => tasks.filter((t) => t.status !== 'completed'), [tasks])

  const dueTasks = useMemo(
    () =>
      openTasks
        .filter((t) => t.due !== null && t.due <= today)
        .sort((a, b) => {
          const left = (a.due ?? '') + (a.time ?? '')
          const right = (b.due ?? '') + (b.time ?? '')
          return left < right ? -1 : 1
        })
        .slice(0, 4),
    [openTasks, today]
  )

  const todaysEvents = useMemo(() => {
    const items = [...calendarItems]
    for (const sub of subscriptions) {
      if (sub.enabled) items.push(...sub.events)
    }
    return items
      .filter((item) => expandItemDates(item, today, today).length > 0)
      .sort((a, b) => ((a.start.dateTime ?? 'z') < (b.start.dateTime ?? 'z') ? -1 : 1))
      .slice(0, 4)
  }, [calendarItems, subscriptions, today])

  const weekEnd = addDays(today, 7)
  const tomorrow = addDays(today, 1)

  const eventTime = (item: { start: { dateTime?: string | null } }): string => {
    const time = item.start.dateTime?.split('T')[1]?.slice(0, 5)
    return time ? formatClock(time) : 'All day'
  }

  // Upcoming events after today through the next 7 days, soonest first.
  const weekEvents = useMemo(() => {
    const items = [...calendarItems]
    for (const sub of subscriptions) {
      if (sub.enabled) items.push(...sub.events)
    }
    const rows: { date: string; item: CalendarItem }[] = []
    for (const item of items) {
      for (const date of expandItemDates(item, tomorrow, weekEnd)) {
        rows.push({ date, item })
      }
    }
    rows.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1
      const left = a.item.start.dateTime ?? 'z'
      const right = b.item.start.dateTime ?? 'z'
      return left < right ? -1 : left > right ? 1 : 0
    })
    return rows.slice(0, 7)
  }, [calendarItems, subscriptions, tomorrow, weekEnd])

  // Open tasks due after today through the next 7 days (today's live above).
  const weekTasks = useMemo(
    () =>
      openTasks
        .filter((t) => t.due !== null && t.due > today && t.due <= weekEnd)
        .sort((a, b) => {
          const left = (a.due ?? '') + (a.time ?? '')
          const right = (b.due ?? '') + (b.time ?? '')
          return left < right ? -1 : 1
        })
        .slice(0, 5),
    [openTasks, today, weekEnd]
  )

  const dayLabel = (date: string): string => {
    if (date === tomorrow) return 'Tomorrow'
    return formatDayLabel(date)
  }

  const dayParts: string[] = []
  if (todaysEvents.length > 0) {
    dayParts.push(`${todaysEvents.length} event${todaysEvents.length === 1 ? '' : 's'}`)
  }
  if (dueTasks.length > 0) {
    dayParts.push(`${dueTasks.length} task${dueTasks.length === 1 ? '' : 's'} due`)
  }
  const daySummary =
    dayParts.length > 0 ? `${dayParts.join(' · ')} today.` : 'Nothing on today — enjoy the clear.'

  const linkCount = useMemo(() => {
    const seen = new Set<string>()
    for (const note of notes) {
      for (const link of parseWikiLinks(note.content)) {
        const targetId = resolveWikiTarget(link.target, notes)
        if (!targetId || targetId === note.id) continue
        seen.add([note.id, targetId].sort().join('|'))
      }
    }
    return seen.size
  }, [notes])

  const liveNotes = useMemo(() => notes.filter((note) => !note.deletedAt), [notes])
  const recent = useMemo(
    () =>
      liveNotes
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 6),
    [liveNotes]
  )

  const stats: { value: string; label: string }[] = [
    { value: String(liveNotes.length), label: liveNotes.length === 1 ? 'note' : 'notes' },
    { value: String(openTasks.length), label: 'open tasks' },
    { value: String(todaysEvents.length), label: 'events today' },
    { value: String(linkCount), label: linkCount === 1 ? 'link' : 'links' }
  ]

  const hasToday = todaysEvents.length > 0 || dueTasks.length > 0
  const hasWeek = weekEvents.length > 0 || weekTasks.length > 0
  const todayCount = todaysEvents.length + dueTasks.length
  const weekCount = weekEvents.length + weekTasks.length

  return (
    <main className="home" ref={scrollRef}>
      <header className="home__hero">
        <div className="home__hero-inner">
          <p className="home__date">{dateStr}</p>
          <h1 className="home__title">{greeting}.</h1>
          <p className="home__subtitle">{daySummary}</p>
          <div className="home__hero-actions">
            <button type="button" className="btn btn--primary" onClick={() => createNote()}>
              <PlusIcon size={15} />
              New note
            </button>
            {hasToday && (
              <button type="button" className="btn btn--ghost" onClick={() => openNav('calendar')}>
                <CalendarIcon size={15} />
                Today&apos;s plan
              </button>
            )}
          </div>
          <div className="home__hero-grid">
            <section className="home__panel" aria-label="Today at a glance">
              <h2 className="home__section-title">
                Today
                {todayCount > 0 && <span className="home__panel-count">{todayCount}</span>}
              </h2>
              {!hasToday ? (
                <p className="home__muted">Nothing on for today — enjoy the clear.</p>
              ) : (
                <div className="home__today">
                  {todaysEvents.map((event) => (
                    <button
                      key={event.id}
                      type="button"
                      className="home__today-row"
                      onClick={() => openNav('calendar')}
                    >
                      <span className="home__today-text">
                        <strong>{event.summary.trim() || 'Untitled'}</strong>
                        {event.location ? <small>{event.location}</small> : null}
                      </span>
                      <span className="home__today-time">{eventTime(event)}</span>
                    </button>
                  ))}
                  {dueTasks.map((task) => (
                    <div key={task.id} className="home__today-row" title={task.title}>
                      <input
                        type="checkbox"
                        className="home__today-check"
                        checked={false}
                        aria-label={`Mark done: ${task.title || 'Untitled'}`}
                        onChange={() => toggleTask(task.id)}
                        onClick={(event) => event.stopPropagation()}
                      />
                      <button
                        type="button"
                        className="home__today-main"
                        onClick={() => openNav('tasks')}
                      >
                        <span className="home__today-text">
                          <strong>{task.title.trim() || 'Untitled'}</strong>
                          <small>
                            {task.due !== null && task.due < today
                              ? `Overdue · due ${task.due}`
                              : `Due today${task.time ? ` · ${formatClock(task.time)}` : ''}`}
                          </small>
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section className="home__panel" aria-label="This week">
              <h2 className="home__section-title">
                This week
                {weekCount > 0 && <span className="home__panel-count">{weekCount}</span>}
              </h2>
              {!hasWeek ? (
                <p className="home__muted">A clear week ahead.</p>
              ) : (
                <div className="home__today">
                  {weekEvents.map(({ date, item }) => (
                    <button
                      key={`${date}:${item.id}`}
                      type="button"
                      className="home__today-row"
                      onClick={() => openNav('calendar')}
                    >
                      <span className="home__week-day">{dayLabel(date)}</span>
                      <span className="home__today-text">
                        <strong>{item.summary.trim() || 'Untitled'}</strong>
                        <small>
                          {eventTime(item)}
                          {item.location ? ` · ${item.location}` : ''}
                        </small>
                      </span>
                    </button>
                  ))}
                  {weekTasks.map((task) => (
                    <div key={task.id} className="home__today-row" title={task.title}>
                      <input
                        type="checkbox"
                        className="home__today-check"
                        checked={false}
                        aria-label={`Mark done: ${task.title || 'Untitled'}`}
                        onChange={() => toggleTask(task.id)}
                        onClick={(event) => event.stopPropagation()}
                      />
                      <button
                        type="button"
                        className="home__today-main"
                        onClick={() => openNav('tasks')}
                      >
                        <span className="home__today-text">
                          <strong>{task.title.trim() || 'Untitled'}</strong>
                          <small>
                            Due {task.due ? dayLabel(task.due) : ''}
                            {task.time ? ` · ${formatClock(task.time)}` : ''}
                          </small>
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
        <div className="home__stats" aria-label="Library stats">
          <div className="home__stats-inner">
            {stats.map((stat) => (
              <div key={stat.label} className="home__stat">
                <span className="home__stat-value">{stat.value}</span>
                <span className="home__stat-label">{stat.label}</span>
              </div>
            ))}
          </div>
        </div>
      </header>

      <div className="home__inner">
        <Reveal label="What SeeMO can do">
          <h2 className="home__section-title">Explore</h2>
          <div className="home__grid">
            {CAPABILITIES.map((cap) => {
              const Icon = cap.icon
              return (
                <button
                  key={cap.key}
                  type="button"
                  className="home__card home__card--cap"
                  onClick={() => openNav(cap.key)}
                  title={`Open ${NAV_LABELS[cap.key]}`}
                >
                  <span
                    className="home__cap-icon"
                    style={{ color: cap.color, background: `${cap.color}1f` }}
                  >
                    <Icon size={17} />
                  </span>
                  <span className="home__card-title">{cap.title}</span>
                  <span className="home__card-preview">{cap.body}</span>
                </button>
              )
            })}
          </div>
        </Reveal>

        <Reveal label="Recent notes">
          <h2 className="home__section-title">Recent</h2>
          {recent.length === 0 ? (
            <button type="button" className="home__empty" onClick={() => createNote()}>
              <FileTextIcon size={20} />
              <span>No notes yet. Create your first one.</span>
            </button>
          ) : (
            <div className="home__grid">
              {recent.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  className="home__card"
                  onClick={() => openNote(note.id)}
                >
                  <span className="home__card-title">{note.title.trim() || 'Untitled'}</span>
                  <span className="home__card-preview">{previewFor(note.content)}</span>
                  <span className="home__card-meta">Edited {relTime(note.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </Reveal>

        <p className="home__vault">
          Vault: {vaultPath ?? 'not chosen yet'} · {vaultReady ? 'ready' : 'loading…'}
        </p>
      </div>
    </main>
  )
}

export default Home

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store/appStore'
import {
  LOCAL_CALENDAR_ID,
  itemDate,
  itemEndTime,
  itemStartTime,
  type CalendarItem,
  type TaskItem
} from '../planner'
import { buildRRule, parseRRule, type Freq, type Recurrence } from '../recurrence'
import { CalendarIcon, TaskIcon, XIcon } from './icons'

/** Dialog entry kinds: events live in the calendar, tasks in the list. */
export type DialogKind = 'event' | 'task'

export type PlannerDialogTarget =
  | { mode: 'create'; kind: DialogKind; date: string; startTime?: string | null }
  | { mode: 'edit-item'; item: CalendarItem }
  | { mode: 'edit-task'; item: TaskItem }

type RepeatMode = 'none' | Freq
type EndMode = 'never' | 'on' | 'after'

const WEEKDAY_CHIPS: { code: string; label: string }[] = [
  { code: 'SU', label: 'S' },
  { code: 'MO', label: 'M' },
  { code: 'TU', label: 'T' },
  { code: 'WE', label: 'W' },
  { code: 'TH', label: 'T' },
  { code: 'FR', label: 'F' },
  { code: 'SA', label: 'S' }
]

const REPEAT_OPTIONS: { value: RepeatMode; label: string }[] = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'YEARLY', label: 'Yearly' }
]

function PlannerDialog({
  target,
  onClose
}: {
  target: PlannerDialogTarget
  onClose: () => void
}): React.JSX.Element {
  const addCalendarItem = useAppStore((state) => state.addCalendarItem)
  const updateCalendarItem = useAppStore((state) => state.updateCalendarItem)
  const deleteCalendarItem = useAppStore((state) => state.deleteCalendarItem)
  const addTask = useAppStore((state) => state.addTask)
  const updateTask = useAppStore((state) => state.updateTask)
  const deleteTask = useAppStore((state) => state.deleteTask)

  const [kind, setKind] = useState<DialogKind>(
    target.mode === 'create' ? target.kind : target.mode === 'edit-item' ? 'event' : 'task'
  )
  const [title, setTitle] = useState(() =>
    target.mode === 'create'
      ? ''
      : target.mode === 'edit-item'
        ? target.item.summary
        : target.item.title
  )
  const [notes, setNotes] = useState(() =>
    target.mode === 'create'
      ? ''
      : target.mode === 'edit-item'
        ? target.item.description
        : target.item.notes
  )
  const [location, setLocation] = useState(() =>
    target.mode === 'create' ? '' : target.item.location
  )
  const [date, setDate] = useState(() => {
    if (target.mode === 'create') return target.date
    if (target.mode === 'edit-item') return itemDate(target.item)
    return target.item.due ?? ''
  })
  const [noDate, setNoDate] = useState(
    () => target.mode === 'edit-task' && target.item.due === null
  )
  const [allDay, setAllDay] = useState(() => {
    if (target.mode === 'edit-item') return itemStartTime(target.item) === null
    if (target.mode === 'edit-task') return target.item.time === null
    return target.startTime == null
  })
  const [start, setStart] = useState(() => {
    if (target.mode === 'create') return target.startTime ?? ''
    if (target.mode === 'edit-item') return itemStartTime(target.item) ?? ''
    return target.item.time ?? ''
  })
  const [end, setEnd] = useState(() =>
    target.mode === 'edit-item' ? (itemEndTime(target.item) ?? '') : ''
  )
  const [done, setDone] = useState(
    () => target.mode === 'edit-task' && target.item.status === 'completed'
  )

  // Recurrence form state, seeded from the item's existing rule.
  const existingRule = target.mode === 'edit-item' ? (target.item.recurrence[0] ?? null) : null
  const seeded = useMemo(() => (existingRule ? parseRRule(existingRule) : null), [existingRule])
  const [repeat, setRepeat] = useState<RepeatMode>(seeded?.freq ?? 'none')
  const [interval, setInterval] = useState(seeded?.interval ?? 1)
  const [byDay, setByDay] = useState<string[]>(seeded?.byDay ?? [])
  const [endMode, setEndMode] = useState<EndMode>(
    seeded?.count ? 'after' : seeded?.until ? 'on' : 'never'
  )
  const [count, setCount] = useState(seeded?.count ?? 10)
  const [until, setUntil] = useState(seeded?.until ?? '')

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const kindOptions: readonly DialogKind[] =
    target.mode === 'create'
      ? (['event', 'task'] as const)
      : target.mode === 'edit-item'
        ? (['event'] as const)
        : (['task'] as const)
  const isTask = kind !== 'event'
  const canSave = title.trim().length > 0 && (isTask ? noDate || date !== '' : date !== '')

  const buildRule = (): string | null => {
    if (repeat === 'none') return null
    const rec: Recurrence = {
      freq: repeat,
      interval: Math.max(1, Math.min(99, interval)),
      byDay: repeat === 'WEEKLY' ? byDay : [],
      count: endMode === 'after' ? Math.max(1, Math.min(999, count)) : null,
      until: endMode === 'on' && until ? until : null
    }
    return buildRRule(rec)
  }

  const save = (): void => {
    if (!canSave) return
    const cleanTitle = title.trim()
    if (isTask) {
      const draft = {
        title: cleanTitle,
        notes: notes.trim(),
        location: location.trim(),
        due: noDate || !date ? null : date,
        time: noDate || allDay || !start ? null : start
      }
      if (target.mode === 'edit-task') {
        updateTask(target.item.id, { ...draft, done })
      } else {
        addTask(draft)
      }
    } else {
      const endTime = !allDay && end && start && end > start ? end : null
      const draft = {
        summary: cleanTitle,
        description: notes.trim(),
        location: location.trim(),
        date,
        startTime: allDay || !start ? null : start,
        endTime,
        recurrence: buildRule(),
        // New events always land in the writable local calendar; feeds are read-only.
        calendarId: target.mode === 'edit-item' ? target.item.calendarId : LOCAL_CALENDAR_ID
      }
      if (target.mode === 'edit-item') {
        updateCalendarItem(target.item.id, draft)
      } else {
        addCalendarItem(draft)
      }
    }
    onClose()
  }

  const remove = (): void => {
    if (target.mode === 'edit-item') deleteCalendarItem(target.item.id)
    else if (target.mode === 'edit-task') deleteTask(target.item.id)
    onClose()
  }

  const kindIcon = (value: DialogKind, size = 13): React.JSX.Element => {
    if (value === 'task') return <TaskIcon size={size} />
    return <CalendarIcon size={size} />
  }
  const kindLabel = (value: DialogKind): string => (value === 'task' ? 'Task' : 'Event')

  return (
    <div className="dlg-overlay" onClick={onClose}>
      <div
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-label={target.mode === 'create' ? 'New entry' : 'Edit entry'}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dlg__head">
          <h2 className="dlg__title">{target.mode === 'create' ? 'New entry' : 'Edit entry'}</h2>
          <button type="button" className="dlg__x" aria-label="Close" onClick={onClose}>
            <XIcon size={15} />
          </button>
        </div>

        <div className="dlg__seg" role="group" aria-label="Entry kind">
          {kindOptions.map((value) => (
            <button
              key={value}
              type="button"
              className={`dlg__seg-btn${kind === value ? ' is-active' : ''}`}
              onClick={() => setKind(value)}
            >
              {kindIcon(value)}
              {kindLabel(value)}
            </button>
          ))}
        </div>

        <label className="dlg__field">
          <span className="dlg__label">Title</span>
          <input
            className="dlg__input"
            value={title}
            autoFocus
            placeholder={isTask ? 'Task title' : 'Event title'}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save()
            }}
          />
        </label>

        <div className="dlg__row">
          <label className="dlg__field">
            <span className="dlg__label">{isTask ? 'Due date' : 'Date'}</span>
            <input
              type="date"
              className="dlg__input"
              value={isTask && noDate ? '' : date}
              disabled={isTask && noDate}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          {isTask ? (
            <label className="dlg__field">
              <span className="dlg__label">Time</span>
              <input
                type="time"
                className="dlg__input"
                value={start}
                disabled={noDate || !date || allDay}
                onChange={(event) => setStart(event.target.value)}
              />
            </label>
          ) : (
            <>
              <label className="dlg__field">
                <span className="dlg__label">Start</span>
                <input
                  type="time"
                  className="dlg__input"
                  value={start}
                  disabled={allDay}
                  onChange={(event) => setStart(event.target.value)}
                />
              </label>
              <label className="dlg__field">
                <span className="dlg__label">End (optional)</span>
                <input
                  type="time"
                  className="dlg__input"
                  value={end}
                  disabled={allDay}
                  onChange={(event) => setEnd(event.target.value)}
                />
              </label>
            </>
          )}
        </div>

        <div className="dlg__row dlg__row--checks">
          {isTask ? (
            <>
              <label className="settings__check">
                <input
                  type="checkbox"
                  checked={noDate}
                  onChange={(event) => setNoDate(event.target.checked)}
                />
                No due date
              </label>
              <label className="settings__check">
                <input
                  type="checkbox"
                  checked={allDay}
                  disabled={noDate || !date}
                  onChange={(event) => setAllDay(event.target.checked)}
                />
                All day
              </label>
              {target.mode === 'edit-task' && (
                <label className="settings__check">
                  <input
                    type="checkbox"
                    checked={done}
                    onChange={(event) => setDone(event.target.checked)}
                  />
                  Done
                </label>
              )}
            </>
          ) : (
            <label className="settings__check">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(event) => setAllDay(event.target.checked)}
              />
              All day
            </label>
          )}
        </div>

        {!isTask && (
          <div className="dlg__recur">
            <label className="dlg__field">
              <span className="dlg__label">Repeat</span>
              <select
                className="dlg__input"
                value={repeat}
                onChange={(event) => {
                  const next = event.target.value as RepeatMode
                  setRepeat(next)
                  // Seed weekly classes with the event's own weekday.
                  if (next === 'WEEKLY' && byDay.length === 0 && date) {
                    const [y, m, d] = date.split('-').map(Number)
                    const code = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][
                      new Date(y, m - 1, d).getDay()
                    ]
                    setByDay([code])
                  }
                }}
              >
                {REPEAT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {repeat === 'WEEKLY' && (
              <div className="dlg__weekdays" role="group" aria-label="Repeat on">
                {WEEKDAY_CHIPS.map((chip) => (
                  <button
                    key={chip.code}
                    type="button"
                    className={`dlg__weekday${byDay.includes(chip.code) ? ' is-active' : ''}`}
                    aria-pressed={byDay.includes(chip.code)}
                    aria-label={chip.code}
                    onClick={() =>
                      setByDay((prev) =>
                        prev.includes(chip.code)
                          ? prev.filter((c) => c !== chip.code)
                          : [...prev, chip.code]
                      )
                    }
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            )}

            {repeat !== 'none' && (
              <>
                <div className="dlg__row">
                  <label className="dlg__field">
                    <span className="dlg__label">Every</span>
                    <input
                      type="number"
                      min={1}
                      max={99}
                      className="dlg__input"
                      value={interval}
                      onChange={(event) => setInterval(Number(event.target.value) || 1)}
                    />
                  </label>
                  <label className="dlg__field">
                    <span className="dlg__label">Ends</span>
                    <select
                      className="dlg__input"
                      value={endMode}
                      onChange={(event) => setEndMode(event.target.value as EndMode)}
                    >
                      <option value="never">Never</option>
                      <option value="on">On date</option>
                      <option value="after">After</option>
                    </select>
                  </label>
                </div>
                {endMode === 'on' && (
                  <label className="dlg__field">
                    <span className="dlg__label">End date</span>
                    <input
                      type="date"
                      className="dlg__input"
                      value={until}
                      onChange={(event) => setUntil(event.target.value)}
                    />
                  </label>
                )}
                {endMode === 'after' && (
                  <label className="dlg__field">
                    <span className="dlg__label">Occurrences</span>
                    <input
                      type="number"
                      min={1}
                      max={999}
                      className="dlg__input"
                      value={count}
                      onChange={(event) => setCount(Number(event.target.value) || 1)}
                    />
                  </label>
                )}
                <p className="dlg__hint">{describeRulePreview(repeat, interval, byDay)}</p>
              </>
            )}
          </div>
        )}

        <label className="dlg__field">
          <span className="dlg__label">Location</span>
          <input
            className="dlg__input"
            value={location}
            placeholder="Where?"
            onChange={(event) => setLocation(event.target.value)}
          />
        </label>

        <label className="dlg__field">
          <span className="dlg__label">{isTask ? 'Notes' : 'Description'}</span>
          <textarea
            className="dlg__input dlg__textarea"
            value={notes}
            rows={3}
            placeholder="Details…"
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>

        <div className="dlg__actions">
          {target.mode !== 'create' && (
            <button type="button" className="btn btn--danger" onClick={remove}>
              Delete
            </button>
          )}
          <span className="dlg__spacer" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!canSave} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function describeRulePreview(freq: Freq, interval: number, byDay: string[]): string {
  const every = interval > 1 ? `every ${interval} ` : ''
  const names: Record<string, string> = {
    SU: 'Sun',
    MO: 'Mon',
    TU: 'Tue',
    WE: 'Wed',
    TH: 'Thu',
    FR: 'Fri',
    SA: 'Sat'
  }
  if (freq === 'WEEKLY') {
    const days = byDay.length > 0 ? ` on ${byDay.map((d) => names[d]).join(', ')}` : ''
    return `Repeats weekly${interval > 1 ? ` (${every.trim()})` : ''}${days}.`
  }
  if (freq === 'DAILY') return `Repeats ${interval > 1 ? `${every}days` : 'daily'}.`
  if (freq === 'MONTHLY') return `Repeats monthly${interval > 1 ? ` (${every.trim()})` : ''}.`
  return `Repeats yearly${interval > 1 ? ` (${every.trim()})` : ''}.`
}

export default PlannerDialog

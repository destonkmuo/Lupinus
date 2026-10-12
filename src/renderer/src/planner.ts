/**
 * Planner data model + pure helpers for the calendar and task list.
 *
 * Stored as plain JSON in the vault: `calendar.json` (local events),
 * `tasks.json` (the shared task list) and `calendars.json`
 * (subscriptions + their cached events).
 *
 * Event and task shapes mirror the Google Calendar / Google Tasks APIs
 * (`summary`, `start`/`end`, `recurrence`, `notes`, `due`, `status`) so data
 * transfers across with a direct field mapping. Our extras are `location`,
 * the task `time`, `calendarId` for multi-calendar coloring, and local
 * timestamps.
 *
 * Dates are local `YYYY-MM-DD` and times `HH:MM`, so no timezone math leaks
 * into the UI. `dateTime` values are floating local times
 * (`YYYY-MM-DDTHH:MM`); append the local offset when exporting.
 */

import { expandRecurrence } from './recurrence'

/** Google Calendar `start`/`end` shape: exactly one variant is set. */
export interface EventDateTime {
  /** Floating local time `YYYY-MM-DDTHH:MM`. */
  dateTime?: string
  /** All-day date `YYYY-MM-DD`. */
  date?: string
}

export type EventStatus = 'confirmed' | 'cancelled'

/** Everything dated or undated that isn't a calendar event is a task. */
export type TaskStatus = 'needsAction' | 'completed'

export interface TaskItem {
  id: string
  title: string
  /** Google Tasks `notes`. */
  notes: string
  location: string
  /** Google Tasks `due` (`YYYY-MM-DD`), or null for unscheduled. */
  due: string | null
  /** `HH:MM` or null. Google due-dates are date-only; this is our extension. */
  time: string | null
  status: TaskStatus
  createdAt: number
  updatedAt: number
}

/** The local, editable calendar. Any other id refers to a subscription. */
export const LOCAL_CALENDAR_ID = 'local'

export interface CalendarItem {
  id: string
  summary: string
  description: string
  location: string
  start: EventDateTime
  end: EventDateTime | null
  status: EventStatus
  /** Google-style rule lines, e.g. `["RRULE:FREQ=WEEKLY;BYDAY=MO"]`. */
  recurrence: string[]
  /** Occurrence dates to skip (`YYYY-MM-DD`). */
  exdates: string[]
  /** Owning calendar: `local` or a subscription id (drives chip color). */
  calendarId: string
  createdAt: number
  updatedAt: number
}

/** A subscribed external calendar (ICS feed) plus its cached events. */
export interface CalendarSubscription {
  id: string
  name: string
  url: string
  color: string
  enabled: boolean
  lastFetched: number | null
  error: string | null
  events: CalendarItem[]
}

/** Read-only view model the calendar UI renders from. */
export interface CalendarSource {
  id: string
  name: string
  color: string
  enabled: boolean
  readOnly: boolean
  error: string | null
}

/** Palette for calendars, close to Google's swatches. */
export const CALENDAR_COLORS = [
  '#6ab0ff',
  '#2fd066',
  '#b284ff',
  '#ffbe5a',
  '#ff6b8a',
  '#2fd0e0',
  '#f98b3f',
  '#9aa4b2'
] as const

export function defaultCalendarColor(index: number): string {
  return CALENDAR_COLORS[index % CALENDAR_COLORS.length]
}

/** Fixed chip color for tasks: app accent blue, matching the rest of the app. */
export const TASK_COLOR = '#6ab0ff'

export const CALENDAR_FILE = 'calendar.json'
export const TASKS_FILE = 'tasks.json'
export const ROUTINES_FILE = 'routines.json'
/** Pre-rename task store; read once for migration, then retired. */
export const TODO_FILE = 'todo.json'
export const CALENDARS_FILE = 'calendars.json'

/** Flat field shapes for the create/edit dialog (ids + timestamps on save). */
export interface CalendarDraft {
  summary: string
  description: string
  location: string
  date: string
  startTime: string | null
  endTime: string | null
  /** Rule line, or null for a one-off event. */
  recurrence: string | null
  calendarId: string
}

export interface TaskDraft {
  title: string
  notes: string
  location: string
  due: string | null
  time: string | null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asDate(value: unknown): string | null {
  return typeof value === 'string' && DATE_RE.test(value) ? value : null
}

function asTime(value: unknown): string | null {
  return typeof value === 'string' && TIME_RE.test(value) ? value : null
}

/**
 * Coerce loose time input to `HH:MM`, or null when it carries no usable time.
 * An hour-only value (`"14"`) means top of the hour — this is what used to
 * leak through as `"2: undefined PM"`.
 */
export function normalizeTimeInput(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (TIME_RE.test(trimmed)) return trimmed
  const hourOnly = /^([01]?\d|2[0-3])$/.exec(trimmed)
  if (hourOnly) return `${hourOnly[1].padStart(2, '0')}:00`
  return null
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asEventDateTime(value: unknown): EventDateTime | null {
  if (!isRecord(value)) return null
  if (typeof value.dateTime === 'string') {
    const match = DATETIME_RE.exec(value.dateTime)
    if (!match) return null
    return { dateTime: `${match[1]}T${match[2]}` }
  }
  const date = asDate(value.date)
  return date ? { date } : null
}

/**
 * Coerce one raw JSON value into a CalendarItem, or null when unusable.
 * Accepts the current Google-like shape plus the legacy flat shape
 * (`title`/`date`/`startTime`, `activity` kind), which is migrated inline.
 */
function asStringArray(value: unknown, pattern: RegExp): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && pattern.test(v))
}

function asCalendarId(value: unknown): string {
  const id = asId(value)
  return id ?? LOCAL_CALENDAR_ID
}

/** Raw fields shared by event parsing and the legacy task migration. */
interface RawItem {
  id: string
  summary: string
  description: string
  location: string
  start: EventDateTime
  end: EventDateTime | null
  status: EventStatus
  recurrence: string[]
  exdates: string[]
  calendarId: string
  createdAt: number
  updatedAt: number
}

function rawFrom(value: Record<string, unknown>, now: number): RawItem | null {
  const id = asId(value.id)
  if (!id) return null
  const summary = 'summary' in value ? asString(value.summary) : asString(value.title)
  const status: EventStatus = value.status === 'cancelled' ? 'cancelled' : 'confirmed'
  const recurrence = asStringArray(value.recurrence, /^RRULE:/i)
  const exdates = asStringArray(value.exdates, /^\d{4}-\d{2}-\d{2}$/)
  const createdAt = asNumber(value.createdAt, now)
  const updatedAt = asNumber(value.updatedAt, now)
  const base = {
    id,
    summary,
    description: asString(value.description),
    location: asString(value.location),
    status,
    recurrence,
    exdates,
    calendarId: asCalendarId(value.calendarId),
    createdAt,
    updatedAt
  }

  if (isRecord(value.start)) {
    const start = asEventDateTime(value.start)
    if (!start) return null
    let end: EventDateTime | null = null
    if (value.end != null) {
      end = asEventDateTime(value.end)
      if (!end) return null
    }
    return { ...base, start, end }
  }
  // Legacy flat shape (date/startTime/endTime).
  const date = asDate(value.date)
  if (!date) return null
  const startTime = asTime(value.startTime)
  const endTime = asTime(value.endTime)
  return {
    ...base,
    start: startTime ? { dateTime: `${date}T${startTime}` } : { date },
    end: endTime ? { dateTime: `${date}T${endTime}` } : null
  }
}

export function toCalendarItem(value: unknown, now: number): CalendarItem | null {
  if (!isRecord(value)) return null
  return rawFrom(value, now)
}

/** Legacy `kind` values that used to live in calendar.json. */
function legacyKind(value: unknown): 'task' | 'event' {
  if (!isRecord(value)) return 'event'
  return value.kind === 'task' || value.kind === 'activity' ? 'task' : 'event'
}

/**
 * Coerce one raw JSON value into a TaskItem, or null when unusable.
 * Accepts the current Google-like shape (`notes`/`due`/`status`) plus the
 * legacy shape (`description`/`date`/`done`), migrated inline. The retired
 * `kind: 'todo' | 'task'` split is ignored — everything is a task now.
 */
export function toTaskItem(value: unknown, now: number): TaskItem | null {
  if (!isRecord(value)) return null
  const id = asId(value.id)
  if (!id) return null
  const notes = 'notes' in value ? asString(value.notes) : asString(value.description)
  const due = 'due' in value ? asDate(value.due) : asDate(value.date)
  const status: TaskStatus =
    value.status === 'completed' || value.done === true ? 'completed' : 'needsAction'
  return {
    id,
    title: asString(value.title),
    notes,
    location: asString(value.location),
    due,
    time: asTime(value.time),
    status,
    createdAt: asNumber(value.createdAt, now),
    updatedAt: asNumber(value.updatedAt, now)
  }
}

/** Local `YYYY-MM-DD` of an item's start (either variant). */
export function itemDate(item: CalendarItem): string {
  const { date, dateTime } = item.start
  if (date) return date
  return (dateTime ?? '').slice(0, 10)
}

/**
 * `HH:MM` start, or null for all-day items — and null for anything malformed,
 * so a corrupt `dateTime` degrades to "All day" instead of `NaN` downstream.
 */
export function itemStartTime(item: CalendarItem): string | null {
  if (!item.start.dateTime) return null
  const time = item.start.dateTime.slice(11, 16)
  return TIME_RE.test(time) ? time : null
}

/** `HH:MM` end, or null for open-ended / all-day / malformed items. */
export function itemEndTime(item: CalendarItem): string | null {
  if (!item.end || !item.end.dateTime) return null
  const time = item.end.dateTime.slice(11, 16)
  return TIME_RE.test(time) ? time : null
}

/** Minutes between an item's start and end, for calendar block height. */
export function itemDurationMinutes(item: CalendarItem): number {
  const start = itemStartTime(item)
  const end = itemEndTime(item)
  if (!start) return 0
  if (!end) return 30
  return Math.max(0, minutesOf(end) - minutesOf(start))
}

export function isTaskDone(task: TaskItem): boolean {
  return task.status === 'completed'
}

/** Flat form fields for editing an existing calendar item. */
export function draftFromItem(item: CalendarItem): CalendarDraft {
  return {
    summary: item.summary,
    description: item.description,
    location: item.location,
    date: itemDate(item),
    startTime: itemStartTime(item),
    endTime: itemEndTime(item),
    recurrence: item.recurrence[0] ?? null,
    calendarId: item.calendarId
  }
}

export function calendarItemFromDraft(
  id: string,
  draft: CalendarDraft,
  now: number,
  existing?: Pick<CalendarItem, 'createdAt' | 'status' | 'exdates' | 'calendarId'>
): CalendarItem {
  // An event needs only a start: the end stays null (open-ended) unless the
  // user picked one. Normalizing here keeps malformed input from ever
  // reaching the stored `dateTime` shape.
  const startTime = normalizeTimeInput(draft.startTime)
  const endTime = normalizeTimeInput(draft.endTime)
  return {
    id,
    summary: draft.summary,
    description: draft.description,
    location: draft.location,
    start: startTime ? { dateTime: `${draft.date}T${startTime}` } : { date: draft.date },
    end: endTime ? { dateTime: `${draft.date}T${endTime}` } : null,
    status: existing?.status ?? 'confirmed',
    recurrence: draft.recurrence ? [draft.recurrence] : [],
    exdates: existing?.exdates ?? [],
    calendarId: draft.calendarId || existing?.calendarId || LOCAL_CALENDAR_ID,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
}

export function taskItemFromDraft(
  id: string,
  draft: TaskDraft,
  done: boolean,
  now: number,
  existing?: Pick<TaskItem, 'createdAt'>
): TaskItem {
  return {
    id,
    title: draft.title,
    notes: draft.notes,
    location: draft.location,
    due: draft.due,
    time: normalizeTimeInput(draft.time),
    status: done ? 'completed' : 'needsAction',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
}

export interface CalendarLoad {
  events: CalendarItem[]
  /** Entries that used to be `kind: 'task'`, converted to shared task records. */
  migratedTasks: TaskItem[]
}

/**
 * Load calendar.json, splitting out legacy `kind: 'task'` entries so tasks
 * end up in the one shared list instead of a parallel array.
 */
export function parseCalendarData(data: unknown): CalendarLoad {
  if (!Array.isArray(data)) return { events: [], migratedTasks: [] }
  const now = Date.now()
  const events: CalendarItem[] = []
  const migratedTasks: TaskItem[] = []
  for (const value of data) {
    const raw = isRecord(value) ? rawFrom(value, now) : null
    if (!raw) continue
    if (legacyKind(value) === 'task') {
      const date = raw.start.date ?? raw.start.dateTime?.slice(0, 10) ?? null
      migratedTasks.push({
        id: raw.id,
        title: raw.summary,
        notes: raw.description,
        location: raw.location,
        due: date,
        time: raw.start.dateTime ? normalizeTimeInput(raw.start.dateTime.slice(11, 16)) : null,
        status: raw.status === 'cancelled' ? 'completed' : 'needsAction',
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt
      })
    } else {
      events.push(raw)
    }
  }
  return { events, migratedTasks }
}

export function parseCalendarItems(data: unknown): CalendarItem[] {
  return parseCalendarData(data).events
}

export function parseTaskItems(data: unknown): TaskItem[] {
  if (!Array.isArray(data)) return []
  const now = Date.now()
  const items: TaskItem[] = []
  for (const value of data) {
    const item = toTaskItem(value, now)
    if (item) items.push(item)
  }
  return items
}

/** One mini-step inside a routine. */
export interface RoutineStep {
  id: string
  title: string
  done: boolean
}

/**
 * A named daily routine: an ordered list of mini-steps that resets every
 * day (`lastReset` tracks the last `YYYY-MM-DD` the steps were cleared).
 */
export interface RoutineItem {
  id: string
  title: string
  notes: string
  steps: RoutineStep[]
  lastReset: string | null
  createdAt: number
  updatedAt: number
}

export function toRoutineStep(value: unknown): RoutineStep | null {
  if (!isRecord(value)) return null
  const id = asId(value.id)
  if (!id) return null
  return { id, title: asString(value.title), done: value.done === true }
}

export function toRoutineItem(value: unknown, now: number): RoutineItem | null {
  if (!isRecord(value)) return null
  const id = asId(value.id)
  if (!id) return null
  const steps: RoutineStep[] = []
  if (Array.isArray(value.steps)) {
    for (const raw of value.steps) {
      const step = toRoutineStep(raw)
      if (step) steps.push(step)
    }
  }
  const lastReset =
    typeof value.lastReset === 'string' && DATE_RE.test(value.lastReset) ? value.lastReset : null
  return {
    id,
    title: asString(value.title),
    notes: asString(value.notes),
    steps,
    lastReset,
    createdAt: asNumber(value.createdAt, now),
    updatedAt: asNumber(value.updatedAt, now)
  }
}

export function parseRoutines(data: unknown): RoutineItem[] {
  if (!Array.isArray(data)) return []
  const now = Date.now()
  const items: RoutineItem[] = []
  for (const value of data) {
    const item = toRoutineItem(value, now)
    if (item) items.push(item)
  }
  return items
}

/** Coerce one raw value into an event belonging to `calendarId`. */
export function toSubscriptionEvent(
  value: unknown,
  calendarId: string,
  now: number
): CalendarItem | null {
  if (!isRecord(value)) return null
  const raw = rawFrom(value, now)
  return raw ? { ...raw, calendarId } : null
}

export function parseSubscriptions(data: unknown): CalendarSubscription[] {
  if (!Array.isArray(data)) return []
  const now = Date.now()
  const out: CalendarSubscription[] = []
  data.forEach((value, index) => {
    if (!isRecord(value)) return
    const id = asId(value.id)
    const url = asString(value.url)
    if (!id || !url) return
    const events: CalendarItem[] = []
    if (Array.isArray(value.events)) {
      for (const raw of value.events) {
        const event = toSubscriptionEvent(raw, id, now)
        if (event) events.push(event)
      }
    }
    out.push({
      id,
      name: asString(value.name) || 'Subscribed calendar',
      url,
      color: asString(value.color) || defaultCalendarColor(index + 1),
      enabled: value.enabled !== false,
      lastFetched: typeof value.lastFetched === 'number' ? value.lastFetched : null,
      error: typeof value.error === 'string' ? value.error : null,
      events
    })
  })
  return out
}

/**
 * Dates an item occupies in `[rangeStart, rangeEnd]`: its own date, plus every
 * recurrence occurrence (exceptions respected).
 */
export function expandItemDates(
  item: CalendarItem,
  rangeStart: string,
  rangeEnd: string
): string[] {
  const base = itemDate(item)
  const rule = item.recurrence[0]
  if (!rule) return base >= rangeStart && base <= rangeEnd ? [base] : []
  const dates = expandRecurrence(base, rule, rangeStart, rangeEnd, item.exdates)
  return dates.includes(base) || base < rangeStart || base > rangeEnd ? dates : [base, ...dates]
}

// ---------------------------------------------------------------------------
// Local-date helpers (month is 1-12; weeks start Sunday like Google US).
// ---------------------------------------------------------------------------

export function toISODate(year: number, month: number, day: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)}`
}

export function todayISO(): string {
  const now = new Date()
  return toISODate(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

export function parseISODate(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split('-').map(Number)
  return { year, month, day }
}

export function fromISODate(iso: string): Date {
  const { year, month, day } = parseISODate(iso)
  return new Date(year, month - 1, day)
}

export function addDays(iso: string, days: number): string {
  const date = fromISODate(iso)
  date.setDate(date.getDate() + days)
  return toISODate(date.getFullYear(), date.getMonth() + 1, date.getDate())
}

export function addMonths(
  year: number,
  month: number,
  delta: number
): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta
  return { year: Math.floor(total / 12), month: (total % 12) + 1 }
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/** 42 cells (6 weeks) covering the month, starting Sunday. */
export function monthGrid(year: number, month: number): string[] {
  const first = new Date(year, month - 1, 1)
  const startOffset = first.getDay()
  const cells: string[] = []
  for (let i = 0; i < 42; i++) {
    const date = new Date(year, month - 1, 1 + i - startOffset)
    cells.push(toISODate(date.getFullYear(), date.getMonth() + 1, date.getDate()))
  }
  return cells
}

/** 7-day week (Sunday-first) containing the given date. */
export function weekRange(iso: string): string[] {
  const date = fromISODate(iso)
  const start = addDays(iso, -date.getDay())
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

export function monthLabel(year: number, month: number): string {
  return new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })
}

/** `2026-09-17` -> `Thu, Sep 17`. */
export function formatDayLabel(iso: string): string {
  const date = fromISODate(iso)
  const weekday = date.toLocaleString('en-US', { weekday: 'short' })
  const rest = date.toLocaleString('en-US', { month: 'short', day: 'numeric' })
  return `${weekday}, ${rest}`
}

export function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

/** `485` -> `08:05`. Wraps past midnight. */
export function toTimeString(totalMinutes: number): string {
  const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`
}

/**
 * `13:05` -> `1:05 PM`; midnight/noon handled. An hour-only value (`"14"`)
 * means top of the hour; anything else unparseable passes through untouched
 * (never `NaN` output).
 */
export function formatTime(time: string): string {
  const normalized = normalizeTimeInput(time) ?? time
  const total = minutesOf(normalized)
  if (!Number.isFinite(total)) return time
  const hours24 = Math.floor(total / 60)
  const minutes = total % 60
  const suffix = hours24 < 12 ? 'AM' : 'PM'
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12
  return `${hours12}:${String(minutes).padStart(2, '0')} ${suffix}`
}

export function formatTimeRange(start: string | null, end: string | null): string {
  if (!start) return 'All day'
  if (!end || end <= start) return formatTime(start)
  return `${formatTime(start)} – ${formatTime(end)}`
}

// ---------------------------------------------------------------------------
// Day-column layout: overlapping timed items share columns side by side.
// ---------------------------------------------------------------------------

export interface TimedBlock<T> {
  item: T
  startMin: number
  endMin: number
  /** 0-based lane within its overlap cluster. */
  lane: number
  /** Lane count of its overlap cluster. */
  lanes: number
}

interface Bound {
  startMin: number
  endMin: number
}

function overlaps(a: Bound, b: Bound): boolean {
  return a.startMin < b.endMin && b.startMin < a.endMin
}

/**
 * Assign lanes so overlapping blocks sit side by side. Returns blocks in
 * input order. Zero/negative durations are treated as 30-minute blocks.
 */
export function layoutDayColumns<T>(items: T[], boundsOf: (item: T) => Bound): TimedBlock<T>[] {
  const withBounds = items.map((item, index) => {
    const bounds = boundsOf(item)
    const startMin = bounds.startMin
    const endMin = Math.max(bounds.endMin, startMin + 30)
    return { item, index, startMin, endMin }
  })
  const order = withBounds
    .map((entry, position) => ({ entry, position }))
    .sort((a, b) => a.entry.startMin - b.entry.startMin || a.entry.endMin - b.entry.endMin)

  // Split into clusters where every member transitively overlaps. All
  // overlapping clusters merge so a bridging event unites them.
  const clusters: (typeof withBounds)[] = []
  for (const { entry } of order) {
    const hits = clusters.filter((members) => members.some((m) => overlaps(m, entry)))
    if (hits.length === 0) {
      clusters.push([entry])
    } else {
      const [first, ...rest] = hits
      first.push(entry)
      for (const other of rest) {
        first.push(...other)
        clusters.splice(clusters.indexOf(other), 1)
      }
    }
  }

  const placed = new Map<number, { lane: number; lanes: number }>()
  for (const cluster of clusters) {
    const laneEnds: number[] = []
    const byStart = cluster.slice().sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)
    for (const entry of byStart) {
      let lane = laneEnds.findIndex((end) => end <= entry.startMin)
      if (lane < 0) {
        lane = laneEnds.length
        laneEnds.push(entry.endMin)
      } else {
        laneEnds[lane] = entry.endMin
      }
      placed.set(entry.index, { lane, lanes: 0 })
    }
    for (const entry of cluster) {
      const slot = placed.get(entry.index)
      if (slot) slot.lanes = laneEnds.length
    }
  }

  return withBounds.map(({ item, index, startMin, endMin }) => {
    const slot = placed.get(index) ?? { lane: 0, lanes: 1 }
    return { item, startMin, endMin, lane: slot.lane, lanes: slot.lanes }
  })
}

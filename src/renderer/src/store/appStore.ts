import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { isKnownSoundId } from '../alarm'
import type { ImageSide } from '../images'
import { noteFileBase, orderedNotes, titleFromFileName, uniqueFileName } from '../notes'
import { renameLinkTarget } from '../subpages'
import { parseIcs } from '../ical'
import {
  CALENDARS_FILE,
  CALENDAR_COLORS,
  CALENDAR_FILE,
  ROUTINES_FILE,
  TASKS_FILE,
  TODO_FILE,
  calendarItemFromDraft,
  draftFromItem,
  parseCalendarData,
  parseRoutines,
  parseSubscriptions,
  parseTaskItems,
  todayISO,
  taskItemFromDraft,
  type CalendarDraft,
  type CalendarItem,
  type RoutineItem,
  type CalendarSubscription,
  type TaskDraft,
  type TaskItem
} from '../planner'

export type NavKey =
  'home' | 'graph' | 'tasks' | 'calendar' | 'agent' | 'misc' | 'email' | 'settings'

/** Visual/behavioral state of the core orb. */
export type CoreState = 'sleep' | 'idle' | 'working' | 'speaking' | 'summoned'

export interface Note {
  id: string
  title: string
  content: string
  /** File inside the vault, e.g. `my-note.md`. Assigned on creation/import. */
  fileName: string
  createdAt: number
  updatedAt: number
  /** Trash timestamp, or null/undefined while the note is live. */
  deletedAt: number | null
  /** Owning note space. Missing only in legacy vault data. */
  spaceId?: string
}

export interface NoteSpace {
  id: string
  name: string
  emoji: string
}

/** Trash auto-destroys notes 30 days after they were trashed. */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Per-picture layout: dock side (unlocked) and/or pinned width. */
export interface ImageLayout {
  /** Wrap alignment; present only while unlocked (docked). */
  side?: ImageSide
  /** Pinned width in pixels (inline and docked alike); absent = natural. */
  w?: number
}

/**
 * An open tab. Tabs are notes-only: nav destinations (Home, Tasks,
 * Calendar, …) render as a sidebar-selected view and never occupy the tab
 * bar, so clicking around the sidebar can't pile up tab clutter.
 */
export type Tab = { id: string; kind: 'note'; noteId: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  text: string
  timestamp: number
}

/** Cap persisted history so the store stays small. */
const MAX_CHAT_MESSAGES = 100

/** Sidebar resize bounds (px). Shared by the store default and the drag handle. */
export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 480
export const SIDEBAR_DEFAULT_WIDTH = 260

export function clampSidebarWidth(width: unknown): number {
  if (typeof width !== 'number' || Number.isNaN(width)) return SIDEBAR_DEFAULT_WIDTH
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

/** Split-view ratio bounds (fraction of content width given to the left pane). */
export const SPLIT_RATIO_MIN = 0.15
export const SPLIT_RATIO_MAX = 0.85
export const SPLIT_RATIO_DEFAULT = 0.5

export function clampSplitRatio(ratio: unknown): number {
  if (typeof ratio !== 'number' || Number.isNaN(ratio)) return SPLIT_RATIO_DEFAULT
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio))
}

/** Calendar display mode. Kept transient (not persisted). */
export type CalendarView = 'month' | 'week' | 'day'

/** Appearance: fixed dark/light, or follow the OS. */
export type ThemeMode = 'dark' | 'light' | 'system'

/** One daily clock alarm. `quietUntil` suppresses re-fire right after stop. */
export interface AlarmItem {
  id: string
  label: string
  time: string | null
  enabled: boolean
  ringing: boolean
  snoozeUntil: string | null
  quietUntil: number
  soundId: string
  /** Re-fire on an interval until Stop. */
  repeat: boolean
  repeatMin: number
  /** Last fire/repeat timestamp (drives the interval). */
  lastRepeatAt: number
}

/** One countdown timer. Progress derives from `endsAt` while running. Kind
 * `pomodoro` cycles focus/break phases using the pomodoro fields. */
export interface TimerItem {
  id: string
  label: string
  kind: 'simple' | 'pomodoro'
  totalSec: number
  leftSec: number
  endsAt: number | null
  running: boolean
  ringing: boolean
  soundId: string
  phase: PomodoroPhase
  completedFocus: number
  focusMin: number
  breakMin: number
  longBreakMin: number
  roundsBeforeLong: number
  autoAdvance: boolean
}

/** One stopwatch. Elapsed = accMs + (running ? now - startStamp : 0). */
export interface StopwatchItem {
  id: string
  label: string
  accMs: number
  startStamp: number | null
}

import type { PomodoroPhase } from '../time'

export type { PomodoroPhase }

interface AppState {
  coreState: CoreState
  spaces: NoteSpace[]
  activeSpaceId: string
  createSpace: (name: string, emoji: string) => string
  updateSpace: (id: string, patch: Partial<Pick<NoteSpace, 'name' | 'emoji'>>) => void
  deleteSpace: (id: string) => void
  setActiveSpace: (id: string) => void
  moveSpace: (dragId: string, targetId: string | null, before: boolean) => void
  notes: Note[]
  /** Manual sidebar order (note ids). Missing ids render first, by recency. */
  noteOrder: string[]
  /** User-defined sidebar sections (dividers), in display order. */
  noteSections: NoteSection[]
  /** Favorite note ids (sidebar lens). Stale ids render nothing. */
  favorites: string[]
  /** noteId -> image src -> layout. Persisted per note, saved on change. */
  imageLayout: Record<string, Record<string, ImageLayout>>
  /** Note awaiting an in-sidebar rename (set on creation, consumed once). */
  renamingNoteId: string | null
  /** noteId -> section id. Missing (or stale) entries render ungrouped. */
  noteSection: Record<string, string>
  tabs: Tab[]
  activeTabId: string | null
  /**
   * Sidebar-selected view. Non-null renders that page in the main content
   * area instead of the note tabs (and never creates a tab). Null means the
   * note tabs are showing.
   */
  activeNav: NavKey | null
  /** Tab ids, most-recently-active first. Powers the Ctrl+Tab switcher order. */
  tabRecency: string[]
  /** Linear visit history + cursor. Back/Forward step through it browser-style. */
  tabHistory: string[]
  historyIndex: number
  /** Named, color-coded tab groups (top tab bar), in display order. */
  tabGroups: TabGroup[]
  /** tabId -> group id. Stale entries render ungrouped. */
  tabGroup: Record<string, string>
  /** Collapsed group ids hide their tabs until expanded. */
  collapsedTabGroups: string[]
  query: string
  vaultPath: string | null
  vaultReady: boolean
  vaultError: string | null
  messages: ChatMessage[]
  autoSync: boolean
  backgroundListening: boolean
  /** SeeMO-page-only mic mute. Independent from Always listening. */
  agentMicMuted: boolean
  orbEnabled: boolean
  lastSeenAgentId: string | null
  ttsEnabled: boolean
  theme: ThemeMode
  sidebarWidth: number
  /** Sidebar hidden (Notion-style collapse). Persists across sessions. */
  sidebarCollapsed: boolean
  /** Today-section event ids the user dismissed (hidden, not deleted). */
  dismissedTodayEvents: string[]
  /** Tab pinned in the right split pane; null = no split. */
  splitTabId: string | null
  /** Left-pane share of split-view width, 0..1. */
  splitRatio: number
  calendarView: CalendarView
  calendarCursor: string
  /** Daily clock alarms (HH:MM). Multiple instances allowed. */
  alarms: AlarmItem[]
  /** Countdown timers, driven by wall-clock endsAt timestamps. */
  timers: TimerItem[]
  /** Stopwatches, driven by accumulated ms + a running start stamp. */
  stopwatches: StopwatchItem[]
  alarmSoundId: string
  customAlarm: { name: string; url: string } | null
  setCoreState: (state: CoreState) => void
  setAutoSync: (enabled: boolean) => void
  setBackgroundListening: (enabled: boolean) => void
  setAgentMicMuted: (muted: boolean) => void
  setOrbEnabled: (enabled: boolean) => void
  setTtsEnabled: (enabled: boolean) => void
  setTheme: (theme: ThemeMode) => void
  setSidebarWidth: (width: number) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  dismissTodayEvent: (id: string) => void
  showTodayEvent: (id: string) => void
  showAllTodayEvents: () => void
  toggleSidebar: () => void
  /** Transient signal (incremented) asking App to re-lock the app. */
  lockRequested: number
  requestLock: () => void
  setSplitTab: (id: string | null) => void
  setSplitRatio: (ratio: number) => void
  markAgentSeen: () => void
  setQuery: (query: string) => void
  setActiveTab: (id: string) => void
  goBackTab: () => void
  goForwardTab: () => void
  setCalendarView: (view: CalendarView) => void
  setCalendarCursor: (date: string) => void
  openDay: (date: string) => void
  addAlarm: (time?: string | null) => string
  removeAlarm: (id: string) => void
  updateAlarm: (id: string, patch: Partial<AlarmItem>) => void
  addTimer: (totalSec?: number, kind?: TimerItem['kind']) => string
  removeTimer: (id: string) => void
  updateTimer: (id: string, patch: Partial<TimerItem>) => void
  addStopwatch: () => string
  removeStopwatch: (id: string) => void
  updateStopwatch: (id: string, patch: Partial<StopwatchItem>) => void
  setAlarmSoundId: (id: string) => void
  setCustomAlarm: (custom: { name: string; url: string } | null) => void
  openNav: (kind: NavKey) => void
  closeNav: () => void
  openNote: (noteId: string) => void
  closeTab: (id: string) => void
  closeAllTabs: () => void
  closeAllGroups: () => void
  moveTab: (dragId: string, targetId: string | null, before: boolean) => void
  moveNote: (dragId: string, targetId: string | null, before: boolean) => void
  createSection: (title?: string, spaceId?: string) => string
  renameSection: (id: string, title: string) => void
  deleteSection: (id: string) => void
  moveSection: (dragId: string, targetId: string | null, before: boolean) => void
  setNoteSection: (noteId: string, sectionId: string | null) => void
  toggleFavorite: (noteId: string) => void
  setImageSide: (noteId: string, src: string, side: ImageSide) => void
  setImageSize: (noteId: string, src: string, w: number | null) => void
  clearImageFloat: (noteId: string, src: string) => void
  setRenamingNoteId: (id: string | null) => void
  openNoteInCurrentTab: (noteId: string) => void
  openNoteNewTab: (noteId: string) => string
  createTabGroup: (name?: string, color?: string, tabIds?: string[]) => string
  renameTabGroup: (id: string, name: string) => void
  setTabGroupColor: (id: string, color: string) => void
  deleteTabGroup: (id: string) => void
  assignTabToGroup: (tabId: string, groupId: string | null) => void
  toggleTabGroupCollapsed: (id: string) => void
  moveTabGroup: (dragId: string, targetId: string | null, before: boolean) => void
  restoreNote: (id: string) => void
  destroyNote: (id: string) => void
  emptyTrash: () => void
  createNote: (title?: string, sectionId?: string | null, spaceId?: string) => string
  updateNote: (id: string, patch: Partial<Pick<Note, 'title' | 'content'>>) => void
  deleteNote: (id: string) => void
  initVault: (force?: boolean) => Promise<void>
  refreshVault: () => Promise<void>
  saveNoteToVault: (id: string) => Promise<void>
  chooseVault: () => Promise<string | null>
  addChatMessage: (role: ChatMessage['role'], text: string) => string
  updateChatMessage: (id: string, text: string) => void
  clearChat: () => void
  calendarItems: CalendarItem[]
  tasks: TaskItem[]
  routines: RoutineItem[]
  subscriptions: CalendarSubscription[]
  localCalendarColor: string
  plannerReady: boolean
  plannerError: string | null
  loadPlanner: () => Promise<void>
  addCalendarItem: (draft: CalendarDraft) => void
  updateCalendarItem: (id: string, patch: Partial<CalendarDraft>) => void
  deleteCalendarItem: (id: string) => void
  addTask: (draft: TaskDraft) => string
  updateTask: (id: string, patch: Partial<TaskDraft> & { done?: boolean }) => void
  toggleTask: (id: string) => void
  deleteTask: (id: string) => void
  clearCompletedTasks: () => void
  addRoutine: (title?: string) => string
  renameRoutine: (id: string, title: string) => void
  deleteRoutine: (id: string) => void
  addRoutineStep: (routineId: string, title?: string) => string | null
  renameRoutineStep: (routineId: string, stepId: string, title: string) => void
  removeRoutineStep: (routineId: string, stepId: string) => void
  toggleRoutineStep: (routineId: string, stepId: string) => void
  toggleRoutineAll: (routineId: string) => void
  resetRoutine: (routineId: string) => void
  ensureRoutinesToday: () => void
  setLocalCalendarColor: (color: string) => void
  addSubscription: (input: { name: string; url: string; color: string }) => Promise<string>
  updateSubscription: (
    id: string,
    patch: Partial<Pick<CalendarSubscription, 'name' | 'color' | 'enabled'>>
  ) => void
  removeSubscription: (id: string) => void
  refreshSubscription: (id: string) => Promise<void>
  refreshAllSubscriptions: () => Promise<void>
}

function uid(): string {
  return crypto.randomUUID()
}

export interface NoteSection {
  id: string
  title: string
  /** Owning space: sections are independent per space. */
  spaceId: string
}

/** Google-style tab group colors. */
export const TAB_GROUP_COLORS = [
  '#9aa4b2',
  '#3f8fff',
  '#ff6b6b',
  '#ffbe5a',
  '#2fd066',
  '#ff6b8a',
  '#b284ff',
  '#2fd0e0',
  '#f98b3f'
] as const

export interface TabGroup {
  id: string
  name: string
  color: string
}

/** Drop group assignments for tabs that no longer exist. */
function pruneTabGroupMap(map: Record<string, string>, keep: Set<string>): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [tabId, groupId] of Object.entries(map)) {
    if (keep.has(tabId)) next[tabId] = groupId
  }
  return next
}

function noteTab(noteId: string): Tab {
  return { id: uid(), kind: 'note', noteId }
}

/** Move a tab id to the front of the recency list (drops duplicates). */
function toFront(recency: string[], id: string): string[] {
  return [id, ...recency.filter((tabId) => tabId !== id)]
}

const MAX_TAB_HISTORY = 100

/**
 * Record a visit: drop any "forward" entries past the cursor, append the tab
 * (unless it repeats the current entry), and cap the length.
 */
function pushHistory(
  history: string[],
  index: number,
  id: string
): { tabHistory: string[]; historyIndex: number } {
  const base = history.slice(0, index + 1)
  if (base[base.length - 1] !== id) base.push(id)
  const tabHistory = base.slice(-MAX_TAB_HISTORY)
  return { tabHistory, historyIndex: tabHistory.length - 1 }
}

/**
 * Drop history entries whose tabs no longer exist, keeping the cursor on the
 * same visit where possible.
 */
function pruneHistory(
  history: string[],
  index: number,
  keep: Set<string>
): { tabHistory: string[]; historyIndex: number } {
  const current = history[index]
  const tabHistory = history.filter((id) => keep.has(id))
  if (tabHistory.length === 0) return { tabHistory, historyIndex: -1 }
  if (current !== undefined && keep.has(current)) {
    return { tabHistory, historyIndex: tabHistory.indexOf(current) }
  }
  return { tabHistory, historyIndex: Math.min(Math.max(index, 0), tabHistory.length - 1) }
}

function blankNote(): Note {
  const now = Date.now()
  return {
    id: uid(),
    title: '',
    content: '',
    fileName: '',
    createdAt: now,
    updatedAt: now,
    deletedAt: null
  }
}

const initialNav: NavKey = 'home'

/** Guard so StrictMode double-mounts and manual refreshes share one load. */
let vaultInitPromise: Promise<void> | null = null

/**
 * Restore the alarm sound selection. Custom entries from before the file
 * protocol existed stored a data URL; those are dropped (and the selection
 * reset) so the UI never claims "custom" while playing a built-in sound.
 */
function restoreAlarmSound(saved: { alarmSoundId?: unknown; customAlarm?: unknown }): {
  alarmSoundId: string
  customAlarm: { name: string; url: string } | null
} {
  const raw = saved.customAlarm
  const customAlarm =
    raw &&
    typeof raw === 'object' &&
    typeof (raw as { name?: unknown }).name === 'string' &&
    typeof (raw as { url?: unknown }).url === 'string'
      ? { name: (raw as { name: string }).name, url: (raw as { url: string }).url }
      : null
  const requested =
    typeof saved.alarmSoundId === 'string' && saved.alarmSoundId.length > 0
      ? saved.alarmSoundId
      : 'classic'
  const alarmSoundId = requested === 'custom' && !customAlarm ? 'classic' : requested
  return { alarmSoundId, customAlarm }
}

type SavedClocks = {
  alarms?: unknown
  timers?: unknown
  stopwatches?: unknown
  alarmTime?: unknown
  alarmEnabled?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/**
 * Restore clock alarms, migrating the pre-list single alarm
 * (`alarmTime`/`alarmEnabled`) into a one-item list.
 */
function restoreAlarms(saved: SavedClocks): AlarmItem[] {
  const out: AlarmItem[] = []
  if (Array.isArray(saved.alarms)) {
    for (const raw of saved.alarms) {
      const item = asRecord(raw)
      if (!item || typeof item.id !== 'string') continue
      const repeatMin =
        typeof item.repeatMin === 'number' && !Number.isNaN(item.repeatMin)
          ? Math.min(60, Math.max(1, Math.floor(item.repeatMin)))
          : 5
      out.push({
        id: item.id,
        label: typeof item.label === 'string' && item.label ? item.label : 'Alarm',
        soundId:
          typeof item.soundId === 'string' && isKnownSoundId(item.soundId)
            ? item.soundId
            : 'classic',
        time: typeof item.time === 'string' ? item.time : null,
        enabled: item.enabled === true,
        ringing: false,
        snoozeUntil: typeof item.snoozeUntil === 'string' ? item.snoozeUntil : null,
        quietUntil: 0,
        repeat: item.repeat === true,
        repeatMin,
        lastRepeatAt: 0
      })
    }
  }
  if (out.length === 0 && typeof saved.alarmTime === 'string') {
    out.push({
      id: uid(),
      label: 'Alarm',
      soundId: 'classic',
      time: saved.alarmTime,
      enabled: saved.alarmEnabled === true,
      ringing: false,
      snoozeUntil: null,
      quietUntil: 0,
      repeat: false,
      repeatMin: 5,
      lastRepeatAt: 0
    })
  }
  return out
}

/**
 * Restore timers. Ones that expired while the app was closed come back
 * ringing (dismiss to clear); running ones keep counting from `endsAt`.
 * A leftover standalone pomodoro session migrates into a pomodoro timer.
 */
function restoreTimers(saved: SavedClocks & { pomodoro?: unknown }): TimerItem[] {
  const now = Date.now()
  const num = (value: unknown, min: number, max: number, or: number): number => {
    if (typeof value !== 'number' || Number.isNaN(value)) return or
    return Math.min(max, Math.max(min, Math.floor(value)))
  }
  const sound = (value: unknown): string =>
    typeof value === 'string' && isKnownSoundId(value) ? value : 'classic'
  const phaseOf = (value: unknown): PomodoroPhase =>
    value === 'focus' || value === 'break' || value === 'longBreak' ? value : 'idle'
  const out: TimerItem[] = []
  const settle = (raw: Record<string, unknown>, base: TimerItem): TimerItem => {
    const endsAt = typeof raw.endsAt === 'number' ? raw.endsAt : null
    const running = raw.running === true && endsAt !== null
    const expired = running && endsAt !== null && endsAt <= now
    return {
      ...base,
      endsAt: expired ? null : endsAt,
      running: running && !expired,
      ringing: expired,
      completedFocus:
        expired && base.kind === 'pomodoro' && base.phase === 'focus'
          ? base.completedFocus + 1
          : base.completedFocus
    }
  }
  if (Array.isArray(saved.timers)) {
    for (const raw of saved.timers) {
      const item = asRecord(raw)
      if (!item || typeof item.id !== 'string') continue
      const kind = item.kind === 'pomodoro' ? 'pomodoro' : 'simple'
      const totalSec =
        typeof item.totalSec === 'number' && item.totalSec > 0 ? Math.floor(item.totalSec) : 60
      out.push(
        settle(item, {
          id: item.id,
          label: typeof item.label === 'string' && item.label ? item.label : 'Timer',
          kind,
          totalSec,
          leftSec:
            typeof item.leftSec === 'number' && item.leftSec >= 0
              ? Math.min(Math.floor(item.leftSec), totalSec)
              : totalSec,
          endsAt: null,
          running: false,
          ringing: false,
          soundId: sound(item.soundId),
          phase: phaseOf(item.phase),
          completedFocus: num(item.completedFocus, 0, 100, 0),
          focusMin: num(item.focusMin, 1, 180, 25),
          breakMin: num(item.breakMin, 1, 60, 5),
          longBreakMin: num(item.longBreakMin, 1, 90, 15),
          roundsBeforeLong: num(item.roundsBeforeLong, 2, 12, 4),
          autoAdvance: item.autoAdvance !== false
        })
      )
    }
  }
  const pomo = asRecord(saved.pomodoro)
  if (pomo) {
    const phase = phaseOf(pomo.phase)
    const focusMin = num(pomo.focusMin, 1, 180, 25)
    const breakMin = num(pomo.breakMin, 1, 60, 5)
    const longBreakMin = num(pomo.longBreakMin, 1, 90, 15)
    const roundsBeforeLong = num(pomo.roundsBeforeLong, 2, 12, 4)
    const completedFocus = num(pomo.completedFocus, 0, 100, 0)
    const meaningful =
      phase !== 'idle' ||
      completedFocus > 0 ||
      focusMin !== 25 ||
      breakMin !== 5 ||
      longBreakMin !== 15 ||
      roundsBeforeLong !== 4
    if (meaningful) {
      const endsAt = typeof pomo.endsAt === 'number' ? pomo.endsAt : null
      const running = pomo.running === true && endsAt !== null && phase !== 'idle'
      const expired = running && endsAt !== null && endsAt <= now
      const leftSec =
        typeof pomo.leftSec === 'number' && pomo.leftSec >= 0
          ? Math.floor(pomo.leftSec)
          : focusMin * 60
      out.unshift({
        id: typeof pomo.id === 'string' ? pomo.id : uid(),
        label: 'Pomodoro',
        kind: 'pomodoro',
        totalSec: focusMin * 60,
        leftSec,
        endsAt: expired ? null : endsAt,
        running: running && !expired,
        ringing: expired,
        soundId: sound(pomo.soundId),
        phase,
        completedFocus: completedFocus + (expired && phase === 'focus' ? 1 : 0),
        focusMin,
        breakMin,
        longBreakMin,
        roundsBeforeLong,
        autoAdvance: pomo.autoAdvance !== false
      })
    }
  }
  return out
}

/** Restore stopwatches; running ones keep ticking from `startStamp`. */
function restoreStopwatches(saved: SavedClocks): StopwatchItem[] {
  if (!Array.isArray(saved.stopwatches)) return []
  const out: StopwatchItem[] = []
  for (const raw of saved.stopwatches) {
    const item = asRecord(raw)
    if (!item || typeof item.id !== 'string') continue
    const startStamp = typeof item.startStamp === 'number' ? item.startStamp : null
    out.push({
      id: item.id,
      label: typeof item.label === 'string' && item.label ? item.label : 'Stopwatch',
      accMs: typeof item.accMs === 'number' && item.accMs >= 0 ? Math.floor(item.accMs) : 0,
      startStamp
    })
  }
  return out
}

type PersistSet = (partial: Partial<AppState>) => void

/** Fire-and-forget vault writes; surface failures in the planner banner. */
function saveCalendarFile(items: CalendarItem[], set: PersistSet): void {
  void window.api.vault.writeJson(CALENDAR_FILE, items).catch((error) => {
    console.error('[planner] failed to save calendar.json', error)
    set({ plannerError: 'Could not save calendar.json.' })
  })
}

function saveTaskFile(tasks: TaskItem[], set: PersistSet): void {
  void window.api.vault.writeJson(TASKS_FILE, tasks).catch((error) => {
    console.error('[planner] failed to save tasks.json', error)
    set({ plannerError: 'Could not save tasks.json.' })
  })
}

function saveRoutineFile(routines: RoutineItem[], set: PersistSet): void {
  void window.api.vault.writeJson(ROUTINES_FILE, routines).catch((error) => {
    console.error('[planner] failed to save routines.json', error)
    set({ plannerError: 'Could not save routines.json.' })
  })
}

/**
 * Clear step checks when the day has rolled over since `lastReset`.
 * Returns the normalized list plus whether anything changed (caller saves).
 */
function normalizeRoutineDay(
  routines: RoutineItem[],
  today: string,
  now: number
): { routines: RoutineItem[]; changed: boolean } {
  let changed = false
  const next = routines.map((routine) => {
    if (routine.lastReset === today) return routine
    changed = true
    return {
      ...routine,
      steps: routine.steps.map((step) => (step.done ? { ...step, done: false } : step)),
      lastReset: today,
      updatedAt: now
    }
  })
  return { routines: next, changed }
}

function saveCalendarsFile(subscriptions: CalendarSubscription[], set: PersistSet): void {
  void window.api.vault.writeJson(CALENDARS_FILE, subscriptions).catch((error) => {
    console.error('[planner] failed to save calendars.json', error)
    set({ plannerError: 'Could not save calendars.json.' })
  })
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // The mic pipeline is always listening, so the core starts attentive.
      coreState: 'idle',
      spaces: [{ id: 'default', name: 'Personal', emoji: '📝' }],
      activeSpaceId: 'default',
      notes: [],
      noteOrder: [],
      noteSections: [],
      noteSection: {},
      favorites: [],
      imageLayout: {},
      renamingNoteId: null,
      tabs: [],
      activeTabId: null,
      activeNav: initialNav,
      tabRecency: [],
      tabHistory: [],
      historyIndex: -1,
      tabGroups: [],
      tabGroup: {},
      collapsedTabGroups: [],
      query: '',
      vaultPath: null,
      vaultReady: false,
      vaultError: null,
      messages: [],
      calendarItems: [],
      tasks: [],
      routines: [],
      subscriptions: [],
      localCalendarColor: CALENDAR_COLORS[0],
      plannerReady: false,
      plannerError: null,
      autoSync: false,
      backgroundListening: false,
      agentMicMuted: false,
      orbEnabled: true,
      lastSeenAgentId: null,
      ttsEnabled: true,
      theme: 'dark',
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      sidebarCollapsed: false,
      lockRequested: 0,
      dismissedTodayEvents: [],
      splitTabId: null,
      splitRatio: SPLIT_RATIO_DEFAULT,
      calendarView: 'month',
      calendarCursor: todayISO(),
      alarms: [],
      timers: [],
      stopwatches: [],
      pomodoro: {
        focusMin: 25,
        breakMin: 5,
        longBreakMin: 15,
        roundsBeforeLong: 4,
        autoAdvance: true,
        soundId: 'classic',
        phase: 'idle',
        running: false,
        ringing: false,
        endsAt: null,
        leftSec: 25 * 60,
        completedFocus: 0
      },
      alarmSoundId: 'classic',
      customAlarm: null,

      setCoreState: (coreState) => set({ coreState }),
      setAutoSync: (autoSync) => set({ autoSync }),
      setBackgroundListening: (backgroundListening) => set({ backgroundListening }),
      setAgentMicMuted: (agentMicMuted) => set({ agentMicMuted }),
      setOrbEnabled: (orbEnabled) => set({ orbEnabled }),
      setTtsEnabled: (ttsEnabled) => set({ ttsEnabled }),
      setTheme: (theme) => set({ theme }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth: clampSidebarWidth(sidebarWidth) }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      dismissTodayEvent: (id) =>
        set((state) => ({
          dismissedTodayEvents: state.dismissedTodayEvents.includes(id)
            ? state.dismissedTodayEvents
            : [...state.dismissedTodayEvents, id]
        })),
      showTodayEvent: (id) =>
        set((state) => ({
          dismissedTodayEvents: state.dismissedTodayEvents.filter((d) => d !== id)
        })),
      showAllTodayEvents: () => set({ dismissedTodayEvents: [] }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      requestLock: () => set((state) => ({ lockRequested: state.lockRequested + 1 })),
      setSplitTab: (splitTabId) => set({ splitTabId }),
      setSplitRatio: (splitRatio) => set({ splitRatio: clampSplitRatio(splitRatio) }),
      markAgentSeen: () =>
        set((state) => {
          let latest: string | null = null
          for (const message of state.messages) {
            if (message.role === 'agent') latest = message.id
          }
          return latest ? { lastSeenAgentId: latest } : {}
        }),
      setQuery: (query) => set({ query }),
      createSpace: (name, emoji) => {
        const id = uid()
        set((state) => ({
          spaces: [
            ...state.spaces,
            { id, name: name.trim() || 'New space', emoji: emoji.trim() || '📁' }
          ],
          activeSpaceId: id,
          // Adopt notes left space-less (e.g. after deleting the last space)
          // so they reappear here instead of being stranded.
          notes: state.notes.map((note) => (note.spaceId ? note : { ...note, spaceId: id }))
        }))
        return id
      },
      updateSpace: (id, patch) =>
        set((state) => ({
          spaces: state.spaces.map((space) =>
            space.id === id
              ? {
                  ...space,
                  ...(patch.name !== undefined ? { name: patch.name.trim() || space.name } : {}),
                  ...(patch.emoji !== undefined ? { emoji: patch.emoji.trim() || space.emoji } : {})
                }
              : space
          )
        })),
      deleteSpace: (id) =>
        set((state) => {
          if (!state.spaces.some((space) => space.id === id)) return {}
          // Zero spaces is allowed: notes fall into the space-less bucket.
          const spaces = state.spaces.filter((space) => space.id !== id)
          const replacementId = spaces[0]?.id ?? ''
          // The space's sections go with it; drop their note mappings too.
          const removedSections = new Set(
            state.noteSections.filter((s) => s.spaceId === id).map((s) => s.id)
          )
          const noteSection: Record<string, string> = {}
          for (const [noteId, sectionId] of Object.entries(state.noteSection)) {
            if (!removedSections.has(sectionId)) noteSection[noteId] = sectionId
          }
          return {
            spaces,
            activeSpaceId: state.activeSpaceId === id ? replacementId : state.activeSpaceId,
            noteSections: state.noteSections.filter((s) => s.spaceId !== id),
            noteSection,
            notes: state.notes.map((note) =>
              note.spaceId === id ? { ...note, spaceId: replacementId } : note
            )
          }
        }),
      setActiveSpace: (id) =>
        set((state) =>
          state.spaces.some((space) => space.id === id) ? { activeSpaceId: id } : {}
        ),
      moveSpace: (dragId, targetId, before) =>
        set((state) => {
          if (dragId === targetId) return {}
          const from = state.spaces.findIndex((space) => space.id === dragId)
          if (from < 0) return {}
          const dragged = state.spaces[from]
          const without = state.spaces.filter((space) => space.id !== dragId)
          if (!targetId) return { spaces: [...without, dragged] }
          let to = without.findIndex((space) => space.id === targetId)
          if (to < 0) return { spaces: [...without, dragged] }
          if (!before) to += 1
          return { spaces: [...without.slice(0, to), dragged, ...without.slice(to)] }
        }),
      setActiveTab: (id) =>
        set((state) => ({
          activeTabId: id,
          activeNav: null,
          tabRecency: toFront(state.tabRecency, id),
          ...pushHistory(state.tabHistory, state.historyIndex, id)
        })),
      goBackTab: () =>
        set((state) => {
          const index = state.historyIndex - 1
          if (index < 0) return {}
          const id = state.tabHistory[index]
          if (!state.tabs.some((t) => t.id === id)) return {}
          return {
            activeTabId: id,
            activeNav: null,
            historyIndex: index,
            tabRecency: toFront(state.tabRecency, id)
          }
        }),
      goForwardTab: () =>
        set((state) => {
          const index = state.historyIndex + 1
          if (index >= state.tabHistory.length) return {}
          const id = state.tabHistory[index]
          if (!state.tabs.some((t) => t.id === id)) return {}
          return {
            activeTabId: id,
            activeNav: null,
            historyIndex: index,
            tabRecency: toFront(state.tabRecency, id)
          }
        }),
      setCalendarView: (calendarView) => set({ calendarView }),
      setCalendarCursor: (calendarCursor) => set({ calendarCursor }),
      openDay: (date) => {
        set({ calendarView: 'day', calendarCursor: date })
        get().openNav('calendar')
      },
      addAlarm: (time) => {
        const id = uid()
        set((state) => ({
          alarms: [
            ...state.alarms,
            {
              id,
              label: `Alarm ${state.alarms.length + 1}`,
              soundId: state.alarmSoundId,
              time: time ?? null,
              enabled: time !== null && time !== undefined,
              ringing: false,
              snoozeUntil: null,
              quietUntil: 0,
              repeat: false,
              repeatMin: 5,
              lastRepeatAt: 0
            }
          ]
        }))
        return id
      },
      removeAlarm: (id) =>
        set((state) => ({ alarms: state.alarms.filter((alarm) => alarm.id !== id) })),
      updateAlarm: (id, patch) =>
        set((state) => ({
          alarms: state.alarms.map((alarm) => (alarm.id === id ? { ...alarm, ...patch } : alarm))
        })),
      addTimer: (totalSec, kind) => {
        const id = uid()
        const seconds = totalSec ?? 300
        const timerKind = kind ?? 'simple'
        set((state) => ({
          timers: [
            ...state.timers,
            {
              id,
              label: timerKind === 'pomodoro' ? 'Pomodoro' : `Timer ${state.timers.length + 1}`,
              kind: timerKind,
              soundId: state.alarmSoundId,
              totalSec: timerKind === 'pomodoro' ? 25 * 60 : seconds,
              leftSec: timerKind === 'pomodoro' ? 25 * 60 : seconds,
              endsAt: null,
              running: false,
              ringing: false,
              phase: 'idle',
              completedFocus: 0,
              focusMin: 25,
              breakMin: 5,
              longBreakMin: 15,
              roundsBeforeLong: 4,
              autoAdvance: true
            }
          ]
        }))
        return id
      },
      removeTimer: (id) =>
        set((state) => ({ timers: state.timers.filter((timer) => timer.id !== id) })),
      updateTimer: (id, patch) =>
        set((state) => ({
          timers: state.timers.map((timer) => (timer.id === id ? { ...timer, ...patch } : timer))
        })),
      addStopwatch: () => {
        const id = uid()
        set((state) => ({
          stopwatches: [
            ...state.stopwatches,
            { id, label: `Stopwatch ${state.stopwatches.length + 1}`, accMs: 0, startStamp: null }
          ]
        }))
        return id
      },
      removeStopwatch: (id) =>
        set((state) => ({ stopwatches: state.stopwatches.filter((sw) => sw.id !== id) })),
      updateStopwatch: (id, patch) =>
        set((state) => ({
          stopwatches: state.stopwatches.map((sw) => (sw.id === id ? { ...sw, ...patch } : sw))
        })),
      setAlarmSoundId: (alarmSoundId) => set({ alarmSoundId }),
      setCustomAlarm: (customAlarm) => set({ customAlarm }),
      openNav: (kind) => set({ activeNav: kind }),
      closeNav: () => set({ activeNav: null }),
      openNote: (noteId) => {
        // Trashed notes never open; restore them from the Trash section first.
        if (get().notes.find((n) => n.id === noteId)?.deletedAt) return
        set((state) => {
          const existing = state.tabs.find((t) => t.kind === 'note' && t.noteId === noteId)
          if (existing)
            return {
              activeTabId: existing.id,
              activeNav: null,
              tabRecency: toFront(state.tabRecency, existing.id),
              ...pushHistory(state.tabHistory, state.historyIndex, existing.id)
            }
          const tab = noteTab(noteId)
          return {
            tabs: [...state.tabs, tab],
            activeTabId: tab.id,
            activeNav: null,
            tabRecency: toFront(state.tabRecency, tab.id),
            ...pushHistory(state.tabHistory, state.historyIndex, tab.id)
          }
        })
      },
      openNoteInCurrentTab: (noteId) => {
        if (get().notes.find((n) => n.id === noteId)?.deletedAt) return
        set((state) => {
          const existing = state.tabs.find((t) => t.kind === 'note' && t.noteId === noteId)
          if (existing)
            return {
              activeTabId: existing.id,
              activeNav: null,
              tabRecency: toFront(state.tabRecency, existing.id),
              ...pushHistory(state.tabHistory, state.historyIndex, existing.id)
            }
          // Reuse the active note tab instead of spawning tabs on every click.
          // When arriving from a nav view (activeNav set) there is no note
          // tab to reuse yet if the tab list is empty — fall through and
          // create one.
          const active =
            state.activeNav === null ? state.tabs.find((t) => t.id === state.activeTabId) : null
          if (active && active.kind === 'note') {
            return {
              tabs: state.tabs.map((t) =>
                t.id === active.id && t.kind === 'note' ? { ...t, noteId } : t
              ),
              activeTabId: active.id,
              activeNav: null,
              tabRecency: toFront(state.tabRecency, active.id),
              ...pushHistory(state.tabHistory, state.historyIndex, active.id)
            }
          }
          const tab = noteTab(noteId)
          return {
            tabs: [...state.tabs, tab],
            activeTabId: tab.id,
            activeNav: null,
            tabRecency: toFront(state.tabRecency, tab.id),
            ...pushHistory(state.tabHistory, state.historyIndex, tab.id)
          }
        })
      },
      openNoteNewTab: (noteId) => {
        if (get().notes.find((n) => n.id === noteId)?.deletedAt) return ''
        const tab = noteTab(noteId)
        set((state) => ({
          tabs: [...state.tabs, tab],
          activeTabId: tab.id,
          activeNav: null,
          tabRecency: toFront(state.tabRecency, tab.id),
          ...pushHistory(state.tabHistory, state.historyIndex, tab.id)
        }))
        return tab.id
      },
      createTabGroup: (name?: string, color?: string, tabIds?: string[]) => {
        const groups = get().tabGroups
        const group: TabGroup = {
          id: uid(),
          // New groups start unnamed so the rename input opens empty and
          // the user only types a name if they want one.
          name: (name ?? '').trim(),
          color:
            color && TAB_GROUP_COLORS.includes(color as (typeof TAB_GROUP_COLORS)[number])
              ? color
              : TAB_GROUP_COLORS[groups.length % TAB_GROUP_COLORS.length]
        }
        set((state) => {
          const tabGroup = { ...state.tabGroup }
          for (const tabId of tabIds ?? []) {
            if (state.tabs.some((t) => t.id === tabId)) tabGroup[tabId] = group.id
          }
          return { tabGroups: [...state.tabGroups, group], tabGroup }
        })
        return group.id
      },
      renameTabGroup: (id, name) =>
        set((state) => ({
          // Empty names are allowed so a group can stay unnamed.
          tabGroups: state.tabGroups.map((g) => (g.id === id ? { ...g, name: name.trim() } : g))
        })),
      setTabGroupColor: (id, color) => {
        if (!TAB_GROUP_COLORS.includes(color as (typeof TAB_GROUP_COLORS)[number])) return
        set((state) => ({
          tabGroups: state.tabGroups.map((g) => (g.id === id ? { ...g, color } : g))
        }))
      },
      deleteTabGroup: (id) =>
        set((state) => {
          const tabGroup: Record<string, string> = {}
          for (const [tabId, groupId] of Object.entries(state.tabGroup)) {
            if (groupId !== id) tabGroup[tabId] = groupId
          }
          return {
            tabGroups: state.tabGroups.filter((g) => g.id !== id),
            tabGroup,
            collapsedTabGroups: state.collapsedTabGroups.filter((g) => g !== id)
          }
        }),
      assignTabToGroup: (tabId, groupId) =>
        set((state) => {
          if (!state.tabs.some((t) => t.id === tabId)) return {}
          if (groupId && !state.tabGroups.some((g) => g.id === groupId)) return {}
          const tabGroup = { ...state.tabGroup }
          if (groupId) tabGroup[tabId] = groupId
          else delete tabGroup[tabId]
          return { tabGroup }
        }),
      toggleTabGroupCollapsed: (id) =>
        set((state) => ({
          collapsedTabGroups: state.collapsedTabGroups.includes(id)
            ? state.collapsedTabGroups.filter((g) => g !== id)
            : [...state.collapsedTabGroups, id]
        })),
      moveTabGroup: (dragId, targetId, before) =>
        set((state) => {
          if (dragId === targetId) return {}
          const from = state.tabGroups.findIndex((g) => g.id === dragId)
          if (from < 0) return {}
          const dragged = state.tabGroups[from]
          const without = state.tabGroups.filter((g) => g.id !== dragId)
          // Dropped on empty bar space (or a stale target): pin to the end.
          if (!targetId) return { tabGroups: [...without, dragged] }
          let to = without.findIndex((g) => g.id === targetId)
          if (to < 0) return { tabGroups: [...without, dragged] }
          if (!before) to += 1
          return { tabGroups: [...without.slice(0, to), dragged, ...without.slice(to)] }
        }),
      closeTab: (id) =>
        set((state) => {
          const index = state.tabs.findIndex((t) => t.id === id)
          if (index < 0) return {}
          const tabs = state.tabs.filter((t) => t.id !== id)
          let activeTabId =
            state.activeTabId === id
              ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null)
              : state.activeTabId
          // Closing the last note tab lands back on Home rather than a
          // blank shell; nav views never needed a tab at all.
          const activeNav = tabs.length === 0 && state.activeNav === null ? 'home' : state.activeNav
          if (tabs.length === 0) activeTabId = null
          // Closing the split tab itself dissolves the split.
          const splitTabId = state.splitTabId === id ? null : state.splitTabId
          const keep = new Set(tabs.map((t) => t.id))
          const history = pruneHistory(state.tabHistory, state.historyIndex, keep)
          return {
            tabs,
            activeTabId,
            activeNav,
            splitTabId,
            tabRecency: state.tabRecency.filter((t) => keep.has(t)),
            ...(history.tabHistory.length > 0
              ? history
              : {
                  tabHistory: activeTabId ? [activeTabId] : [],
                  historyIndex: activeTabId ? 0 : -1
                }),
            tabGroup: pruneTabGroupMap(state.tabGroup, keep)
          }
        }),
      closeAllTabs: () => {
        // Clearing closes ungrouped tabs only; grouped tabs are kept.
        // With nothing left, land back on Home, never an empty shell.
        const grouped = (tabs: Tab[], tabGroup: Record<string, string>): Tab[] =>
          tabs.filter((t) => tabGroup[t.id])
        return set((state) => {
          const kept = grouped(state.tabs, state.tabGroup)
          if (kept.length === 0) {
            return {
              tabs: [],
              activeTabId: null,
              activeNav: 'home' as NavKey,
              splitTabId: null,
              tabRecency: [],
              tabHistory: [],
              historyIndex: -1,
              tabGroup: {}
            }
          }
          const keep = new Set(kept.map((t) => t.id))
          const activeTabId: string =
            state.activeTabId !== null && keep.has(state.activeTabId)
              ? state.activeTabId
              : kept[0].id
          const history = pruneHistory(state.tabHistory, state.historyIndex, keep)
          return {
            tabs: kept,
            activeTabId,
            activeNav: null,
            splitTabId: state.splitTabId && keep.has(state.splitTabId) ? state.splitTabId : null,
            tabRecency: state.tabRecency.filter((t) => keep.has(t)),
            ...(history.tabHistory.length > 0
              ? history
              : { tabHistory: [activeTabId], historyIndex: 0 }),
            tabGroup: pruneTabGroupMap(state.tabGroup, keep)
          }
        })
      },
      closeAllGroups: () => {
        // Close every tab that belongs to a group, then drop groups left
        // empty. Un-grouped tabs are untouched.
        const groupedIds = (state: {
          tabs: Tab[]
          tabGroup: Record<string, string>
        }): Set<string> => new Set(state.tabs.filter((t) => state.tabGroup[t.id]).map((t) => t.id))
        return set((state) => {
          const closing = groupedIds(state)
          if (closing.size === 0) return {}
          const tabs = state.tabs.filter((t) => !closing.has(t.id))
          const keep = new Set(tabs.map((t) => t.id))
          const activeTabId: string | null =
            state.activeTabId !== null && keep.has(state.activeTabId)
              ? state.activeTabId
              : (tabs[0]?.id ?? null)
          // Draining the last note tab lands on Home instead of blank.
          const activeNav: NavKey | null =
            tabs.length === 0 && state.activeNav === null ? 'home' : state.activeNav
          const history = pruneHistory(state.tabHistory, state.historyIndex, keep)
          const remainingGroups = new Set(Object.values(pruneTabGroupMap(state.tabGroup, keep)))
          return {
            tabs,
            activeTabId,
            activeNav,
            splitTabId: state.splitTabId && keep.has(state.splitTabId) ? state.splitTabId : null,
            tabRecency: state.tabRecency.filter((t) => keep.has(t)),
            ...(history.tabHistory.length > 0
              ? history
              : activeTabId
                ? { tabHistory: [activeTabId], historyIndex: 0 }
                : { tabHistory: [], historyIndex: -1 }),
            tabGroup: pruneTabGroupMap(state.tabGroup, keep),
            tabGroups: state.tabGroups.filter((g) => remainingGroups.has(g.id)),
            collapsedTabGroups: state.collapsedTabGroups.filter((id) => remainingGroups.has(id))
          }
        })
      },
      moveTab: (dragId, targetId, before) =>
        set((state) => {
          if (dragId === targetId) return {}
          const from = state.tabs.findIndex((t) => t.id === dragId)
          if (from < 0) return {}
          const dragged = state.tabs[from]
          const without = state.tabs.filter((t) => t.id !== dragId)
          // Dropped on empty bar space (or a stale target): pin to the end.
          if (!targetId) return { tabs: [...without, dragged] }
          let to = without.findIndex((t) => t.id === targetId)
          if (to < 0) return { tabs: [...without, dragged] }
          if (!before) to += 1
          return { tabs: [...without.slice(0, to), dragged, ...without.slice(to)] }
        }),
      moveNote: (dragId, targetId, before) =>
        set((state) => {
          if (dragId === targetId) return {}
          // Canonical full order first, so a partial/stale noteOrder heals
          // itself instead of dropping notes.
          const full = orderedNotes(state.notes, state.noteOrder).map((n) => n.id)
          if (!full.includes(dragId)) return {}
          const without = full.filter((id) => id !== dragId)
          // Dropped on empty list space (or a stale target): pin to the end.
          if (!targetId) return { noteOrder: [...without, dragId] }
          let to = without.indexOf(targetId)
          if (to < 0) return { noteOrder: [...without, dragId] }
          if (!before) to += 1
          return { noteOrder: [...without.slice(0, to), dragId, ...without.slice(to)] }
        }),
      createSection: (title?: string, spaceId?: string) => {
        const section: NoteSection = {
          id: uid(),
          title: (title ?? '').trim() || 'New section',
          spaceId: spaceId ?? get().activeSpaceId
        }
        set((state) => ({ noteSections: [...state.noteSections, section] }))
        return section.id
      },
      renameSection: (id, title) =>
        set((state) => ({
          noteSections: state.noteSections.map((s) =>
            s.id === id ? { ...s, title: title.trim() || s.title } : s
          )
        })),
      deleteSection: (id) =>
        set((state) => {
          const remaining: Record<string, string> = {}
          for (const [noteId, sectionId] of Object.entries(state.noteSection)) {
            if (sectionId !== id) remaining[noteId] = sectionId
          }
          return {
            noteSections: state.noteSections.filter((s) => s.id !== id),
            noteSection: remaining
          }
        }),
      moveSection: (dragId, targetId, before) =>
        set((state) => {
          if (dragId === targetId) return {}
          const from = state.noteSections.findIndex((s) => s.id === dragId)
          if (from < 0) return {}
          const dragged = state.noteSections[from]
          const without = state.noteSections.filter((s) => s.id !== dragId)
          if (!targetId) return { noteSections: [...without, dragged] }
          let to = without.findIndex((s) => s.id === targetId)
          if (to < 0) return { noteSections: [...without, dragged] }
          if (!before) to += 1
          return { noteSections: [...without.slice(0, to), dragged, ...without.slice(to)] }
        }),
      setNoteSection: (noteId, sectionId) =>
        set((state) => {
          if (sectionId && !state.noteSections.some((s) => s.id === sectionId)) return {}
          const noteSection = { ...state.noteSection }
          if (sectionId) noteSection[noteId] = sectionId
          else delete noteSection[noteId]
          return { noteSection }
        }),
      setRenamingNoteId: (renamingNoteId) => set({ renamingNoteId }),
      toggleFavorite: (noteId) =>
        set((state) => ({
          favorites: state.favorites.includes(noteId)
            ? state.favorites.filter((id) => id !== noteId)
            : [...state.favorites, noteId]
        })),
      setImageSide: (noteId, src, side) =>
        set((state) => ({
          imageLayout: {
            ...state.imageLayout,
            [noteId]: {
              ...state.imageLayout[noteId],
              [src]: { ...state.imageLayout[noteId]?.[src], side }
            }
          }
        })),
      setImageSize: (noteId, src, w) =>
        set((state) => {
          const prev = state.imageLayout[noteId]?.[src]
          const next = { ...prev }
          if (w === null) delete next.w
          else next.w = w
          const inner = { ...state.imageLayout[noteId] }
          if (next.side === undefined && next.w === undefined) {
            delete inner[src]
          } else {
            inner[src] = next
          }
          const imageLayout = { ...state.imageLayout }
          if (Object.keys(inner).length > 0) imageLayout[noteId] = inner
          else delete imageLayout[noteId]
          return { imageLayout }
        }),
      clearImageFloat: (noteId, src) =>
        set((state) => {
          // Locking back inline drops the dock side but keeps a pinned
          // width, if any.
          const prev = state.imageLayout[noteId]?.[src]
          const inner = { ...state.imageLayout[noteId] }
          if (prev && typeof prev.w === 'number') inner[src] = { w: prev.w }
          else delete inner[src]
          const imageLayout = { ...state.imageLayout }
          if (Object.keys(inner).length > 0) imageLayout[noteId] = inner
          else delete imageLayout[noteId]
          return { imageLayout }
        }),
      createNote: (title?: string, sectionId?: string | null, spaceId?: string) => {
        const note = {
          ...blankNote(),
          title: (title ?? '').trim(),
          spaceId: spaceId ?? get().activeSpaceId
        }
        const tab = noteTab(note.id)
        set((state) => {
          const taken = new Set(state.notes.map((n) => n.fileName))
          const fileName = uniqueFileName(noteFileBase(note.title), taken)
          // Filing straight into a section pins the note at the top of it:
          // new ids render first, and the section filter keeps the rest out.
          const noteSection = { ...state.noteSection }
          if (sectionId && state.noteSections.some((s) => s.id === sectionId)) {
            noteSection[note.id] = sectionId
          }
          return {
            notes: [{ ...note, fileName }, ...state.notes],
            noteOrder: [note.id, ...state.noteOrder.filter((id) => id !== note.id)],
            noteSection,
            tabs: [...state.tabs, tab],
            activeTabId: tab.id,
            activeNav: null,
            tabRecency: toFront(state.tabRecency, tab.id),
            ...pushHistory(state.tabHistory, state.historyIndex, tab.id)
          }
        })
        const created = get().notes.find((n) => n.id === note.id)
        if (created && get().vaultReady) {
          void window.api.vault.write(created.fileName, created.content).catch((error) => {
            console.error(`[vault] failed to write ${created.fileName}`, error)
            set({ vaultError: `Could not write ${created.fileName}.` })
          })
        }
        // The sidebar picks this up and opens an inline rename field.
        set({ renamingNoteId: note.id })
        return note.id
      },
      updateNote: (id, patch) => {
        // Renames follow the note: retarget `[[Old]]` links everywhere else
        // so hidden-footer children stay parented and inline embeds keep
        // opening the same note instead of spawning lookalikes.
        const current = get().notes.find((n) => n.id === id)
        const rawTitle = patch.title
        const effectiveOld = current ? current.title.trim() || 'Untitled' : ''
        const effectiveNew = typeof rawTitle === 'string' ? rawTitle.trim() || 'Untitled' : ''
        const sweep =
          current && typeof rawTitle === 'string' && effectiveNew !== effectiveOld
            ? { oldTitle: effectiveOld, newTitle: effectiveNew }
            : null
        set((state) => ({
          notes: state.notes.map((n) => {
            if (n.id === id) return { ...n, ...patch, updatedAt: Date.now() }
            if (sweep && !n.deletedAt) {
              const next = renameLinkTarget(n.content, sweep.oldTitle, sweep.newTitle)
              if (next !== n.content) return { ...n, content: next, updatedAt: Date.now() }
            }
            return n
          })
        }))
      },
      deleteNote: (id) => {
        // Trash, not destroy: the record keeps its order slot so restore
        // lands it back in place. initVault auto-purges trash older
        // than 30 days; destroyNote() removes immediately.
        const removed = get().notes.find((n) => n.id === id)
        if (!removed || removed.deletedAt) return
        const removeFile = Boolean(removed.fileName && get().vaultReady)
        set((state) => {
          const notes = state.notes.map((n) => (n.id === id ? { ...n, deletedAt: Date.now() } : n))
          const tabs = state.tabs.filter((t) => !(t.kind === 'note' && t.noteId === id))
          const activeTabId = tabs.some((t) => t.id === state.activeTabId)
            ? state.activeTabId
            : (tabs[0]?.id ?? null)
          // Trashing the last open note reveals Home instead of blank.
          const activeNav: NavKey | null =
            tabs.length === 0 && state.activeNav === null ? 'home' : state.activeNav
          const splitTabId =
            state.splitTabId && tabs.some((t) => t.id === state.splitTabId)
              ? state.splitTabId
              : null
          const kept = new Set(tabs.map((t) => t.id))
          return {
            notes,
            tabs,
            activeTabId: tabs.length === 0 ? null : activeTabId,
            activeNav,
            splitTabId,
            tabRecency: state.tabRecency.filter((t) => kept.has(t)),
            ...pruneHistory(state.tabHistory, state.historyIndex, kept),
            tabGroup: pruneTabGroupMap(state.tabGroup, kept)
          }
        })
        if (removeFile && removed) {
          void window.api.vault.remove(removed.fileName).catch((error) => {
            console.error(`[vault] failed to remove ${removed.fileName}`, error)
          })
        }
      },
      restoreNote: (id) => {
        const note = get().notes.find((n) => n.id === id)
        if (!note?.deletedAt) return
        const taken = new Set(
          get()
            .notes.filter((n) => n.id !== id)
            .map((n) => n.fileName)
        )
        const fileName = uniqueFileName(note.fileName || noteFileBase(note.title), taken)
        set((state) => ({
          notes: state.notes.map((n) => (n.id === id ? { ...n, deletedAt: null, fileName } : n))
        }))
        if (get().vaultReady) {
          void window.api.vault.write(fileName, note.content).catch((error) => {
            console.error(`[vault] failed to restore ${fileName}`, error)
            set({ vaultError: `Could not restore ${fileName}.` })
          })
        }
      },
      emptyTrash: () => {
        // Destroy everything in Trash at once. Vault files are already gone
        // (removed at trash time), so this only drops records and slots.
        const ids = new Set(
          get()
            .notes.filter((n) => n.deletedAt)
            .map((n) => n.id)
        )
        if (ids.size === 0) return
        set((state) => {
          const tabs = state.tabs.filter((t) => !(t.kind === 'note' && ids.has(t.noteId)))
          const activeTabId = tabs.some((t) => t.id === state.activeTabId)
            ? state.activeTabId
            : (tabs[0]?.id ?? null)
          const activeNav: NavKey | null =
            tabs.length === 0 && state.activeNav === null ? 'home' : state.activeNav
          const splitTabId =
            state.splitTabId && tabs.some((t) => t.id === state.splitTabId)
              ? state.splitTabId
              : null
          const keep = new Set(tabs.map((t) => t.id))
          const noteSection: Record<string, string> = {}
          for (const [noteId, sectionId] of Object.entries(state.noteSection)) {
            if (!ids.has(noteId)) noteSection[noteId] = sectionId
          }
          return {
            notes: state.notes.filter((n) => !ids.has(n.id)),
            noteOrder: state.noteOrder.filter((id) => !ids.has(id)),
            tabs,
            activeTabId: tabs.length === 0 ? null : activeTabId,
            activeNav,
            splitTabId,
            tabRecency: state.tabRecency.filter((t) => keep.has(t)),
            ...pruneHistory(state.tabHistory, state.historyIndex, keep),
            noteSection,
            favorites: state.favorites.filter((fav) => !ids.has(fav)),
            tabGroup: pruneTabGroupMap(state.tabGroup, keep)
          }
        })
      },
      destroyNote: (id) => {
        // Permanent: drops the record, order/section/favorite slots, and tabs.
        const removed = get().notes.find((n) => n.id === id)
        if (!removed) return
        const removeFile = Boolean(removed.fileName && get().vaultReady)
        set((state) => {
          const notes = state.notes.filter((n) => n.id !== id)
          const noteOrder = state.noteOrder.filter((noteId) => noteId !== id)
          const tabs = state.tabs.filter((t) => !(t.kind === 'note' && t.noteId === id))
          const activeTabId = tabs.some((t) => t.id === state.activeTabId)
            ? state.activeTabId
            : (tabs[0]?.id ?? null)
          const activeNav: NavKey | null =
            tabs.length === 0 && state.activeNav === null ? 'home' : state.activeNav
          const splitTabId =
            state.splitTabId && tabs.some((t) => t.id === state.splitTabId)
              ? state.splitTabId
              : null
          const kept = new Set(tabs.map((t) => t.id))
          const noteSection = { ...state.noteSection }
          delete noteSection[id]
          return {
            notes,
            noteOrder,
            tabs,
            activeTabId: tabs.length === 0 ? null : activeTabId,
            activeNav,
            splitTabId,
            tabRecency: state.tabRecency.filter((t) => kept.has(t)),
            ...pruneHistory(state.tabHistory, state.historyIndex, kept),
            noteSection,
            favorites: state.favorites.filter((fav) => fav !== id),
            tabGroup: pruneTabGroupMap(state.tabGroup, kept)
          }
        })
        if (removeFile && removed) {
          void window.api.vault.remove(removed.fileName).catch(() => {})
        }
      },
      initVault: (force = false) => {
        if (vaultInitPromise && !force) return vaultInitPromise
        if (force) vaultInitPromise = null
        vaultInitPromise = (async () => {
          set({ vaultError: null })
          try {
            const { root } = await window.api.vault.status()
            set({ vaultPath: root })
            const files = await window.api.vault.list()
            const disk: {
              fileName: string
              content: string
              mtimeMs: number
              birthtimeMs: number
            }[] = []
            for (const file of files) {
              try {
                const read = await window.api.vault.read(file.name)
                disk.push({
                  fileName: file.name,
                  content: read.content,
                  mtimeMs: read.mtimeMs,
                  birthtimeMs: file.birthtimeMs
                })
              } catch (error) {
                console.error(`[vault] failed to read ${file.name}`, error)
              }
            }

            const pendingWrites: { id: string; fileName: string }[] = []
            set((state) => {
              const storedByFile = new Map(state.notes.map((note) => [note.fileName, note]))
              const taken = new Set<string>()
              const notes: Note[] = []
              // Disk is the source of truth for files that exist there.
              for (const entry of disk) {
                const existing = storedByFile.get(entry.fileName)
                if (existing) {
                  notes.push({
                    ...existing,
                    content: entry.content,
                    updatedAt: Math.max(existing.updatedAt, Math.round(entry.mtimeMs))
                  })
                } else {
                  notes.push({
                    id: crypto.randomUUID(),
                    title: titleFromFileName(entry.fileName),
                    content: entry.content,
                    fileName: entry.fileName,
                    createdAt: Math.round(entry.birthtimeMs) || Date.now(),
                    updatedAt: Math.round(entry.mtimeMs) || Date.now(),
                    deletedAt: null,
                    spaceId: state.spaces[0]?.id ?? ''
                  })
                }
                taken.add(entry.fileName)
              }
              // Notes missing on disk (new, or pre-vault) get written out.
              // Trashed notes stay fileless — their files were removed on
              // trash — but their records are kept so Trash survives reloads.
              for (const note of state.notes) {
                if (disk.some((entry) => entry.fileName === note.fileName)) continue
                if (note.deletedAt) {
                  notes.push(note)
                  if (note.fileName) taken.add(note.fileName)
                  continue
                }
                const fileName = uniqueFileName(note.fileName || noteFileBase(note.title), taken)
                taken.add(fileName)
                notes.push(fileName === note.fileName ? note : { ...note, fileName })
                pendingWrites.push({ id: note.id, fileName })
              }
              // Trash older than 30 days is destroyed, not restored.
              const retained = notes.filter(
                (n) => !n.deletedAt || Date.now() - n.deletedAt < TRASH_RETENTION_MS
              )
              if (retained.length !== notes.length) {
                console.info(
                  `[vault] purged ${notes.length - retained.length} trashed notes (30d+)`
                )
              }
              const noteIds = new Set(retained.map((n) => n.id))
              // Tabs are notes-only; legacy nav tabs from older sessions are
              // dropped here (their destination survives via activeNav).
              const withTabs = state.tabs.filter(
                (tab) => tab.kind === 'note' && noteIds.has(tab.noteId)
              )
              const activeTabId = withTabs.some((t) => t.id === state.activeTabId)
                ? state.activeTabId
                : (withTabs[0]?.id ?? null)
              // Preserve the nav view; fall back to Home when there are no
              // note tabs to show and no nav view is selected.
              const activeNav: NavKey | null =
                state.activeNav ?? (withTabs.length === 0 ? 'home' : null)
              const withTabIds = new Set(withTabs.map((t) => t.id))
              const keptHistory = pruneHistory(state.tabHistory, state.historyIndex, withTabIds)
              // Fresh vaults (or pre-history saves) start history at the
              // restored tab so Back has somewhere to go.
              if (keptHistory.tabHistory.length === 0 && withTabs.length > 0 && activeTabId) {
                keptHistory.tabHistory.push(activeTabId)
                keptHistory.historyIndex = 0
              }
              // Keep the manual order, drop stale ids, surface unpositioned
              // notes (imports, pre-vault notes) up top by recency.
              const keptOrder = state.noteOrder.filter((id) => noteIds.has(id))
              const keptSet = new Set(keptOrder)
              const unpositioned = retained
                .filter((n) => !keptSet.has(n.id))
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .map((n) => n.id)
              return {
                notes: retained,
                noteOrder: [...unpositioned, ...keptOrder],
                tabs: withTabs,
                activeTabId,
                activeNav,
                tabRecency: [
                  ...state.tabRecency.filter((id) => withTabIds.has(id)),
                  ...withTabs.map((t) => t.id).filter((id) => !state.tabRecency.includes(id))
                ],
                tabGroup: pruneTabGroupMap(state.tabGroup, withTabIds),
                tabHistory: keptHistory.tabHistory,
                historyIndex: keptHistory.historyIndex
              }
            })

            for (const pending of pendingWrites) {
              try {
                const note = get().notes.find((n) => n.id === pending.id)
                if (!note) continue
                const written = await window.api.vault.write(pending.fileName, note.content)
                if (written.name !== pending.fileName) {
                  set((state) => ({
                    notes: state.notes.map((n) =>
                      n.id === pending.id ? { ...n, fileName: written.name } : n
                    )
                  }))
                }
              } catch (error) {
                console.error(`[vault] failed to write ${pending.fileName}`, error)
                set({ vaultError: `Could not write ${pending.fileName}.` })
              }
            }
            set({ vaultReady: true })
            // Vault is up — pull planner JSON next (missing files load empty).
            void get().loadPlanner()
          } catch (error) {
            console.error('[vault] initialization failed', error)
            set({ vaultError: 'Could not open the notes vault.', vaultReady: false })
          }
        })()
        return vaultInitPromise
      },
      refreshVault: () => get().initVault(true),
      saveNoteToVault: async (id) => {
        const state = get()
        if (!state.vaultReady) return
        const note = state.notes.find((n) => n.id === id)
        if (!note || note.deletedAt) return
        try {
          const taken = new Set(state.notes.filter((n) => n.id !== id).map((n) => n.fileName))
          let fileName = note.fileName || uniqueFileName(noteFileBase(note.title), taken)
          if (note.fileName && fileName !== note.fileName) {
            const renamed = await window.api.vault.rename(note.fileName, fileName)
            fileName = renamed.name
            set((s) => ({
              notes: s.notes.map((n) => (n.id === id ? { ...n, fileName } : n))
            }))
          } else if (!note.fileName) {
            set((s) => ({
              notes: s.notes.map((n) => (n.id === id ? { ...n, fileName } : n))
            }))
          }
          const current = get().notes.find((n) => n.id === id)
          if (!current) return
          const written = await window.api.vault.write(fileName, current.content)
          if (written.name !== fileName) {
            set((s) => ({
              notes: s.notes.map((n) => (n.id === id ? { ...n, fileName: written.name } : n))
            }))
          }
        } catch (error) {
          console.error(`[vault] failed to save note ${id}`, error)
          set({ vaultError: 'Could not save the note to the vault.' })
        }
      },
      chooseVault: async () => {
        try {
          const result = await window.api.vault.choose()
          if (!result) return null
          await get().initVault(true)
          return result.root
        } catch (error) {
          console.error('[vault] failed to change folder', error)
          set({ vaultError: 'Could not change the vault folder.' })
          return null
        }
      },
      addChatMessage: (role, text) => {
        const message: ChatMessage = { id: uid(), role, text, timestamp: Date.now() }
        set((state) => ({ messages: [...state.messages, message].slice(-MAX_CHAT_MESSAGES) }))
        return message.id
      },
      updateChatMessage: (id, text) =>
        set((state) => ({
          messages: state.messages.map((m) => (m.id === id ? { ...m, text } : m))
        })),
      clearChat: () => set({ messages: [] }),
      loadPlanner: async () => {
        try {
          const [calendarRaw, tasksRaw, legacyRaw, calendarsRaw, routinesRaw] = await Promise.all([
            window.api.vault.readJson(CALENDAR_FILE),
            window.api.vault.readJson(TASKS_FILE),
            window.api.vault.readJson(TODO_FILE),
            window.api.vault.readJson(CALENDARS_FILE),
            window.api.vault.readJson(ROUTINES_FILE)
          ])
          const { events, migratedTasks } = parseCalendarData(calendarRaw)
          const byId = new Map(parseTaskItems(tasksRaw).map((task) => [task.id, task]))
          let migrated = 0
          for (const task of migratedTasks) {
            if (!byId.has(task.id)) {
              byId.set(task.id, task)
              migrated += 1
            }
          }
          // One-time move from the pre-rename `todo.json` store.
          let legacyMigrated = 0
          for (const task of parseTaskItems(legacyRaw)) {
            if (!byId.has(task.id)) {
              byId.set(task.id, task)
              legacyMigrated += 1
            }
          }
          const tasks = [...byId.values()]
          const subscriptions = parseSubscriptions(calendarsRaw)
          const normalized = normalizeRoutineDay(parseRoutines(routinesRaw), todayISO(), Date.now())
          if (normalized.changed) {
            // Day rolled over while away: persist the fresh checks.
            saveRoutineFile(normalized.routines, set)
          }
          set({
            calendarItems: events,
            tasks,
            routines: normalized.routines,
            subscriptions,
            plannerReady: true,
            plannerError: null
          })
          // Tasks used to live in calendar.json; persist the split once.
          if (migrated > 0) {
            await window.api.vault.writeJson(CALENDAR_FILE, events)
            console.info(`[planner] migrated ${migrated} calendar tasks into tasks.json`)
          }
          if (migrated > 0 || legacyMigrated > 0) {
            await window.api.vault.writeJson(TASKS_FILE, tasks)
          }
          if (legacyMigrated > 0) {
            // Retire the legacy file so its items can never resurrect.
            await window.api.vault.writeJson(TODO_FILE, [])
            console.info(`[planner] migrated ${legacyMigrated} tasks from todo.json`)
          }
          void get().refreshAllSubscriptions()
        } catch (error) {
          console.error('[planner] failed to load planner data', error)
          set({ plannerError: 'Could not load calendar/task data.', plannerReady: true })
        }
      },
      addCalendarItem: (draft) => {
        const item = calendarItemFromDraft(uid(), draft, Date.now())
        const items = [...get().calendarItems, item]
        set({ calendarItems: items, plannerError: null })
        saveCalendarFile(items, set)
      },
      updateCalendarItem: (id, patch) => {
        const current = get().calendarItems.find((item) => item.id === id)
        if (!current) return
        const draft = { ...draftFromItem(current), ...patch }
        const items = get().calendarItems.map((item) =>
          item.id === id
            ? calendarItemFromDraft(id, draft, Date.now(), {
                createdAt: item.createdAt,
                status: item.status,
                exdates: item.exdates,
                calendarId: item.calendarId
              })
            : item
        )
        set({ calendarItems: items, plannerError: null })
        saveCalendarFile(items, set)
      },
      deleteCalendarItem: (id) => {
        const items = get().calendarItems.filter((item) => item.id !== id)
        set({ calendarItems: items, plannerError: null })
        saveCalendarFile(items, set)
      },
      addTask: (draft) => {
        const item = taskItemFromDraft(uid(), draft, false, Date.now())
        const tasks = [item, ...get().tasks]
        set({ tasks, plannerError: null })
        saveTaskFile(tasks, set)
        return item.id
      },
      updateTask: (id, patch) => {
        const current = get().tasks.find((item) => item.id === id)
        if (!current) return
        const draft: TaskDraft = {
          title: patch.title ?? current.title,
          notes: patch.notes ?? current.notes,
          location: patch.location ?? current.location,
          due: patch.due !== undefined ? patch.due : current.due,
          time: patch.time !== undefined ? patch.time : current.time
        }
        const done = patch.done ?? current.status === 'completed'
        const tasks = get().tasks.map((item) =>
          item.id === id
            ? taskItemFromDraft(id, draft, done, Date.now(), { createdAt: item.createdAt })
            : item
        )
        set({ tasks, plannerError: null })
        saveTaskFile(tasks, set)
      },
      toggleTask: (id) => {
        const current = get().tasks.find((item) => item.id === id)
        if (current) get().updateTask(id, { done: current.status !== 'completed' })
      },
      deleteTask: (id) => {
        const tasks = get().tasks.filter((item) => item.id !== id)
        set({ tasks, plannerError: null })
        saveTaskFile(tasks, set)
      },
      clearCompletedTasks: () => {
        const tasks = get().tasks.filter((item) => item.status !== 'completed')
        set({ tasks, plannerError: null })
        saveTaskFile(tasks, set)
      },
      addRoutine: (title) => {
        const now = Date.now()
        const routine: RoutineItem = {
          id: uid(),
          title: (title ?? '').trim(),
          notes: '',
          steps: [],
          lastReset: todayISO(),
          createdAt: now,
          updatedAt: now
        }
        const routines = [routine, ...get().routines]
        set({ routines, plannerError: null })
        saveRoutineFile(routines, set)
        return routine.id
      },
      renameRoutine: (id, title) => {
        const routines = get().routines.map((item) =>
          item.id === id ? { ...item, title: title.trim(), updatedAt: Date.now() } : item
        )
        set({ routines, plannerError: null })
        saveRoutineFile(routines, set)
      },
      deleteRoutine: (id) => {
        const routines = get().routines.filter((item) => item.id !== id)
        set({ routines, plannerError: null })
        saveRoutineFile(routines, set)
      },
      addRoutineStep: (routineId, title) => {
        const trimmed = (title ?? '').trim()
        if (!trimmed) return null
        const now = Date.now()
        const step = { id: uid(), title: trimmed, done: false }
        let created: string | null = null
        const routines = get().routines.map((item) => {
          if (item.id !== routineId) return item
          created = step.id
          return { ...item, steps: [...item.steps, step], updatedAt: now }
        })
        if (!created) return null
        set({ routines, plannerError: null })
        saveRoutineFile(routines, set)
        return created
      },
      renameRoutineStep: (routineId, stepId, title) => {
        const trimmed = title.trim()
        if (!trimmed) return
        const routines = get().routines.map((item) =>
          item.id === routineId
            ? {
                ...item,
                steps: item.steps.map((step) =>
                  step.id === stepId ? { ...step, title: trimmed } : step
                ),
                updatedAt: Date.now()
              }
            : item
        )
        set({ routines, plannerError: null })
        saveRoutineFile(routines, set)
      },
      removeRoutineStep: (routineId, stepId) => {
        const routines = get().routines.map((item) =>
          item.id === routineId
            ? {
                ...item,
                steps: item.steps.filter((step) => step.id !== stepId),
                updatedAt: Date.now()
              }
            : item
        )
        set({ routines, plannerError: null })
        saveRoutineFile(routines, set)
      },
      toggleRoutineStep: (routineId, stepId) => {
        const routines = get().routines.map((item) =>
          item.id === routineId
            ? {
                ...item,
                steps: item.steps.map((step) =>
                  step.id === stepId ? { ...step, done: !step.done } : step
                ),
                updatedAt: Date.now()
              }
            : item
        )
        set({ routines, plannerError: null })
        saveRoutineFile(routines, set)
      },
      toggleRoutineAll: (routineId) => {
        const routines = get().routines.map((item) => {
          if (item.id !== routineId) return item
          const allDone = item.steps.length > 0 && item.steps.every((step) => step.done)
          return {
            ...item,
            steps: item.steps.map((step) => ({ ...step, done: !allDone })),
            updatedAt: Date.now()
          }
        })
        set({ routines, plannerError: null })
        saveRoutineFile(routines, set)
      },
      resetRoutine: (routineId) => {
        const now = Date.now()
        const routines = get().routines.map((item) =>
          item.id === routineId
            ? {
                ...item,
                steps: item.steps.map((step) => (step.done ? { ...step, done: false } : step)),
                lastReset: todayISO(),
                updatedAt: now
              }
            : item
        )
        set({ routines, plannerError: null })
        saveRoutineFile(routines, set)
      },
      ensureRoutinesToday: () => {
        const now = Date.now()
        const { routines, changed } = normalizeRoutineDay(get().routines, todayISO(), now)
        if (!changed) return
        set({ routines, plannerError: null })
        saveRoutineFile(routines, set)
      },
      setLocalCalendarColor: (localCalendarColor) => set({ localCalendarColor }),
      addSubscription: async ({ name, url, color }) => {
        const id = uid()
        const subscription: CalendarSubscription = {
          id,
          name: name.trim() || 'Subscribed calendar',
          url: url.trim(),
          color,
          enabled: true,
          lastFetched: null,
          error: null,
          events: []
        }
        const subscriptions = [...get().subscriptions, subscription]
        set({ subscriptions })
        saveCalendarsFile(subscriptions, set)
        await get().refreshSubscription(id)
        return id
      },
      updateSubscription: (id, patch) => {
        const subscriptions = get().subscriptions.map((sub) =>
          sub.id === id ? { ...sub, ...patch } : sub
        )
        set({ subscriptions })
        saveCalendarsFile(subscriptions, set)
      },
      removeSubscription: (id) => {
        const subscriptions = get().subscriptions.filter((sub) => sub.id !== id)
        set({ subscriptions })
        saveCalendarsFile(subscriptions, set)
      },
      refreshSubscription: async (id) => {
        const sub = get().subscriptions.find((s) => s.id === id)
        if (!sub) return
        try {
          const text = await window.api.fetchIcs(sub.url)
          const now = Date.now()
          const events: CalendarItem[] = []
          for (const event of parseIcs(text)) {
            events.push({
              id: `${id}:${event.uid}`,
              summary: event.summary || 'Untitled',
              description: event.description,
              location: event.location,
              start: event.start,
              end: event.end,
              status: 'confirmed',
              recurrence: event.recurrence,
              exdates: event.exdates,
              calendarId: id,
              createdAt: now,
              updatedAt: now
            })
          }
          const subscriptions = get().subscriptions.map((s) =>
            s.id === id ? { ...s, events, lastFetched: now, error: null } : s
          )
          set({ subscriptions })
          saveCalendarsFile(subscriptions, set)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Could not load the feed.'
          console.error(`[planner] subscription ${id} failed`, error)
          const subscriptions = get().subscriptions.map((s) =>
            s.id === id ? { ...s, error: message } : s
          )
          set({ subscriptions })
          saveCalendarsFile(subscriptions, set)
        }
      },
      refreshAllSubscriptions: async () => {
        const ids = get()
          .subscriptions.filter((sub) => sub.enabled)
          .map((sub) => sub.id)
        for (const id of ids) {
          await get().refreshSubscription(id)
        }
      }
    }),
    {
      name: 'seemo-store',
      // Only documents, open tabs, sidebar order and chat history persist.
      partialize: (state) => ({
        spaces: state.spaces,
        activeSpaceId: state.activeSpaceId,
        notes: state.notes,
        noteOrder: state.noteOrder,
        noteSections: state.noteSections,
        noteSection: state.noteSection,
        favorites: state.favorites,
        imageLayout: state.imageLayout,
        tabGroups: state.tabGroups,
        tabGroup: state.tabGroup,
        collapsedTabGroups: state.collapsedTabGroups,
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        activeNav: state.activeNav,
        tabRecency: state.tabRecency,
        tabHistory: state.tabHistory,
        historyIndex: state.historyIndex,
        messages: state.messages.slice(-MAX_CHAT_MESSAGES),
        autoSync: state.autoSync,
        backgroundListening: state.backgroundListening,
        agentMicMuted: state.agentMicMuted,
        orbEnabled: state.orbEnabled,
        lastSeenAgentId: state.lastSeenAgentId,
        ttsEnabled: state.ttsEnabled,
        theme: state.theme,
        sidebarWidth: state.sidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed,
        dismissedTodayEvents: state.dismissedTodayEvents,
        splitTabId: state.splitTabId,
        splitRatio: state.splitRatio,
        localCalendarColor: state.localCalendarColor,
        alarms: state.alarms,
        timers: state.timers,
        stopwatches: state.stopwatches,
        alarmSoundId: state.alarmSoundId,
        customAlarm: state.customAlarm
      }),
      // Drop note tabs whose note no longer exists (e.g. after an older
      // session). Legacy nav tabs (Home, Tasks, …) migrate to the tab-free
      // activeNav view instead of lingering in the tab bar.
      merge: (persisted, current) => {
        const NAV_KEYS: NavKey[] = [
          'home',
          'graph',
          'tasks',
          'calendar',
          'agent',
          'misc',
          'email',
          'settings'
        ]
        const asNavKey = (value: unknown): NavKey | null =>
          typeof value === 'string' && (NAV_KEYS as string[]).includes(value)
            ? (value as NavKey)
            : null
        // Pre-rename / removed pages map onto a surviving destination.
        const migrateNavKind = (kind: string): NavKey => {
          if (kind === 'todo') return 'tasks'
          if (kind === 'activity') return 'home'
          if (kind === 'flashcards' || kind === 'learn' || kind === 'mindmap' || kind === 'quizzes')
            return 'home'
          return asNavKey(kind) ?? 'home'
        }
        const saved = (persisted ?? {}) as Partial<
          Pick<
            AppState,
            | 'notes'
            | 'spaces'
            | 'activeSpaceId'
            | 'noteOrder'
            | 'noteSections'
            | 'noteSection'
            | 'favorites'
            | 'imageLayout'
            | 'tabGroups'
            | 'tabGroup'
            | 'collapsedTabGroups'
            | 'tabs'
            | 'activeTabId'
            | 'activeNav'
            | 'tabRecency'
            | 'tabHistory'
            | 'historyIndex'
            | 'messages'
            | 'autoSync'
            | 'backgroundListening'
            | 'agentMicMuted'
            | 'orbEnabled'
            | 'lastSeenAgentId'
            | 'ttsEnabled'
            | 'theme'
            | 'sidebarWidth'
            | 'sidebarCollapsed'
            | 'dismissedTodayEvents'
            | 'splitTabId'
            | 'splitRatio'
            | 'localCalendarColor'
            | 'alarms'
            | 'timers'
            | 'stopwatches'
            | 'alarmSoundId'
            | 'customAlarm'
          >
        >
        const spaces = (saved.spaces ?? []).filter(
          (space) =>
            space &&
            typeof space.id === 'string' &&
            typeof space.name === 'string' &&
            typeof space.emoji === 'string'
        )
        // A brand-new install starts with one space; an intentionally emptied
        // one (persisted as []) stays at zero.
        if (persisted == null && spaces.length === 0) {
          spaces.push({ id: 'default', name: 'Personal', emoji: '📝' })
        }
        const activeSpaceId = spaces.some((space) => space.id === saved.activeSpaceId)
          ? saved.activeSpaceId!
          : (spaces[0]?.id ?? '')
        const spaceIds = new Set(spaces.map((space) => space.id))
        const notes = (saved.notes ?? []).map((note) => ({
          ...note,
          spaceId: note.spaceId && spaceIds.has(note.spaceId) ? note.spaceId : (spaces[0]?.id ?? '')
        }))
        const noteIds = new Set(notes.map((n) => n.id))
        // The previously active nav tab (if any) becomes the selected view.
        const legacyActiveNav = (() => {
          const active = (saved.tabs ?? []).find((t) => t.id === saved.activeTabId) as
            { kind?: unknown } | undefined
          if (active && typeof active.kind === 'string' && active.kind !== 'note') {
            return migrateNavKind(active.kind)
          }
          return null
        })()
        const tabs = (saved.tabs ?? []).filter(
          (tab): tab is Tab => tab.kind === 'note' && noteIds.has(tab.noteId)
        )
        const activeTabId =
          saved.activeTabId && tabs.some((t) => t.id === saved.activeTabId)
            ? (saved.activeTabId as string)
            : (tabs[0]?.id ?? null)
        // New sessions persist the view directly; legacy sessions derive it
        // from whichever nav tab was active.
        let resolvedNav: NavKey | null
        if (saved.activeNav === undefined) {
          resolvedNav = legacyActiveNav ?? (activeTabId ? null : 'home')
        } else {
          resolvedNav = asNavKey(saved.activeNav)
          if (resolvedNav === null && activeTabId === null) resolvedNav = 'home'
        }
        // Recency survives restarts: keep known ids most-recent-first, then
        // append any restored tab the old list never saw.
        const tabIds = new Set(tabs.map((t) => t.id))
        const tabRecency = [
          ...(saved.tabRecency ?? []).filter((id) => tabIds.has(id)),
          ...tabs.map((t) => t.id).filter((id) => !(saved.tabRecency ?? []).includes(id))
        ]
        // History survives restarts too; it may legitimately be empty when
        // there are no note tabs (nav views don't record tab history).
        const pruned = pruneHistory(saved.tabHistory ?? [], saved.historyIndex ?? -1, tabIds)
        const tabHistory = pruned.tabHistory
        const historyIndex = pruned.historyIndex
        const messages = (saved.messages ?? []).slice(-MAX_CHAT_MESSAGES)
        const noteOrder = (saved.noteOrder ?? []).filter((id) => noteIds.has(id))
        // Sections survive restarts and belong to a space; legacy sections
        // without a space fall back to the first. Drop mappings for notes or
        // sections that no longer exist so orphans render ungrouped.
        const noteSections = (saved.noteSections ?? [])
          .filter((s) => s && typeof s.id === 'string' && typeof s.title === 'string')
          .map((s) => ({
            id: s.id,
            title: s.title,
            spaceId: s.spaceId && spaceIds.has(s.spaceId) ? s.spaceId : (spaces[0]?.id ?? '')
          }))
        const sectionIds = new Set(noteSections.map((s) => s.id))
        const noteSection: Record<string, string> = {}
        for (const [noteId, sectionId] of Object.entries(saved.noteSection ?? {})) {
          if (noteIds.has(noteId) && sectionIds.has(sectionId)) noteSection[noteId] = sectionId
        }
        const favorites = (saved.favorites ?? []).filter((id) => noteIds.has(id))
        const imageLayout: Record<string, Record<string, ImageLayout>> = {}
        for (const [noteId, inner] of Object.entries(saved.imageLayout ?? {})) {
          if (!noteIds.has(noteId) || typeof inner !== 'object' || inner === null) continue
          const positions: Record<string, ImageLayout> = {}
          for (const [src, pos] of Object.entries(inner as Record<string, unknown>)) {
            const p = pos as { side?: unknown; w?: unknown }
            if (p === null || typeof p !== 'object') continue
            const clean: ImageLayout = {}
            if (p.side === 'left' || p.side === 'right' || p.side === 'center') {
              clean.side = p.side
            }
            if (typeof p.w === 'number' && p.w > 0) clean.w = p.w
            if (clean.side !== undefined || clean.w !== undefined) positions[src] = clean
          }
          if (Object.keys(positions).length > 0) imageLayout[noteId] = positions
        }
        const tabGroups = (saved.tabGroups ?? []).filter(
          (g) =>
            g &&
            typeof g.id === 'string' &&
            typeof g.name === 'string' &&
            typeof g.color === 'string'
        )
        const groupIds = new Set(tabGroups.map((g) => g.id))
        const tabGroup: Record<string, string> = {}
        for (const [tabId, groupId] of Object.entries(saved.tabGroup ?? {})) {
          if (tabIds.has(tabId) && groupIds.has(groupId)) tabGroup[tabId] = groupId
        }
        const collapsedTabGroups = (saved.collapsedTabGroups ?? []).filter((id) => groupIds.has(id))
        // Never pop the bubble for history that predates this launch: seed
        // "seen" at the newest restored SeeMO message.
        let lastSeenAgentId = saved.lastSeenAgentId ?? null
        if (!lastSeenAgentId) {
          for (const message of messages) {
            if (message.role === 'agent') lastSeenAgentId = message.id
          }
        }
        return {
          ...current,
          spaces,
          activeSpaceId,
          notes,
          noteOrder,
          noteSections,
          noteSection,
          favorites,
          imageLayout,
          tabGroups,
          tabGroup,
          collapsedTabGroups,
          tabs,
          activeTabId,
          activeNav: resolvedNav,
          tabRecency,
          tabHistory,
          historyIndex,
          messages,
          autoSync: saved.autoSync ?? false,
          backgroundListening: saved.backgroundListening ?? false,
          agentMicMuted: saved.agentMicMuted ?? false,
          ttsEnabled: saved.ttsEnabled ?? true,
          theme: saved.theme === 'light' || saved.theme === 'system' ? saved.theme : 'dark',
          sidebarWidth: clampSidebarWidth(saved.sidebarWidth),
          sidebarCollapsed: saved.sidebarCollapsed ?? false,
          dismissedTodayEvents: Array.isArray(saved.dismissedTodayEvents)
            ? saved.dismissedTodayEvents.filter((d) => typeof d === 'string')
            : [],
          splitTabId:
            saved.splitTabId && tabs.some((t) => t.id === saved.splitTabId)
              ? saved.splitTabId
              : null,
          splitRatio: clampSplitRatio(saved.splitRatio),
          localCalendarColor:
            typeof saved.localCalendarColor === 'string' && saved.localCalendarColor
              ? saved.localCalendarColor
              : CALENDAR_COLORS[0],
          alarms: restoreAlarms(saved),
          timers: restoreTimers(saved),
          stopwatches: restoreStopwatches(saved),
          ...restoreAlarmSound(saved),
          lastSeenAgentId
        }
      }
    }
  )
)

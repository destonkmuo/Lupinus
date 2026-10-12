/**
 * Tiny pure time helpers shared by the Misc mini-apps (alarm, timer,
 * stopwatch). Dependency-free so they stay unit-testable.
 */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export function isValidTimeHHMM(value: string): boolean {
  return TIME_RE.test(value)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Current local time as `HH:MM`. */
export function nowHHMM(date: Date = new Date()): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** True when the clock currently shows the alarm time (minute precision). */
export function isAlarmDue(alarmTime: string, now: Date = new Date()): boolean {
  return isValidTimeHHMM(alarmTime) && nowHHMM(now) === alarmTime
}

/** Pomodoro phase. Lives here (dependency-free) so store + UI can share it. */
export type PomodoroPhase = 'idle' | 'focus' | 'break' | 'longBreak'

export interface PomodoroSpec {
  phase: PomodoroPhase
  completedFocus: number
  roundsBeforeLong: number
  focusMin: number
  breakMin: number
  longBreakMin: number
}

/** Length in minutes of a pomodoro phase (`idle` previews focus). */
export function pomodoroPhaseMinutes(spec: PomodoroSpec, phase: PomodoroPhase): number {
  if (phase === 'break') return spec.breakMin
  if (phase === 'longBreak') return spec.longBreakMin
  return spec.focusMin
}

/**
 * Next phase after the current one ends (or is skipped). A finished focus
 * counts toward the long break only when the caller already incremented
 * `completedFocus` (natural expiry does; skip does not).
 */
export function advancePomodoroTimer(
  spec: PomodoroSpec,
  startRunning: boolean,
  now: number
): {
  phase: PomodoroPhase
  completedFocus: number
  running: boolean
  ringing: boolean
  endsAt: number | null
  leftSec: number
} {
  let phase: PomodoroPhase = 'focus'
  let completedFocus = spec.completedFocus
  if (spec.phase === 'focus') {
    phase =
      completedFocus > 0 && completedFocus % spec.roundsBeforeLong === 0 ? 'longBreak' : 'break'
  } else if (spec.phase === 'break') {
    phase = 'focus'
  } else if (spec.phase === 'longBreak') {
    phase = 'focus'
    completedFocus = 0
  }
  const minutes = pomodoroPhaseMinutes(spec, phase)
  return {
    phase,
    completedFocus,
    running: startRunning,
    ringing: false,
    endsAt: startRunning ? now + minutes * 60 * 1000 : null,
    leftSec: minutes * 60
  }
}

/** `HH:MM` + minutes, wrapping past midnight. Returns null on bad input. */
export function addMinutesHHMM(time: string, minutes: number): string | null {
  if (!isValidTimeHHMM(time)) return null
  const [h, m] = time.split(':').map(Number)
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

/** Parse `MM:SS` or `M:SS` (also bare minutes like `5`) into total seconds. */
export function parseDurationInput(value: string): number | null {
  const trimmed = value.trim()
  if (/^\d{1,4}$/.test(trimmed)) {
    const minutes = Number(trimmed)
    return minutes > 0 && minutes <= 999 ? minutes * 60 : null
  }
  const match = /^(\d{1,3}):([0-5]?\d)$/.exec(trimmed)
  if (!match) return null
  const total = Number(match[1]) * 60 + Number(match[2])
  return total > 0 && total <= 59999 ? total : null
}

/** Seconds -> `MM:SS` (hours fold into minutes). */
export function formatElapsed(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(clamped / 60)
  return `${pad(minutes)}:${pad(clamped % 60)}`
}

/**
 * `HH:MM` (24h) -> 12-hour display (`2:30 PM`). An hour-only value (`"14"`)
 * means top of the hour. Null/invalid passes through (never "undefined").
 */
export function formatTime12h(time: string | null): string {
  if (time === null) return '--:--'
  let normalized = time
  if (!isValidTimeHHMM(normalized)) {
    const hourOnly = /^([01]?\d|2[0-3])$/.exec(normalized.trim())
    if (!hourOnly) return time
    normalized = `${hourOnly[1].padStart(2, '0')}:00`
  }
  const [h, m] = normalized.split(':').map(Number)
  const suffix = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${pad(m)} ${suffix}`
}

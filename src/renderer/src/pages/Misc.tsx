import { useEffect, useState } from 'react'
import { BUILT_IN_SOUNDS, previewSound, resolveSoundUrl, stopAlarm } from '../alarm'
import { AlarmIcon, PlusIcon, StopwatchIcon, TimerIcon, XIcon } from '../components/icons'
import {
  useAppStore,
  type AlarmItem,
  type PomodoroPhase,
  type StopwatchItem,
  type TimerItem
} from '../store/appStore'
import {
  addMinutesHHMM,
  advancePomodoroTimer,
  formatElapsed,
  formatTime12h,
  nowHHMM,
  parseDurationInput,
  pomodoroPhaseMinutes
} from '../time'

/** Re-render on a heartbeat so countdown/stopwatch faces stay live. */
function useNowMs(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), stepMs)
    return () => clearInterval(id)
  }, [stepMs])
  return now
}

/** Stop the shared loop only when nothing is still ringing. */
function silenceUnlessRinging(): void {
  const state = useAppStore.getState()
  const ringing =
    state.alarms.some((alarm) => alarm.ringing) || state.timers.some((timer) => timer.ringing)
  if (!ringing) stopAlarm()
}

/** Put the OS volume back after a max-volume alarm stops ringing. */
function restoreVolumeIfMaxed(alarm: AlarmItem): void {
  // Optional call: tolerates a stale preload bundle (app not rebuilt) —
  // in that case nothing was ever maxed, so there is nothing to restore.
  if (alarm.maxVolume && alarm.ringing && window.api.restoreAlarmVolume) {
    void window.api.restoreAlarmVolume().then(
      (result) => {
        if (!result.ok) console.error('[alarm] restore volume failed:', result.error)
      },
      (error) => console.error('[alarm] restore volume failed:', error)
    )
  }
}

function formatDurationDraft(totalSec: number): string {
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function CardSound({
  value,
  onChange,
  label
}: {
  value: string
  onChange: (id: string) => void
  label: string
}): React.JSX.Element {
  const customAlarm = useAppStore((state) => state.customAlarm)
  const setCustomAlarm = useAppStore((state) => state.setCustomAlarm)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const uploadCustom = async (): Promise<void> => {
    setUploading(true)
    setUploadError(null)
    try {
      const result = await window.api.importAlarmSound()
      if (!result) return // user canceled the picker
      setCustomAlarm({ name: result.name, url: result.url })
      onChange('custom')
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Could not import sound.')
    } finally {
      setUploading(false)
    }
  }

  const onSelect = (id: string): void => {
    if (id === 'custom' && !customAlarm) {
      void uploadCustom()
      return
    }
    onChange(id)
  }

  return (
    <>
      <div className="miniapp__row">
        <select
          className="dlg__input"
          aria-label={label}
          value={value}
          onChange={(event) => onSelect(event.target.value)}
        >
          {BUILT_IN_SOUNDS.map((sound) => (
            <option key={sound.id} value={sound.id}>
              {sound.label}
            </option>
          ))}
          <option value="custom">
            {customAlarm ? `Custom: ${customAlarm.name}` : 'Custom file…'}
          </option>
        </select>
        <button
          type="button"
          className="btn btn--ghost"
          title="Play a sample"
          onClick={() => previewSound(resolveSoundUrl(value, customAlarm?.url ?? null))}
        >
          Preview
        </button>
        {value === 'custom' && customAlarm && (
          <button
            type="button"
            className="btn btn--ghost"
            disabled={uploading}
            onClick={() => void uploadCustom()}
          >
            {uploading ? 'Importing…' : 'Change file…'}
          </button>
        )}
      </div>
      {uploadError && (
        <p className="miniapp__hint miniapp__error" role="alert">
          {uploadError}
        </p>
      )}
    </>
  )
}

function DeleteButton({
  label,
  onDelete
}: {
  label: string
  onDelete: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="miniapp__delete"
      title={`Delete ${label}`}
      aria-label={`Delete ${label}`}
      onClick={onDelete}
    >
      <XIcon size={13} />
    </button>
  )
}

function AlarmCard({ alarm }: { alarm: AlarmItem }): React.JSX.Element {
  const updateAlarm = useAppStore((state) => state.updateAlarm)
  const removeAlarm = useAppStore((state) => state.removeAlarm)
  const setAlarmSoundId = useAppStore((state) => state.setAlarmSoundId)

  const stop = (): void => {
    restoreVolumeIfMaxed(alarm)
    updateAlarm(alarm.id, {
      ringing: false,
      snoozeUntil: null,
      quietUntil: Date.now() + 60_000
    })
    silenceUnlessRinging()
  }

  const snooze = (): void => {
    const next = addMinutesHHMM(nowHHMM(), 5)
    if (!next) return
    restoreVolumeIfMaxed(alarm)
    updateAlarm(alarm.id, { ringing: false, snoozeUntil: next })
    silenceUnlessRinging()
  }

  const onToggleEnabled = (enabled: boolean): void => {
    if (!enabled && alarm.ringing) {
      restoreVolumeIfMaxed(alarm)
      updateAlarm(alarm.id, {
        enabled,
        ringing: false,
        snoozeUntil: null,
        quietUntil: Date.now() + 60_000
      })
      silenceUnlessRinging()
      return
    }
    updateAlarm(alarm.id, { enabled })
  }

  const onDelete = (): void => {
    restoreVolumeIfMaxed(alarm)
    removeAlarm(alarm.id)
    silenceUnlessRinging()
  }

  return (
    <section className={`miniapp${alarm.ringing ? ' is-ringing' : ''}`} aria-label={alarm.label}>
      <header className="miniapp__head">
        <AlarmIcon size={18} />
        <input
          className="miniapp__name"
          aria-label="Alarm name"
          title="Click to rename"
          placeholder="Alarm name"
          value={alarm.label}
          spellCheck={false}
          onChange={(event) => updateAlarm(alarm.id, { label: event.target.value })}
        />
        <DeleteButton label={alarm.label} onDelete={onDelete} />
      </header>
      <div className="miniapp__clock">{formatTime12h(alarm.time)}</div>
      <div className="miniapp__row">
        <input
          type="time"
          className="dlg__input"
          aria-label={`${alarm.label} time`}
          value={alarm.time ?? ''}
          onChange={(event) => updateAlarm(alarm.id, { time: event.target.value || null })}
        />
      </div>
      <CardSound
        label={`${alarm.label} sound`}
        value={alarm.soundId}
        onChange={(soundId) => {
          updateAlarm(alarm.id, { soundId })
          setAlarmSoundId(soundId)
        }}
      />
      <label className="settings__check">
        <input
          type="checkbox"
          checked={alarm.enabled}
          onChange={(event) => onToggleEnabled(event.target.checked)}
        />
        Enabled
      </label>
      <label
        className="settings__check"
        title="Crank the OS volume to max while this alarm rings, then put it back."
      >
        <input
          type="checkbox"
          checked={alarm.maxVolume}
          onChange={(event) => updateAlarm(alarm.id, { maxVolume: event.target.checked })}
        />
        Max system volume
      </label>
      <div className="miniapp__row">
        <label className="settings__check">
          <input
            type="checkbox"
            checked={alarm.repeat}
            onChange={(event) => updateAlarm(alarm.id, { repeat: event.target.checked })}
          />
          Repeat until stopped
        </label>
        {alarm.repeat && (
          <label className="pomo__field" style={{ maxWidth: 110 }}>
            Every (min)
            <input
              type="number"
              className="dlg__input"
              min={1}
              max={60}
              value={alarm.repeatMin}
              aria-label={`${alarm.label} repeat minutes`}
              onChange={(event) =>
                updateAlarm(alarm.id, {
                  repeatMin: Math.min(
                    60,
                    Math.max(1, Math.floor(Number(event.target.value) || 0) || 5)
                  )
                })
              }
            />
          </label>
        )}
      </div>
      {alarm.ringing ? (
        <>
          <div className="miniapp__row">
            <button type="button" className="btn btn--primary" onClick={stop}>
              Stop
            </button>
            <button type="button" className="btn btn--ghost" onClick={snooze}>
              Snooze 5 min
            </button>
          </div>
          {alarm.repeat && (
            <p className="miniapp__hint">Repeating every {alarm.repeatMin} min until stopped.</p>
          )}
        </>
      ) : (
        <p className="miniapp__hint">
          {!alarm.enabled || !alarm.time
            ? 'Set a time and enable the alarm.'
            : alarm.snoozeUntil
              ? `Snoozed until ${formatTime12h(alarm.snoozeUntil)}.`
              : `Rings daily at ${formatTime12h(alarm.time)} while the app is open.`}
          {alarm.repeat && alarm.enabled && alarm.time && (
            <> Repeats every {alarm.repeatMin} min until stopped.</>
          )}
          {alarm.maxVolume && alarm.enabled && alarm.time && (
            <> Raises the OS volume to max while ringing, then restores it.</>
          )}
        </p>
      )}
    </section>
  )
}

const POMODORO_LABEL: Record<Exclude<PomodoroPhase, 'idle'>, string> = {
  focus: 'Focus',
  break: 'Short break',
  longBreak: 'Long break'
}

function TimerCard({ timer, now }: { timer: TimerItem; now: number }): React.JSX.Element {
  const updateTimer = useAppStore((state) => state.updateTimer)
  const removeTimer = useAppStore((state) => state.removeTimer)
  const setAlarmSoundId = useAppStore((state) => state.setAlarmSoundId)
  const [draft, setDraft] = useState(() => formatDurationDraft(timer.totalSec))
  const isPomo = timer.kind === 'pomodoro'

  const remaining =
    timer.running && timer.endsAt !== null
      ? Math.max(0, Math.ceil((timer.endsAt - now) / 1000))
      : timer.leftSec

  const pause = (): void => {
    updateTimer(timer.id, { running: false, leftSec: remaining, endsAt: null })
  }

  const resume = (): void => {
    if (remaining <= 0) return
    updateTimer(timer.id, { running: true, endsAt: Date.now() + remaining * 1000 })
  }

  const onDelete = (): void => {
    removeTimer(timer.id)
    silenceUnlessRinging()
  }

  const switchKind = (kind: TimerItem['kind']): void => {
    if (kind === timer.kind) return
    if (kind === 'pomodoro') {
      updateTimer(timer.id, {
        kind,
        phase: 'idle',
        running: false,
        ringing: false,
        endsAt: null,
        leftSec: timer.focusMin * 60,
        completedFocus: 0
      })
    } else {
      updateTimer(timer.id, {
        kind,
        phase: 'idle',
        running: false,
        ringing: false,
        endsAt: null,
        leftSec: timer.totalSec
      })
      setDraft(formatDurationDraft(timer.totalSec))
    }
    silenceUnlessRinging()
  }

  // --- simple countdown ---
  const idle = !timer.running && !timer.ringing
  const paused = idle && remaining > 0 && remaining < timer.totalSec
  const startSimple = (): void => {
    const seconds = parseDurationInput(draft)
    if (seconds === null) return
    stopAlarm()
    updateTimer(timer.id, {
      totalSec: seconds,
      leftSec: seconds,
      endsAt: Date.now() + seconds * 1000,
      running: true,
      ringing: false
    })
  }
  const resetSimple = (): void => {
    updateTimer(timer.id, {
      running: false,
      ringing: false,
      leftSec: timer.totalSec,
      endsAt: null
    })
    setDraft(formatDurationDraft(timer.totalSec))
    silenceUnlessRinging()
  }
  const simpleProgress = timer.totalSec
    ? Math.min(1, Math.max(0, 1 - remaining / timer.totalSec))
    : 0

  // --- pomodoro cycle ---
  const phaseLenSec = Math.max(1, pomodoroPhaseMinutes(timer, timer.phase) * 60)
  const pomoProgress = Math.min(1, Math.max(0, 1 - remaining / phaseLenSec))
  const previewing = isPomo && !timer.running && !timer.ringing && timer.phase !== 'idle'
  const pomoStart = (): void => {
    stopAlarm()
    if (timer.phase === 'idle') {
      updateTimer(timer.id, {
        phase: 'focus',
        ringing: false,
        running: true,
        endsAt: Date.now() + timer.focusMin * 60 * 1000,
        leftSec: timer.focusMin * 60
      })
      return
    }
    updateTimer(timer.id, {
      running: true,
      ringing: false,
      endsAt: Date.now() + Math.max(0, remaining) * 1000
    })
  }
  const pomoStop = (): void => {
    updateTimer(timer.id, advancePomodoroTimer(timer, timer.autoAdvance, Date.now()))
    silenceUnlessRinging()
  }
  const pomoSkip = (): void => {
    updateTimer(timer.id, advancePomodoroTimer(timer, timer.running, Date.now()))
    silenceUnlessRinging()
  }
  const pomoReset = (): void => {
    updateTimer(timer.id, {
      phase: 'idle',
      running: false,
      ringing: false,
      endsAt: null,
      leftSec: timer.focusMin * 60,
      completedFocus: 0
    })
    silenceUnlessRinging()
  }
  const setMinutes = (key: 'focusMin' | 'breakMin' | 'longBreakMin', value: string): void => {
    const minutes = Math.min(180, Math.max(1, Math.floor(Number(value) || 0)))
    if (!minutes) return
    const patch: Partial<TimerItem> = {}
    if (key === 'focusMin') patch.focusMin = minutes
    else if (key === 'breakMin') patch.breakMin = minutes
    else patch.longBreakMin = minutes
    const phaseKey =
      timer.phase === 'break'
        ? 'breakMin'
        : timer.phase === 'longBreak'
          ? 'longBreakMin'
          : 'focusMin'
    if (!timer.running && !timer.ringing && key === phaseKey) {
      patch.leftSec = minutes * 60
    }
    updateTimer(timer.id, patch)
  }
  const dots = Array.from({ length: timer.roundsBeforeLong }, (_, i) => i)
  const busy = timer.running || timer.ringing

  return (
    <section className={`miniapp${timer.ringing ? ' is-ringing' : ''}`} aria-label={timer.label}>
      <header className="miniapp__head">
        <TimerIcon size={18} />
        <input
          className="miniapp__name"
          aria-label="Timer name"
          title="Click to rename"
          placeholder="Timer name"
          value={timer.label}
          spellCheck={false}
          onChange={(event) => updateTimer(timer.id, { label: event.target.value })}
        />
        <DeleteButton label={timer.label} onDelete={onDelete} />
      </header>
      <div className="kind-toggle" role="group" aria-label={`${timer.label} type`}>
        {(['simple', 'pomodoro'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            className={`kind-toggle__btn${timer.kind === kind ? ' is-active' : ''}`}
            aria-pressed={timer.kind === kind}
            disabled={busy}
            title={busy ? 'Stop the timer to change its type' : `Use as ${kind} timer`}
            onClick={() => switchKind(kind)}
          >
            {kind === 'simple' ? 'Countdown' : 'Pomodoro'}
          </button>
        ))}
      </div>
      {!isPomo && (
        <>
          <div className="miniapp__clock">{formatElapsed(remaining)}</div>
          <div className="miniapp__bar">
            <span style={{ width: `${simpleProgress * 100}%` }} />
          </div>
          <div className="miniapp__row">
            <input
              className="dlg__input"
              aria-label={`${timer.label} duration (MM:SS)`}
              value={draft}
              placeholder="MM:SS"
              spellCheck={false}
              disabled={timer.running || paused}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <div className="miniapp__row">
            {timer.ringing ? (
              <button type="button" className="btn btn--primary" onClick={resetSimple}>
                Stop
              </button>
            ) : timer.running ? (
              <button type="button" className="btn btn--primary" onClick={pause}>
                Pause
              </button>
            ) : paused ? (
              <button type="button" className="btn btn--primary" onClick={resume}>
                Resume
              </button>
            ) : (
              <button type="button" className="btn btn--primary" onClick={startSimple}>
                Start
              </button>
            )}
            <button type="button" className="btn btn--ghost" onClick={resetSimple}>
              Reset
            </button>
          </div>
          {timer.ringing && <p className="miniapp__hint">Time&apos;s up!</p>}
          {idle && !timer.ringing && (
            <p className="miniapp__hint">
              {paused ? 'Paused — resume or reset.' : 'Set a duration and start.'}
            </p>
          )}
        </>
      )}
      {isPomo && (
        <>
          <div className="miniapp__row">
            <span className="pomo__phase">
              {timer.phase === 'idle' ? 'Ready' : POMODORO_LABEL[timer.phase]}
            </span>
            <span className="pomo__dots" aria-label={`${timer.completedFocus} sessions done`}>
              {dots.map((i) => (
                <span
                  key={i}
                  className={`pomo__dot${i < timer.completedFocus ? ' is-done' : ''}`}
                />
              ))}
            </span>
          </div>
          <div className="miniapp__clock">{formatElapsed(remaining)}</div>
          <div className="miniapp__bar">
            <span style={{ width: `${pomoProgress * 100}%` }} />
          </div>
          <div className="miniapp__row">
            {timer.ringing ? (
              <button type="button" className="btn btn--primary" onClick={pomoStop}>
                Stop
              </button>
            ) : timer.running ? (
              <button type="button" className="btn btn--primary" onClick={pause}>
                Pause
              </button>
            ) : (
              <button type="button" className="btn btn--primary" onClick={pomoStart}>
                {timer.phase === 'idle' ? 'Start focus' : previewing ? 'Resume' : 'Start'}
              </button>
            )}
            {!timer.ringing && timer.phase !== 'idle' && (
              <button type="button" className="btn btn--ghost" onClick={pomoSkip}>
                Skip
              </button>
            )}
            <button type="button" className="btn btn--ghost" onClick={pomoReset}>
              Reset
            </button>
          </div>
          {timer.ringing && (
            <p className="miniapp__hint">
              {timer.phase === 'focus' ? 'Focus done — break time!' : 'Break over — back to focus!'}
            </p>
          )}
          <div className="pomo__settings">
            <label className="pomo__field">
              Focus
              <input
                type="number"
                className="dlg__input"
                min={1}
                max={180}
                value={timer.focusMin}
                aria-label={`${timer.label} focus minutes`}
                onChange={(event) => setMinutes('focusMin', event.target.value)}
              />
            </label>
            <label className="pomo__field">
              Break
              <input
                type="number"
                className="dlg__input"
                min={1}
                max={60}
                value={timer.breakMin}
                aria-label={`${timer.label} break minutes`}
                onChange={(event) => setMinutes('breakMin', event.target.value)}
              />
            </label>
            <label className="pomo__field">
              Long
              <input
                type="number"
                className="dlg__input"
                min={1}
                max={90}
                value={timer.longBreakMin}
                aria-label={`${timer.label} long break minutes`}
                onChange={(event) => setMinutes('longBreakMin', event.target.value)}
              />
            </label>
            <label className="pomo__field">
              Every
              <input
                type="number"
                className="dlg__input"
                min={2}
                max={12}
                value={timer.roundsBeforeLong}
                aria-label={`${timer.label} sessions before long break`}
                onChange={(event) =>
                  updateTimer(timer.id, {
                    roundsBeforeLong: Math.min(
                      12,
                      Math.max(2, Math.floor(Number(event.target.value) || 0) || 4)
                    )
                  })
                }
              />
            </label>
          </div>
          <label className="settings__check">
            <input
              type="checkbox"
              checked={timer.autoAdvance}
              onChange={(event) => updateTimer(timer.id, { autoAdvance: event.target.checked })}
            />
            Auto-start next phase
          </label>
        </>
      )}
      <CardSound
        label={`${timer.label} sound`}
        value={timer.soundId}
        onChange={(soundId) => {
          updateTimer(timer.id, { soundId })
          setAlarmSoundId(soundId)
        }}
      />
    </section>
  )
}

function StopwatchCard({ sw, now }: { sw: StopwatchItem; now: number }): React.JSX.Element {
  const updateStopwatch = useAppStore((state) => state.updateStopwatch)
  const removeStopwatch = useAppStore((state) => state.removeStopwatch)

  const running = sw.startStamp !== null
  const elapsedMs = sw.accMs + (sw.startStamp !== null ? Math.max(0, now - sw.startStamp) : 0)

  const start = (): void => {
    updateStopwatch(sw.id, { startStamp: Date.now() })
  }

  const stop = (): void => {
    if (sw.startStamp === null) return
    updateStopwatch(sw.id, {
      accMs: sw.accMs + Math.max(0, Date.now() - sw.startStamp),
      startStamp: null
    })
  }

  const reset = (): void => {
    updateStopwatch(sw.id, { accMs: 0, startStamp: null })
  }

  return (
    <section className="miniapp" aria-label={sw.label}>
      <header className="miniapp__head">
        <StopwatchIcon size={18} />
        <input
          className="miniapp__name"
          aria-label="Stopwatch name"
          title="Click to rename"
          placeholder="Stopwatch name"
          value={sw.label}
          spellCheck={false}
          onChange={(event) => updateStopwatch(sw.id, { label: event.target.value })}
        />
        <DeleteButton label={sw.label} onDelete={() => removeStopwatch(sw.id)} />
      </header>
      <div className="miniapp__clock">{formatElapsed(elapsedMs / 1000)}</div>
      <div className="miniapp__row">
        {running ? (
          <button type="button" className="btn btn--primary" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={start}>
            Start
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={reset}>
          Reset
        </button>
      </div>
      <p className="miniapp__hint">Hundredths precision while running.</p>
    </section>
  )
}

function ClockSection({
  icon,
  title,
  count,
  onAdd,
  addLabel,
  children
}: {
  icon: React.JSX.Element
  title: string
  count: number
  onAdd: () => void
  addLabel: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="clock-section" aria-label={title}>
      <div className="clock-section__head">
        {icon}
        <h2 className="clock-section__title">
          {title} <span className="clock-section__count">{count}</span>
        </h2>
        <button type="button" className="btn btn--ghost" onClick={onAdd} title={addLabel}>
          <PlusIcon size={14} /> Add
        </button>
      </div>
      <div className="misc__grid">{children}</div>
    </section>
  )
}

function Misc(): React.JSX.Element {
  const alarms = useAppStore((state) => state.alarms)
  const timers = useAppStore((state) => state.timers)
  const stopwatches = useAppStore((state) => state.stopwatches)
  const addAlarm = useAppStore((state) => state.addAlarm)
  const addTimer = useAppStore((state) => state.addTimer)
  const addStopwatch = useAppStore((state) => state.addStopwatch)
  const now = useNowMs(250)

  return (
    <main className="misc">
      <div className="misc__inner">
        <header className="misc__header">
          <div>
            <h1 className="misc__title">Misc</h1>
            <p className="misc__subtitle">Small utilities that live beside your notes.</p>
          </div>
        </header>
        <ClockSection
          icon={<AlarmIcon size={17} />}
          title="Alarms"
          count={alarms.length}
          onAdd={() => addAlarm()}
          addLabel="Add alarm"
        >
          {alarms.map((alarm) => (
            <AlarmCard key={alarm.id} alarm={alarm} />
          ))}
          {alarms.length === 0 && (
            <p className="miniapp__hint">No alarms yet — add one to get started.</p>
          )}
        </ClockSection>
        <ClockSection
          icon={<TimerIcon size={17} />}
          title="Timers"
          count={timers.length}
          onAdd={() => addTimer()}
          addLabel="Add timer"
        >
          {timers.map((timer) => (
            <TimerCard key={timer.id} timer={timer} now={now} />
          ))}
          {timers.length === 0 && (
            <p className="miniapp__hint">No timers yet — add one to get started.</p>
          )}
        </ClockSection>
        <ClockSection
          icon={<StopwatchIcon size={17} />}
          title="Stopwatches"
          count={stopwatches.length}
          onAdd={() => addStopwatch()}
          addLabel="Add stopwatch"
        >
          {stopwatches.map((sw) => (
            <StopwatchCard key={sw.id} sw={sw} now={now} />
          ))}
          {stopwatches.length === 0 && (
            <p className="miniapp__hint">No stopwatches yet — add one to get started.</p>
          )}
        </ClockSection>
      </div>
    </main>
  )
}

export default Misc

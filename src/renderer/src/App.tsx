import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { resolveSoundUrl, startAlarmLoop } from './alarm'
import { isAlarmDue, nowHHMM } from './time'
import AgentBubble from './components/AgentBubble'
import LockScreen, { type LockInfo } from './components/LockScreen'
import Rail from './components/Rail'
import Sidebar from './components/Sidebar'
import TabBar from './components/TabBar'
import TabSwitcher from './components/TabSwitcher'
import Spotlight from './components/Spotlight'
import { XIcon } from './components/icons'
import { useTheme } from './theme'
import { NAV_LABELS, isInlineNav } from './nav'
import { isSpaceSwipeActive } from './gestures'
import Agent from './pages/Agent'
import Calendar from './pages/Calendar'
import Email from './pages/Email'
import Graph from './pages/Graph'
import Home from './pages/Home'
import Misc from './pages/Misc'
import Note from './pages/Note'
import Settings from './pages/Settings'
import Tasks from './pages/Tasks'
import { SPLIT_RATIO_DEFAULT, type NavKey, type Tab, useAppStore } from './store/appStore'

/** How often auto-sync checks for unpushed vault changes. */
const AUTO_SYNC_INTERVAL_MS = 30000

/** How often the calendar pulls fresh events (local files + subscriptions). */
const CALENDAR_REFRESH_INTERVAL_MS = 5 * 60 * 1000

function Content({ active }: { active: NavKey }): React.JSX.Element {
  if (active === 'agent') return <Agent />
  if (active === 'home') return <Home />
  if (active === 'graph') return <Graph />
  if (active === 'settings') return <Settings />
  if (active === 'calendar') return <Calendar />
  if (active === 'email') return <Email />
  if (active === 'tasks') return <Tasks />
  if (active === 'misc') return <Misc />
  // All remaining nav keys have dedicated pages above; this is dead code
  // kept so a stale persisted tab can never render a blank screen.
  return <Home />
}

function renderTab(tab: Tab): ReactNode {
  // Key by note so reusing the active tab for a different note (sidebar clicks)
  // remounts the editor instead of leaving the previous note's blocks on screen.
  return <Note key={tab.noteId} noteId={tab.noteId} />
}

function SplitPaneHeader({
  tabId,
  onClose
}: {
  tabId: string
  onClose: () => void
}): React.JSX.Element {
  const tabs = useAppStore((state) => state.tabs)
  const notes = useAppStore((state) => state.notes)
  const tab = tabs.find((t) => t.id === tabId)
  const label = !tab ? '' : notes.find((n) => n.id === tab.noteId)?.title.trim() || 'Untitled'
  return (
    <div className="pane__header">
      <span className="pane__label" title={label}>
        {label}
      </span>
      <button
        type="button"
        className="pane__close"
        aria-label="Close split view"
        title="Close split view"
        onClick={onClose}
      >
        <XIcon size={13} />
      </button>
    </div>
  )
}

/**
 * Sidebar pages (Tasks, Calendar, …) float above the current note tab in a
 * rounded window instead of replacing it — no tab clutter, and the note stays
 * put underneath. Home and SeeMO keep their dedicated full-size views (see
 * isInlineNav). Dismiss via the ✕ button, clicking the backdrop, or Esc.
 * Remounts per page so each window opens fresh. The calendar gets a wider
 * window for its grid.
 */
function NavFloat({ nav, onClose }: { nav: NavKey; onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const title = NAV_LABELS[nav]
  const wide = nav === 'calendar'
  return (
    <div
      className={`navfloat__backdrop${wide ? ' navfloat__backdrop--wide' : ''}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={`navfloat${wide ? ' navfloat--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="navfloat__head">
          <span className="navfloat__title" title={title}>
            {title}
          </span>
          <button
            type="button"
            className="navfloat__close"
            aria-label={`Close ${title}`}
            title={`Close ${title} (Esc)`}
            onClick={onClose}
          >
            <XIcon size={14} />
          </button>
        </div>
        <div className="navfloat__body">
          <Content key={nav} active={nav} />
        </div>
      </div>
    </div>
  )
}

function App(): React.JSX.Element {
  useTheme()
  const tabs = useAppStore((state) => state.tabs)
  const goBackTab = useAppStore((state) => state.goBackTab)
  const goForwardTab = useAppStore((state) => state.goForwardTab)
  const activeTabId = useAppStore((state) => state.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  // Sidebar pages (Home, Tasks, Calendar, …) float above the note tabs.
  // Null means no floating window is open.
  const activeNav = useAppStore((state) => state.activeNav)
  const closeNav = useAppStore((state) => state.closeNav)
  const splitTabId = useAppStore((state) => state.splitTabId)
  const setSplitTab = useAppStore((state) => state.setSplitTab)
  const splitRatio = useAppStore((state) => state.splitRatio)
  const setSplitRatio = useAppStore((state) => state.setSplitRatio)
  const autoSync = useAppStore((state) => state.autoSync)
  const vaultReady = useAppStore((state) => state.vaultReady)
  const syncingRef = useRef(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const historySwipeRef = useRef<{ x: number; y: number } | null>(null)
  const historyWheelRef = useRef({ accum: 0, lockUntil: 0 })
  const leftPaneRef = useRef<HTMLDivElement>(null)
  const splitDragRef = useRef({ x: 0, left: 0 })
  const [resizingSplit, setResizingSplit] = useState(false)

  // App lock: ask the main process whether a password gate exists. Vault
  // loading waits for unlock, so note contents never enter memory locked.
  const [lockChecked, setLockChecked] = useState(false)
  const [unlocked, setUnlocked] = useState(false)
  const [lockInfo, setLockInfo] = useState<LockInfo | null>(null)
  useEffect(() => {
    window.api.lock
      .status()
      .then((status) => {
        setLockInfo({
          biometricKind: status.biometricKind,
          biometricAvailable: status.biometricAvailable,
          biometricEnabled: status.biometricEnabled
        })
        setUnlocked(!status.passwordSet)
      })
      .catch(() => setUnlocked(true))
      .finally(() => setLockChecked(true))
  }, [])

  // Sign out: the rail's account menu bumps the store counter, and we drop
  // back to the lock screen. Subscribing (rather than watching the value in a
  // selector) keeps the setState out of a render-sync effect.
  useEffect(() => {
    return useAppStore.subscribe((state, prev) => {
      if (state.lockRequested !== prev.lockRequested) setUnlocked(false)
    })
  }, [])

  // Load the on-disk vault once: imports existing .md files and writes out
  // any notes that only exist in localStorage yet.
  useEffect(() => {
    if (!unlocked) return
    void useAppStore.getState().initVault()
  }, [unlocked])

  // Push the PiP-orb preference to the main process (it can't read renderer
  // storage). Runs only in the main window — the orb renders OrbView instead.
  const orbEnabled = useAppStore((state) => state.orbEnabled)
  useEffect(() => {
    window.api.setOrbEnabled(orbEnabled)
  }, [orbEnabled])

  // macOS traffic lights stay put and hide while the sidebar is collapsed.
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed)
  useEffect(() => {
    window.api.setSidebarCollapsed?.(sidebarCollapsed)
  }, [sidebarCollapsed])

  // Clock watcher: fires due alarms and expired timers wherever you are in
  // the app (the Misc page only displays them). Timestamps are the source of
  // truth; this just flips flags and starts the shared sound loop.
  useEffect(() => {
    const tick = (): void => {
      const state = useAppStore.getState()
      const customUrl = state.customAlarm?.url ?? null
      const now = Date.now()
      for (const alarm of state.alarms) {
        // Repeat: while ringing, restart the loop every interval until Stop.
        // Also retries playback when the browser blocked it mid-ring.
        if (alarm.ringing && alarm.repeat && now - alarm.lastRepeatAt >= alarm.repeatMin * 60_000) {
          startAlarmLoop(resolveSoundUrl(alarm.soundId, customUrl))
          state.updateAlarm(alarm.id, { lastRepeatAt: now })
          continue
        }
        if (!alarm.enabled || alarm.ringing || now < alarm.quietUntil) continue
        if (alarm.snoozeUntil && alarm.snoozeUntil !== nowHHMM()) {
          state.updateAlarm(alarm.id, { snoozeUntil: null })
        }
        const target = alarm.snoozeUntil ?? alarm.time
        if (target && isAlarmDue(target)) {
          startAlarmLoop(resolveSoundUrl(alarm.soundId, customUrl))
          if (alarm.maxVolume) {
            // Crank the OS volume so the alarm is heard; put back on stop.
            // A failed max-out still rings at the current level. The optional
            // call also tolerates a stale preload bundle (app not rebuilt).
            void window.api.maxAlarmVolume?.().then(
              (result) => {
                if (!result.ok) console.error('[alarm] max volume failed:', result.error)
              },
              (error) => console.error('[alarm] max volume failed:', error)
            )
          }
          state.updateAlarm(alarm.id, { ringing: true, lastRepeatAt: now })
        }
      }
      for (const timer of state.timers) {
        if (!timer.running || timer.ringing || timer.endsAt === null) continue
        if (timer.endsAt <= now) {
          startAlarmLoop(resolveSoundUrl(timer.soundId, customUrl))
          state.updateTimer(timer.id, {
            running: false,
            ringing: true,
            leftSec: 0,
            endsAt: null,
            // A finished pomodoro focus counts toward the long break even if
            // the user dismisses the ring without auto-advance.
            completedFocus:
              timer.kind === 'pomodoro' && timer.phase === 'focus'
                ? timer.completedFocus + 1
                : timer.completedFocus
          })
        }
      }
    }
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [])

  // Ctrl/Cmd+S toggles the sidebar (there is no save dialog to clash with:
  // notes persist continuously). preventDefault stops the browser chime.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 's'
      ) {
        event.preventDefault()
        useAppStore.getState().toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Auto-sync: while enabled, periodically push unpushed vault changes.
  // Guarded against overlap; sync() itself no-ops when the tree is clean.
  useEffect(() => {
    if (!autoSync || !vaultReady) return
    const tick = (): void => {
      if (syncingRef.current) return
      syncingRef.current = true
      window.api.github
        .status()
        .then((status) => {
          if (status.remoteUrl && !status.clean) return window.api.github.sync()
          return null
        })
        .catch((error) => {
          console.error('[github] auto-sync failed', error)
        })
        .finally(() => {
          syncingRef.current = false
        })
    }
    tick()
    const timer = setInterval(tick, AUTO_SYNC_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [autoSync, vaultReady])

  // Calendar auto-refresh: re-pull local files + subscriptions every
  // 5 minutes so new/changed events appear without a restart.
  // Guarded against overlap; loadPlanner() no-ops its migrations on rerun.
  useEffect(() => {
    if (!vaultReady) return
    const refreshingRef = { current: false }
    const timer = setInterval(() => {
      if (refreshingRef.current) return
      refreshingRef.current = true
      useAppStore
        .getState()
        .loadPlanner()
        .catch((error) => {
          console.error('[planner] auto-refresh failed', error)
        })
        .finally(() => {
          refreshingRef.current = false
        })
    }, CALENDAR_REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [vaultReady])

  // Nightly cleanup: clear finished tasks at 11:59pm local time so each
  // morning starts fresh. Clearing is idempotent; the first timeout covers
  // the gap until the next 23:59, then it repeats every 24 hours.
  useEffect(() => {
    const clearIfDone = (): void => {
      const state = useAppStore.getState()
      if (state.tasks.some((task) => task.status === 'completed')) {
        state.clearCompletedTasks()
      }
    }
    const msUntilNext2359 = (): number => {
      const now = new Date()
      const target = new Date(now)
      target.setHours(23, 59, 0, 0)
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
      return target.getTime() - now.getTime()
    }
    let interval: ReturnType<typeof setInterval> | null = null
    const timeout = setTimeout(() => {
      clearIfDone()
      interval = setInterval(clearIfDone, 24 * 60 * 60 * 1000)
    }, msUntilNext2359())
    return () => {
      clearTimeout(timeout)
      if (interval) clearInterval(interval)
    }
  }, [])

  let content: ReactNode
  const splitTab =
    splitTabId !== null && splitTabId !== activeTabId
      ? (tabs.find((t) => t.id === splitTabId) ?? null)
      : null
  // Home and SeeMO render as dedicated full-size views (tab-free). Other
  // pages float above the notes; with no note tabs open they render inline
  // instead so a fresh vault never shows a blank shell.
  const showFloat = activeNav !== null && !isInlineNav(activeNav) && activeTab !== null
  if (activeNav !== null && (isInlineNav(activeNav) || !activeTab)) {
    // Full-size nav pages have no tab bar, so give them their own title-bar
    // drag strip. Without it macOS can't treat double-clicks up here as
    // title-bar double-clicks (fullscreen/zoom), which note tabs get for free.
    content = (
      <div className="navshell">
        <div className="navshell__drag" aria-hidden="true" />
        <Content active={activeNav} />
      </div>
    )
  } else if (!activeTab) {
    content = (
      <main className="empty">
        <p>No note tabs open. Pick a page above or a note from the sidebar.</p>
      </main>
    )
  } else if (splitTab) {
    const clampSplitPx = (width: number, leftPx: number): number => {
      const min = Math.max(160, width * 0.15)
      return Math.min(Math.max(leftPx, min), Math.max(min, width - min))
    }
    const onSplitResizeStart = (event: React.PointerEvent<HTMLDivElement>): void => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      splitDragRef.current = {
        x: event.clientX,
        left: leftPaneRef.current?.offsetWidth ?? 0
      }
      setResizingSplit(true)
    }
    const onSplitResizeMove = (event: React.PointerEvent<HTMLDivElement>): void => {
      if (!resizingSplit || !contentRef.current || !leftPaneRef.current) return
      const width = contentRef.current.clientWidth
      if (width <= 0) return
      const next = clampSplitPx(
        width,
        splitDragRef.current.left + (event.clientX - splitDragRef.current.x)
      )
      // Paint live via the DOM for 60fps; commit the ratio on release.
      leftPaneRef.current.style.flex = 'none'
      leftPaneRef.current.style.width = `${next}px`
    }
    const onSplitResizeEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
      if (!resizingSplit || !contentRef.current) return
      setResizingSplit(false)
      const width = contentRef.current.clientWidth
      if (width <= 0) return
      const next = clampSplitPx(
        width,
        splitDragRef.current.left + (event.clientX - splitDragRef.current.x)
      )
      if (leftPaneRef.current) {
        leftPaneRef.current.style.flex = ''
        leftPaneRef.current.style.width = ''
      }
      setSplitRatio(next / width)
    }
    content = (
      <>
        <div
          className="app__pane"
          key={`left-${activeTab.id}`}
          ref={leftPaneRef}
          style={{ flexGrow: splitRatio }}
        >
          {renderTab(activeTab)}
        </div>
        <div
          className={`app__divider${resizingSplit ? ' is-active' : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize split panes"
          title="Drag to resize (double-click to reset)"
          onPointerDown={onSplitResizeStart}
          onPointerMove={onSplitResizeMove}
          onPointerUp={onSplitResizeEnd}
          onPointerCancel={onSplitResizeEnd}
          onDoubleClick={() => setSplitRatio(SPLIT_RATIO_DEFAULT)}
        />
        <div className="app__pane app__pane--split" key={`right-${splitTab.id}`}>
          <SplitPaneHeader tabId={splitTab.id} onClose={() => setSplitTab(null)} />
          {renderTab(splitTab)}
        </div>
      </>
    )
  } else {
    content = renderTab(activeTab)
  }

  // In the main window a horizontal swipe walks page history, matching the
  // browser gesture: swipe right → back, swipe left → forward. Space
  // switching is reserved for the sidebar. Vertical scrolling is ignored, and
  // horizontally scrollable regions keep their own behaviour. Unlike inputs,
  // the note body is allowed: swiping anywhere on a page navigates history.
  const onHistoryWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.2) return
    const target = event.target as HTMLElement
    // Sidebar/rail gestures belong to space switching, and a space swipe owns
    // the whole motion so it can never also step page history.
    if (target.closest('.sidebar, .rail') || isSpaceSwipeActive()) {
      historyWheelRef.current.accum = 0
      return
    }
    if (target.closest('input, textarea, .tabbar__list, pre')) {
      return
    }
    const now = performance.now()
    const wheel = historyWheelRef.current
    if (now < wheel.lockUntil) return
    if (Math.sign(wheel.accum) !== Math.sign(event.deltaX)) wheel.accum = 0
    wheel.accum += event.deltaX
    if (Math.abs(wheel.accum) < 80) return
    const forward = wheel.accum > 0
    wheel.accum = 0
    wheel.lockUntil = now + 500
    if (forward) goForwardTab()
    else goBackTab()
  }

  // Blank stage while checking; lock screen while gated. Nothing behind
  // it renders, and the vault stays unread until unlock.
  if (!lockChecked) return <div className="app" aria-hidden="true" />
  if (!unlocked) {
    return (
      <div className="app">
        <LockScreen
          info={
            lockInfo ?? { biometricKind: null, biometricAvailable: false, biometricEnabled: false }
          }
          onUnlock={() => setUnlocked(true)}
        />
      </div>
    )
  }

  return (
    <div className="app">
      {/* Icon-only rail that slides in from the very left edge on hover. */}
      <Rail />
      {/* Always mounted: collapsing animates width to zero via CSS. */}
      <Sidebar />
      <div className="app__main">
        {/* Home and SeeMO own the full window: no tab bar while focused. */}
        {!isInlineNav(activeNav) && <TabBar />}
        <div
          ref={contentRef}
          className={`app__content${splitTab ? ' app__content--split' : ''}`}
          onWheel={onHistoryWheel}
          onTouchStart={(event) => {
            const target = event.target as HTMLElement
            if (target.closest('input, textarea, .sidebar, .rail') || isSpaceSwipeActive()) return
            const touch = event.touches[0]
            historySwipeRef.current = { x: touch.clientX, y: touch.clientY }
          }}
          onTouchEnd={(event) => {
            const start = historySwipeRef.current
            historySwipeRef.current = null
            if (!start || isSpaceSwipeActive()) return
            const touch = event.changedTouches[0]
            const dx = touch.clientX - start.x
            const dy = touch.clientY - start.y
            if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.3) return
            // Swipe right (dx > 0) = back; swipe left (dx < 0) = forward.
            if (dx > 0) goBackTab()
            else goForwardTab()
          }}
        >
          {content}
        </div>
      </div>
      {showFloat && activeNav !== null && <NavFloat nav={activeNav} onClose={closeNav} />}
      <AgentBubble />
      <TabSwitcher />
      <Spotlight />
    </div>
  )
}

export default App

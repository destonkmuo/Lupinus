import { useEffect, useRef } from 'react'
import JarvisCore from './JarvisCore'
import { useTheme } from '../theme'
import { useAppStore, type CoreState } from '../store/appStore'

// Same cadence as the main voice pipeline so both windows agree.
const WORKING_TIMEOUT_MS = 8000
const SLEEP_TIMEOUT_MS = 90000
const SUMMONED_TIMEOUT_MS = 2500

const REMOTE_STATES: readonly CoreState[] = ['sleep', 'idle', 'working', 'speaking', 'summoned']

/**
 * Voice-driven core mirror for the PiP orb. Same inputs as the main
 * VoiceProvider (broadcast wake/transcript events + agent state pulses)
 * but deliberately *without* its side effects: no chat messages, no agent
 * replies — those stay owned by the main window.
 */
function useOrbCore(): void {
  const workingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const summonedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const clearTimers = (): void => {
      if (workingTimer.current) clearTimeout(workingTimer.current)
      if (sleepTimer.current) clearTimeout(sleepTimer.current)
      if (summonedTimer.current) clearTimeout(summonedTimer.current)
      workingTimer.current = null
      sleepTimer.current = null
      summonedTimer.current = null
    }
    const offWake = window.api.onVoiceWake(() => {
      const { setCoreState } = useAppStore.getState()
      if (summonedTimer.current) clearTimeout(summonedTimer.current)
      setCoreState('summoned')
      summonedTimer.current = setTimeout(() => setCoreState('idle'), SUMMONED_TIMEOUT_MS)
    })
    const offTranscript = window.api.onVoiceTranscript(() => {
      const { setCoreState } = useAppStore.getState()
      setCoreState('working')
      if (workingTimer.current) clearTimeout(workingTimer.current)
      if (sleepTimer.current) clearTimeout(sleepTimer.current)
      if (summonedTimer.current) clearTimeout(summonedTimer.current)
      workingTimer.current = setTimeout(() => setCoreState('idle'), WORKING_TIMEOUT_MS)
      sleepTimer.current = setTimeout(() => setCoreState('sleep'), SLEEP_TIMEOUT_MS)
    })
    const offRemote = window.api.onCoreRemote((state) => {
      if (!(REMOTE_STATES as readonly string[]).includes(state)) return
      // Agent-side states win outright; drop fallbacks so they can't stomp it.
      clearTimers()
      useAppStore.getState().setCoreState(state as CoreState)
    })
    return () => {
      offWake()
      offTranscript()
      offRemote()
      clearTimers()
    }
  }, [])
}

/**
 * Picture-in-picture orb: the same live core, floating. The whole surface
 * drags (frameless window); clicking it brings the main window back.
 */
declare global {
  interface Window {
    __orbCore?: { get: () => CoreState }
  }
}

function OrbView(): React.JSX.Element {
  useOrbCore()
  useTheme()

  // Drag-release also fires click on frameless drag regions: only a true
  // (near-stationary) click brings the app back, moving the orb never does.
  const downPos = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    document.body.classList.add('is-orb')
    // Debug handle mirroring __voiceContext: live core without a subscription.
    window.__orbCore = { get: () => useAppStore.getState().coreState }
    return () => {
      document.body.classList.remove('is-orb')
      delete window.__orbCore
    }
  }, [])

  const focusApp = (clientX: number, clientY: number): void => {
    const start = downPos.current
    downPos.current = null
    if (start && Math.hypot(clientX - start.x, clientY - start.y) > 6) return
    void window.api.focusApp().catch(() => undefined)
  }

  return (
    <div
      className="orb"
      role="button"
      tabIndex={0}
      title="Open SeeMO"
      aria-label="SeeMO is here — activate to open the app"
      onMouseDown={(event) => {
        downPos.current = { x: event.clientX, y: event.clientY }
      }}
      onClick={(event) => focusApp(event.clientX, event.clientY)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          void window.api.focusApp().catch(() => undefined)
        }
      }}
    >
      <JarvisCore />
    </div>
  )
}

export default OrbView

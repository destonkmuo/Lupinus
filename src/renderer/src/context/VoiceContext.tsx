/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { respondTo } from '../agentBrain'
import { useAppStore } from '../store/appStore'

// A fresh transcript means the user spoke: process it as `working`, fall
// back to `idle` (listening) after a few quiet seconds, and drift to `sleep`
// after prolonged silence. A wake-word hit flashes `summoned` briefly until
// the transcript lands (or its own short fallback expires).
const WORKING_TIMEOUT_MS = 8000
const SLEEP_TIMEOUT_MS = 90000
const SUMMONED_TIMEOUT_MS = 2500

export interface VoiceTranscript {
  id: string
  text: string
  timestamp: number
}

interface VoiceContextValue {
  transcripts: VoiceTranscript[]
  lastTranscript: VoiceTranscript | null
  clear: () => void
  dump: () => void
}

const VoiceContext = createContext<VoiceContextValue | null>(null)

interface VoiceContextGlobal {
  transcripts: VoiceTranscript[]
  dump: () => void
  clear: () => void
}

declare global {
  interface Window {
    __voiceContext?: VoiceContextGlobal
  }
}

/**
 * Global context for the whisper pipeline output.
 *
 * The main process runs the Python whisper pipeline and forwards each finished
 * transcription over IPC. This provider collects them, mirrors the whole
 * context onto `window.__voiceContext`, and prints the contents to the DevTools
 * console on every update.
 */
export function VoiceProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [transcripts, setTranscripts] = useState<VoiceTranscript[]>([])
  const workingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const summonedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear activity timers on unmount.
  useEffect(() => {
    return () => {
      if (workingTimer.current) clearTimeout(workingTimer.current)
      if (sleepTimer.current) clearTimeout(sleepTimer.current)
      if (summonedTimer.current) clearTimeout(summonedTimer.current)
    }
  }, [])

  // The SeeMO page has its own independent mute: on the page (sidebar view)
  // voice is live unless the page is muted. Off the page the mic is
  // effectively off unless Always listening is on. Anywhere voice isn't
  // live, input is ignored entirely: nothing in chat, no orb movement, no
  // replies.
  const isVoiceLive = (): boolean => {
    const { activeNav, backgroundListening, agentMicMuted } = useAppStore.getState()
    const onPage = activeNav === 'agent'
    return onPage ? !agentMicMuted : backgroundListening
  }

  // Wake-word hits arrive ahead of any transcript: flash `summoned` briefly.
  useEffect(() => {
    return window.api.onVoiceWake(() => {
      if (!isVoiceLive()) return
      const { setCoreState } = useAppStore.getState()
      if (summonedTimer.current) clearTimeout(summonedTimer.current)
      setCoreState('summoned')
      summonedTimer.current = setTimeout(() => setCoreState('idle'), SUMMONED_TIMEOUT_MS)
    })
  }, [])

  // Receive transcriptions forwarded from the main process.
  useEffect(() => {
    return window.api.onVoiceTranscript((text) => {
      if (!isVoiceLive()) return
      const { setCoreState, addChatMessage, backgroundListening } = useAppStore.getState()
      setTranscripts((prev) => [...prev, { id: crypto.randomUUID(), text, timestamp: Date.now() }])

      // Drive the core animation from voice activity. getState() avoids
      // re-rendering this provider on every state change.
      setCoreState('working')
      // Spoken commands also land in the SeeMO chat as user messages.
      addChatMessage('user', text)
      // Background listening: answer out loud in state + chat even when the
      // SeeMO page isn't open. Same engine as typed messages, so the flow
      // (and its supersede guards) stay identical.
      if (backgroundListening) respondTo(text)
      if (workingTimer.current) clearTimeout(workingTimer.current)
      if (sleepTimer.current) clearTimeout(sleepTimer.current)
      // A transcript supersedes the summoned flash — don't let its fallback
      // cut `working` short.
      if (summonedTimer.current) clearTimeout(summonedTimer.current)
      workingTimer.current = setTimeout(() => setCoreState('idle'), WORKING_TIMEOUT_MS)
      sleepTimer.current = setTimeout(() => setCoreState('sleep'), SLEEP_TIMEOUT_MS)
    })
  }, [])

  const clear = useCallback((): void => setTranscripts([]), [])

  const dump = useCallback((): void => {
    // Copy-pasteable snapshot of the context contents.
    console.log('[VoiceContext] contents:\n' + JSON.stringify(transcripts, null, 2))
  }, [transcripts])

  // Mirror the context on `window` and log every update to the DevTools console.
  useEffect(() => {
    window.__voiceContext = { transcripts, dump, clear }

    if (transcripts.length > 0) {
      console.log('[VoiceContext] transcript:', transcripts[transcripts.length - 1].text)
      console.log('[VoiceContext] contents:', transcripts)
    }
  }, [transcripts, dump, clear])

  useEffect(() => {
    console.log(
      '[VoiceContext] ready — inspect with `__voiceContext.transcripts` or call `__voiceContext.dump()`'
    )
  }, [])

  const value: VoiceContextValue = {
    transcripts,
    lastTranscript: transcripts.length > 0 ? transcripts[transcripts.length - 1] : null,
    clear,
    dump
  }

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}

export function useVoice(): VoiceContextValue {
  const context = useContext(VoiceContext)
  if (!context) {
    throw new Error('useVoice must be used within a VoiceProvider')
  }
  return context
}

import { useAppStore } from './store/appStore'

/**
 * Shared Lupinus reply engine. Extracted from the Lupinus page so voice
 * transcripts can trigger the exact same working -> speaking flow while the
 * user is elsewhere in the app (background listening).
 *
 * Timers live at module scope and every sequence carries an id, so a newer
 * trigger always supersedes a stale one and nothing depends on a mounted
 * component. Each reply is short-lived and self-clearing.
 */

let seq = 0
const timers: ReturnType<typeof setTimeout>[] = []
let stream: ReturnType<typeof setInterval> | null = null

/**
 * Stand-in reply until the full agent backend lands. Honest about what it is:
 * an acknowledgement plus where things stand, so the chat still exercises
 * the working -> speaking state flow end to end.
 */
export function buildReply(text: string, noteCount: number): string {
  const collapsed = text.trim().replace(/\s+/g, ' ')
  const said = collapsed.length > 140 ? `${collapsed.slice(0, 140)}…` : collapsed
  const notes = noteCount === 1 ? '1 note' : `${noteCount} notes`
  return `Got it — "${said}". I'm on a local preview brain until the full agent backend lands, so I can't reason over this yet. Anything you say by voice lands here too, and your ${notes} are safe in the vault.`
}

function streamReply(id: string, full: string, mySeq: number, onSpeaking?: () => void): void {
  const store = useAppStore.getState()
  store.setCoreState('speaking')
  // The PiP orb lives in another window: mirror agent-side states to it.
  window.api.announceCore('speaking')
  onSpeaking?.()
  let shown = 0
  const step = Math.max(2, Math.ceil(full.length / 60))
  if (stream) clearInterval(stream)
  stream = setInterval(() => {
    shown = Math.min(full.length, shown + step)
    useAppStore.getState().updateChatMessage(id, full.slice(0, shown))
    if (shown >= full.length) {
      if (stream) clearInterval(stream)
      stream = null
      // Read the finished reply aloud (Piper TTS, Alba voice) when enabled.
      // Fire-and-forget: the pipeline queues, synthesizes and plays it.
      if (useAppStore.getState().ttsEnabled) {
        window.api.speak(full).catch((error: unknown) => {
          console.error('[tts] speak failed:', error)
        })
      }
      timers.push(
        setTimeout(() => {
          if (seq !== mySeq) return
          useAppStore.getState().setCoreState('idle')
          window.api.announceCore('idle')
        }, 1400)
      )
    }
  }, 28)
}

/**
 * Run one reply sequence for user text: thinking pause, then a streamed
 * agent message. `onSpeaking` fires when streaming starts (used by the chat
 * to swap its thinking bubble for the live reply).
 */
export function respondTo(text: string, onSpeaking?: () => void): void {
  seq += 1
  const mySeq = seq
  const store = useAppStore.getState()
  store.setCoreState('working')
  timers.push(
    setTimeout(() => {
      if (seq !== mySeq) return
      const live = useAppStore.getState()
      const id = live.addChatMessage('agent', '')
      streamReply(id, buildReply(text, live.notes.length), mySeq, onSpeaking)
    }, 1100)
  )
}

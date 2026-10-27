import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { respondTo } from '../agentBrain'
import JarvisCore from '../components/JarvisCore'
import {
  SendIcon,
  TrashIcon,
  VolumeIcon,
  VolumeMutedIcon,
  MicIcon,
  MicMutedIcon
} from '../components/icons'
import { type CoreState, useAppStore } from '../store/appStore'

const STATES: { key: CoreState; label: string; hint: string }[] = [
  { key: 'sleep', label: 'Sleep', hint: 'Dormant — not working, not spoken to' },
  { key: 'idle', label: 'Idle', hint: 'Listening — being spoken to' },
  { key: 'summoned', label: 'Summoned', hint: 'Just heard the wake word' },
  { key: 'working', label: 'Working', hint: 'On an objective' },
  { key: 'speaking', label: 'Speaking', hint: 'Talking back' }
]

function timeOfDay(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function Agent(): React.JSX.Element {
  const coreState = useAppStore((state) => state.coreState)
  const messages = useAppStore((state) => state.messages)
  const addChatMessage = useAppStore((state) => state.addChatMessage)
  const clearChat = useAppStore((state) => state.clearChat)
  const ttsEnabled = useAppStore((state) => state.ttsEnabled)
  const setTtsEnabled = useAppStore((state) => state.setTtsEnabled)
  const agentMicMuted = useAppStore((state) => state.agentMicMuted)
  const setAgentMicMuted = useAppStore((state) => state.setAgentMicMuted)

  const [draft, setDraft] = useState('')
  const [pendingReply, setPendingReply] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, pendingReply])

  // Grow the input with its content, up to a cap.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [draft])

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    addChatMessage('user', text)
    setPendingReply(true)
    // Shared engine also powers background replies; the callback swaps the
    // thinking bubble for the live reply the moment streaming starts.
    respondTo(text, () => setPendingReply(false))
  }

  return (
    <main className="agent">
      <div className="agent__stage">
        <div className="agent__core">
          <JarvisCore />
          <div className="agent__mutes" aria-label="Audio controls">
            <button
              type="button"
              className={`agent__mute-btn${agentMicMuted ? ' is-muted' : ''}`}
              title={agentMicMuted ? 'Unmute microphone' : 'Mute microphone'}
              aria-label={agentMicMuted ? 'Unmute microphone' : 'Mute microphone'}
              aria-pressed={agentMicMuted}
              onClick={() => setAgentMicMuted(!agentMicMuted)}
            >
              {agentMicMuted ? <MicMutedIcon size={20} /> : <MicIcon size={20} />}
            </button>
            <button
              type="button"
              className={`agent__mute-btn${ttsEnabled ? '' : ' is-muted'}`}
              title={ttsEnabled ? 'Mute spoken replies' : 'Unmute spoken replies'}
              aria-label={ttsEnabled ? 'Mute spoken replies' : 'Unmute spoken replies'}
              aria-pressed={!ttsEnabled}
              onClick={() => setTtsEnabled(!ttsEnabled)}
            >
              {ttsEnabled ? <VolumeIcon size={20} /> : <VolumeMutedIcon size={20} />}
            </button>
          </div>
        </div>
        <div className="agent__controls">
          {STATES.map((s) =>
            s.key === coreState ? (
              <span key={s.key} className="state-pill is-active" title={s.hint}>
                <span className="agent__thinking">{s.label}</span>
              </span>
            ) : (
              <span key={s.key} className="state-pill" title={s.hint}>
                {s.label}
              </span>
            )
          )}
        </div>
      </div>

      <section className="agent__chat" aria-label="Lupinus chat">
        <header className="chat__header">
          <span className="chat__title">Lupinus</span>
          <span className="chat__tag">Local preview</span>
          <span className="chat__state">
            <span className={`chat__dot chat__dot--${coreState}`} />
            {coreState}
          </span>
          <button
            type="button"
            className={`chat__clear chat__mute${agentMicMuted ? ' is-muted' : ''}`}
            title={agentMicMuted ? 'Unmute microphone' : 'Mute microphone'}
            aria-label={agentMicMuted ? 'Unmute microphone' : 'Mute microphone'}
            aria-pressed={agentMicMuted}
            onClick={() => setAgentMicMuted(!agentMicMuted)}
          >
            {agentMicMuted ? <MicMutedIcon size={14} /> : <MicIcon size={14} />}
          </button>
          <button
            type="button"
            className={`chat__clear chat__mute${ttsEnabled ? '' : ' is-muted'}`}
            title={ttsEnabled ? 'Mute spoken replies' : 'Unmute spoken replies'}
            aria-label={ttsEnabled ? 'Mute spoken replies' : 'Unmute spoken replies'}
            aria-pressed={!ttsEnabled}
            onClick={() => setTtsEnabled(!ttsEnabled)}
          >
            {ttsEnabled ? <VolumeIcon size={14} /> : <VolumeMutedIcon size={14} />}
          </button>
          <button
            type="button"
            className="chat__clear"
            title="Clear chat"
            aria-label="Clear chat"
            onClick={() => clearChat()}
          >
            <TrashIcon size={14} />
          </button>
        </header>

        <div className="chat__messages" ref={listRef}>
          {messages.length === 0 && !pendingReply ? (
            <div className="msg msg--agent">
              <div className="msg__bubble">
                Hey — I&apos;m Lupinus. Type below, or just speak and your words will land here.
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <div key={message.id} className={`msg msg--${message.role}`}>
                <div className="msg__bubble">{message.text || '…'}</div>
                <span className="msg__time">{timeOfDay(message.timestamp)}</span>
              </div>
            ))
          )}
          {pendingReply && (
            <div className="msg msg--agent">
              <div className="msg__bubble">
                <span className="agent__thinking">core thinking</span>
              </div>
            </div>
          )}
        </div>

        <div className="chat__inputbar">
          <textarea
            ref={inputRef}
            className="chat__input"
            rows={1}
            value={draft}
            placeholder="Message Lupinus…"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            }}
          />
          <button
            type="button"
            className="chat__send"
            title="Send"
            aria-label="Send"
            disabled={!draft.trim()}
            onClick={send}
          >
            <SendIcon size={16} />
          </button>
        </div>
      </section>
    </main>
  )
}

export default Agent

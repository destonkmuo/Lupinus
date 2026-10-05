import { useEffect } from 'react'
import { useAppStore } from '../store/appStore'
import { XIcon } from './icons'

/**
 * Floating SeeMO reply card, pinned to the bottom-right of the screen.
 * Appears when a fresh response arrives while the user is anywhere but the
 * SeeMO page — including prompts sent from Spotlight, which deliberately do
 * not navigate away. Dismissing or opening the SeeMO page marks it seen so it
 * never nags about old messages.
 */
function AgentBubble(): React.JSX.Element | null {
  const messages = useAppStore((state) => state.messages)
  const lastSeenAgentId = useAppStore((state) => state.lastSeenAgentId)
  const activeNav = useAppStore((state) => state.activeNav)
  const openNav = useAppStore((state) => state.openNav)
  const markAgentSeen = useAppStore((state) => state.markAgentSeen)

  const onAgentTab = activeNav === 'agent'

  useEffect(() => {
    if (onAgentTab) markAgentSeen()
  }, [onAgentTab, markAgentSeen])

  let latest: { id: string; text: string } | null = null
  for (const message of messages) {
    if (message.role === 'agent') latest = message
  }

  if (onAgentTab) return null
  if (!latest || latest.id === lastSeenAgentId) return null

  return (
    <aside className="agent-bubble" aria-live="polite" aria-label="Agent response">
      <div className="agent-bubble__head">
        <span className="agent-bubble__title">SeeMO</span>
        <button
          type="button"
          className="chat__clear"
          title="Dismiss"
          aria-label="Dismiss"
          onClick={() => markAgentSeen()}
        >
          <XIcon size={13} />
        </button>
      </div>
      <p className="agent-bubble__text">{latest.text || '…'}</p>
      <button
        type="button"
        className="btn btn--ghost agent-bubble__go"
        onClick={() => {
          markAgentSeen()
          openNav('agent')
        }}
      >
        Open SeeMO
      </button>
    </aside>
  )
}

export default AgentBubble

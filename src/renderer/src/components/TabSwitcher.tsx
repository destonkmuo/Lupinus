import { useCallback, useEffect, useMemo, useState } from 'react'
import { isInlineNav } from '../nav'
import { useAppStore } from '../store/appStore'
import { FileTextIcon } from './icons'

function snippetFor(content: string): string {
  const clean = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*`>_~[\]()|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.slice(0, 120) || 'Empty note'
}

/**
 * Ctrl+Tab switcher for open note tabs, most-recent-first.
 *
 * Sidebar pages (Home, Tasks, Calendar, …) are views, not tabs, so they
 * never appear here — this only cycles notes.
 *
 * Rows follow tab recency (the tab you just left sits on top), so a quick
 * Ctrl+Tab tap toggles between your last two tabs. Holding Control and
 * tapping Tab cycles the selection (Shift reverses); releasing Control opens
 * the selected tab. Esc cancels, arrows/Enter work while open, and clicking
 * a row jumps straight to it. Each row shows a content preview so tabs are
 * recognizable beyond their titles.
 */
function TabSwitcher(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(0)

  const tabs = useAppStore((state) => state.tabs)
  const tabRecency = useAppStore((state) => state.tabRecency)
  const activeTabId = useAppStore((state) => state.activeTabId)
  const activeNav = useAppStore((state) => state.activeNav)
  const notes = useAppStore((state) => state.notes)

  // Most-recent-first tab order; anything the recency list never saw (e.g. a
  // tab created before this feature) trails at the end in bar order.
  const ordered = useMemo(() => {
    const live = new Set(tabs.map((t) => t.id))
    const seen = new Set<string>()
    const mru = tabRecency.filter((id) => {
      if (!live.has(id) || seen.has(id)) return false
      seen.add(id)
      return true
    })
    for (const tab of tabs) {
      if (!seen.has(tab.id)) {
        seen.add(tab.id)
        mru.push(tab.id)
      }
    }
    return mru.map((id) => tabs.find((t) => t.id === id)).filter((t) => t !== undefined)
  }, [tabs, tabRecency])

  // Clamp without an effect: if tabs closed under the switcher, the
  // highlight falls back to the first row instead of pointing past the end.
  const safeSelected = ordered.length === 0 ? 0 : selected % ordered.length

  const cycle = useCallback((delta: number): void => {
    const { tabs: live, tabRecency: liveRecency } = useAppStore.getState()
    if (live.length === 0) return
    const liveIds = new Set(live.map((t) => t.id))
    const count =
      liveRecency.filter((id) => liveIds.has(id)).length +
      live.filter((t) => !liveRecency.includes(t.id)).length
    if (count === 0) return
    setOpen((wasOpen) => {
      if (!wasOpen) {
        // First tap lands on the previous tab (classic switcher toggle).
        setSelected(delta > 0 ? 1 % count : count - 1)
        return true
      }
      setSelected((prev) => (prev + delta + count) % count)
      return true
    })
  }, [])

  const commit = useCallback((index: number): void => {
    const { tabs: live, tabRecency: liveRecency, setActiveTab } = useAppStore.getState()
    const liveIds = new Set(live.map((t) => t.id))
    const seen = new Set<string>()
    const mru = liveRecency.filter((id) => {
      if (!liveIds.has(id) || seen.has(id)) return false
      seen.add(id)
      return true
    })
    for (const tab of live) {
      if (!seen.has(tab.id)) {
        seen.add(tab.id)
        mru.push(tab.id)
      }
    }
    const id = mru[index]
    setOpen(false)
    if (id) setActiveTab(id)
  }, [])

  const cancel = useCallback((): void => setOpen(false), [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // The switcher owns Ctrl+Tab only; plain Tab stays in the editor.
      if (event.key !== 'Tab' || !event.ctrlKey || event.metaKey || event.altKey) return
      event.preventDefault()
      cycle(event.shiftKey ? -1 : 1)
      return
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      // Classic switcher commit: releasing Control opens the selection.
      if (event.key === 'Control' && open) {
        commit(safeSelected)
      }
      if (event.key === 'Escape' && open) cancel()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [open, safeSelected, cycle, commit, cancel])

  // Arrow-key navigation + Enter while the switcher is open.
  useEffect(() => {
    if (!open) return
    const onNav = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault()
        setSelected((prev) => (prev + 1) % Math.max(ordered.length, 1))
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault()
        setSelected((prev) => (prev - 1 + ordered.length) % Math.max(ordered.length, 1))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        commit(safeSelected)
      }
    }
    window.addEventListener('keydown', onNav)
    return () => window.removeEventListener('keydown', onNav)
  }, [open, safeSelected, ordered.length, commit])

  if (!open || ordered.length === 0) return null

  return (
    <div
      className="switcher__backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel()
      }}
    >
      <div className="switcher" role="dialog" aria-modal="true" aria-label="Switch note tabs">
        <div className="switcher__head">
          <span className="switcher__title">Switch notes · recent first</span>
          <kbd className="sidebar__kbd">ctrl + tab</kbd>
        </div>
        <ul className="switcher__list">
          {ordered.map((tab, index) => {
            const note = notes.find((n) => n.id === tab.noteId)
            const label = note?.title.trim() || 'Untitled'
            const emoji = note?.emoji?.trim() ?? ''
            const preview = snippetFor(note?.content ?? '')
            const isActive =
              (activeNav === null || !isInlineNav(activeNav)) && tab.id === activeTabId
            return (
              <li key={tab.id}>
                <button
                  type="button"
                  className={`switcher__row${index === safeSelected ? ' is-selected' : ''}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => commit(index)}
                >
                  {emoji ? (
                    <span className="note-emoji" aria-hidden="true">
                      {emoji}
                    </span>
                  ) : (
                    <FileTextIcon size={16} />
                  )}
                  <span className="switcher__text">
                    <span className="switcher__label">
                      {label}
                      {isActive ? ' · current' : ''}
                    </span>
                    <span className="switcher__preview">{preview}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <p className="switcher__hint">
          Hold Ctrl and tap Tab to cycle · release to open · Esc to cancel
        </p>
      </div>
    </div>
  )
}

export default TabSwitcher

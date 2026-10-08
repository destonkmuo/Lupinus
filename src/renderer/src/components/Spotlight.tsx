import { useCallback, useEffect, useMemo, useState } from 'react'
import { respondTo } from '../agentBrain'
import { NAV_BY_KEY, NAV_ITEMS } from '../nav'
import { useAppStore } from '../store/appStore'
import { AgentIcon, CommandIcon, FileTextIcon, SearchIcon, TaskIcon } from './icons'

/**
 * A query this long with zero matches is almost certainly a question for
 * SeeMO rather than a search, so the assistant is offered automatically.
 */
const LONG_QUERY_CHARS = 12

/** Plain-text single-line preview: strip markdown furniture, collapse space. */
function plainPreview(line: string, max = 120): string {
  const clean = line
    .replace(/```/g, '')
    .replace(/[#*`>_~[\]()|=-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Case-insensitive query highlight for a text-only snippet. Wrapped in a
 * single span: callers render inside flex rows, and a bare fragment would
 * turn every text part + mark into its own flex item with gaps between them.
 */
function Highlight({ text, query }: { text: string; query: string }): React.JSX.Element {
  if (!query) return <span className="spotlight__hit">{text}</span>
  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, 'gi'))
  return (
    <span className="spotlight__hit">
      {parts.map((part, index) =>
        part.toLowerCase() === query.toLowerCase() ? <mark key={index}>{part}</mark> : part
      )}
    </span>
  )
}

type Result =
  | { kind: 'note'; id: string; title: string; lines: string[] }
  | { kind: 'task'; id: string; title: string; lines: string[] }
  | { kind: 'nav'; id: string; title: string; lines: string[] }
  | { kind: 'command'; id: string; title: string; lines: string[] }
  /** A prompt to send to SeeMO instead of a search hit. */
  | { kind: 'prompt'; id: string; title: string; lines: string[] }

interface Command {
  id: string
  title: string
  hint: string
  keywords: string
  run: () => void
}

function appCommands(): Command[] {
  const api = (): ReturnType<typeof useAppStore.getState> => useAppStore.getState()
  return [
    {
      id: 'new-note',
      title: 'New note',
      hint: 'Create and open a note',
      keywords: 'new note page create',
      run: () => void api().createNote()
    },
    {
      id: 'new-space',
      title: 'New space',
      hint: 'Create a note space',
      keywords: 'new space workspace emoji',
      run: () => {
        const name = window.prompt('Name this space')
        if (name === null || !name.trim()) return
        const emoji = window.prompt('Choose an emoji for this space (empty for dot)', '')
        if (emoji === null) return
        api().createSpace(name, emoji)
      }
    },
    {
      id: 'new-section',
      title: 'New section',
      hint: 'Add a sidebar divider',
      keywords: 'new section divider group',
      run: () => void api().createSection()
    },
    {
      id: 'clear-tabs',
      title: 'Clear all tabs',
      hint: 'Close ungrouped tabs (groups kept)',
      keywords: 'clear close all tabs reset',
      run: () => api().closeAllTabs()
    },
    {
      id: 'clear-groups',
      title: 'Clear all groups',
      hint: 'Close every tab in a group',
      keywords: 'clear close groups grouped tabs reset',
      run: () => api().closeAllGroups()
    },
    {
      id: 'empty-trash',
      title: 'Empty trash',
      hint: 'Destroy trashed notes forever',
      keywords: 'empty trash delete forever clear',
      run: () => api().emptyTrash()
    },
    {
      id: 'open-calendar',
      title: 'Open calendar',
      hint: 'Go to the calendar',
      keywords: 'open calendar schedule events',
      run: () => api().openNav('calendar')
    },
    {
      id: 'open-tasks',
      title: 'Open tasks',
      hint: 'Go to the task list',
      keywords: 'open tasks todo list',
      run: () => api().openNav('tasks')
    },
    {
      id: 'open-settings',
      title: 'Open settings',
      hint: 'Vault, sync, and app settings',
      keywords: 'open settings preferences config',
      run: () => api().openNav('settings')
    }
  ]
}

/**
 * Ctrl+T command search: a centered overlay over everything, searching note
 * titles + contents, tasks, and pages. Content previews are plain text only
 * (no markdown, no images). Enter opens the selection in the current tab,
 * arrows move, Esc closes, click jumps straight there.
 */
function Spotlight(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  const notes = useAppStore((state) => state.notes)
  const tasks = useAppStore((state) => state.tasks)

  useEffect(() => {
    // Ctrl+T (either logical modifier). An OS-level Ctrl/Cmd swap is
    // invisible to apps — only remapped modifiers arrive — so requiring
    // exactly one of them breaks swapped keyboards. Nothing besides T
    // opens Spotlight.
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        setQuery('')
        setSelected(0)
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const results = useMemo((): Result[] => {
    const live = notes.filter((n) => !n.deletedAt)
    const raw = query.trim()
    // `@` turns the box into a direct prompt to SeeMO (search is bypassed).
    if (raw.startsWith('@')) {
      const prompt = raw.slice(1).trim()
      return prompt ? [{ kind: 'prompt', id: 'ask', title: prompt, lines: ['Ask SeeMO'] }] : []
    }
    const needle = raw.toLowerCase()
    if (!needle) {
      // Idle state: recent notes plus every page.
      const recent = live
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5)
        .map((n): Result => ({
          kind: 'note',
          id: n.id,
          title: n.title.trim() || 'Untitled',
          lines: n.content.trim()
            ? [plainPreview(n.content.split('\n').find((l) => l.trim()) ?? '')]
            : []
        }))
      return [
        ...recent,
        ...NAV_ITEMS.map((item): Result => ({
          kind: 'nav',
          id: item.key,
          title: item.label,
          lines: []
        }))
      ]
    }
    const out: Result[] = []
    for (const note of live) {
      const titleHit = note.title.toLowerCase().includes(needle)
      const hits = note.content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && line.toLowerCase().includes(needle))
        .slice(0, 2)
      if (titleHit || hits.length > 0) {
        out.push({
          kind: 'note',
          id: note.id,
          title: note.title.trim() || 'Untitled',
          lines: hits.map((line) => plainPreview(line))
        })
      }
    }
    for (const task of tasks) {
      if (
        task.status !== 'completed' &&
        (task.title.toLowerCase().includes(needle) || task.notes.toLowerCase().includes(needle))
      ) {
        const lines = task.notes
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && line.toLowerCase().includes(needle))
          .slice(0, 2)
          .map((line) => plainPreview(line))
        out.push({
          kind: 'task',
          id: task.id,
          title: task.title.trim() || 'Untitled',
          lines: task.due
            ? [`Due ${task.due}${task.time ? ` · ${task.time}` : ''}`, ...lines]
            : lines
        })
      }
    }
    for (const item of NAV_ITEMS) {
      if (item.label.toLowerCase().includes(needle)) {
        out.push({ kind: 'nav', id: item.key, title: item.label, lines: [] })
      }
    }
    for (const command of appCommands()) {
      if (command.title.toLowerCase().includes(needle) || command.keywords.includes(needle)) {
        out.push({ kind: 'command', id: command.id, title: command.title, lines: [command.hint] })
      }
    }
    // Nothing matched a long query: offer the assistant as the default action.
    if (out.length === 0 && raw.length >= LONG_QUERY_CHARS) {
      out.push({ kind: 'prompt', id: 'ask', title: raw, lines: ['Ask SeeMO'] })
    }
    return out.slice(0, 30)
  }, [notes, tasks, query])

  // Keep the highlight on a live row as the result set changes.
  const safeSelected = results.length === 0 ? 0 : selected % results.length

  const activate = useCallback((result: Result | undefined): void => {
    if (!result) return
    const state = useAppStore.getState()
    setOpen(false)
    if (result.kind === 'prompt') {
      // Same reply engine as the SeeMO page, but stay where the user is:
      // the turn is logged and the answer surfaces in the floating bubble.
      state.addChatMessage('user', result.title)
      respondTo(result.title)
    } else if (result.kind === 'note') state.openNoteInCurrentTab(result.id)
    else if (result.kind === 'task') state.openNav('tasks')
    else if (result.kind === 'command') {
      appCommands()
        .find((command) => command.id === result.id)
        ?.run()
    } else state.openNav(result.id as Parameters<typeof state.openNav>[0])
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelected((prev) => (prev + 1) % Math.max(results.length, 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelected((prev) => (prev - 1 + results.length) % Math.max(results.length, 1))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        activate(results[safeSelected])
      } else if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, results, safeSelected, activate])

  if (!open) return null

  return (
    <div
      className="spotlight__backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }}
    >
      <div className="spotlight" role="dialog" aria-modal="true" aria-label="Search">
        <div className="spotlight__bar">
          <SearchIcon size={17} />
          <input
            className="spotlight__input"
            autoFocus
            value={query}
            placeholder="Search, or ask SeeMO with @…"
            aria-label="Search notes, tasks, pages, or ask SeeMO"
            onChange={(event) => {
              setQuery(event.target.value)
              setSelected(0)
            }}
            onKeyDown={(event) => {
              // Let the global handler own arrows/Enter/Esc; typing stays here.
              if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
                event.preventDefault()
              }
            }}
          />
          <kbd className="sidebar__kbd">^T</kbd>
        </div>
        <ul className="spotlight__list">
          {results.length === 0 && (
            <li className="spotlight__empty">
              {query.trim().startsWith('@') ? 'Type a question after @…' : 'No matches.'}
            </li>
          )}
          {results.map((result, index) => {
            const Icon =
              result.kind === 'prompt'
                ? AgentIcon
                : result.kind === 'note'
                  ? FileTextIcon
                  : result.kind === 'task'
                    ? TaskIcon
                    : result.kind === 'command'
                      ? CommandIcon
                      : (NAV_BY_KEY[result.id]?.icon ?? FileTextIcon)
            return (
              <li key={`${result.kind}-${result.id}`}>
                <button
                  type="button"
                  className={`spotlight__row${index === safeSelected ? ' is-selected' : ''}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => activate(result)}
                >
                  <Icon size={16} />
                  <span className="spotlight__text">
                    <span className="spotlight__label">
                      <Highlight
                        text={result.title}
                        query={result.kind === 'prompt' ? '' : query.trim()}
                      />
                      <span className="spotlight__kind">
                        {result.kind === 'prompt' ? 'SeeMO' : result.kind}
                      </span>
                    </span>
                    {result.lines.map((line, lineIndex) => (
                      <span key={lineIndex} className="spotlight__snippet">
                        <Highlight text={line} query={query.trim()} />
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <p className="spotlight__hint">
          Enter runs · @ asks SeeMO · long queries ask automatically · Esc closes
        </p>
      </div>
    </div>
  )
}

export default Spotlight

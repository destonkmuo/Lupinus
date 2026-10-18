import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { isInlineNav } from '../nav'
import { TAB_GROUP_COLORS, useAppStore, type Tab } from '../store/appStore'
import { FileTextIcon, ChevronLeftIcon, ChevronRightIcon, SidebarToggleIcon, XIcon } from './icons'

interface DropHint {
  id: string
  before: boolean
}

type MenuState =
  | { kind: 'tab'; tabId: string; x: number; y: number }
  | { kind: 'group'; groupId: string; x: number; y: number }
  | null

function clampMenu(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - 200)),
    y: Math.max(8, Math.min(y, window.innerHeight - 300))
  }
}

/** macOS floats the traffic lights over the top-left of the window. */
const IS_MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

function TabBar(): React.JSX.Element {
  const tabs = useAppStore((state) => state.tabs)
  const activeTabId = useAppStore((state) => state.activeTabId)
  const activeNav = useAppStore((state) => state.activeNav)
  // Home/SeeMO take over the content area, so no tab reads active under
  // them; floating windows leave the note underneath lit.
  const noteVisible = activeNav === null || !isInlineNav(activeNav)
  const notes = useAppStore((state) => state.notes)
  const tabHistory = useAppStore((state) => state.tabHistory)
  const historyIndex = useAppStore((state) => state.historyIndex)
  const tabGroups = useAppStore((state) => state.tabGroups)
  const tabGroup = useAppStore((state) => state.tabGroup)
  const collapsedTabGroups = useAppStore((state) => state.collapsedTabGroups)
  const setActiveTab = useAppStore((state) => state.setActiveTab)
  const goBackTab = useAppStore((state) => state.goBackTab)
  const goForwardTab = useAppStore((state) => state.goForwardTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const moveTab = useAppStore((state) => state.moveTab)
  const moveTabGroup = useAppStore((state) => state.moveTabGroup)
  const setSplitTab = useAppStore((state) => state.setSplitTab)
  const createTabGroup = useAppStore((state) => state.createTabGroup)
  const renameTabGroup = useAppStore((state) => state.renameTabGroup)
  const setTabGroupColor = useAppStore((state) => state.setTabGroupColor)
  const deleteTabGroup = useAppStore((state) => state.deleteTabGroup)
  const assignTabToGroup = useAppStore((state) => state.assignTabToGroup)
  const toggleTabGroupCollapsed = useAppStore((state) => state.toggleTabGroupCollapsed)
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null)
  const [groupDropHint, setGroupDropHint] = useState<DropHint | null>(null)
  const [tabGroupHint, setTabGroupHint] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState>(null)
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const dragIdRef = useRef<string | null>(null)
  const dragGroupRef = useRef<string | null>(null)

  // Browser-style history: Back revisits the previously active tab,
  // Forward redoes it. New visits truncate the forward trail.
  const canGoBack = historyIndex > 0
  const canGoForward = historyIndex >= 0 && historyIndex < tabHistory.length - 1

  // Esc closes the context menu.
  useEffect(() => {
    if (!menu) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  const groupIds = new Set(tabGroups.map((g) => g.id))
  const groupOf = (tabId: string): string | null => {
    const id = tabGroup[tabId]
    return id !== undefined && groupIds.has(id) ? id : null
  }

  const clearDrag = (): void => {
    dragIdRef.current = null
    dragGroupRef.current = null
    setDraggingId(null)
    setDropHint(null)
    setDraggingGroupId(null)
    setGroupDropHint(null)
    setTabGroupHint(null)
  }

  // Which side of the hovered tab the dragged tab would land on.
  const positionFromEvent = (event: React.DragEvent<HTMLDivElement>): boolean => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientX - rect.left < rect.width / 2
  }

  const onTabDrop = (event: React.DragEvent<HTMLDivElement>, tabId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    const dragId = dragIdRef.current
    clearDrag()
    if (dragId && dragId !== tabId) {
      moveTab(dragId, tabId, positionFromEvent(event))
      const targetGroup = groupOf(tabId)
      if (groupOf(dragId) !== targetGroup) assignTabToGroup(dragId, targetGroup)
    }
  }

  const onListDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    // Only fires for empty bar space; tab/group drops stop propagation above.
    event.preventDefault()
    const dragId = dragIdRef.current
    const dragGroupId = dragGroupRef.current
    clearDrag()
    if (dragGroupId) moveTabGroup(dragGroupId, null, false)
    else if (dragId) moveTab(dragId, null, false)
  }

  const onGroupDrop = (event: React.DragEvent<HTMLDivElement>, groupId: string): void => {
    // Group-header drags reorder groups; tab drags join the group.
    // (Tab drops on inner tabs never reach here — they stop propagation.)
    if (dragGroupRef.current) {
      event.preventDefault()
      event.stopPropagation()
      const dragGroup = dragGroupRef.current
      clearDrag()
      if (dragGroup && dragGroup !== groupId) {
        moveTabGroup(dragGroup, groupId, positionFromEvent(event))
      }
      return
    }
    const dragId = dragIdRef.current
    if (!dragId || groupOf(dragId) === groupId) return
    event.preventDefault()
    event.stopPropagation()
    clearDrag()
    assignTabToGroup(dragId, groupId)
    // Pin after the group's last tab so the bar stays contiguous.
    const state = useAppStore.getState()
    const lastInGroup = [...state.tabs].reverse().find((t) => state.tabGroup[t.id] === groupId)
    if (lastInGroup && lastInGroup.id !== dragId) moveTab(dragId, lastInGroup.id, false)
  }

  const startGroupRename = (id: string, name: string): void => {
    setMenu(null)
    setRenamingGroupId(id)
    setRenameDraft(name)
  }

  const commitGroupRename = (): void => {
    if (renamingGroupId) renameTabGroup(renamingGroupId, renameDraft)
    setRenamingGroupId(null)
  }

  const closeGroupTabs = (groupId: string): void => {
    const state = useAppStore.getState()
    for (const tab of state.tabs) {
      if (state.tabGroup[tab.id] === groupId) state.closeTab(tab.id)
    }
  }

  const renderTab = (tab: Tab): React.JSX.Element => {
    // Sidebar pages never take tabs; floating windows leave the note lit.
    const isActive = noteVisible && tab.id === activeTabId
    const note = notes.find((n) => n.id === tab.noteId)
    const label = note?.title.trim() || 'Untitled'
    const emoji = note?.emoji?.trim() ?? ''
    const hint = dropHint?.id === tab.id ? dropHint : null

    return (
      <div
        key={tab.id}
        draggable
        onDragStart={(event) => {
          dragIdRef.current = tab.id
          setDraggingId(tab.id)
          event.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={clearDrag}
        onDragOver={(event) => {
          // Group-header drags are handled by the group container;
          // don't swallow them here so the group can be the drop target.
          if (dragGroupRef.current) return
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
          if (dragIdRef.current && dragIdRef.current !== tab.id) {
            setDropHint({ id: tab.id, before: positionFromEvent(event) })
          }
        }}
        onDrop={(event) => {
          if (dragGroupRef.current) return
          onTabDrop(event, tab.id)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu({ kind: 'tab', tabId: tab.id, ...clampMenu(event.clientX, event.clientY) })
        }}
        className={`tab tab--note${isActive ? ' is-active' : ''}${draggingId === tab.id ? ' tab--dragging' : ''}${hint ? (hint.before ? ' tab--drop-before' : ' tab--drop-after') : ''}`}
      >
        <button
          type="button"
          role="tab"
          aria-selected={isActive}
          className="tab__main"
          title={label}
          onClick={() => setActiveTab(tab.id)}
        >
          {emoji ? (
            <span className="note-emoji" aria-hidden="true">
              {emoji}
            </span>
          ) : (
            <FileTextIcon size={14} />
          )}
          <span className="tab__label">{label}</span>
        </button>
        <button
          type="button"
          className="tab__close"
          aria-label={`Close ${label}`}
          title={`Close ${label}`}
          onClick={() => closeTab(tab.id)}
        >
          <XIcon size={13} />
        </button>
      </div>
    )
  }

  const ungrouped = tabs.filter((t) => !groupOf(t.id))
  const menuTab = menu?.kind === 'tab' ? tabs.find((t) => t.id === menu.tabId) : null
  const menuGroup = menu?.kind === 'group' ? tabGroups.find((g) => g.id === menu.groupId) : null
  const menuTabGroup = menuTab ? groupOf(menuTab.id) : null

  return (
    <div
      className={`tabbar${sidebarCollapsed && IS_MAC ? ' tabbar--clear-lights' : ''}`}
      role="tablist"
      aria-label="Open note tabs"
    >
      {sidebarCollapsed && (
        <button
          type="button"
          className="tabbar__new tabbar__sidebtn"
          title="Show sidebar (Ctrl+S)"
          aria-label="Show sidebar"
          onClick={toggleSidebar}
        >
          <SidebarToggleIcon size={17} />
        </button>
      )}
      <div className="tabbar__nav" role="group" aria-label="Switch tabs">
        <button
          type="button"
          className="tabbar__new"
          title="Back to the previous tab"
          aria-label="Back to the previous tab"
          disabled={!canGoBack}
          onClick={() => goBackTab()}
        >
          <ChevronLeftIcon size={15} />
        </button>
        <button
          type="button"
          className="tabbar__new"
          title="Forward to the next tab"
          aria-label="Forward to the next tab"
          disabled={!canGoForward}
          onClick={() => goForwardTab()}
        >
          <ChevronRightIcon size={15} />
        </button>
      </div>
      <div
        className={`tabbar__list${tabs.length > 2 ? ' is-divided' : ''}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onListDrop}
      >
        {tabs.length === 0 && tabGroups.length === 0 && (
          <span className="tabbar__empty" title="Open a note from the sidebar">
            No note tabs
          </span>
        )}
        {ungrouped.map((tab) => renderTab(tab))}
        {tabGroups.map((group) => {
          const groupTabs = tabs.filter((t) => groupOf(t.id) === group.id)
          // The visible tab's group never renders collapsed.
          const collapsed =
            collapsedTabGroups.includes(group.id) &&
            !(noteVisible && groupTabs.some((t) => t.id === activeTabId))
          const renaming = renamingGroupId === group.id
          const groupHint = groupDropHint?.id === group.id ? groupDropHint : null
          const displayName = group.name.trim()
          return (
            <div
              key={group.id}
              className={`tabgroup${draggingGroupId === group.id ? ' tabgroup--dragging' : ''}${groupHint ? (groupHint.before ? ' tabgroup--drop-before' : ' tabgroup--drop-after') : ''}${tabGroupHint === group.id ? ' tabgroup--drop-target' : ''}`}
              style={{ '--group-color': group.color } as CSSProperties}
              onDragOver={(event) => {
                if (dragGroupRef.current && dragGroupRef.current !== group.id) {
                  // Group-header drags reorder groups.
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setGroupDropHint({ id: group.id, before: positionFromEvent(event) })
                  return
                }
                // Tab drags over the header/padding join the group
                // (drops on inner tabs stop propagation above).
                const dragId = dragIdRef.current
                if (dragId && groupOf(dragId) !== group.id) {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setTabGroupHint((prev) => (prev === group.id ? prev : group.id))
                }
              }}
              onDragLeave={() => setTabGroupHint((prev) => (prev === group.id ? null : prev))}
              onDrop={(event) => onGroupDrop(event, group.id)}
            >
              <button
                type="button"
                className="tabgroup__head"
                draggable={!renaming}
                title={`${displayName ? `${displayName} · ` : ''}click to ${collapsed ? 'expand' : 'collapse'} · double-click to rename · drag to move · drop tabs here`}
                aria-expanded={!collapsed}
                onClick={() => toggleTabGroupCollapsed(group.id)}
                onDoubleClick={() => startGroupRename(group.id, group.name)}
                onDragStart={(event) => {
                  event.stopPropagation()
                  dragGroupRef.current = group.id
                  setDraggingGroupId(group.id)
                  event.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={clearDrag}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setMenu({
                    kind: 'group',
                    groupId: group.id,
                    ...clampMenu(event.clientX, event.clientY)
                  })
                }}
              >
                <span className="tabgroup__dot" title={displayName || undefined} />
                {renaming ? (
                  <input
                    className="tabgroup__input"
                    autoFocus
                    value={renameDraft}
                    aria-label="Group name"
                    placeholder="New group"
                    onClick={(event) => event.stopPropagation()}
                    onDragStart={(event) => event.stopPropagation()}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitGroupRename()
                      if (event.key === 'Escape') setRenamingGroupId(null)
                    }}
                    onBlur={commitGroupRename}
                  />
                ) : (
                  <>
                    {displayName && (
                      <>
                        <span className="tabgroup__name">{group.name}</span>
                        <span className="tabgroup__count">{groupTabs.length}</span>
                      </>
                    )}
                  </>
                )}
              </button>
              {!collapsed && groupTabs.map((tab) => renderTab(tab))}
            </div>
          )
        })}
      </div>

      {menu && (
        <div
          className="note-menu__backdrop"
          aria-hidden="true"
          onClick={() => setMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenu(null)
          }}
        />
      )}
      {menu && menuTab && (
        <div
          className="note-menu tabmenu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className="note-menu__item"
            onClick={() => {
              const id = createTabGroup(undefined, undefined, [menuTab.id])
              const created = useAppStore.getState().tabGroups.find((g) => g.id === id)
              setMenu(null)
              if (created) startGroupRename(created.id, created.name)
            }}
          >
            New group
          </button>
          {tabGroups.length > 0 && <p className="tabmenu__label">Add to group</p>}
          {tabGroups.map((group) => (
            <button
              key={group.id}
              type="button"
              className="note-menu__item"
              aria-label={
                group.name.trim() ? `Add to ${group.name.trim()}` : 'Add to unnamed group'
              }
              onClick={() => {
                assignTabToGroup(menuTab.id, group.id)
                setMenu(null)
              }}
            >
              <span className="tabmenu__dot" style={{ background: group.color }} />
              {group.name.trim()}
            </button>
          ))}
          {menuTabGroup && (
            <button
              type="button"
              className="note-menu__item"
              onClick={() => {
                assignTabToGroup(menuTab.id, null)
                setMenu(null)
              }}
            >
              Remove from group
            </button>
          )}
          <button
            type="button"
            className="note-menu__item"
            disabled={menuTab.id === activeTabId}
            title={
              menuTab.id === activeTabId
                ? 'The active tab cannot split with itself'
                : 'Show this tab beside the active one'
            }
            onClick={() => {
              setSplitTab(menuTab.id)
              setMenu(null)
            }}
          >
            Open in split view
          </button>
          <button
            type="button"
            className="note-menu__item note-menu__item--danger"
            onClick={() => {
              setMenu(null)
              closeTab(menuTab.id)
            }}
          >
            Close tab
          </button>
        </div>
      )}
      {menu && menuGroup && (
        <div
          className="note-menu tabmenu"
          role="menu"
          aria-label={`${menuGroup.name.trim() || 'Unnamed'} group`}
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className="note-menu__item"
            onClick={() => startGroupRename(menuGroup.id, menuGroup.name)}
          >
            Rename group
          </button>
          <div className="tabmenu__swatches" role="group" aria-label="Group color">
            {TAB_GROUP_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`tabmenu__swatch${menuGroup.color === color ? ' is-active' : ''}`}
                style={{ background: color }}
                aria-label={`Color ${color}`}
                title={color}
                onClick={() => setTabGroupColor(menuGroup.id, color)}
              />
            ))}
          </div>
          <button
            type="button"
            className="note-menu__item"
            onClick={() => {
              setMenu(null)
              deleteTabGroup(menuGroup.id)
            }}
          >
            Ungroup (keep tabs)
          </button>
          <button
            type="button"
            className="note-menu__item note-menu__item--danger"
            onClick={() => {
              setMenu(null)
              closeGroupTabs(menuGroup.id)
            }}
          >
            Close group&apos;s tabs
          </button>
        </div>
      )}
    </div>
  )
}

export default TabBar

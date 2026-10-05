import { useEffect, useMemo, useRef, useState } from 'react'
import { NAV_ITEMS, type NavItem } from '../nav'
import { useAppStore, type NavKey } from '../store/appStore'
import { LogOutIcon, MicIcon, MicMutedIcon, SettingsIcon, SwitchUserIcon, UserIcon } from './icons'

/** Rail destinations, in display order (matches the icon strip). */
const RAIL_ORDER: NavKey[] = ['home', 'graph', 'tasks', 'calendar', 'email', 'agent', 'misc']

/**
 * Slim icon rail pinned to the left edge. It stays tucked off-screen until the
 * pointer reaches the very edge of the window, then glides in as a rounded
 * pill. Holds the primary destinations (icon-only), the core status dot, the
 * Always-listening mic toggle, and the profile menu.
 */
function Rail(): React.JSX.Element {
  const railItems = useMemo(
    () =>
      RAIL_ORDER.map((key) => NAV_ITEMS.find((item) => item.key === key)).filter(
        (item): item is NavItem => item !== undefined
      ),
    []
  )

  const activeNav = useAppStore((state) => state.activeNav)
  const backgroundListening = useAppStore((state) => state.backgroundListening)
  const setBackgroundListening = useAppStore((state) => state.setBackgroundListening)
  const vaultPath = useAppStore((state) => state.vaultPath)
  const openNav = useAppStore((state) => state.openNav)
  const chooseVault = useAppStore((state) => state.chooseVault)
  const requestLock = useAppStore((state) => state.requestLock)

  const [hovered, setHovered] = useState(false)
  const [menu, setMenu] = useState<'profile' | null>(null)
  const [user, setUser] = useState<string | null>(null)
  const [passwordSet, setPasswordSet] = useState(false)
  const railRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)

  const expanded = hovered || menu !== null

  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  const holdOpen = (): void => {
    cancelClose()
    setHovered(true)
  }

  // Grace period so travelling from the edge strip onto the bar doesn't dismiss
  // it mid-flight.
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setHovered(false), 140)
  }

  // Leaving the strip/bar is only a real exit when focus moves outside the
  // whole rail (so hop from strip → bar → flyout doesn't flicker shut).
  const onRailLeave = (event: React.MouseEvent): void => {
    const next = event.relatedTarget as Node | null
    if (next && railRef.current?.contains(next)) return
    scheduleClose()
  }

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    }
  }, [])

  // Profile identity + lock availability, both from the main process. Re-run
  // when the profile menu opens so recent account/lock changes are reflected.
  useEffect(() => {
    window.api.github
      .status()
      .then((status) => setUser(status.user ?? null))
      .catch(() => setUser(null))
    window.api.lock
      .status()
      .then((status) => setPasswordSet(status.passwordSet))
      .catch(() => setPasswordSet(false))
  }, [menu])

  // Dismiss an open flyout when clicking anywhere else.
  useEffect(() => {
    if (menu === null) return
    const onDown = (event: PointerEvent): void => {
      if (railRef.current?.contains(event.target as Node)) return
      setMenu(null)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [menu])

  useEffect(() => {
    if (menu === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  // Clicking the active destination is a no-op: it stays put instead of
  // dropping back to the notes behind it.
  const toggleNav = (key: NavKey): void => {
    if (activeNav !== key) openNav(key)
    setMenu(null)
  }

  const vaultName = vaultPath?.split(/[\\/]/).filter(Boolean).pop() ?? 'Local vault'

  const openSettings = (): void => {
    setMenu(null)
    openNav('settings')
  }

  const changeUser = (): void => {
    setMenu(null)
    void chooseVault()
  }

  const logOut = (): void => {
    setMenu(null)
    if (passwordSet) requestLock()
    else openSettings()
  }

  const initial = user?.trim().charAt(0).toUpperCase() ?? ''

  return (
    <div className="rail" ref={railRef}>
      <div
        className="rail__zone"
        aria-hidden="true"
        title="Navigation"
        onMouseEnter={holdOpen}
        onMouseLeave={onRailLeave}
      />

      <div
        className={`rail__bar${expanded ? ' is-open' : ''}`}
        onMouseEnter={holdOpen}
        onMouseLeave={onRailLeave}
      >
        <nav className="rail__group" aria-label="Primary">
          {railItems.map((item) => {
            const Icon = item.icon
            const isActive = activeNav === item.key
            return (
              <button
                key={item.key}
                type="button"
                className={`rail__btn${isActive ? ' is-active' : ''}`}
                title={item.label}
                aria-label={item.label}
                aria-pressed={isActive}
                onClick={() => toggleNav(item.key)}
              >
                <Icon size={19} />
              </button>
            )
          })}
        </nav>

        <div className="rail__spacer" />

        <div className="rail__group">
          <button
            type="button"
            className={`rail__btn${backgroundListening ? '' : ' is-muted'}`}
            title={backgroundListening ? 'Turn off Always listening' : 'Turn on Always listening'}
            aria-label={
              backgroundListening ? 'Turn off Always listening' : 'Turn on Always listening'
            }
            aria-pressed={backgroundListening}
            onClick={() => setBackgroundListening(!backgroundListening)}
          >
            {backgroundListening ? <MicIcon size={18} /> : <MicMutedIcon size={18} />}
          </button>
          <button
            type="button"
            className={`rail__avatar${menu === 'profile' ? ' is-active' : ''}`}
            title={user ? `${user} · profile` : 'Profile'}
            aria-label="Profile and account"
            aria-haspopup="menu"
            aria-expanded={menu === 'profile'}
            onClick={() => setMenu((value) => (value === 'profile' ? null : 'profile'))}
          >
            {initial ? <span aria-hidden="true">{initial}</span> : <UserIcon size={18} />}
          </button>
        </div>
      </div>

      {menu === 'profile' && (
        <div className="rail-menu rail-menu--profile" role="menu" aria-label="Profile">
          <div className="rail-menu__head">
            <span className="rail-menu__avatar" aria-hidden="true">
              {initial ? initial : <UserIcon size={18} />}
            </span>
            <span className="rail-menu__id">
              <span className="rail-menu__name">{user ?? 'This device'}</span>
              <span className="rail-menu__sub">{vaultName}</span>
            </span>
            <button
              type="button"
              className="rail-menu__switch"
              title="Change user"
              aria-label="Change user"
              onClick={changeUser}
            >
              <SwitchUserIcon size={16} />
            </button>
          </div>
          <div className="rail-menu__sep" />
          <button type="button" className="rail-menu__item" role="menuitem" onClick={openSettings}>
            <UserIcon size={15} />
            Account
          </button>
          <button type="button" className="rail-menu__item" role="menuitem" onClick={openSettings}>
            <SettingsIcon size={15} />
            Settings
          </button>
          <div className="rail-menu__sep" />
          <button
            type="button"
            className="rail-menu__item rail-menu__item--danger"
            role="menuitem"
            onClick={logOut}
          >
            <LogOutIcon size={15} />
            Log out
          </button>
        </div>
      )}
    </div>
  )
}

export default Rail

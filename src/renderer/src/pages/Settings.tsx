import { useCallback, useEffect, useState } from 'react'
import { useAppStore, type SidebarWidgetKey } from '../store/appStore'
import type { GithubStatus } from '../../../preload/github'

function GithubBackup(): React.JSX.Element {
  const autoSync = useAppStore((state) => state.autoSync)
  const setAutoSync = useAppStore((state) => state.setAutoSync)
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [repoName, setRepoName] = useState('seemo-notes')
  const [isPrivate, setIsPrivate] = useState(true)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)

  const refresh = useCallback(() => {
    setConfirmingDisconnect(false)
    return window.api.github
      .status()
      .then(setStatus)
      .catch((error) => {
        console.error('[github] status failed', error)
        setMessage('Could not check GitHub status.')
      })
  }, [])

  useEffect(() => {
    // One-time load of main-process state on mount — the canonical exception
    // to the rule below (syncing with an external system, not derived state).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  const runAction = <T,>(action: () => Promise<T>, done: (value: T) => void): void => {
    setBusy(true)
    setMessage(null)
    action().then(
      (value) => {
        done(value)
        setBusy(false)
        void refresh()
      },
      (error: unknown) => {
        console.error('[github] action failed', error)
        setMessage(error instanceof Error ? error.message : 'GitHub command failed.')
        setBusy(false)
        void refresh()
      }
    )
  }

  const create = (): void => {
    const name = repoName.trim()
    if (!name) {
      setMessage('Give the repo a name first.')
      return
    }
    runAction(
      () => window.api.github.createRepo(name, isPrivate),
      (result) => setMessage(`Created and pushed to ${result.repoUrl}`)
    )
  }

  const sync = (): void => {
    runAction(
      () => window.api.github.sync(),
      (result) => setMessage(result.detail)
    )
  }

  const disconnect = (): void => {
    if (!confirmingDisconnect) {
      setConfirmingDisconnect(true)
      setMessage('This permanently deletes the GitHub repo. Press Disconnect again to confirm.')
      return
    }
    setConfirmingDisconnect(false)
    runAction(
      () => window.api.github.disconnect(),
      (result) => setMessage(`Deleted ${result.deleted}. Local notes are untouched.`)
    )
  }

  return (
    <section className="settings__section">
      <h2 className="settings__section-title">GitHub backup</h2>
      <div className="vault-card">
        <div className="vault-card__info">
          {!status ? (
            <div className="vault-card__meta">Checking GitHub status…</div>
          ) : !status.ghInstalled ? (
            <>
              <div className="vault-card__path">GitHub CLI not found</div>
              <div className="vault-card__meta">
                Install it from https://cli.github.com, then press Refresh.
              </div>
            </>
          ) : !status.authed ? (
            <>
              <div className="vault-card__path">Not signed in</div>
              <div className="vault-card__meta">
                Run <code>gh auth login</code> in a terminal, then press Refresh.
              </div>
            </>
          ) : status.remoteUrl ? (
            <>
              <div className="vault-card__path">
                {status.repoUrl ? (
                  <a href={status.repoUrl} target="_blank" rel="noreferrer">
                    {status.repoUrl.replace(/^https?:\/\//, '')}
                  </a>
                ) : (
                  status.remoteUrl
                )}
              </div>
              <div className="vault-card__meta">
                Signed in as {status.user ?? 'you'} · branch {status.branch ?? 'main'} ·{' '}
                {status.clean ? 'everything pushed' : 'unpushed changes'}
              </div>
              <label className="settings__check">
                <input
                  type="checkbox"
                  checked={autoSync}
                  onChange={(event) => setAutoSync(event.target.checked)}
                />
                Auto-sync
              </label>
            </>
          ) : (
            <>
              <div className="vault-card__path">Signed in as {status.user ?? 'you'}</div>
              <div className="vault-card__meta">
                Creates a repo, commits every note in the vault, and pushes it.
              </div>
              <div className="settings__form">
                <input
                  className="settings__input"
                  value={repoName}
                  maxLength={100}
                  spellCheck={false}
                  placeholder="Repo name"
                  aria-label="Repo name"
                  onChange={(event) => setRepoName(event.target.value)}
                />
                <label className="settings__check">
                  <input
                    type="checkbox"
                    checked={isPrivate}
                    onChange={(event) => setIsPrivate(event.target.checked)}
                  />
                  Private
                </label>
              </div>
            </>
          )}
          {message && <p className="vault-card__meta">{message}</p>}
        </div>
        <div className="vault-card__actions">
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => void refresh()}
          >
            Refresh
          </button>
          {status && status.ghInstalled && status.authed && !status.remoteUrl && (
            <button type="button" className="btn btn--primary" disabled={busy} onClick={create}>
              {busy ? 'Creating…' : 'Create repo'}
            </button>
          )}
          {status?.remoteUrl && (
            <>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={sync}>
                {busy ? 'Syncing…' : 'Sync now'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                onClick={disconnect}
                title="Delete the GitHub repo and unlink this vault"
              >
                {confirmingDisconnect ? 'Confirm delete' : 'Disconnect'}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function LockSettings(): React.JSX.Element {
  const [status, setStatus] = useState<{
    passwordSet: boolean
    biometricKind: 'touch-id' | 'windows-hello' | null
    biometricAvailable: boolean
    biometricEnabled: boolean
  } | null>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await window.api.lock.status())
    } catch {
      // Main handlers missing (shouldn't happen) — leave stale state.
    }
  }

  // Mount-once fetch from the main process (not derived state).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void refresh()
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect */

  const clearFields = (): void => {
    setCurrent('')
    setNext('')
    setConfirm('')
  }

  const fail = (err: unknown): void => {
    setError(err instanceof Error ? err.message : 'Something went wrong.')
  }

  const enable = async (): Promise<void> => {
    if (next.length < 4) {
      setError('Password must be at least 4 characters.')
      return
    }
    if (next !== confirm) {
      setError('New passwords do not match.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await window.api.lock.setPassword(next)
      clearFields()
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const change = async (): Promise<void> => {
    if (next.length < 4) {
      setError('Password must be at least 4 characters.')
      return
    }
    if (next !== confirm) {
      setError('New passwords do not match.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const ok = await window.api.lock.verify(current)
      if (!ok) {
        setError('Current password is incorrect.')
        return
      }
      await window.api.lock.setPassword(next)
      clearFields()
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.lock.remove(current)
      clearFields()
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const toggleBiometric = async (enabled: boolean): Promise<void> => {
    setError(null)
    try {
      await window.api.lock.setBiometric(enabled)
      await refresh()
    } catch (err) {
      fail(err)
    }
  }

  if (!status) return <p className="settings__note">Checking lock status…</p>

  const bioName =
    status.biometricKind === 'touch-id'
      ? 'Touch ID'
      : status.biometricKind === 'windows-hello'
        ? 'Windows Hello'
        : 'Biometrics'

  return (
    <div className="lock-settings">
      {!status.passwordSet ? (
        <>
          <div className="lock-settings__row">
            <input
              type="password"
              className="dlg__input"
              value={next}
              placeholder="New password (4+ characters)"
              aria-label="New password"
              onChange={(event) => setNext(event.target.value)}
            />
            <input
              type="password"
              className="dlg__input"
              value={confirm}
              placeholder="Confirm password"
              aria-label="Confirm password"
              onChange={(event) => setConfirm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void enable()
              }}
            />
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => void enable()}
            >
              Enable lock
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="settings__check">
            <input
              type="checkbox"
              checked={status.biometricEnabled}
              disabled={!status.biometricAvailable}
              onChange={(event) => void toggleBiometric(event.target.checked)}
            />
            {bioName} unlock
          </label>
          {!status.biometricAvailable && status.biometricKind !== null && (
            <p className="settings__note">
              {bioName} isn&apos;t available on this device (no reader or nothing enrolled).
            </p>
          )}
          {status.biometricKind === null && (
            <p className="settings__note">
              Biometric unlock isn&apos;t supported on this platform.
            </p>
          )}
          <div className="lock-settings__row">
            <input
              type="password"
              className="dlg__input"
              value={current}
              placeholder="Current password"
              aria-label="Current password"
              onChange={(event) => setCurrent(event.target.value)}
            />
            <input
              type="password"
              className="dlg__input"
              value={next}
              placeholder="New password"
              aria-label="New password"
              onChange={(event) => setNext(event.target.value)}
            />
            <input
              type="password"
              className="dlg__input"
              value={confirm}
              placeholder="Confirm new password"
              aria-label="Confirm new password"
              onChange={(event) => setConfirm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void change()
              }}
            />
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => void change()}
            >
              Change
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              title="Removes the app lock"
              onClick={() => void remove()}
            >
              Remove lock
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="miniapp__hint miniapp__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

const SIDEBAR_WIDGET_LABELS: Record<SidebarWidgetKey, { label: string; hint: string }> = {
  today: { label: 'Today', hint: "Today's events and tasks" },
  favorites: { label: 'Favorites', hint: 'Pinned pages and notes' },
  notes: { label: 'Notes', hint: 'Space name and the note list' }
}

function Settings(): React.JSX.Element {
  const notes = useAppStore((state) => state.notes)
  const backgroundListening = useAppStore((state) => state.backgroundListening)
  const setBackgroundListening = useAppStore((state) => state.setBackgroundListening)
  const orbEnabled = useAppStore((state) => state.orbEnabled)
  const setOrbEnabled = useAppStore((state) => state.setOrbEnabled)
  const theme = useAppStore((state) => state.theme)
  const setTheme = useAppStore((state) => state.setTheme)
  const sidebarWidgets = useAppStore((state) => state.sidebarWidgets)
  const sidebarWidgetOrder = useAppStore((state) => state.sidebarWidgetOrder)
  const setSidebarWidgetVisible = useAppStore((state) => state.setSidebarWidgetVisible)
  const moveSidebarWidget = useAppStore((state) => state.moveSidebarWidget)
  const ttsEnabled = useAppStore((state) => state.ttsEnabled)
  const setTtsEnabled = useAppStore((state) => state.setTtsEnabled)
  const vaultPath = useAppStore((state) => state.vaultPath)
  const vaultReady = useAppStore((state) => state.vaultReady)
  const vaultError = useAppStore((state) => state.vaultError)
  const refreshVault = useAppStore((state) => state.refreshVault)
  const chooseVault = useAppStore((state) => state.chooseVault)

  const revealVault = (): void => {
    window.api.vault.reveal().catch((error) => {
      console.error('[vault] failed to reveal folder', error)
    })
  }

  return (
    <main className="settings">
      <div className="settings__inner">
        <h1 className="settings__title">Settings</h1>

        <section className="settings__section">
          <h2 className="settings__section-title">Appearance</h2>
          <div className="kind-toggle settings__theme" role="group" aria-label="Appearance">
            {(['dark', 'light', 'system'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`kind-toggle__btn${theme === mode ? ' is-active' : ''}`}
                aria-pressed={theme === mode}
                onClick={() => setTheme(mode)}
              >
                {mode === 'dark' ? 'Dark' : mode === 'light' ? 'Light' : 'System'}
              </button>
            ))}
          </div>
          <p className="settings__note">
            {theme === 'system'
              ? 'Following your OS appearance.'
              : theme === 'light'
                ? 'Light theme.'
                : 'Dark theme.'}
          </p>
        </section>

        <section className="settings__section">
          <h2 className="settings__section-title">Sidebar</h2>
          <div className="settings__widgets">
            {sidebarWidgetOrder.map((key, index) => (
              <div key={key} className="settings__widget-row">
                <label className="settings__check settings__widget-label">
                  <input
                    type="checkbox"
                    checked={sidebarWidgets[key]}
                    onChange={(event) => setSidebarWidgetVisible(key, event.target.checked)}
                  />
                  <span>
                    {SIDEBAR_WIDGET_LABELS[key].label}
                    <span className="settings__widget-hint">{SIDEBAR_WIDGET_LABELS[key].hint}</span>
                  </span>
                </label>
                <div className="settings__widget-actions">
                  <button
                    type="button"
                    className="settings__widget-btn"
                    disabled={index === 0}
                    title="Move up"
                    aria-label={`Move ${SIDEBAR_WIDGET_LABELS[key].label} up`}
                    onClick={() => moveSidebarWidget(key, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="settings__widget-btn"
                    disabled={index === sidebarWidgetOrder.length - 1}
                    title="Move down"
                    aria-label={`Move ${SIDEBAR_WIDGET_LABELS[key].label} down`}
                    onClick={() => moveSidebarWidget(key, 1)}
                  >
                    ↓
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="settings__note">
            Show, hide, and reorder the sidebar widgets. The space name and everything above the
            note list stay fixed; only the note list scrolls.
          </p>
        </section>

        <section className="settings__section">
          <h2 className="settings__section-title">Notes vault</h2>
          <div className="vault-card">
            <div className="vault-card__info">
              <div className="vault-card__path" title={vaultPath ?? undefined}>
                {vaultPath ?? 'Locating vault…'}
              </div>
              <div className="vault-card__meta">
                {vaultReady
                  ? `${notes.length} ${notes.length === 1 ? 'note' : 'notes'} on disk · one .md file each`
                  : (vaultError ?? 'Opening…')}
              </div>
              {vaultError && <p className="vault-card__error">{vaultError}</p>}
            </div>
            <div className="vault-card__actions">
              <button type="button" className="btn btn--ghost" onClick={() => void refreshVault()}>
                Refresh
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => void chooseVault()}>
                Change folder
              </button>
              <button type="button" className="btn btn--ghost" onClick={revealVault}>
                Show in folder
              </button>
            </div>
          </div>
        </section>

        <GithubBackup />

        <section className="settings__section">
          <h2 className="settings__section-title">Voice & audio</h2>
          <label className="settings__check">
            <input
              type="checkbox"
              checked={backgroundListening}
              onChange={(event) => setBackgroundListening(event.target.checked)}
            />
            Always listening
          </label>
          <p className="settings__note">
            When on, the mic stays live everywhere: SeeMO answers what you say even away from the
            SeeMO page, and its replies surface in a bubble at the bottom-right. When off, the mic
            only works on the SeeMO page — anywhere else it&apos;s effectively turned off. The
            microphone button in the sidebar toggles this same setting; the SeeMO page has its own
            independent mute.
          </p>
          <label className="settings__check">
            <input
              type="checkbox"
              checked={ttsEnabled}
              onChange={(event) => setTtsEnabled(event.target.checked)}
            />
            Spoken replies (Piper · Alba medium)
          </label>
          <p className="settings__note">
            When on, finished replies are read aloud through the voice pipeline. Requires the Piper
            binary and Alba voice from start.sh.
          </p>
          <label className="settings__check">
            <input
              type="checkbox"
              checked={orbEnabled}
              onChange={(event) => setOrbEnabled(event.target.checked)}
            />
            Picture-in-picture orb
          </label>
          <p className="settings__note">
            When on, minimizing or hiding the app leaves SeeMO hovering in a small always-on-top
            window. Click it to bring the app back.
          </p>
        </section>

        <section className="settings__section">
          <h2 className="settings__section-title">App lock</h2>
          <LockSettings />
          <p className="settings__note">
            Locks the app behind a password at launch. Keeps casual snoopers out; it does not
            encrypt the vault files on disk.
          </p>
        </section>

        <section className="settings__section">
          <h2 className="settings__section-title">About</h2>
          <p className="settings__note">
            <strong>SeeMO</strong> — your notes, organized and always in motion.
          </p>
        </section>
      </div>
    </main>
  )
}

export default Settings

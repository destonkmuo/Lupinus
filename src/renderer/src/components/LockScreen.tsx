import { useState } from 'react'
import lupinusIcon from '../assets/lupinus-icon.png'

export interface LockInfo {
  biometricKind: 'touch-id' | 'windows-hello' | null
  biometricAvailable: boolean
  biometricEnabled: boolean
}

function biometricLabel(kind: LockInfo['biometricKind']): string {
  if (kind === 'touch-id') return 'Use Touch ID'
  if (kind === 'windows-hello') return 'Use Windows Hello'
  return 'Use biometrics'
}

/**
 * Gate over the whole app while locked. Knows nothing about the vault —
 * it just reports a successful unlock upward.
 */
function LockScreen({
  info,
  onUnlock
}: {
  info: LockInfo
  onUnlock: () => void
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [bioBusy, setBioBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      const ok = await window.api.lock.verify(password)
      if (ok) {
        setPassword('')
        onUnlock()
      } else {
        setError('Incorrect password.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlock.')
    } finally {
      setBusy(false)
    }
  }

  const submitBiometric = async (): Promise<void> => {
    if (bioBusy) return
    setBioBusy(true)
    setError(null)
    try {
      const ok = await window.api.lock.biometric()
      if (ok) onUnlock()
      // A cancel/failed scan just returns false: stay locked, no error noise.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Biometric unlock failed.')
    } finally {
      setBioBusy(false)
    }
  }

  const showBio = info.biometricEnabled && info.biometricAvailable && info.biometricKind !== null

  return (
    <div className="lockscreen" role="dialog" aria-modal="true" aria-label="Unlock Lupinus">
      <div className="lockscreen__card">
        <img className="lockscreen__orb" src={lupinusIcon} alt="" aria-hidden="true" />
        <h1 className="lockscreen__title">Lupinus is locked</h1>
        <p className="lockscreen__hint">Enter your password to open the app.</p>
        <input
          type="password"
          className="dlg__input lockscreen__input"
          autoFocus
          value={password}
          placeholder="Password"
          aria-label="Password"
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
        />
        {error && (
          <p className="miniapp__hint miniapp__error" role="alert">
            {error}
          </p>
        )}
        <div className="lockscreen__row">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !password}
            onClick={() => void submit()}
          >
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
          {showBio && (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={bioBusy}
              onClick={() => void submitBiometric()}
            >
              {bioBusy ? 'Waiting…' : biometricLabel(info.biometricKind)}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default LockScreen

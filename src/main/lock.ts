import { app, ipcMain, systemPreferences } from 'electron'
import { promises as fs } from 'fs'
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto'
import { join } from 'path'

/**
 * App lock: password gate + platform biometrics (Touch ID on macOS,
 * Windows Hello via NodeRT).
 *
 * Threat model: casual snooping on a shared machine. The password verifier
 * is a salted scrypt hash in `<userData>/lock.json`; the renderer delays
 * vault reads until unlock. This does not encrypt the vault — DevTools or
 * disk forensics can still reach files. Do not oversell it in the UI.
 */

const LOCK_FILE = 'lock.json'
const FAIL_DELAY_MS = 600

interface LockRecord {
  salt: string
  hash: string
  biometric: boolean
}

function lockPath(): string {
  return join(app.getPath('userData'), LOCK_FILE)
}

async function readRecord(): Promise<LockRecord | null> {
  try {
    const raw = await fs.readFile(lockPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<LockRecord>
    if (
      typeof parsed.salt !== 'string' ||
      typeof parsed.hash !== 'string' ||
      !parsed.salt ||
      !parsed.hash
    ) {
      return null
    }
    return { salt: parsed.salt, hash: parsed.hash, biometric: parsed.biometric === true }
  } catch {
    return null
  }
}

async function writeRecord(record: LockRecord): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(lockPath(), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex')
}

function verifyHash(password: string, record: LockRecord): boolean {
  const candidate = Buffer.from(hashPassword(password, record.salt), 'hex')
  const expected = Buffer.from(record.hash, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Biometrics
// ---------------------------------------------------------------------------

export type BiometricKind = 'touch-id' | 'windows-hello' | null

function biometricKind(): BiometricKind {
  if (process.platform === 'darwin') return 'touch-id'
  if (process.platform === 'win32') return 'windows-hello'
  return null
}

/** Whether the device can prompt right now (reader present + enrolled). */
async function biometricAvailable(): Promise<boolean> {
  if (process.platform === 'darwin') {
    try {
      return systemPreferences.canPromptTouchID()
    } catch {
      return false
    }
  }
  if (process.platform === 'win32') {
    try {
      // Optional dep (mac/linux installs skip it); absence means unavailable.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const hello = require('@nodert-win10-rs4/windows.security.credentials.ui') as {
        UserConsentVerifier: {
          checkAvailabilityAsync: (callback: (error: Error | null, result: number) => void) => void
          UserConsentVerifierAvailability: { available: number; deviceBusy: number }
        }
      }
      const { UserConsentVerifier } = hello
      const availability: number = await new Promise((resolve, reject) => {
        UserConsentVerifier.checkAvailabilityAsync((error, result) => {
          if (error) reject(error)
          else resolve(result)
        })
      })
      const { UserConsentVerifierAvailability } = UserConsentVerifier
      return (
        availability === UserConsentVerifierAvailability.available ||
        availability === UserConsentVerifierAvailability.deviceBusy
      )
    } catch {
      return false
    }
  }
  return false
}

/** Prompt for a biometric consent. Returns true only when verified. */
async function biometricVerify(): Promise<boolean> {
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.promptTouchID('Unlock Lupinus')
      return true
    } catch {
      return false
    }
  }
  if (process.platform === 'win32') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const hello = require('@nodert-win10-rs4/windows.security.credentials.ui') as {
        UserConsentVerifier: {
          requestVerificationAsync: (
            message: string,
            callback: (error: Error | null, result: number) => void
          ) => void
          UserConsentVerificationResult: { verified: number }
        }
      }
      const { UserConsentVerifier } = hello
      const result: number = await new Promise((resolve, reject) => {
        UserConsentVerifier.requestVerificationAsync('Unlock Lupinus', (error, res) => {
          if (error) reject(error)
          else resolve(res)
        })
      })
      return result === UserConsentVerifier.UserConsentVerificationResult.verified
    } catch {
      return false
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

export interface LockStatus {
  passwordSet: boolean
  biometricKind: BiometricKind
  biometricAvailable: boolean
  biometricEnabled: boolean
}

export function registerLockHandlers(): void {
  ipcMain.handle('lock:status', async (): Promise<LockStatus> => {
    const record = await readRecord()
    return {
      passwordSet: record !== null,
      biometricKind: biometricKind(),
      biometricAvailable: await biometricAvailable(),
      biometricEnabled: record?.biometric === true
    }
  })

  ipcMain.handle('lock:set-password', async (_event, password: unknown): Promise<boolean> => {
    if (typeof password !== 'string' || password.length < 4 || password.length > 256) {
      throw new Error('Password must be 4–256 characters.')
    }
    const prev = await readRecord()
    const salt = randomBytes(32).toString('hex')
    await writeRecord({
      salt,
      hash: hashPassword(password, salt),
      biometric: prev?.biometric === true
    })
    return true
  })

  ipcMain.handle('lock:verify', async (_event, password: unknown): Promise<boolean> => {
    const record = await readRecord()
    if (!record || typeof password !== 'string') {
      await delay(FAIL_DELAY_MS)
      return false
    }
    const ok = verifyHash(password, record)
    if (!ok) await delay(FAIL_DELAY_MS)
    return ok
  })

  ipcMain.handle('lock:remove', async (_event, password: unknown): Promise<boolean> => {
    const record = await readRecord()
    if (!record) return true
    if (typeof password !== 'string' || !verifyHash(password, record)) {
      await delay(FAIL_DELAY_MS)
      throw new Error('Current password is incorrect.')
    }
    await fs.rm(lockPath(), { force: true })
    return true
  })

  ipcMain.handle('lock:set-biometric', async (_event, enabled: unknown): Promise<boolean> => {
    const record = await readRecord()
    if (!record) throw new Error('Set a password first.')
    const want = enabled === true
    if (want && !(await biometricAvailable())) {
      throw new Error('Biometric unlock is not available on this device.')
    }
    await writeRecord({ ...record, biometric: want })
    return true
  })

  ipcMain.handle('lock:biometric', async (): Promise<boolean> => {
    const record = await readRecord()
    if (!record?.biometric) return false
    if (!(await biometricAvailable())) return false
    return biometricVerify()
  })
}

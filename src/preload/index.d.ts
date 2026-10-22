import { ElectronAPI } from '@electron-toolkit/preload'
import type { GithubApi } from './github'
import type { VaultApi } from './vault'

interface VoiceApi {
  onVoiceTranscript: (callback: (text: string) => void) => () => void
  onVoiceWake: (callback: () => void) => () => void
  onCoreRemote: (callback: (state: string) => void) => () => void
  announceCore: (state: string) => void
  focusApp: () => Promise<void>
  setOrbEnabled: (enabled: boolean) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  speak: (text: string) => Promise<boolean>
  importAlarmSound: () => Promise<{ name: string; url: string } | null>
  maxAlarmVolume: () => Promise<{ ok: boolean; error?: string }>
  restoreAlarmVolume: () => Promise<{ ok: boolean; error?: string }>
  fetchIcs: (url: string) => Promise<string>
}

interface LockApi {
  status: () => Promise<{
    passwordSet: boolean
    biometricKind: 'touch-id' | 'windows-hello' | null
    biometricAvailable: boolean
    biometricEnabled: boolean
  }>
  setPassword: (password: string) => Promise<boolean>
  verify: (password: string) => Promise<boolean>
  remove: (password: string) => Promise<boolean>
  setBiometric: (enabled: boolean) => Promise<boolean>
  biometric: () => Promise<boolean>
}

interface AppApi extends VoiceApi {
  vault: VaultApi
  github: GithubApi
  lock: LockApi
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: AppApi
  }
}

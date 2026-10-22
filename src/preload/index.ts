import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { GithubApi } from './github'
import type { VaultApi } from './vault'

// Custom APIs for renderer
const vault: VaultApi = {
  status: () => ipcRenderer.invoke('vault:status'),
  choose: () => ipcRenderer.invoke('vault:choose'),
  reveal: () => ipcRenderer.invoke('vault:reveal'),
  list: () => ipcRenderer.invoke('vault:list'),
  read: (name: string) => ipcRenderer.invoke('vault:read', name),
  write: (name: string, content: string) => ipcRenderer.invoke('vault:write', name, content),
  rename: (oldName: string, newName: string) =>
    ipcRenderer.invoke('vault:rename', oldName, newName),
  remove: (name: string) => ipcRenderer.invoke('vault:remove', name),
  readJson: (name: string) => ipcRenderer.invoke('vault:readJson', name),
  writeJson: (name: string, data: unknown[]) => ipcRenderer.invoke('vault:writeJson', name, data),
  importPicture: (sourcePath?: string) => ipcRenderer.invoke('vault:importPicture', sourcePath),
  importPictureData: (name: string, data: ArrayBuffer) =>
    ipcRenderer.invoke('vault:importPictureData', name, data)
}

const api = {
  onVoiceTranscript: (callback: (text: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, text: string): void => callback(text)
    ipcRenderer.on('voice:transcript', listener)
    return () => {
      ipcRenderer.removeListener('voice:transcript', listener)
    }
  },
  onVoiceWake: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('voice:wake', listener)
    return () => {
      ipcRenderer.removeListener('voice:wake', listener)
    }
  },
  /** Core-state pulses from sibling windows (speaking/idle from the agent). */
  onCoreRemote: (callback: (state: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: string): void => callback(state)
    ipcRenderer.on('core:remote', listener)
    return () => {
      ipcRenderer.removeListener('core:remote', listener)
    }
  },
  announceCore: (state: string): void => {
    ipcRenderer.send('core:announce', state)
  },
  /** Orb window: bring the main window back (restores + focuses it). */
  focusApp: (): Promise<void> => ipcRenderer.invoke('orb:focus-app'),
  setOrbEnabled: (enabled: boolean): void => {
    ipcRenderer.send('orb:set-enabled', enabled)
  },
  /** macOS: hide the native traffic lights while the sidebar is collapsed. */
  setSidebarCollapsed: (collapsed: boolean): void => {
    ipcRenderer.send('window:sidebar-collapsed', collapsed)
  },
  vault,
  speak: (text: string): Promise<boolean> => ipcRenderer.invoke('voice:speak', text),
  importAlarmSound: (): Promise<{ name: string; url: string } | null> =>
    ipcRenderer.invoke('alarm:importSound'),
  /** Crank the OS volume to max for a ringing alarm (prior level is saved). */
  maxAlarmVolume: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('alarm:maxVolume'),
  /** Put back the OS volume saved by the matching maxAlarmVolume call. */
  restoreAlarmVolume: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('alarm:restoreVolume'),
  fetchIcs: (url: string): Promise<string> => ipcRenderer.invoke('calendar:fetchIcs', url),
  lock: {
    status: () =>
      ipcRenderer.invoke('lock:status') as Promise<{
        passwordSet: boolean
        biometricKind: 'touch-id' | 'windows-hello' | null
        biometricAvailable: boolean
        biometricEnabled: boolean
      }>,
    setPassword: (password: string): Promise<boolean> =>
      ipcRenderer.invoke('lock:set-password', password),
    verify: (password: string): Promise<boolean> => ipcRenderer.invoke('lock:verify', password),
    remove: (password: string): Promise<boolean> => ipcRenderer.invoke('lock:remove', password),
    setBiometric: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('lock:set-biometric', enabled),
    biometric: (): Promise<boolean> => ipcRenderer.invoke('lock:biometric')
  },
  github: {
    status: () => ipcRenderer.invoke('github:status'),
    createRepo: (name: string, isPrivate: boolean) =>
      ipcRenderer.invoke('github:create', name, isPrivate),
    sync: (message?: string) => ipcRenderer.invoke('github:sync', message),
    disconnect: () => ipcRenderer.invoke('github:disconnect')
  } satisfies GithubApi
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

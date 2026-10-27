import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { cpSync, existsSync, readdirSync, renameSync, rmdirSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerAlarmHandlers, registerAlarmScheme } from './alarm'
import { registerCalendarHandlers } from './calendar'
import { startVoice, stopVoice, speakResponse } from './voice'
import { registerGithubHandlers } from './github'
import { applyDockIcon } from './icon'
import { registerLockHandlers } from './lock'
import { registerChromeHandlers } from './chrome'
import { handleActivate, registerOrbHandlers, trackMainWindow } from './orb'
import { registerMediaHandlers, registerMediaScheme } from './media'
import { registerPdfHandlers } from './pdf'
import { registerVaultHandlers } from './vault'
import { registerVolumeHandlers } from './volume'
import icon from '../../resources/icon.png?asset'

/**
 * Move the pre-rebrand profile (settings, localStorage, alarm sounds, and
 * vault.json) into the new userData folder on first launch. Chromium may have
 * already created an empty folder for the new name, so an empty one is
 * replaced; anything with real content is left untouched.
 */
function migrateLegacyUserData(): void {
  try {
    const appData = app.getPath('appData')
    const current = app.getPath('userData')
    const legacy = ['seemo', 'SeeMO']
      .map((name) => join(appData, name))
      .find((path) => path !== current && existsSync(path))
    if (!legacy) return

    if (!existsSync(current) || readdirSync(current).length === 0) {
      if (existsSync(current)) rmdirSync(current)
      renameSync(legacy, current)
      return
    }

    // Chromium may have already seeded the new profile. Merge only when the
    // app's own data hasn't been written yet, so nothing is overwritten.
    if (existsSync(join(current, 'vault.json')) || existsSync(join(current, 'Local Storage'))) {
      return
    }
    for (const entry of ['vault.json', 'alarm-sounds', 'Local Storage', 'Session Storage']) {
      const from = join(legacy, entry)
      if (existsSync(from)) cpSync(from, join(current, entry), { recursive: true })
    }
  } catch {
    // Path lookup or permissions failed; continue with a fresh profile.
  }
}

migrateLegacyUserData()

// Alarm/timer sounds must be allowed to start from timer callbacks (no user
// gesture at ring time), so disable the autoplay gate for this app window.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Horizontal trackpad swipes are handled in-app (sidebar space switch, page
// history on the note surface). Keep Chromium's overscroll back/forward
// navigation from firing alongside those gestures.
app.commandLine.appendSwitch('disable-features', 'OverscrollHistoryNavigation')

// Must be declared before the app is ready so the scheme is privileged.
registerAlarmScheme()
registerMediaScheme()

function createWindow(): void {
  // Create the browser window.
  // Custom chrome: hide the native title bar (no more "Lupinus" strip up top).
  // On macOS the traffic lights float over the sidebar, so the sidebar
  // search sits lower to clear them; elsewhere the OS frame stays as-is so
  // window controls are never lost.
  const mainWindow = new BrowserWindow({
    width: 1500,
    height: 880,
    minWidth: 720,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    // Native backdrop behind the web content: without this Electron shows
    // white here, which flashes as a trailing edge during live resizes
    // before the renderer repaints. Matches the chrome canvas around the
    // floating main viewport (--chrome-bg, same as the sidebar).
    backgroundColor: '#1b1b1b',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 12, y: 14 }
        }
      : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  trackMainWindow(mainWindow)

  mainWindow.on('ready-to-show', () => {
    applyDockIcon()
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.lupinus')

  // Dev runs on macOS execute inside Electron.app, whose own bundle icon
  // lands in the dock. Override it at runtime so dev shows the real icon
  // too (packaged builds already carry build/icon.icns — no override).
  applyDockIcon()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
    // A new window can flip macOS's activation policy; re-assert the icon.
    applyDockIcon()
  })

  // Any window gaining focus is a point macOS may have restored the bundle
  // icon; keep Lupinus's in place.
  app.on('browser-window-focus', () => applyDockIcon())

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // Renderer -> pipeline: speak a Lupinus reply aloud via Piper TTS.
  ipcMain.handle('voice:speak', (_event, text: unknown) =>
    speakResponse(typeof text === 'string' ? text : '')
  )

  // Markdown vault: one .md file per note, readable outside the app.
  registerVaultHandlers()

  // Custom alarm sounds: import picker + lupinus-alarm:// streaming.
  registerAlarmHandlers()

  // Alarm "max volume" option: OS-level volume max/restore.
  registerVolumeHandlers()

  // Note pictures: import picker + lupinus-media:// streaming.
  registerMediaHandlers()
  registerPdfHandlers()

  // Calendar subscriptions: fetch external ICS feeds for the renderer.
  registerCalendarHandlers()

  // GitHub backup for the vault (status/create/sync via gh + git).
  registerGithubHandlers()

  // App lock: password gate + Touch ID / Windows Hello.
  registerLockHandlers()

  // Picture-in-picture orb + core-state relay between windows.
  registerOrbHandlers()

  // Native macOS traffic lights: hide them while the sidebar is collapsed.
  registerChromeHandlers()

  createWindow()

  // Start the always-on wake-word + transcription pipeline. Transcriptions
  // are printed to this process's console and forwarded to the renderer.
  startVoice()

  app.on('activate', function () {
    // macOS re-activation can reset a custom Dock icon; re-assert it.
    applyDockIcon()
    // Dock click / Cmd+Tab back: bring a minimized/hidden main window
    // forward (the orb counts as a window, so the zero-windows check below
    // would otherwise never fire). Only re-create when nothing exists.
    if (handleActivate()) return
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  stopVoice()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

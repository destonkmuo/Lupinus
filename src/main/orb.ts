import { BrowserWindow, app, ipcMain, screen } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { applyDockIcon } from './icon'
import icon from '../../resources/icon.png?asset'

/**
 * Picture-in-picture orb.
 *
 * Lifecycle contract — one rule, derived in `syncOrb()`:
 *
 *   orb visible  ⇔  setting enabled  ∧  the user is away from Lupinus
 *                   (main window minimized/hidden, or simply not focused)
 *
 * Every window event funnels through `syncOrb()`, so no ad-hoc handler can
 * strand the orb or resurrect it. The renderer side (OrbView) owns all
 * visuals; this file owns only when the window exists.
 *
 * Activation safety has two layers, because an orb that follows you onto
 * every Space can otherwise drag the app forward:
 *   1. the orb is shown with `showInactive()` — it never activates Lupinus;
 *   2. `activate` ignores pulses within a short window of the orb appearing
 *      (the create→activate feedback loop), so real dock/Cmd+Tab intent
 *      still restores the app while the feedback path cannot.
 */

/**
 * Feature flag. The PiP orb is temporarily switched off: the window is never
 * created regardless of the saved preference, but everything else stays in
 * place (settings toggle, OrbView, IPC) so it can be turned back on by
 * flipping this to `true`.
 */
const ORB_FEATURE_ENABLED = false

const ORB_SIZE = 176
const ORB_MARGIN = 24

let mainWindow: BrowserWindow | null = null
let orbWindow: BrowserWindow | null = null
/** Set once the main window has shown for real (guards the launch flash). */
let mainShown = false
/**
 * Latched "user has stepped away" flag, flipped by events rather than polled
 * from `isFocused()`. Polling is unreliable right after we steal focus back
 * (the focus event may lag), which would bounce the orb back on screen.
 */
let userAway = false
/** Latched on first focus: the orb never appears before the user has been
 *  in the app at least once (no orb flash during launch). */
let hasFocusedOnce = false
/** When the orb last appeared; used to absorb the create→activate pulse. */
let orbCreatedAt = 0
/** Mirrors the renderer setting (main can't read renderer storage). */
let orbEnabled = true

// ---------------------------------------------------------------------------
// Temporary tracing: writes only lifecycle *decisions* so any recurrence is
// traceable to the exact branch. Delete once the orb has been quiet for a
// release or two.
// ---------------------------------------------------------------------------

const DIAG_FILE = 'window-events.log'
let diagChain: Promise<void> = Promise.resolve()

function diag(event: string): void {
  if (!is.dev) return
  const line = `${new Date().toISOString()} ${event}`
  diagChain = diagChain
    .then(async () => {
      const file = join(app.getPath('userData'), DIAG_FILE)
      let prev: string[] = []
      try {
        prev = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)
      } catch {
        prev = []
      }
      await fs.writeFile(file, `${[...prev, line].slice(-200).join('\n')}\n`, 'utf8')
    })
    .catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * "The user is away." Driven purely by latched events, never by polling
 * `isMinimized()`/`isVisible()`: during a restore those still report the old
 * state for a beat, and polling them would bounce the orb straight back.
 */
function mainNeedsOrb(): boolean {
  const main = mainWindow
  if (!main || main.isDestroyed()) return false
  return hasFocusedOnce && userAway
}

/** The single reconcile point: make reality match the contract. */
function syncOrb(): void {
  const shouldShow = ORB_FEATURE_ENABLED && orbEnabled && mainShown && mainNeedsOrb()
  if (shouldShow) {
    if (!orbWindow || orbWindow.isDestroyed()) createOrb()
    return
  }
  destroyOrb()
}

export function trackMainWindow(win: BrowserWindow): void {
  mainWindow = win
  mainShown = false
  attachDiagnostics(win)
  const resync = (): void => syncOrb()
  win.on('minimize', () => {
    userAway = true
    resync()
  })
  win.on('hide', () => {
    userAway = true
    resync()
  })
  win.on('restore', () => {
    userAway = false
    resync()
  })
  win.on('focus', () => {
    hasFocusedOnce = true
    userAway = false
    // Coming back to the app is a common point for macOS to have swapped the
    // Dock icon back to Electron's; re-assert Lupinus's.
    applyDockIcon()
    resync()
  })
  win.on('blur', () => {
    userAway = true
    resync()
  })
  win.on('show', () => {
    mainShown = true
    userAway = false
    resync()
  })
  win.on('closed', () => {
    mainWindow = null
    mainShown = false
    userAway = false
    hasFocusedOnce = false
    destroyOrb()
  })
}

/**
 * Dock click / Cmd+Tab. Returns true when handled (a main window exists).
 * The orb appearing does not go through here (it's shown inactive), so this
 * path is reserved for genuine user intent to bring Lupinus back.
 */
export function handleActivate(): boolean {
  const main = mainWindow
  if (!main || main.isDestroyed()) return false
  // Absorb the activation macOS fires the instant an all-Spaces window
  // appears. Genuine dock/Cmd+Tab intent always arrives after this window.
  if (Date.now() - orbCreatedAt < 800) {
    diag('activate:ignored (orb just appeared)')
    return true
  }
  // Pre-first-show activations are the OS launching us; show() is intentional.
  if (!mainShown && !main.isVisible()) return true
  diag(`activate:restore minimized=${main.isMinimized()} visible=${main.isVisible()}`)
  // Full restore (drops the orb immediately, not on a focus event).
  focusMainWindow()
  return true
}

/**
 * Restore + activate the main window from the background. `focus()` alone
 * can't pull a window forward while another app is active, so macOS gets an
 * explicit `app.focus({ steal: true })` first.
 */
function bringMainForward(main: BrowserWindow): void {
  // Clear "away" first so the restore events can't bounce the orb back.
  userAway = false
  if (process.platform === 'darwin') app.focus({ steal: true })
  if (main.isMinimized()) main.restore()
  if (!main.isVisible()) main.show()
  main.focus()
}

// ---------------------------------------------------------------------------
// Orb window
// ---------------------------------------------------------------------------

const ORB_FADE_MS = 220
const ORB_FADE_STEPS = 12

/**
 * Ramp a window from transparent to opaque with an ease-out curve, so the
 * orb settles in rather than snapping onto the screen. `setOpacity` is a
 * no-op on Linux, where it just appears.
 */
function fadeIn(win: BrowserWindow): void {
  if (process.platform === 'linux') {
    win.setOpacity(1)
    return
  }
  let step = 0
  const id = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(id)
      return
    }
    step += 1
    if (step >= ORB_FADE_STEPS) {
      win.setOpacity(1)
      clearInterval(id)
      return
    }
    const t = step / ORB_FADE_STEPS
    win.setOpacity(1 - Math.pow(1 - t, 3))
  }, ORB_FADE_MS / ORB_FADE_STEPS)
}

function createOrb(): void {
  if (!ORB_FEATURE_ENABLED || !orbEnabled) return
  const win = new BrowserWindow({
    width: ORB_SIZE,
    height: ORB_SIZE,
    // Same Lupinus icon as the main window / macOS Dock (matters on
    // Linux/Windows taskbars; ignored on macOS where the Dock is app-wide).
    icon,
    // The look: transparent frameless stage; the renderer paints the orb.
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Windows/Linux only. On macOS this flag is one of the things that can
    // make the whole app vanish from the Dock while the orb is up.
    skipTaskbar: process.platform !== 'darwin',
    // Focus comes from showInactive() below, not from the window type:
    // marking the orb non-focusable made macOS treat it as a panel, which
    // could also drop the app's Dock icon.
    // Shown explicitly once flags are set — a window that appears on its own
    // activates the app (the old "jumps in front" bug).
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  // Follow the user across desktops (and over fullscreen apps — it's the
  // point of a PiP), floating above normal windows. Set before first show so
  // macOS applies it to the Space the orb is born on.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setAlwaysOnTop(true, 'floating')
  const area = screen.getPrimaryDisplay().workArea
  win.setPosition(
    area.x + area.width - ORB_SIZE - ORB_MARGIN,
    area.y + area.height - ORB_SIZE - ORB_MARGIN
  )
  // Start fully transparent; the fade happens once the first frame is
  // painted, so window and content materialize together instead of popping.
  win.setOpacity(0)
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?orb=1`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { orb: '1' } })
  }
  // Keep the Dock icon while the orb is the app's only visible window:
  // showing a non-activating window can otherwise flip macOS to an
  // accessory activation policy, which hides Lupinus from the Dock. Changing
  // the policy also drops any custom icon, so re-assert it right after.
  if (process.platform === 'darwin') app.setActivationPolicy('regular')
  applyDockIcon()

  let revealed = false
  const reveal = (): void => {
    if (revealed || win.isDestroyed()) return
    revealed = true
    // showInactive: visible everywhere without ever activating Lupinus, so the
    // orb can't drag the main window forward with it.
    win.showInactive()
    orbCreatedAt = Date.now()
    fadeIn(win)
    // Showing the orb can make macOS fall back to the bundle icon. The dev
    // bundle is branded now, but re-assert Lupinus's runtime icon as well; the
    // activation-policy update can land a beat after showInactive().
    if (process.platform === 'darwin') {
      applyDockIcon()
      setTimeout(applyDockIcon, 150)
    }
  }
  // 'ready-to-show' fires once the first frame is painted — the seamless
  // moment. The timeout is a safety net for transparent windows.
  win.once('ready-to-show', reveal)
  const revealFallback = setTimeout(reveal, 700)

  win.on('closed', () => {
    clearTimeout(revealFallback)
    orbWindow = null
  })
  orbWindow = win
  diag('orb:create')
}

function destroyOrb(): void {
  const win = orbWindow
  orbWindow = null
  if (win && !win.isDestroyed()) {
    win.close()
    diag('orb:destroy')
  }
}

/** Bring the app back and take the orb down (also reached via `activate`). */
function focusMainWindow(): void {
  const main = mainWindow
  destroyOrb()
  applyDockIcon()
  if (!main || main.isDestroyed()) return
  bringMainForward(main)
}

// ---------------------------------------------------------------------------
// Diagnostics + IPC
// ---------------------------------------------------------------------------

function attachDiagnostics(win: BrowserWindow): void {
  win.on('show', () => diag('main:show'))
  win.on('hide', () => diag('main:hide'))
  win.on('minimize', () => diag('main:minimize'))
  win.on('restore', () => diag('main:restore'))
  win.on('focus', () => diag('main:focus'))
  win.on('blur', () => diag('main:blur'))
  win.on('close', () => diag('main:close'))
  app.on('activate', () => diag('app:activate'))
}

export function registerOrbHandlers(): void {
  ipcMain.handle('orb:focus-app', () => {
    focusMainWindow()
  })
  ipcMain.on('orb:set-enabled', (_event, enabled: unknown) => {
    orbEnabled = enabled === true
    syncOrb() // unchecking takes effect immediately
  })
  // Core-state pulses from one window reach all the others, so the orb
  // mirrors agent-side states (speaking/idle) the voice broadcast misses.
  ipcMain.on('core:announce', (event, state: unknown) => {
    if (typeof state !== 'string') return
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents === event.sender) continue
      win.webContents.send('core:remote', state)
    }
  })
}

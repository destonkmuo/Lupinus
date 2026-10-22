import { BrowserWindow, ipcMain } from 'electron'

/** Hide/show the native macOS traffic lights without moving them. */
export function registerChromeHandlers(): void {
  ipcMain.on('window:sidebar-collapsed', (event, collapsed: unknown) => {
    if (process.platform !== 'darwin') return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    win.setWindowButtonVisibility(collapsed !== true)
  })
}

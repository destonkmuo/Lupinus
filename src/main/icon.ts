import { app, nativeImage } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

/**
 * Keep SeeMO's Dock icon applied on macOS.
 *
 * Packaged builds carry `build/icon.icns`, and the dev prelaunch script brands
 * the local Electron bundle with the same icon. macOS can still drop a custom
 * Dock icon when the activation policy changes (the PiP orb calls
 * `setActivationPolicy('regular')`) or when the app is (re)activated, so this
 * is re-applied at each of those points.
 */
let cached: Electron.NativeImage | null = null

export function applyDockIcon(): void {
  if (!is.dev || process.platform !== 'darwin' || !app.dock) return
  if (!cached) cached = nativeImage.createFromPath(icon)
  if (!cached.isEmpty()) app.dock.setIcon(cached)
}

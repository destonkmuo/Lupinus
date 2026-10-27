#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Brand the dev Electron bundle on macOS.
//
// Dev runs inside node_modules/electron/dist/Electron.app, and macOS takes the
// Dock hover label from that bundle's directory (plus its Info.plist), before
// any app JavaScript runs. `app.setName()` cannot change it. Rename the bundle,
// patch its display name, and swap its icon so dev shows Lupinus like a packaged
// build does.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') process.exit(0)

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const warn = (message) => console.warn(`[brand-dev-electron] ${message}`)

function readProductName() {
  try {
    const yml = readFileSync(join(projectRoot, 'electron-builder.yml'), 'utf8')
    const match = yml.match(/^productName:\s*(.+?)\s*$/m)
    if (match) return match[1].replace(/^['"]|['"]$/g, '')
  } catch {
    // Fall through to package.json.
  }
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
    return pkg.productName || pkg.name
  } catch {
    return null
  }
}

function plistGet(path, key) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

function plistSet(path, key, value) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, path], {
      stdio: 'ignore'
    })
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, path], {
      stdio: 'ignore'
    })
  }
}

const productName = readProductName()
if (!productName || productName.includes('/')) {
  warn(`Cannot use product name "${productName}" as a bundle name; leaving Electron alone`)
  process.exit(0)
}

const require = createRequire(import.meta.url)
let electronPackage
try {
  electronPackage = require.resolve('electron/package.json')
} catch (error) {
  warn(`Electron is not installed: ${error.message}`)
  process.exit(0)
}

const electronDir = dirname(electronPackage)
const distDir = join(electronDir, 'dist')
const pathFile = join(electronDir, 'path.txt')
if (!existsSync(pathFile)) {
  warn(`Missing ${pathFile}; leaving Electron alone`)
  process.exit(0)
}

const relativeExecutable = readFileSync(pathFile, 'utf8').trim()
const bundleName = relativeExecutable.split('/')[0]
if (!bundleName.endsWith('.app')) {
  warn(`Unexpected Electron path "${relativeExecutable}"; leaving it alone`)
  process.exit(0)
}

const desiredBundleName = `${productName}.app`
const desiredBundlePath = join(distDir, desiredBundleName)
let bundlePath = join(distDir, bundleName)
let nextRelativeExecutable = relativeExecutable

/**
 * True when `path` is the stock Electron dev bundle (possibly already renamed
 * and re-branded by an earlier run). Renaming is only ever allowed for these:
 * a prior product name is safe, anything else in dist/ is not ours to touch.
 * The bundle identifier is written by Electron's own install and our branding
 * only changes display name/icon, so it survives renames.
 */
function isDevElectronBundle(path) {
  const plist = join(path, 'Contents', 'Info.plist')
  return existsSync(plist) && plistGet(plist, 'CFBundleIdentifier') === 'com.github.Electron'
}

if (bundleName !== desiredBundleName) {
  if (!isDevElectronBundle(bundlePath)) {
    warn(`Refusing to rename unexpected bundle "${bundleName}"`)
    process.exit(0)
  }
  if (existsSync(desiredBundlePath)) {
    warn(`Both ${bundleName} and ${desiredBundleName} exist; leaving them alone`)
    process.exit(0)
  }
  try {
    renameSync(bundlePath, desiredBundlePath)
  } catch (error) {
    warn(`Could not rename the dev bundle: ${error.message}`)
    process.exit(0)
  }
  nextRelativeExecutable = relativeExecutable.replace(/^[^/]+\.app/, desiredBundleName)
  try {
    writeFileSync(pathFile, nextRelativeExecutable)
  } catch (error) {
    // Put the install back the way we found it so Electron still resolves.
    try {
      renameSync(desiredBundlePath, bundlePath)
    } catch {
      // Best effort.
    }
    warn(`Could not update ${pathFile}: ${error.message}`)
    process.exit(0)
  }
  bundlePath = desiredBundlePath
}

const plistPath = join(bundlePath, 'Contents', 'Info.plist')
if (!existsSync(plistPath)) {
  warn(`Missing ${plistPath}; leaving the display name alone`)
  process.exit(0)
}

let changed = []
try {
  changed = ['CFBundleDisplayName', 'CFBundleName'].filter(
    (key) => plistGet(plistPath, key) !== productName
  )
  for (const key of changed) plistSet(plistPath, key, productName)
  if (bundleName !== desiredBundleName || changed.length > 0) {
    console.log(`[brand-dev-electron] Dev Electron bundle identifies as "${productName}".`)
  }
} catch (error) {
  warn(`Could not patch ${plistPath}: ${error.message}`)
}

// Replacing the app's own icon matters for the PiP orb: showing it can make
// macOS drop the runtime Dock icon and fall back to the bundle icon. If that
// bundle icon is still Electron's, the Dock silently reverts.
const sourceIcon = join(projectRoot, 'build', 'icon.icns')
if (existsSync(sourceIcon)) {
  try {
    const iconFile = plistGet(plistPath, 'CFBundleIconFile') || 'electron.icns'
    const iconName = iconFile.includes('.') ? iconFile : `${iconFile}.icns`
    const bundleIcon = join(bundlePath, 'Contents', 'Resources', iconName)
    const alreadyBranded =
      existsSync(bundleIcon) && readFileSync(sourceIcon).equals(readFileSync(bundleIcon))
    if (!alreadyBranded) {
      copyFileSync(sourceIcon, bundleIcon)
      // Refresh LaunchServices so the Dock drops its cached Electron icon.
      try {
        execFileSync(LSREGISTER, ['-f', bundlePath], { stdio: 'ignore' })
      } catch {
        // Best effort; the next launch usually refreshes it anyway.
      }
      console.log('[brand-dev-electron] Replaced the dev bundle icon with Lupinus.')
    }
  } catch (error) {
    warn(`Could not replace the dev bundle icon: ${error.message}`)
  }
}

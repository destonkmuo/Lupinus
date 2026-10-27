import type { VaultFileInfo } from '../preload/vault'
import { app, dialog, ipcMain, shell } from 'electron'
import { promises as fs, existsSync, renameSync } from 'fs'
import { basename, join, resolve, sep } from 'path'

const CONFIG_FILE = 'vault.json'
const DEFAULT_VAULT_DIR = 'Lupinus'
const LEGACY_VAULT_DIR = 'SeeMO'

function userDataDir(): string {
  return app.getPath('userData')
}

function configPath(): string {
  return join(userDataDir(), CONFIG_FILE)
}

async function readConfiguredRoot(): Promise<string | null> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && 'root' in parsed) {
      const root = (parsed as { root: unknown }).root
      if (typeof root === 'string' && root.trim().length > 0) return root
    }
    return null
  } catch {
    return null
  }
}

async function writeConfiguredRoot(root: string): Promise<void> {
  await fs.mkdir(userDataDir(), { recursive: true })
  await fs.writeFile(configPath(), JSON.stringify({ root }, null, 2), 'utf8')
}

function defaultRoot(): string {
  try {
    const documents = app.getPath('documents')
    const root = join(documents, DEFAULT_VAULT_DIR)
    // Preserve a default vault from before the rebrand on first launch.
    if (!existsSync(root)) {
      const legacy = join(documents, LEGACY_VAULT_DIR)
      if (existsSync(legacy)) {
        try {
          renameSync(legacy, root)
        } catch {
          // Permission denied: fall through to a fresh default folder.
        }
      }
    }
    return root
  } catch {
    return join(userDataDir(), 'notes-vault')
  }
}

export async function getVaultRoot(): Promise<string> {
  const root = (await readConfiguredRoot()) ?? defaultRoot()
  await fs.mkdir(root, { recursive: true })
  return root
}

/** Keep every note flat inside the vault: no directories, no traversal. */
function resolveVaultFile(root: string, name: string): string {
  const base = basename(name)
    .replace(/[/\\]+/g, '')
    .trim()
  if (!base) throw new Error(`invalid note file name: ${name}`)
  const full = resolve(root, base)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`note escapes the vault: ${name}`)
  }
  return full
}

function ensureMarkdown(name: string): string {
  const clean = name.trim()
  return clean.toLowerCase().endsWith('.md') ? clean : `${clean}.md`
}

/**
 * JSON data files allowed to live alongside notes in the vault. Kept as an
 * explicit allowlist so a renderer bug can never read/write arbitrary paths.
 *
 * NOTE: these names are mirrored by CALENDAR_FILE / TASKS_FILE / TODO_FILE
 * (legacy, migration reads only) / CALENDARS_FILE in
 * src/renderer/src/planner.ts — add new data files in both places.
 */
const DATA_FILES = [
  'calendar.json',
  'tasks.json',
  'todo.json',
  'calendars.json',
  'routines.json'
] as const

function resolveDataFile(root: string, name: string): string {
  if (!DATA_FILES.includes(name as (typeof DATA_FILES)[number])) {
    throw new Error(`not a planner data file: ${name} (expected one of ${DATA_FILES.join(', ')})`)
  }
  return resolveVaultFile(root, name)
}

async function listVaultFiles(root: string): Promise<VaultFileInfo[]> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const files: VaultFileInfo[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    const full = resolveVaultFile(root, entry.name)
    const stat = await fs.stat(full)
    files.push({
      name: entry.name,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
      size: stat.size
    })
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export function registerVaultHandlers(): void {
  ipcMain.handle('vault:status', async () => ({ root: await getVaultRoot() }))

  ipcMain.handle('vault:choose', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    await writeConfiguredRoot(root)
    await fs.mkdir(root, { recursive: true })
    return { root }
  })

  ipcMain.handle('vault:reveal', async () => {
    const root = await getVaultRoot()
    shell.showItemInFolder(root)
    return { root }
  })

  ipcMain.handle('vault:list', async () => listVaultFiles(await getVaultRoot()))

  ipcMain.handle('vault:read', async (_event, name: unknown) => {
    if (typeof name !== 'string') throw new Error('note file name must be a string')
    const root = await getVaultRoot()
    const full = resolveVaultFile(root, name)
    const [content, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)])
    return { name: basename(full), content, mtimeMs: stat.mtimeMs }
  })

  ipcMain.handle('vault:write', async (_event, name: unknown, content: unknown) => {
    if (typeof name !== 'string') throw new Error('note file name must be a string')
    if (typeof content !== 'string') throw new Error('note content must be a string')
    const root = await getVaultRoot()
    const full = resolveVaultFile(root, ensureMarkdown(name))
    await fs.writeFile(full, content, 'utf8')
    return { name: basename(full) }
  })

  ipcMain.handle('vault:rename', async (_event, oldName: unknown, newName: unknown) => {
    if (typeof oldName !== 'string' || typeof newName !== 'string') {
      throw new Error('note file names must be strings')
    }
    const root = await getVaultRoot()
    const from = resolveVaultFile(root, oldName)
    const to = resolveVaultFile(root, ensureMarkdown(newName))
    if (from === to) return { name: basename(to) }
    try {
      await fs.access(to)
      throw new Error(`note already exists: ${basename(to)}`)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('note already exists')) throw error
      // Destination is free — fall through and rename.
    }
    await fs.rename(from, to)
    return { name: basename(to) }
  })

  ipcMain.handle('vault:remove', async (_event, name: unknown) => {
    if (typeof name !== 'string') throw new Error('note file name must be a string')
    const root = await getVaultRoot()
    try {
      await fs.unlink(resolveVaultFile(root, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  })

  ipcMain.handle('vault:readJson', async (_event, name: unknown) => {
    if (typeof name !== 'string') throw new Error('data file name must be a string')
    const root = await getVaultRoot()
    const full = resolveDataFile(root, name)
    try {
      return JSON.parse(await fs.readFile(full, 'utf8')) as unknown
    } catch (error) {
      // Missing file = empty dataset; corrupt file surfaces to the caller.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
      throw error
    }
  })

  ipcMain.handle('vault:writeJson', async (_event, name: unknown, data: unknown) => {
    if (typeof name !== 'string') throw new Error('data file name must be a string')
    if (!Array.isArray(data)) throw new Error('planner data must be an array')
    const root = await getVaultRoot()
    await fs.writeFile(resolveDataFile(root, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  })
}

import { dialog, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { basename, extname, join, resolve, sep } from 'path'
import { getVaultRoot } from './vault'

/**
 * PDF attachments.
 *
 * The note record lives in the vault as a normal `.md` file whose body is JSON
 * (`{"type":"pdf","file":"pdfs/…"}`). The actual PDF is copied into
 * `<vault>/pdfs/` so it stays with the notes and works offline.
 */

const DIR = 'pdfs'
const MAX_BYTES = 250 * 1024 * 1024

function pdfsDir(root: string): string {
  return join(root, DIR)
}

/** Contained resolution: flat file names only, never outside pdfs/. */
function resolvePdfFile(root: string, file: string): string {
  const normalized = file.replace(/\\/g, '/')
  const parts = normalized.split('/')
  const base = parts[1]
  if (parts.length !== 2 || parts[0] !== DIR || !base || base !== basename(base)) {
    throw new Error(`invalid PDF path: ${file}`)
  }
  if (extname(base).toLowerCase() !== '.pdf') throw new Error('PDF attachment must end in .pdf')
  const full = resolve(pdfsDir(root), base)
  const dir = resolve(pdfsDir(root))
  if (full !== dir && !full.startsWith(dir + sep)) {
    throw new Error(`PDF escapes the library: ${file}`)
  }
  return full
}

function titleFromName(name: string): string {
  const base = basename(name)
  const stem = base.toLowerCase().endsWith('.pdf') ? base.slice(0, -4) : base
  const title = stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return title || 'PDF'
}

function safePdfName(originalName: string): string {
  const base = basename(originalName)
  const stem = base.toLowerCase().endsWith('.pdf') ? base.slice(0, -4) : base
  const clean =
    stem
      .replace(/[^A-Za-z0-9._ -]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 80) || 'document'
  return `${clean}.pdf`
}

/** Keep the original file name, adding `-2`, `-3`, … only on collisions. */
async function uniquePdfName(root: string, originalName: string): Promise<string> {
  const base = safePdfName(originalName)
  const stem = base.slice(0, -4)
  let candidate = base
  let counter = 2
  for (;;) {
    try {
      await fs.access(join(pdfsDir(root), candidate))
      candidate = `${stem}-${counter}.pdf`
      counter += 1
    } catch {
      return candidate
    }
  }
}

/** PDF files start with `%PDF-`; allow a tiny preamble before the header. */
function hasPdfHeader(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 1024))).toString('latin1')
  return head.includes('%PDF-')
}

async function assertPdfSource(path: string): Promise<void> {
  const stat = await fs.stat(path)
  if (!stat.isFile()) throw new Error('PDF import needs a file.')
  if (stat.size > MAX_BYTES) throw new Error('PDF is too large (250 MB max).')
  const handle = await fs.open(path, 'r')
  try {
    const buffer = Buffer.alloc(1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (!hasPdfHeader(buffer.subarray(0, bytesRead))) throw new Error('That file is not a PDF.')
  } finally {
    await handle.close()
  }
}

function asBytes(data: unknown): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (data instanceof Uint8Array) return Buffer.from(data)
  throw new Error('PDF data is required.')
}

export function registerPdfHandlers(): void {
  ipcMain.handle('vault:importPdf', async (_event, sourcePath?: unknown) => {
    let source = typeof sourcePath === 'string' && sourcePath ? sourcePath : null
    if (!source) {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (result.canceled || result.filePaths.length === 0) return null
      source = result.filePaths[0]
    }
    if (extname(source).toLowerCase() !== '.pdf') throw new Error('Choose a PDF file.')
    await assertPdfSource(source)
    const root = await getVaultRoot()
    await fs.mkdir(pdfsDir(root), { recursive: true })
    const stored = await uniquePdfName(root, source)
    await fs.copyFile(source, join(pdfsDir(root), stored))
    return { file: `${DIR}/${stored}`, title: titleFromName(source) }
  })

  ipcMain.handle('vault:importPdfData', async (_event, name: unknown, data: unknown) => {
    if (typeof name !== 'string' || !name) throw new Error('PDF name is required.')
    if (extname(name).toLowerCase() !== '.pdf') throw new Error('That file is not a PDF.')
    const bytes = asBytes(data)
    if (bytes.byteLength === 0) throw new Error('PDF data is empty.')
    if (bytes.byteLength > MAX_BYTES) throw new Error('PDF is too large (250 MB max).')
    if (!hasPdfHeader(bytes)) throw new Error('That file is not a PDF.')
    const root = await getVaultRoot()
    await fs.mkdir(pdfsDir(root), { recursive: true })
    const stored = await uniquePdfName(root, name)
    await fs.writeFile(join(pdfsDir(root), stored), bytes)
    return { file: `${DIR}/${stored}`, title: titleFromName(name) }
  })

  ipcMain.handle('vault:listPdfs', async () => {
    const root = await getVaultRoot()
    try {
      const entries = await fs.readdir(pdfsDir(root), { withFileTypes: true })
      const out: { name: string; mtimeMs: number; birthtimeMs: number; size: number }[] = []
      for (const entry of entries) {
        if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.pdf') continue
        const stat = await fs.stat(join(pdfsDir(root), entry.name))
        out.push({
          name: entry.name,
          mtimeMs: stat.mtimeMs,
          birthtimeMs: stat.birthtimeMs,
          size: stat.size
        })
      }
      return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
      throw error
    }
  })

  ipcMain.handle('vault:readPdf', async (_event, file: unknown) => {
    if (typeof file !== 'string') throw new Error('PDF path must be a string.')
    const root = await getVaultRoot()
    const data = await fs.readFile(resolvePdfFile(root, file))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  })

  ipcMain.handle('vault:removePdf', async (_event, file: unknown) => {
    if (typeof file !== 'string') throw new Error('PDF path must be a string.')
    const root = await getVaultRoot()
    try {
      await fs.unlink(resolvePdfFile(root, file))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  })
}

import { dialog, ipcMain, protocol } from 'electron'
import { promises as fs } from 'fs'
import { basename, extname, join, resolve, sep } from 'path'
import { getVaultRoot } from './vault'

/**
 * Note pictures.
 *
 * Web pictures (`https://…`) render directly. Local files are copied into
 * `<vault>/images/` and served back through the privileged `lupinus-media://`
 * scheme, so notes keep working offline and `.md` files stay portable
 * (vault-relative `images/…` paths, resolved at render time).
 */

const SCHEME = 'lupinus-media'
// Notes written before the rebrand still point at the old scheme.
const LEGACY_SCHEME = 'seemo-media'
const DIR = 'images'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
}

const ALLOWED_EXTENSIONS = Object.keys(MIME_BY_EXT).map((ext) => ext.slice(1))

function imagesDir(root: string): string {
  return join(root, DIR)
}

/** Contained resolution: flat file names only, never outside images/. */
function resolveImageFile(root: string, name: string): string {
  const base = basename(name)
  if (!base || base === '.' || base === '..') throw new Error(`invalid image name: ${name}`)
  const full = resolve(imagesDir(root), base)
  const dir = resolve(imagesDir(root))
  if (full !== dir && !full.startsWith(dir + sep)) {
    throw new Error(`image escapes the library: ${name}`)
  }
  return full
}

/** Must run before `app.whenReady()` so the scheme is privileged. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged(
    [SCHEME, LEGACY_SCHEME].map((scheme) => ({
      scheme,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }))
  )
}

/** Serve `<vault>/images/<file>` at `lupinus-media://images/<file>`. */
function handleMediaRequests(): void {
  for (const scheme of [SCHEME, LEGACY_SCHEME]) {
    protocol.handle(scheme, async (request) => {
      try {
        const url = new URL(request.url)
        // basename() drops any traversal attempt; only flat names are served.
        const name = basename(decodeURIComponent(url.pathname))
        if (!name) return new Response('Not found', { status: 404 })
        const mime = MIME_BY_EXT[extname(name).toLowerCase()]
        if (!mime) return new Response('Unsupported type', { status: 415 })
        const data = await fs.readFile(resolveImageFile(await getVaultRoot(), name))
        return new Response(data, { headers: { 'content-type': mime } })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })
  }
}

export function registerMediaHandlers(): void {
  handleMediaRequests()

  // Shared store step: sanitized unique name under images/, returns the
  // vault-relative path plus ready-to-insert markdown.
  const storePicture = async (
    originalName: string,
    ext: string,
    write: (dest: string) => Promise<void>
  ): Promise<{ file: string; markdown: string }> => {
    const root = await getVaultRoot()
    await fs.mkdir(imagesDir(root), { recursive: true })
    // Strip the extension case-insensitively (`photo.JPG` must not keep it).
    const stem =
      basename(originalName)
        .slice(0, -ext.length || undefined)
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .slice(0, 60) || 'image'
    const stored = `${Date.now()}-${stem}${ext}`
    await write(join(imagesDir(root), stored))
    const rel = `${DIR}/${stored}`
    return { file: rel, markdown: `![${stem}](${rel})` }
  }

  ipcMain.handle('vault:importPicture', async (_event, sourcePath?: unknown) => {
    // Optional path (e.g. future callers); otherwise ask with a picker.
    let source: string | null = typeof sourcePath === 'string' && sourcePath ? sourcePath : null
    if (!source) {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ALLOWED_EXTENSIONS }]
      })
      if (result.canceled || result.filePaths.length === 0) return null
      source = result.filePaths[0]
    }
    const ext = extname(source).toLowerCase()
    if (!MIME_BY_EXT[ext]) throw new Error('Unsupported image format.')
    const from = source
    return storePicture(basename(from), ext, (dest) => fs.copyFile(from, dest))
  })

  // Drops: the renderer cannot see filesystem paths on drop objects, so it
  // sends bytes (always available via File.arrayBuffer()).
  ipcMain.handle('vault:importPictureData', async (_event, name: unknown, data: unknown) => {
    if (typeof name !== 'string' || !name) throw new Error('image name required')
    const bytes =
      data instanceof ArrayBuffer
        ? Buffer.from(data)
        : data instanceof Uint8Array
          ? Buffer.from(data)
          : null
    if (!bytes || bytes.byteLength === 0) throw new Error('image data required')
    if (bytes.byteLength > 50 * 1024 * 1024) throw new Error('image too large (50 MB max)')
    const ext = extname(name).toLowerCase()
    if (!MIME_BY_EXT[ext]) throw new Error('Unsupported image format.')
    return storePicture(name, ext, (dest) => fs.writeFile(dest, bytes))
  })
}

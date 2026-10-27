import { app, dialog, ipcMain, protocol } from 'electron'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { basename, join } from 'path'

/**
 * Custom alarm sounds.
 *
 * Chosen files are copied into `<userData>/alarm-sounds` and served back to
 * the renderer through the privileged `lupinus-alarm://` scheme. Streaming from
 * disk (rather than inlining base64) keeps arbitrary-length audio working and
 * means the store only ever holds a short URL — a multi-megabyte data URL in
 * the persisted store would bloat localStorage and slow every state write.
 */

const SCHEME = 'lupinus-alarm'
// Alarm URLs saved before the rebrand still use the old scheme.
const LEGACY_SCHEME = 'seemo-alarm'
const HOST = 'sounds'

const MIME_BY_EXT: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac'
}

const ALLOWED_EXTENSIONS = Object.keys(MIME_BY_EXT).map((ext) => ext.slice(1))

function soundsDir(): string {
  return join(app.getPath('userData'), 'alarm-sounds')
}

/** Must run before `app.whenReady()` so the scheme is privileged. */
export function registerAlarmScheme(): void {
  protocol.registerSchemesAsPrivileged(
    [SCHEME, LEGACY_SCHEME].map((scheme) => ({
      scheme,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }))
  )
}

/** Serve `<userData>/alarm-sounds/<file>` at `lupinus-alarm://sounds/<file>`. */
function handleAlarmRequests(): void {
  for (const scheme of [SCHEME, LEGACY_SCHEME]) {
    protocol.handle(scheme, async (request) => {
      try {
        const url = new URL(request.url)
        // basename() drops any traversal attempt; only flat names are served.
        const name = basename(decodeURIComponent(url.pathname))
        if (!name) return new Response('Not found', { status: 404 })
        const dot = name.lastIndexOf('.')
        const mime = dot >= 0 ? MIME_BY_EXT[name.slice(dot).toLowerCase()] : undefined
        if (!mime) return new Response('Unsupported type', { status: 415 })
        const data = await fs.readFile(join(soundsDir(), name))
        return new Response(data, { headers: { 'content-type': mime } })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })
  }
}

export function registerAlarmHandlers(): void {
  handleAlarmRequests()

  ipcMain.handle('alarm:importSound', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ALLOWED_EXTENSIONS }]
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const source = result.filePaths[0]
    const dot = source.lastIndexOf('.')
    const ext = dot >= 0 ? source.slice(dot).toLowerCase() : ''

    if (!MIME_BY_EXT[ext]) throw new Error('Unsupported audio format.')

    const dir = soundsDir()
    await fs.mkdir(dir, { recursive: true })

    // Re-encode mp3 to wav on import so the browser can always decode the preview.
    // Other formats (wav, ogg, m4a, flac, aac) are kept as-is since they are
    // natively supported by the platform audio decoder.
    const stem =
      basename(source, ext)
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .slice(0, 40) || 'sound'
    let storedPath: string
    if (ext === '.mp3') {
      const outPath = join(dir, `${Date.now()}-${stem}.wav`)
      await new Promise<void>((resolve, reject) => {
        execFile(
          'ffmpeg',
          ['-y', '-i', source, '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '1', outPath],
          (err) => {
            if (err) reject(err)
            else resolve()
          }
        )
      }).catch((err: unknown) => {
        const missing =
          err instanceof Error &&
          (err.message.includes('ENOENT') || err.message.includes('not found'))
        throw new Error(
          missing
            ? 'Could not convert the mp3: ffmpeg is not installed or not on PATH.'
            : `Could not convert the mp3: ${err instanceof Error ? err.message : String(err)}`
        )
      })
      storedPath = outPath
    } else {
      storedPath = join(dir, `${Date.now()}-${stem}${ext}`)
      await fs.copyFile(source, storedPath)
    }

    const storedName = basename(storedPath)
    const storedExt =
      storedName.lastIndexOf('.') >= 0
        ? storedName.slice(storedName.lastIndexOf('.')).toLowerCase()
        : ''
    const mimeType = MIME_BY_EXT[storedExt]
    const url = `${SCHEME}://${HOST}/${storedName}`

    return { name: storedName, url, mimeType }
  })
}

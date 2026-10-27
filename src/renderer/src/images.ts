/**
 * Note picture sources.
 *
 * Web pictures (`https://…`) render directly. Vault-relative paths
 * (`images/pic.png`, as written by the picture importer) stream through the
 * privileged `lupinus-media://` scheme, so notes keep working offline and the
 * `.md` files stay portable for other editors.
 */

const SAFE_URL = /^(https?:\/\/|mailto:|#|\/)/i
const KNOWN_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
/** Picture URLs written before the rebrand still point at the old scheme. */
const LEGACY_MEDIA_PREFIX = 'seemo-media://'

/**
 * Resolve an image source for rendering. Returns undefined for anything
 * unsafe: absolute paths, traversal, `file:`/`data:`/unknown schemes.
 */
export function resolveImageSrc(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('lupinus-media://') || trimmed.startsWith(LEGACY_MEDIA_PREFIX)) {
    return trimmed
  }
  // Absolute filesystem paths must never reach an <img> tag.
  if (trimmed.startsWith('/')) return undefined
  if (SAFE_URL.test(trimmed)) return trimmed
  if (KNOWN_SCHEME_RE.test(trimmed)) return undefined
  if (trimmed.includes('\\')) return undefined
  const parts = trimmed.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return undefined
  return `lupinus-media://${parts.map(encodeURIComponent).join('/')}`
}

/** Wrap alignment for a docked (unlocked) picture. */
export type ImageSide = 'left' | 'right' | 'center'

/** Per-image dock/resize controls threaded from the note page. */
export interface ImageControls {
  /** Raw markdown sources currently docked (float + wrap instead of inline). */
  docked: Set<string>
  /** Dock side by raw source. */
  sides: Record<string, ImageSide>
  /** Pinned widths by raw source (inline and docked alike). */
  widths: Record<string, number>
  onToggleFloat: (src: string, side?: ImageSide) => void
  onCommitWidth: (src: string, w: number | null) => void
  onSetSide: (src: string, side: ImageSide) => void
  onLock: (src: string) => void
  onCommitMove: (
    src: string,
    target: { blockIndex: number; above: boolean; side: ImageSide } | null
  ) => void
}

/** Importable picture extensions (mirrors the main-process allowlist). */
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i

/**
 * Import one dropped file by bytes. Drops never expose filesystem paths to
 * the page, so the content travels via File.arrayBuffer() instead.
 * Resolves to ready-to-insert markdown; throws a human-readable reason.
 */
export async function importDroppedPicture(file: File): Promise<string> {
  if (!IMAGE_EXT_RE.test(file.name)) throw new Error(`${file.name || 'file'} (not an image)`)
  const data = await file.arrayBuffer()
  const result = await window.api.vault.importPictureData(file.name, data)
  return result.markdown
}

/** Raw `![alt](src)` sources mentioned in markdown. */
export function contentImageSrcs(content: string): Set<string> {
  const found = new Set<string>()
  const re = /!\[[^\]\n]*\]\(([^)\n]+)\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) found.add(match[1].trim())
  return found
}

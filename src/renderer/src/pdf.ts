/**
 * PDF notes.
 *
 * A PDF is a note whose body is strict JSON (`{"type":"pdf","file":"pdfs/…"}`)
 * and whose binary lives in the vault under `pdfs/`. The title stays on the
 * note record, exactly like study children, so renaming the note never moves
 * or renames the attachment.
 */

export interface PdfNote {
  type: 'pdf'
  /** Vault-relative attachment path, always `pdfs/<flat-name>.pdf`. */
  file: string
}

const PDF_FILE_RE = /^pdfs\/[A-Za-z0-9._-]+\.pdf$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** True when a vault-relative path is a safe flat PDF attachment. */
export function isPdfVaultFile(value: string): boolean {
  return PDF_FILE_RE.test(value)
}

/** Parse a PDF note body. Returns null for markdown, study JSON, or malformed data. */
export function parsePdfNote(body: string): PdfNote | null {
  const text = body.trim()
  if (!text.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed) || parsed.type !== 'pdf') return null
    if (typeof parsed.file !== 'string') return null
    const file = parsed.file.trim()
    if (!isPdfVaultFile(file)) return null
    return { type: 'pdf', file }
  } catch {
    return null
  }
}

/** Serialize the legacy body for a PDF note (migration/tests only). */
export function pdfNoteBody(file: string): string {
  if (!isPdfVaultFile(file)) throw new Error('invalid PDF attachment path')
  return `${JSON.stringify({ type: 'pdf', file }, null, 2)}\n`
}

/** The PDF attachment backing a note, if it is a PDF note. */
export function pdfFileForNote(note: { fileName: string; content: string }): string | null {
  // New PDF notes point straight at the attachment; older ones used a JSON
  // markdown wrapper. Both resolve to the same vault-relative PDF file.
  if (isPdfVaultFile(note.fileName)) return note.fileName
  return parsePdfNote(note.content)?.file ?? null
}

/** Human-readable title derived from a stored PDF file name. */
export function titleFromPdfFileName(fileName: string): string {
  const base = fileName.split('/').pop() ?? fileName
  const stem = base.replace(/\.pdf$/i, '')
  const title = stem
    .replace(/^\d{13}-/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return title || 'PDF'
}

/** Display name for a PDF attachment (drops legacy timestamp prefixes). */
export function pdfDisplayName(file: string): string {
  const base = file.split('/').pop() ?? file
  return base.replace(/^\d{13}-/, '')
}

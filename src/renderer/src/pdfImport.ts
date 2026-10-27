import { useAppStore } from './store/appStore'

export interface ImportedPdf {
  file: string
  title: string
}

/** Finder may report an empty MIME type, so the extension is authoritative. */
export function isPdfFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf'
}

/** Drop path: the renderer sends bytes because File objects hide their path. */
export async function importDroppedPdf(file: File): Promise<ImportedPdf> {
  const data = await file.arrayBuffer()
  return window.api.vault.importPdfData(file.name, data)
}

/**
 * Import PDF files into a space. Every valid file becomes a note and opens in
 * a tab (the last one wins), matching the normal create-note flow.
 */
export async function importPdfFiles(files: File[], spaceId?: string): Promise<number> {
  let count = 0
  for (const file of files) {
    if (!isPdfFile(file)) continue
    const imported = await importDroppedPdf(file)
    useAppStore.getState().createPdfNote(imported.title, imported.file, spaceId)
    count += 1
  }
  return count
}

/** Picker path: main copies the chosen file into the vault. */
export async function importPdfFromDialog(spaceId?: string): Promise<boolean> {
  const imported = await window.api.vault.importPdf()
  if (!imported) return false
  useAppStore.getState().createPdfNote(imported.title, imported.file, spaceId)
  return true
}

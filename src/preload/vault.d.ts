export interface VaultFileInfo {
  name: string
  mtimeMs: number
  birthtimeMs: number
  size: number
}

export interface VaultReadResult {
  name: string
  content: string
  mtimeMs: number
}

export interface PdfImportResult {
  file: string
  title: string
}

export interface PdfFileInfo {
  name: string
  mtimeMs: number
  birthtimeMs: number
  size: number
}

export interface VaultApi {
  status(): Promise<{ root: string }>
  choose(): Promise<{ root: string } | null>
  reveal(): Promise<{ root: string }>
  list(): Promise<VaultFileInfo[]>
  read(name: string): Promise<VaultReadResult>
  write(name: string, content: string): Promise<{ name: string }>
  rename(oldName: string, newName: string): Promise<{ name: string }>
  remove(name: string): Promise<void>
  readJson(name: string): Promise<unknown>
  writeJson(name: string, data: unknown[]): Promise<void>
  importPicture(sourcePath?: string): Promise<{ file: string; markdown: string } | null>
  importPictureData(name: string, data: ArrayBuffer): Promise<{ file: string; markdown: string }>
  importPdf(sourcePath?: string): Promise<PdfImportResult | null>
  importPdfData(name: string, data: ArrayBuffer): Promise<PdfImportResult>
  listPdfs(): Promise<PdfFileInfo[]>
  readPdf(file: string): Promise<Uint8Array>
  removePdf(file: string): Promise<void>
}

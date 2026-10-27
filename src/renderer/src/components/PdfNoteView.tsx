import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { ChevronLeftIcon, ChevronRightIcon, PdfIcon } from './icons'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

interface PdfNoteViewProps {
  file: string
  title: string
}

/** One-page-at-a-time PDF reader with page navigation, zoom, and fit-width. */
export default function PdfNoteView({ file, title }: PdfNoteViewProps): React.JSX.Element {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [numPages, setNumPages] = useState(0)
  const [fit, setFit] = useState(true)
  const [zoom, setZoom] = useState(1.25)
  const [effectiveScale, setEffectiveScale] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [resizeTick, setResizeTick] = useState(0)

  const docRef = useRef<PDFDocumentProxy | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const scaleRef = useRef(1)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await window.api.vault.readPdf(file)
        if (cancelled) return
        const next = await pdfjsLib.getDocument({ data }).promise
        if (cancelled) {
          void next.destroy()
          return
        }
        docRef.current = next
        setDoc(next)
        setNumPages(next.numPages)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not open the PDF.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      const current = docRef.current
      docRef.current = null
      if (current) void current.destroy()
    }
  }, [file])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setResizeTick((tick) => tick + 1))
    })
    observer.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!doc) return
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    let cancelled = false
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        const available = Math.max(240, wrap.clientWidth)
        const fitScale = Math.max(0.2, Math.min(3, (available - 4) / base.width))
        const scale = fit ? fitScale : zoom
        const viewport = page.getViewport({ scale })
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr))
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr))
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Could not create a canvas context.')
        renderTaskRef.current?.cancel()
        const task = page.render({
          canvasContext: context,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
        })
        renderTaskRef.current = task
        await task.promise
        if (cancelled) return
        scaleRef.current = scale
        setEffectiveScale(scale)
      } catch (err) {
        if (cancelled) return
        const name = (err as { name?: string } | null)?.name
        if (name === 'RenderingCancelledException') return
        setError(err instanceof Error ? err.message : 'Could not render this page.')
      }
    })()
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
    }
  }, [doc, pageNumber, fit, zoom, resizeTick])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setPageNumber((page) => Math.max(1, page - 1))
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        setPageNumber((page) => Math.min(numPages || 1, page + 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [numPages])

  const zoomBy = (factor: number): void => {
    setFit(false)
    setZoom(Math.max(0.25, Math.min(4, scaleRef.current * factor)))
  }

  return (
    <section className="pdf-view" aria-label={`PDF: ${title.trim() || 'Untitled'}`}>
      <div className="pdf-view__bar">
        <span className="pdf-view__badge">
          <PdfIcon size={15} />
          PDF
        </span>
        <div className="pdf-view__nav">
          <button
            type="button"
            className="pdf-view__btn"
            title="Previous page"
            aria-label="Previous page"
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber((page) => Math.max(1, page - 1))}
          >
            <ChevronLeftIcon size={16} />
          </button>
          <span className="pdf-view__page">
            {numPages > 0 ? `${pageNumber} / ${numPages}` : '—'}
          </span>
          <button
            type="button"
            className="pdf-view__btn"
            title="Next page"
            aria-label="Next page"
            disabled={numPages === 0 || pageNumber >= numPages}
            onClick={() => setPageNumber((page) => Math.min(numPages || 1, page + 1))}
          >
            <ChevronRightIcon size={16} />
          </button>
        </div>
        <span className="pdf-view__spacer" />
        <button
          type="button"
          className="pdf-view__btn"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => zoomBy(1 / 1.2)}
        >
          −
        </button>
        <span className="pdf-view__zoom">{Math.round(effectiveScale * 100)}%</span>
        <button
          type="button"
          className="pdf-view__btn"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => zoomBy(1.2)}
        >
          +
        </button>
        <button
          type="button"
          className={`pdf-view__fit${fit ? ' is-active' : ''}`}
          title="Fit page width"
          aria-pressed={fit}
          onClick={() => setFit(true)}
        >
          Fit
        </button>
      </div>
      <div className="pdf-view__canvas-wrap" ref={wrapRef}>
        {loading && <p className="pdf-view__status">Opening PDF…</p>}
        {error && <p className="pdf-view__status is-error">{error}</p>}
        <canvas
          ref={canvasRef}
          className="pdf-view__canvas"
          hidden={loading || Boolean(error)}
          aria-label={`PDF page ${pageNumber}`}
        />
      </div>
    </section>
  )
}

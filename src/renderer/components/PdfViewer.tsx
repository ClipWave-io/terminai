import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker&inline'

GlobalWorkerOptions.workerPort = new PdfWorker()

export default function PdfViewer({ content }: { content: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1), [zoom, setZoom] = useState(1), [error, setError] = useState('')
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    if (!host.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(host.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let cancelled = false
    setDocument(null); setPage(1); setError('')
    const task = getDocument({ data: Uint8Array.from(atob(content), ch => ch.charCodeAt(0)), useSystemFonts: true })
    task.promise.then(pdf => { if (!cancelled) setDocument(pdf) }).catch(err => { if (!cancelled) setError(err?.name === 'PasswordException' ? 'This PDF is password-protected. Open an unlocked copy to view it here.' : 'Could not open this PDF.') })
    return () => { cancelled = true; void task.destroy() }
  }, [content])
  useEffect(() => {
    if (!document || !canvas.current || width < 1) return
    let cancelled = false
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined
    void document.getPage(page).then(pdfPage => {
      if (cancelled || !canvas.current) return
      const base = pdfPage.getViewport({ scale: 1 })
      const scale = Math.min(3, Math.max(0.1, (width - 32) / base.width)) * zoom
      const viewport = pdfPage.getViewport({ scale })
      const pixelRatio = Math.min(2, devicePixelRatio || 1)
      canvas.current.width = Math.ceil(viewport.width * pixelRatio)
      canvas.current.height = Math.ceil(viewport.height * pixelRatio)
      canvas.current.style.width = `${viewport.width}px`
      canvas.current.style.height = `${viewport.height}px`
      render = pdfPage.render({ canvas: canvas.current, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] })
      return render.promise
    }).catch(err => { if (!cancelled && err?.name !== 'RenderingCancelledException') setError('Could not render this PDF page.') })
    return () => { cancelled = true; render?.cancel() }
  }, [document, page, zoom, width])
  return <div className="pdf-viewer">
    <div className="pdf-toolbar">
      <button className="btn" aria-label="Previous PDF page" disabled={page <= 1} onClick={() => setPage(page - 1)}>←</button>
      <span role="status">{document ? `Page ${page} of ${document.numPages}` : error || 'Loading PDF…'}</span>
      <button className="btn" aria-label="Next PDF page" disabled={!document || page >= document.numPages} onClick={() => setPage(page + 1)}>→</button>
      <button className="btn" aria-label="Zoom out PDF" disabled={zoom <= 0.5} onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}>−</button>
      <button className="btn" onClick={() => setZoom(1)}>Fit width</button>
      <button className="btn" aria-label="Zoom in PDF" disabled={zoom >= 2} onClick={() => setZoom(Math.min(2, zoom + 0.25))}>+</button>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="pdf-pages" ref={host}><canvas ref={canvas} aria-label={`PDF page ${page}`} /></div>
  </div>
}

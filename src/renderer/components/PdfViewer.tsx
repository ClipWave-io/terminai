import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker&inline'

GlobalWorkerOptions.workerPort = new PdfWorker()

const Svg = ({ d }: { d: string }) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
const I = { prev: 'M15 6l-6 6 6 6', next: 'M9 6l6 6-6 6', minus: 'M6 12h12', plus: 'M12 6v12M6 12h12', width: 'M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3', page: 'M7 3h10v18H7ZM10 8h4', rotate: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6', finder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', open: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5', copy: 'M9 9h11v11H9ZM5 15H4V4h11v1', full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }

/** A PDF in the Files pane: pages, zoom (fit width, fit page, steps), rotate, and the file's own actions on the right. */
export default function PdfViewer({ content, onReveal, onOpen, onCopyPath, onFull }: { content: string; onReveal?: () => void; onOpen?: () => void; onCopyPath?: () => void; onFull?: () => void }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1), [zoom, setZoom] = useState(1), [error, setError] = useState(''), [fit, setFit] = useState<'width' | 'page'>('width'), [rotation, setRotation] = useState(0), [typed, setTyped] = useState('')
  const [height, setHeight] = useState(600)
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    if (!host.current) return
    const observer = new ResizeObserver(([entry]) => { setWidth(entry.contentRect.width); setHeight(entry.contentRect.height) })
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
      const base = pdfPage.getViewport({ scale: 1, rotation })
      const fitScale = fit === 'page' ? Math.min((width - 32) / base.width, (height - 32) / base.height) : (width - 32) / base.width
      const scale = Math.min(4, Math.max(0.1, fitScale)) * zoom
      const viewport = pdfPage.getViewport({ scale, rotation })
      const pixelRatio = Math.min(2, devicePixelRatio || 1)
      canvas.current.width = Math.ceil(viewport.width * pixelRatio)
      canvas.current.height = Math.ceil(viewport.height * pixelRatio)
      canvas.current.style.width = `${viewport.width}px`
      canvas.current.style.height = `${viewport.height}px`
      render = pdfPage.render({ canvas: canvas.current, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] })
      return render.promise
    }).catch(err => { if (!cancelled && err?.name !== 'RenderingCancelledException') setError('Could not render this PDF page.') })
    return () => { cancelled = true; render?.cancel() }
  }, [document, page, zoom, width, height, fit, rotation])
  const pages = document?.numPages ?? 0
  const go = (n: number) => { if (pages) setPage(Math.min(pages, Math.max(1, n))) }
  // Arrow keys and Page Up / Page Down turn pages when the viewer has focus.
  const keys = (e: React.KeyboardEvent) => { if ((e.target as HTMLElement).tagName === 'INPUT') return; if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key)) { e.preventDefault(); go(page + 1) } if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); go(page - 1) } }
  return <div className="pdf-viewer" tabIndex={0} onKeyDown={keys}>
    <div className="pdf-toolbar">
      <span className="pdf-group">
        <button className="pdf-btn" title="Previous page" aria-label="Previous PDF page" disabled={page <= 1} onClick={() => go(page - 1)}><Svg d={I.prev} /></button>
        {document ? <span className="pdf-page"><input aria-label="Page" value={typed || String(page)} onChange={e => setTyped(e.target.value.replace(/\D/g, ''))}
          onBlur={() => { if (typed) go(Number(typed)); setTyped('') }} onKeyDown={e => { if (e.key === 'Enter') { go(Number(typed || page)); setTyped(''); (e.target as HTMLInputElement).blur() } }} /> of {pages}</span>
          : <span className="pdf-page" role="status">{error || 'Loading…'}</span>}
        <button className="pdf-btn" title="Next page" aria-label="Next PDF page" disabled={!document || page >= pages} onClick={() => go(page + 1)}><Svg d={I.next} /></button>
      </span>
      <span className="pdf-group">
        <button className="pdf-btn" title="Zoom out" aria-label="Zoom out PDF" disabled={zoom <= 0.5} onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}><Svg d={I.minus} /></button>
        <button className="pdf-zoom" title="Back to 100%" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
        <button className="pdf-btn" title="Zoom in" aria-label="Zoom in PDF" disabled={zoom >= 3} onClick={() => setZoom(Math.min(3, zoom + 0.25))}><Svg d={I.plus} /></button>
        <button className={`pdf-btn${fit === 'width' ? ' on' : ''}`} title="Fit width" aria-label="Fit width" aria-pressed={fit === 'width'} onClick={() => { setFit('width'); setZoom(1) }}><Svg d={I.width} /></button>
        <button className={`pdf-btn${fit === 'page' ? ' on' : ''}`} title="Fit the whole page" aria-label="Fit page" aria-pressed={fit === 'page'} onClick={() => { setFit('page'); setZoom(1) }}><Svg d={I.page} /></button>
        <button className="pdf-btn" title="Rotate" aria-label="Rotate" onClick={() => setRotation((rotation + 90) % 360)}><Svg d={I.rotate} /></button>
      </span>
      {(onReveal || onOpen || onCopyPath || onFull) && <span className="pdf-group">
        {onCopyPath && <button className="pdf-btn" title="Copy the file's path" aria-label="Copy path" onClick={onCopyPath}><Svg d={I.copy} /></button>}
        {onReveal && <button className="pdf-btn" title="Show in Finder" aria-label="Show in Finder" onClick={onReveal}><Svg d={I.finder} /></button>}
        {onOpen && <button className="pdf-btn" title="Open in the default app (Preview)" aria-label="Open in the default app" onClick={onOpen}><Svg d={I.open} /></button>}
        {onFull && <button className="pdf-btn" title="Full size (Esc to go back)" aria-label="Full size" onClick={onFull}><Svg d={I.full} /></button>}
      </span>}
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="pdf-pages" ref={host}><canvas ref={canvas} aria-label={`PDF page ${page}`} /></div>
  </div>
}

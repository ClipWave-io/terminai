import { useEffect, useRef, type JSX } from 'react'

/**
 * TerminAI Browser inside the window: the real Chromium (extensions, Claude in Chrome, logins) sits exactly on this
 * pane and moves, resizes and hides with it (native/browser-glue.m keeps it there). The pane only says where it is.
 */
export function FullBrowserPane({ visible, layoutKey, mode, onPopOut, onBringBack, onClose }: { visible: boolean; layoutKey: string; mode: 'pane' | 'popped' | 'opening'; onPopOut: () => void; onBringBack: () => void; onClose: () => void }): JSX.Element {
  const slot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = slot.current
    if (!element) return
    const report = () => {
      const { x, y, width, height } = element.getBoundingClientRect()
      void window.term.browser.fullPane({ x, y, width, height, visible: visible && mode === 'pane' && document.visibilityState === 'visible' })
    }
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    document.addEventListener('visibilitychange', report)
    // Panes slide when the sidebar or another pane changes size: follow for a moment after any change.
    const settle = [60, 200, 400].map(ms => setTimeout(report, ms))
    report()
    return () => { observer.disconnect(); window.removeEventListener('resize', report); document.removeEventListener('visibilitychange', report); settle.forEach(clearTimeout); void window.term.browser.fullPane(null) }
  }, [visible, layoutKey, mode])
  const icon = (d: string) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  // A slim strip on top (TerminAI's own, so it always works): the name, pop out, close. The browser fills the rest.
  return <aside className="browser-pane full-browser" aria-label="TerminAI Browser">
    <div className="full-browser-strip">
      <span>TerminAI Browser</span>
      {mode === 'pane' && <button title="Open in its own window" aria-label="Pop out" onClick={onPopOut}>{icon('M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5')}</button>}
      <button title="Close the browser pane (the browser keeps running for your agents)" aria-label="Close browser pane" onClick={onClose}>{icon('M6 6l12 12M18 6L6 18')}</button>
    </div>
    <div className="full-browser-slot" ref={slot}>
      {mode === 'popped' ? <div className="full-browser-popped"><strong>TerminAI Browser is in its own window</strong><small>Your tabs, logins and the Claude extension are all there.</small>
        <span><button className="btn primary" onClick={onBringBack}>Bring it back here</button><button className="btn" onClick={onClose}>Close the pane</button></span></div>
        : <span>{mode === 'opening' ? 'Starting TerminAI Browser…' : 'TerminAI Browser opens here…'}</span>}
    </div>
  </aside>
}

import { useEffect, useRef, type JSX } from 'react'

/**
 * TerminAI Browser inside the window: the real Chromium (extensions, Claude in Chrome, logins) sits exactly on this
 * pane and moves, resizes and hides with it (native/browser-glue.m keeps it there). The pane only says where it is.
 */
export function FullBrowserPane({ visible, layoutKey, onClose }: { visible: boolean; layoutKey: string; onClose: () => void }): JSX.Element {
  const slot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = slot.current
    if (!element) return
    const report = () => {
      const { x, y, width, height } = element.getBoundingClientRect()
      void window.term.browser.fullPane({ x, y, width, height, visible: visible && document.visibilityState === 'visible' })
    }
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    document.addEventListener('visibilitychange', report)
    // Panes slide when the sidebar or another pane changes size: follow for a moment after any change.
    const settle = [60, 200, 400].map(ms => setTimeout(report, ms))
    report()
    return () => { observer.disconnect(); window.removeEventListener('resize', report); document.removeEventListener('visibilitychange', report); settle.forEach(clearTimeout); void window.term.browser.fullPane(null) }
  }, [visible, layoutKey])
  return <aside className="browser-pane full-browser" aria-label="TerminAI Browser">
    <div className="full-browser-bar">
      <strong>TerminAI Browser</strong>
      <span className="full-browser-note">Extensions, Claude in Chrome and your logins</span>
      <button className="btn" title="Show it as a window of its own" onClick={() => void window.term.browser.fullInPane(false)}>Pop out</button>
      <button className="btn" title="Close the pane (the browser keeps running for your agents)" aria-label="Close browser pane" onClick={onClose}>×</button>
    </div>
    <div className="full-browser-slot" ref={slot}><span>TerminAI Browser opens here…</span></div>
  </aside>
}

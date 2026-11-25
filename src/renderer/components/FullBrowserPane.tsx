import { useEffect, useRef, type JSX } from 'react'

/**
 * TerminAI Browser inside the window: the real Chromium (extensions, Claude in Chrome, logins) sits exactly on this
 * pane and moves, resizes and hides with it (native/browser-glue.m keeps it there). The pane only says where it is.
 */
export function FullBrowserPane({ visible, layoutKey }: { visible: boolean; layoutKey: string; onClose?: () => void }): JSX.Element {
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
  // No header of its own: the browser fills the pane, and its × and pop-out sit in the tab strip (native/browser-glue.m).
  return <aside className="browser-pane full-browser" aria-label="TerminAI Browser">
    <div className="full-browser-slot" ref={slot}><span>TerminAI Browser opens here…</span></div>
  </aside>
}

import type { Terminal } from '@xterm/xterm'

/** Recovered Claude selection fix, with cleanup and native modifier handling.
 * xterm 5.5.0 is pinned because its public API cannot separate clicks and drags
 * while a TUI enables mouse tracking. Plain drags select; plain clicks reach it.
 */
export function installSelectionOverride(term: Terminal, host: HTMLElement): () => void {
  const core = (term as any)._core
  const selection = core?._selectionService, mouse = core?.coreMouseService, mouseUtil = core?._mouseService
  if (!selection || !mouse || !mouseUtil) return () => {}
  const original = selection.shouldForceSelection
  selection.shouldForceSelection = (event: MouseEvent): boolean =>
    event.button === 0 && !event.ctrlKey || original.call(selection, event)
  let start: { x: number; y: number } | null = null
  const down = (event: MouseEvent) => { start = event.button === 0 ? { x: event.clientX, y: event.clientY } : null }
  const up = (event: MouseEvent) => {
    const at = start; start = null
    if (!at || event.button !== 0 || event.altKey || event.ctrlKey || !mouse.areMouseEventsActive) return
    if (Math.hypot(event.clientX - at.x, event.clientY - at.y) > 3 || term.hasSelection()) return
    const pos = mouseUtil.getMouseReportCoords(event, core.screenElement)
    if (!pos) return
    const report = { ...pos, button: 0, shift: event.shiftKey, alt: false, ctrl: false }
    mouse.triggerMouseEvent({ ...report, action: 1 })
    mouse.triggerMouseEvent({ ...report, action: 0 })
  }
  host.addEventListener('mousedown', down, true)
  host.addEventListener('mouseup', up, true)
  return () => {
    host.removeEventListener('mousedown', down, true)
    host.removeEventListener('mouseup', up, true)
    selection.shouldForceSelection = original
    start = null
  }
}

import type { PointerEvent as ReactPointerEvent } from 'react'

export function PaneResizeHandle({ label, width, sign, onChange, onDrag }: {
  label: string; width: number; sign: number; onChange: (width: number) => void; onDrag: (dragging: boolean) => void
}) {
  const clamp = (value: number) => Math.max(180, Math.min(700, value))
  function start(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    const handle = event.currentTarget
    const x = event.clientX
    handle.setPointerCapture(event.pointerId)
    onDrag(true)
    const move = (e: PointerEvent) => onChange(clamp(width + sign * (e.clientX - x)))
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      handle.removeEventListener('lostpointercapture', end)
      onDrag(false)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
    handle.addEventListener('lostpointercapture', end)
  }
  return <div role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={180} aria-valuemax={700} aria-valuenow={Math.round(width)} tabIndex={0} className="pane-resize-handle" onPointerDown={start} onDoubleClick={()=>onChange(320)} onKeyDown={event=>{
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onChange(clamp(width + sign * (event.key === 'ArrowRight' ? 20 : -20))) }
  }} title="Drag to resize · double-click to reset" />
}

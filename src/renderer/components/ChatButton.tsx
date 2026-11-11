import { useEffect, useRef, useState, type JSX } from 'react'

/**
 * The team chat button. It sits at the bottom right of the terminal; drag it anywhere in the window and it stays there
 * (kept on this Mac). On hover two small buttons show: one puts it back where it started, one shrinks it to a round icon
 * (with the unread count) or grows it back to "Chat".
 */
type Spot = { x: number; y: number } | null
const KEY = 'chatButton:spot', MINI = 'chatButton:mini'
const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } }
const save = (k: string, v: unknown) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)) } catch {} }

const Icon = ({ d, s = 13 }: { d: string; s?: number }) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
const BUBBLE = 'M20 11.5a7.5 7.5 0 0 1-11.1 6.6L4 19.5l1.4-4.6A7.5 7.5 0 1 1 20 11.5Z'

export function ChatButton({ open, unread, onToggle }: { open: boolean; unread: number; onToggle: () => void }): JSX.Element {
  // Where it was dropped, as a share of the window, so it stays in the same place when the window is resized.
  const [spot, setSpot] = useState<Spot>(() => load<Spot>(KEY, null))
  const [mini, setMini] = useState<boolean>(() => load(MINI, false))
  const [, redraw] = useState(0)
  const dragged = useRef(false), el = useRef<HTMLDivElement>(null)
  useEffect(() => { const r = () => redraw(n => n + 1); window.addEventListener('resize', r); return () => window.removeEventListener('resize', r) }, [])

  const down = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.cb-tools')) return
    const box = el.current!.getBoundingClientRect(), dx = e.clientX - box.left, dy = e.clientY - box.top, x0 = e.clientX, y0 = e.clientY
    dragged.current = false
    const move = (m: MouseEvent) => {
      if (!dragged.current && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return
      dragged.current = true
      const x = Math.max(4, Math.min(window.innerWidth - box.width - 4, m.clientX - dx)), y = Math.max(4, Math.min(window.innerHeight - box.height - 4, m.clientY - dy))
      setSpot({ x: x / window.innerWidth, y: y / window.innerHeight })
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setSpot(s => { save(KEY, s); return s }) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  const click = () => { if (dragged.current) { dragged.current = false; return } onToggle() }
  const style = spot ? { position: 'fixed' as const, left: Math.min(spot.x * window.innerWidth, window.innerWidth - 60), top: Math.min(spot.y * window.innerHeight, window.innerHeight - 40), zIndex: 70 } : undefined
  return <div ref={el} className={`cb${spot ? ' moved' : ''}`} style={style} onMouseDown={down} title={spot ? 'Team chat · drag to move' : 'Team chat · drag to move it anywhere'}>
    <button className={`corner-chat${open ? ' on' : ''}${unread > 0 ? ' unread' : ''}${mini ? ' mini' : ''}`} aria-label={unread ? `Team chat, ${unread} unread` : 'Team chat'} aria-pressed={open} onClick={click}>
      <Icon d={BUBBLE} s={mini ? 15 : 13} />{!mini && 'Chat'}{unread > 0 && <span className="corner-count">{unread > 99 ? '99+' : unread}</span>}
    </button>
    <span className="cb-tools">
      <button title={mini ? 'Show it as Chat' : 'Make it a small icon'} aria-label={mini ? 'Bigger chat button' : 'Smaller chat button'} onClick={() => { setMini(!mini); save(MINI, !mini) }}>
        <Icon d={mini ? 'M5 12h14M12 5v14' : 'M5 12h14'} s={11} /></button>
      {spot && <button title="Put it back at the bottom right" aria-label="Put the chat button back" onClick={() => { setSpot(null); save(KEY, null) }}>
        <Icon d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" s={11} /></button>}
    </span>
  </div>
}

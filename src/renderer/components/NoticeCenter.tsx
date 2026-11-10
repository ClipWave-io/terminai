import { useEffect, useRef, useState, type JSX } from 'react'

/**
 * The bell in the top bar: every notification in one place (conversations that finished, To-do changes and requests,
 * team chat, agents and bots, memory, updates), newest first, with filters, unread counts and a click that goes to it.
 */
type Notice = Awaited<ReturnType<typeof window.term.notices.list>>[number]
type Kind = Notice['kind']
const FILTERS: [Kind | 'all', string][] = [['all', 'All'], ['done', 'Finished'], ['todo', 'To-do'], ['request', 'Requests'], ['chat', 'Chat'], ['agent', 'Agents & bots'], ['memory', 'System']]
const ICON: Record<Kind, string> = { done: 'M5 12.5 9.5 17 19 7', todo: 'M11 6h9M11 12h9M11 18h9M3.5 6l1.5 1.5L8 4.5M3.5 12l1.5 1.5L8 10.5', request: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  chat: 'M20 11.5a7.5 7.5 0 0 1-11.1 6.6L4 19.5l1.4-4.6A7.5 7.5 0 1 1 20 11.5Z', agent: 'M12 8V4H8M4 12a8 8 0 0 0 16 0 8 8 0 0 0-16 0M9 13h.01M15 13h.01', memory: 'M6 6h12v12H6ZM9 2v4M15 2v4M9 18v4M15 18v4', update: 'M12 4v11M7 10l5 5 5-5M5 20h14' }
const ago = (iso: string) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }) }
const Svg = ({ d, s = 15 }: { d: string; s?: number }) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>

export function NoticeBell({ onOpen, drag }: { onOpen: (n: Notice) => void; drag: object }): JSX.Element {
  const [items, setItems] = useState<Notice[]>([]), [open, setOpen] = useState(false), [filter, setFilter] = useState<Kind | 'all'>('all')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { void window.term.notices.list().then(setItems); return window.term.notices.onNew(n => setItems(v => [n, ...v].slice(0, 300))) }, [])
  useEffect(() => { if (!open) return; const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }; window.addEventListener('mousedown', away); return () => window.removeEventListener('mousedown', away) }, [open])
  const unread = items.filter(n => !n.read).length
  const kinds = (k: Kind | 'all') => k === 'all' ? items : items.filter(n => k === 'memory' ? n.kind === 'memory' || n.kind === 'update' : n.kind === k)
  const shown = kinds(filter)
  const go = (n: Notice) => { setOpen(false); void window.term.notices.read([n.id]).then(setItems); onOpen(n) }
  return <div className="nc" ref={box}>
    <button className="btn icon no-drag nc-bell" {...drag} aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} title="Notifications" aria-pressed={open} onClick={() => setOpen(v => !v)}>
      <Svg d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15ZM10 20a2 2 0 0 0 4 0" s={16} />{unread > 0 && <span className="nc-count">{unread > 99 ? '99+' : unread}</span>}</button>
    {open && <section className="nc-panel" role="dialog" aria-label="Notifications">
      <header><strong>Notifications</strong>
        <span>{unread > 0 && <button className="nc-link" onClick={() => void window.term.notices.read('all').then(setItems)}>Mark all read</button>}
          {items.length > 0 && <button className="nc-link" onClick={() => void window.term.notices.clear().then(setItems)}>Clear</button>}</span></header>
      <div className="nc-filters">{FILTERS.map(([k, label]) => { const n = kinds(k).filter(x => !x.read).length
        return <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{label}{n > 0 && <i>{n}</i>}</button> })}</div>
      <ul className="nc-list">
        {!shown.length && <li className="nc-empty">{filter === 'all' ? 'Nothing yet. Finished conversations, To-do changes, chat and bots show up here.' : 'Nothing here yet.'}</li>}
        {shown.map(n => <li key={n.id}><button className={n.read ? '' : 'unread'} onClick={() => go(n)}>
          <span className={`nc-ico ${n.kind}`}><Svg d={ICON[n.kind]} s={14} /></span>
          <span className="nc-text"><strong>{n.kind === 'done' ? `Finished · ${n.title}` : n.title}</strong><small>{n.body}</small></span>
          <span className="nc-when">{ago(n.at)}</span></button></li>)}
      </ul>
    </section>}
  </div>
}

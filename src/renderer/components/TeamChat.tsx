import { useEffect, useMemo, useRef, useState, type JSX } from 'react'

/** A soft two-note chime for a new chat message, made with Web Audio (works whatever macOS does with notifications). */
function chime(): void {
  try {
    const ctx = new AudioContext(), t = ctx.currentTime
    for (const [f, d] of [[880, 0], [1320, 0.12]] as const) {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(ctx.destination)
      g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(0.13, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.35)
      o.start(t + d); o.stop(t + d + 0.4)
    }
    setTimeout(() => void ctx.close(), 900)
  } catch {}
}
import './teamchat.css'
import { AccessPicker, Avatar, PeoplePanel, useProducts, type Access } from './Permissions'
import { CallIcon, CallView, useCalls } from './Call'

/**
 * Team chat and team files, a drawer on the right. It stays mounted while signed in so the long poll keeps the
 * unread count and notifications current; messages and the file list are cached locally, so it opens instantly.
 * Files are only downloaded when opened (images when they scroll into view), then kept in this Mac's cache.
 */
type Person = { id: string; name: string; seenAt: string | null; readAt: string | null; typing: boolean; online: boolean }
type ChatFile = { id: string; name: string; mime: string; size: number } | { hidden: true }
type Message = { id: string; body: string; at: string; from: string; fromName: string; file: ChatFile | null; pending?: boolean }
type TeamFile = { id: string; name: string; mime: string; size: number; access: 'all' | 'admins' | 'products'; products: string[] | null; by: string; byName?: string; createdAt: string; fromChat: boolean }

const cache = { get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } }, set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} } }

const P: Record<string, string> = {
  clip: 'M20.5 11.5 12 20a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.7a1.7 1.7 0 0 1-2.4-2.4L15 7.6',
  send: 'M4 12 20 4l-4 16-4-7-8-1Z', close: 'M6 6l12 12M18 6 6 18', lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5Z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14', reveal: 'M12 4v11M7 10l5 5 5-5M5 20h14', group: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20v-1a6 6 0 0 1 12 0v1M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 6',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', check: 'M5 12.5 9.5 17 19 7', checks: 'M2 12.5 6.5 17 16 7M10 16l1 1 9.5-10',
  image: 'M4 5h16v14H4ZM4 16l5-5 4 4 3-3 4 4M15 9h.01', play: 'M8 5v14l11-7Z', note: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
}
const Ico = ({ n, s = 16 }: { n: keyof typeof P; s?: number }) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={P[n]} /></svg>
const images = new Map<string, Promise<string>>()
const openInPane = (company: string, id: string, name: string) => window.term.teamchat.open(company, id, name, 'pane').then(() => { window.dispatchEvent(new Event('tc:opened-in-pane')) })
const size = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const dayLabel = (iso: string) => { const d = new Date(iso), t = new Date(); const y = new Date(t); y.setDate(t.getDate() - 1)
  return d.toDateString() === t.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }) }
const lastSeen = (p: Person) => p.typing ? 'typing…' : p.online ? 'online' : p.seenAt ? `last seen ${dayLabel(p.seenAt) === 'Today' ? 'today' : dayLabel(p.seenAt) === 'Yesterday' ? 'yesterday' : dayLabel(p.seenAt)} at ${clock(p.seenAt)}` : 'not on TerminAI yet'
const isImage = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name)

export function TeamChat({ open, onClose, onUnread }: { open: boolean; onClose: () => void; onUnread: (n: number) => void }): JSX.Element | null {
  const [company, setCompany] = useState<{ id: string; role: string } | null>(null)
  // Find the workspace, and keep trying until it answers: one failed lookup at launch (a busy Mac, no network yet) used to
  // leave the chat off until it was opened, so no unread count, no notification and no sound all day.
  useEffect(() => {
    let stop = false, timer = 0
    const look = () => void window.term.workspace.state().then(s => { if (stop) return; const c = s.identity?.companies[0]; setCompany(c ? { id: c.id, role: c.role } : null); if (!c) timer = window.setTimeout(look, 60000) })
      .catch(() => { if (!stop) timer = window.setTimeout(look, 10000) })
    look(); return () => { stop = true; window.clearTimeout(timer) }
  }, [open])
  if (!company) return open ? <aside className="tc"><header className="tc-head"><strong>Team</strong><button className="tc-x" aria-label="Close" onClick={onClose}><Ico n="close" /></button></header><p className="tc-empty">Sign in with Sync (people icon) to chat with your team.</p></aside> : null
  return <Team key={company.id} company={company.id} admin={company.role === 'owner' || company.role === 'admin'} open={open} onClose={onClose} onUnread={onUnread} />
}

function Team({ company, admin, open, onClose, onUnread }: { company: string; admin: boolean; open: boolean; onClose: () => void; onUnread: (n: number) => void }): JSX.Element | null {
  const soundRef = useRef(true)
  // Its width: drag the left edge (double-click it for the default), kept on this Mac.
  const [width, setWidth] = useState<number>(() => cache.get('tc:width', 420))
  const resize = (e: React.MouseEvent) => {
    e.preventDefault(); const x0 = e.clientX, w0 = width
    const move = (m: MouseEvent) => setWidth(Math.max(320, Math.min(window.innerWidth - 120, w0 + x0 - m.clientX)))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.cursor = ''; setWidth(w => { cache.set('tc:width', w); return w }) }
    document.body.style.cursor = 'ew-resize'; window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  // Opening a file or picture in the Files pane closes the drawer, so the file is not hidden behind it.
  useEffect(() => { const h = () => onClose(); window.addEventListener('tc:opened-in-pane', h); return () => window.removeEventListener('tc:opened-in-pane', h) }, [onClose])
  useEffect(() => { const load = () => void window.term.prefs.get().then(p => { soundRef.current = p.chatSound !== false }).catch(() => {}); load(); const t = window.setInterval(load, 30000); return () => window.clearInterval(t) }, [])
  // Channels: the whole team ('') and one per product. Someone limited to some products has only those.
  const [channel, setChannel] = useState<string>(() => cache.get(`tc:${company}:channel`, ''))
  const [channels, setChannels] = useState<{ team: boolean; channels: string[] }>(() => cache.get(`tc:${company}:channels`, { team: true, channels: [] }))
  useEffect(() => {
    const load = () => void window.term.teamchat.channels(company).then(c => { setChannels(c); cache.set(`tc:${company}:channels`, c); if (!c.team && !c.channels.includes(channel) && c.channels[0]) pick(c.channels[0]) }).catch(() => {})
    load(); const t = window.setInterval(load, 60000); return () => window.clearInterval(t)
  }, [company]) // eslint-disable-line react-hooks/exhaustive-deps
  const key = `tc:${company}${channel ? `:${channel}` : ''}`
  const [messages, setMessages] = useState<Message[]>(() => cache.get(`${key}:m`, []))
  const [people, setPeople] = useState<Person[]>(() => cache.get(`${key}:p`, []))
  const [me, setMe] = useState<string>(() => cache.get(`${key}:me`, ''))
  const [view, setView] = useState<'chat' | 'files' | 'people'>('chat')
  const [lastRead, setLastRead] = useState<string>(() => cache.get(`${key}:read`, ''))
  const lastReadRef = useRef(lastRead); lastReadRef.current = lastRead
  const [offline, setOffline] = useState(false)
  const openRef = useRef(open); openRef.current = open
  const known = useRef(new Set<string>())
  const peopleRef = useRef(people); peopleRef.current = people
  const meRef = useRef(me); meRef.current = me
  const msgsRef = useRef(messages); msgsRef.current = messages
  const pick = (c: string) => {
    if (c === channel) return
    const k = `tc:${company}${c ? `:${c}` : ''}`
    known.current = new Set(); setMessages(cache.get(`${k}:m`, [])); setLastRead(cache.get(`${k}:read`, '')); setChannel(c); cache.set(`tc:${company}:channel`, c)
  }

  // The long poll: each answer brings what is new, then the next call waits for more (or for typing to change).
  useEffect(() => {
    let stop = false, after = messages.at(-1)?.at, typing = '', first = true
    messages.forEach(m => known.current.add(m.id))
    const run = async () => {
      while (!stop) {
        try {
          // My newest message not yet on everyone's Mac: the server answers as soon as it is, so the second tick shows at once.
          const mine = msgsRef.current.filter(m => m.from === meRef.current && !m.pending), last = mine.at(-1)
          const others = peopleRef.current.filter(p => p.id !== meRef.current)
          const pending = last && others.some(p => !p.seenAt || p.seenAt < last.at) ? last.at : undefined
          const r = await window.term.teamchat.chat(company, after, typing, pending, channel)
          if (stop) return
          setOffline(false); setMe(r.me); cache.set(`${key}:me`, r.me); setPeople(r.people); cache.set(`${key}:p`, r.people)
          typing = r.people.filter((p: Person) => p.typing).map((p: Person) => p.id).join(',')
          // An empty chat has no newest message: wait from the beginning of time, so the next call is a long poll too.
          if (!after && !r.messages.length) after = new Date(0).toISOString()
          if (r.messages.length) {
            after = r.messages.at(-1).at
            // Only messages this window has not had yet notify, once each (a repeat from the server never does).
            const fresh = r.messages.filter((m: Message) => m.from !== r.me && !known.current.has(m.id) && (!first || m.at > lastReadRef.current))
            r.messages.forEach((m: Message) => known.current.add(m.id)); first = false
            setMessages(prev => { const seen = new Set(prev.filter(m => !m.pending).map(m => m.id)); const next = [...prev.filter(m => !m.pending), ...r.messages.filter((m: Message) => !seen.has(m.id))].slice(-500); cache.set(`${key}:m`, next); return next })
            if (fresh.length && (!openRef.current || !document.hasFocus())) {
              const m = fresh.at(-1); void window.term.teamchat.notify(m.fromName, m.body || (m.file ? 'Sent a file' : ''))
              if (soundRef.current) chime()
            }
          }
        } catch { if (stop) return; setOffline(true); await new Promise(r => setTimeout(r, 4000)) }
      }
    }
    void run()
    return () => { stop = true }
  }, [company, channel]) // eslint-disable-line react-hooks/exhaustive-deps

  // Read: everything up to the newest message once the chat is in view.
  const newest = messages.at(-1)?.at ?? ''
  useEffect(() => { if (open && view === 'chat' && newest && newest > lastRead) { setLastRead(newest); cache.set(`${key}:read`, newest); void window.term.teamchat.signal(company, 'read').catch(() => {}) } }, [open, view, newest]) // eslint-disable-line react-hooks/exhaustive-deps
  const unread = messages.filter(m => m.from !== me && m.at > lastRead).length
  useEffect(() => onUnread(unread), [unread, onUnread])

  const send = async (body: string, fileId?: string) => {
    const temp: Message = { id: `tmp-${Date.now()}`, body, at: new Date().toISOString(), from: meRef.current, fromName: 'You', file: null, pending: true }
    if (!fileId) setMessages(prev => [...prev, temp])
    try { await window.term.teamchat.send(company, body, fileId, channel) } catch { setMessages(prev => prev.map(m => m.id === temp.id ? { ...m, body: `${m.body}`, fromName: 'failed' } : m)) }
  }
  const share = async (paths: string[]) => {
    for (const path of paths) { try { const { file } = await window.term.teamchat.upload(company, path, 'all', [], true); await send('', file.id) } catch (e) { alertLine(String((e as Error).message ?? e)) } }
  }
  const [notice, setNotice] = useState(''); const alertLine = (t: string) => { setNotice(t); setTimeout(() => setNotice(''), 5000) }

  const calls = useCalls(company, me, id => peopleRef.current.find(p => p.id === id)?.name ?? 'Someone')
  const others = people.filter(p => p.id !== me)
  const callTitle = others.length === 1 ? others[0].name : 'Team'
  if (!open) return <CallView calls={calls} title={callTitle} />
  const typingNow = others.filter(p => p.typing)
  const title = others.length === 1 ? others[0].name : others.length ? others.map(p => p.name.split(' ')[0]).join(', ') : 'Team'
  const sub = offline ? 'connecting…' : typingNow.length ? `${typingNow.map(p => p.name.split(' ')[0]).join(', ')} ${typingNow.length > 1 ? 'are' : 'is'} typing…` : others.length === 1 ? lastSeen(others[0]) : others.length ? `${others.filter(p => p.online).length} of ${others.length} online` : 'Invite someone from Sync › Members'
  return <><CallView calls={calls} title={callTitle} beside /><aside className="tc" aria-label="Team chat" style={{ width }}>
    <div className="tc-resize" title="Drag to resize" onMouseDown={resize} onDoubleClick={() => { setWidth(420); cache.set('tc:width', 420) }} />
    <header className="tc-head">
      <span className="tc-faces" aria-hidden="true">{(others.length ? others : people).slice(0, 4).map(p => <Avatar key={p.id} id={p.id} name={p.name} size={30} online={p.online} />)}</span>
      <div className="tc-who"><strong>{title}</strong><small className={typingNow.length ? 'typing' : ''}>{sub}</small></div>
      <div className="tc-tabs" role="tablist">{(['chat', 'files', 'people'] as const).map(v => <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v === 'chat' ? 'Chat' : v === 'files' ? 'Files' : 'People'}</button>)}</div>
      {others.length > 0 && calls.phase === 'idle' && <span className="tc-calls">
        <button className="tc-x" title={`Voice call ${callTitle}`} aria-label="Voice call" onClick={() => void calls.start(false)}><CallIcon n="phone" s={17} /></button>
        <button className="tc-x" title={`Video call ${callTitle}`} aria-label="Video call" onClick={() => void calls.start(true)}><CallIcon n="video" s={17} /></button>
      </span>}
      <button className="tc-x" title="Close" aria-label="Close" onClick={onClose}><Ico n="close" /></button>
    </header>
    {view === 'chat' && channels.channels.length > 0 && <div className="tc-channels" role="tablist" aria-label="Chats">
      {channels.team && <button role="tab" aria-selected={channel === ''} className={channel === '' ? 'on' : ''} onClick={() => pick('')}>Team</button>}
      {channels.channels.map(c => <button key={c} role="tab" aria-selected={channel === c} className={channel === c ? 'on' : ''} onClick={() => pick(c)}>{c}</button>)}
    </div>}
    {notice && <div className="tc-notice">{notice}</div>}
    {view === 'chat' ? <Chat company={company} messages={messages} me={me} others={others} onSend={send} onShare={share} />
      : view === 'files' ? <Files company={company} admin={admin} me={me} onError={alertLine} />
      : <PeoplePanel company={company} me={me} onError={e => alertLine(String((e as Error).message ?? e))} online={id => people.find(p => p.id === id)?.online} />}
  </aside></>
}

function Chat({ company, messages, me, others, onSend, onShare }: { company: string; messages: Message[]; me: string; others: Person[]; onSend: (b: string) => void; onShare: (p: string[]) => void }): JSX.Element {
  const [text, setText] = useState(''), [drag, setDrag] = useState(false)
  const list = useRef<HTMLDivElement>(null), stick = useRef(true), lastTyping = useRef(0)
  useEffect(() => { const el = list.current; if (el && stick.current) el.scrollTop = el.scrollHeight }, [messages.length])
  // WhatsApp ticks: one grey sent, two grey on their Mac, two blue read.
  const readBy = (m: Message) => others.length > 0 && others.every(p => p.readAt && p.readAt >= m.at)
  const gotBy = (m: Message) => others.length > 0 && others.every(p => p.seenAt && p.seenAt >= m.at)
  const go = () => { const t = text.trim(); if (!t) return; onSend(t); setText(''); stick.current = true }
  const typed = (v: string) => { setText(v); const now = Date.now(); if (v && now - lastTyping.current > 3000) { lastTyping.current = now; void window.term.teamchat.signal(company, 'typing').catch(() => {}) } }
  let day = ''
  return <div className={`tc-chat${drag ? ' drag' : ''}`}
    onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true) } }} onDragLeave={() => setDrag(false)}
    onDrop={e => { e.preventDefault(); setDrag(false); onShare([...e.dataTransfer.files].map(f => window.term.teamchat.pathOf(f)).filter(Boolean)) }}>
    <div className="tc-list" ref={list} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
      {!messages.length && <p className="tc-empty">No messages yet. Say hi, or drop a file here.</p>}
      {messages.map((m, i) => {
        const d = dayLabel(m.at), showDay = d !== day; day = d
        const mine = m.from === me, first = i === 0 || messages[i - 1].from !== m.from || showDay
        return <div key={m.id}>
          {showDay && <div className="tc-day"><span>{d}</span></div>}
          <div className={`tc-msg${mine ? ' mine' : ''}${first ? ' first' : ''}`}>
            <div className="tc-bubble">
              {!mine && first && others.length > 1 && <b className="tc-from">{m.fromName}</b>}
              {m.file && <Attachment company={company} file={m.file} />}
              {m.body && <span className="tc-text">{m.body}</span>}
              <span className="tc-meta">{m.fromName === 'failed' ? 'not sent' : clock(m.at)}{mine && <span className={`tc-ticks${readBy(m) ? ' read' : ''}`}><Ico n={m.pending ? 'clock' : readBy(m) || gotBy(m) ? 'checks' : 'check'} s={14} /></span>}</span>
            </div>
          </div>
        </div>
      })}
    </div>
    <form className="tc-compose" onSubmit={e => { e.preventDefault(); go() }}>
      <button type="button" className="tc-clip" title="Share a file or photo" aria-label="Share a file or photo" onClick={() => void window.term.teamchat.pick().then(p => { if (p.length) onShare(p) })}><Ico n="clip" s={19} /></button>
      <textarea rows={1} placeholder="Message" value={text} onChange={e => typed(e.target.value)}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go() } }} />
      <button className="tc-send" type="submit" disabled={!text.trim()} title="Send" aria-label="Send"><Ico n="send" s={17} /></button>
    </form>
  </div>
}

function Attachment({ company, file }: { company: string; file: ChatFile }): JSX.Element {
  if ('hidden' in file) return <span className="tc-file hidden"><Ico n="lock" s={14} /> A file you have no access to</span>
  if (isImage(file.name)) return <LazyImage company={company} file={file} />
  return <button className="tc-file" onClick={() => void openInPane(company, file.id, file.name)}>
    <span className="tc-file-ico">{/\.(mp4|mov)$/i.test(file.name) ? <Ico n="play" /> : /\.(mp3|m4a|wav)$/i.test(file.name) ? <Ico n="note" /> : (file.name.split('.').pop() ?? '').slice(0, 4).toUpperCase()}</span>
    <span className="tc-file-name">{file.name}<small>{size(file.size)} · click to open</small></span></button>
}

/** Downloads the picture once (kept in this Mac's cache), retrying a few times; clicking opens it in the Files pane. */
function LazyImage({ company, file }: { company: string; file: { id: string; name: string; size: number } }): JSX.Element {
  const [src, setSrc] = useState(''), [failed, setFailed] = useState(false)
  useEffect(() => {
    let stop = false
    const load = async (tries: number) => {
      let p = images.get(file.id); if (!p) { p = window.term.teamchat.image(company, file.id, file.name); images.set(file.id, p) }
      try { const v = await p; if (!stop) setSrc(v) }
      catch { images.delete(file.id); if (tries > 0 && !stop) setTimeout(() => void load(tries - 1), 2500); else if (!stop) setFailed(true) }
    }
    void load(3); return () => { stop = true }
  }, [company, file.id, file.name])
  return <button className="tc-img" title={`${file.name} · click to open in Files`} onClick={() => void openInPane(company, file.id, file.name)}>
    {src ? <img src={src} alt={file.name} /> : <span className="tc-img-wait">{failed ? `${file.name} · click to open` : `Loading · ${size(file.size)}`}</span>}</button>
}

const ACCESS: Record<TeamFile['access'], string> = { all: 'Everyone', admins: 'Admins only', products: 'Products' }
function Files({ company, admin, me, onError }: { company: string; admin: boolean; me: string; onError: (t: string) => void }): JSX.Element {
  const key = `tc:${company}:f`
  const [files, setFiles] = useState<TeamFile[]>(() => cache.get(key, []))
  const [q, setQ] = useState(''), [access, setAccess] = useState<Access>({ access: 'all', products: [] })
  const [busy, setBusy] = useState(0), [editing, setEditing] = useState<string | null>(null), [showChat, setShowChat] = useState(false), [choosing, setChoosing] = useState(false)
  const options = useProducts(files.flatMap(f => f.products ?? []))
  const load = () => void window.term.teamchat.files(company).then(r => { setFiles(r.files); cache.set(key, r.files) }).catch(e => onError(String(e.message ?? e)))
  useEffect(load, [company]) // eslint-disable-line react-hooks/exhaustive-deps
  const upload = async (paths: string[]) => {
    setBusy(n => n + paths.length)
    for (const p of paths) { try { await window.term.teamchat.upload(company, p, access.access, access.products) } catch (e) { onError(String((e as Error).message ?? e)) } finally { setBusy(n => n - 1) } }
    load()
  }
  const change = (f: TeamFile, c: object | null) => void window.term.teamchat.change(company, f.id, c).then(load).catch(e => onError(String(e.message ?? e)))
  const shown = useMemo(() => files.filter(f => (showChat || !f.fromChat) && (!q || f.name.toLowerCase().includes(q.toLowerCase()))), [files, q, showChat])
  return <div className="tc-files" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void upload([...e.dataTransfer.files].map(f => window.term.teamchat.pathOf(f)).filter(Boolean)) }}>
    <div className="tc-up">
      <button className="tc-access-btn" onClick={() => setChoosing(v => !v)} title="Who can see what you upload">
        <Ico n="lock" s={14} />{access.access === 'all' ? 'Everyone' : access.access === 'admins' ? 'Admins only' : access.products.length ? access.products.join(', ') : 'Choose products'}</button>
      <button className="tc-btn" onClick={() => void window.term.teamchat.pick().then(p => { if (p.length) void upload(p) })}>{busy ? `Uploading ${busy}…` : 'Upload'}</button>
    </div>
    {choosing && <div className="tc-access-pop"><small>New uploads can be seen by</small><AccessPicker value={access} onChange={setAccess} admin={admin} options={options} /></div>}
    <div className="tc-search"><input placeholder="Search files" value={q} onChange={e => setQ(e.target.value)} />
      <label><input type="checkbox" checked={showChat} onChange={e => setShowChat(e.target.checked)} /> From chat</label></div>
    <div className="tc-flist">
      {!shown.length && <p className="tc-empty">{files.length ? 'Nothing matches.' : 'No team files yet. Drop files here or press Upload.'}</p>}
      {shown.map(f => {
        const mine = admin || f.by === me
        return <div key={f.id}><div className="tc-frow">
          <button className="tc-fmain" onClick={() => void openInPane(company, f.id, f.name).catch(e => onError(String(e.message ?? e)))} title="Open (downloads it the first time)">
            <span className="tc-file-ico">{isImage(f.name) ? <Ico n="image" /> : (f.name.split('.').pop() ?? '').slice(0, 4).toUpperCase()}</span>
            <span className="tc-file-name">{f.name}<small>{size(f.size)} · {f.byName ?? 'someone'} · {dayLabel(f.createdAt)}</small></span></button>
          {editing === f.id ? null
            : <span className={`tc-acc ${f.access}`} title="Who can see it">{f.access === 'products' ? (f.products ?? []).join(', ') || 'No one' : ACCESS[f.access]}</span>}
          <span className="tc-factions">
            <button className="tc-link" title="Show in Finder" aria-label="Show in Finder" onClick={() => void window.term.teamchat.open(company, f.id, f.name, 'reveal')}><Ico n="reveal" s={15} /></button>
            {mine && <button className="tc-link" title="Who can see it" aria-label="Who can see it" onClick={() => setEditing(editing === f.id ? null : f.id)}><Ico n="lock" s={15} /></button>}
            {mine && <button className="tc-link" title="Delete" aria-label="Delete" onClick={() => change(f, null)}><Ico n="trash" s={15} /></button>}
          </span>
        </div>
        {editing === f.id && <div className="tc-access-pop inline"><AccessPicker value={{ access: f.access, products: f.products ?? [] }} admin={admin} options={options}
          onChange={v => change(f, { access: v.access, products: v.access === 'products' ? v.products : undefined })} /><button className="tc-link" onClick={() => setEditing(null)}>Done</button></div>}
      </div>
      })}
    </div>
  </div>
}

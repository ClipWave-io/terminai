import { useEffect, useMemo, useRef, useState, type JSX } from 'react'

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
type Message = { id: string; body: string; at: string; from: string; fromName: string; file: ChatFile | null; pending?: boolean; call?: { video: boolean; seconds: number; missed: boolean; declined: boolean } }
type TeamFile = { id: string; folder?: string; shared?: boolean; name: string; mime: string; size: number; access: 'all' | 'admins' | 'products'; products: string[] | null; by: string; byName?: string; createdAt: string; fromChat: boolean }

type Dm = { channel: string; id: string; name: string }
type Group = { channel: string; name: string; members: string[] }
type Channels = { team: boolean; channels: string[]; latest?: Record<string, { at: string; from: string; fromName: string; body: string }>; dms?: Dm[]; groups?: Group[]; me?: string }
type ChatItem = { c: string; label: string; dm?: Dm; group?: Group; unread?: boolean; at?: string }
const cache = { get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } }, set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} } }

const P: Record<string, string> = {
  clip: 'M20.5 11.5 12 20a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.7a1.7 1.7 0 0 1-2.4-2.4L15 7.6',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', back: 'M15 6l-6 6 6 6', plusFolder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM12 11v5M9.5 13.5h5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16ZM10 20.5a2 2 0 0 0 4 0', bellOff: 'M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l1.5 2H8M10 20.5a2 2 0 0 0 4 0M4 4l16 16',
  send: 'M4 12 20 4l-4 16-4-7-8-1Z', close: 'M6 6l12 12M18 6 6 18', lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5Z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14', reveal: 'M12 4v11M7 10l5 5 5-5M5 20h14', group: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20v-1a6 6 0 0 1 12 0v1M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 6',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', check: 'M5 12.5 9.5 17 19 7', checks: 'M2 12.5 6.5 17 16 7M10 16l1 1 9.5-10',
  image: 'M4 5h16v14H4ZM4 16l5-5 4 4 3-3 4 4M15 9h.01', search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4', play: 'M8 5v14l11-7Z', note: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
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
    const look = () => void Promise.all([window.term.workspace.state(), window.term.prefs.get()]).then(([s, p]) => { if (stop) return; const c = s.identity?.companies.find(x => x.id === p.workspaceId) ?? s.identity?.companies[0]; setCompany(c ? { id: c.id, role: c.role } : null); if (!c) timer = window.setTimeout(look, 60000) })
      .catch(() => { if (!stop) timer = window.setTimeout(look, 10000) })
    // Another organisation picked in Sync: the chat follows at once.
    window.addEventListener('workspace:changed', look)
    look(); return () => { stop = true; window.clearTimeout(timer); window.removeEventListener('workspace:changed', look) }
  }, [open])
  if (!company) return open ? <aside className="tc"><header className="tc-head"><strong>Team</strong><button className="tc-x" aria-label="Close" onClick={onClose}><Ico n="close" /></button></header><p className="tc-empty">Sign in with Sync (people icon) to chat with your team.</p></aside> : null
  return <Team key={company.id} company={company.id} admin={company.role === 'owner' || company.role === 'admin'} open={open} onClose={onClose} onUnread={onUnread} />
}

function Team({ company, admin, open, onClose, onUnread }: { company: string; admin: boolean; open: boolean; onClose: () => void; onUnread: (n: number) => void }): JSX.Element | null {
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
  // The bell in the header: the chat's sound on or off (Settings › Notifications › Sounds has every kind).
  const [sound, setSound] = useState(true)
  useEffect(() => { const load = () => void window.term.prefs.get().then(p => setSound(p.sounds?.chat !== false)).catch(() => {}); load(); const t = window.setInterval(load, 15000); return () => window.clearInterval(t) }, [])
  const toggleSound = () => void window.term.prefs.get().then(p => { const on = !(p.sounds?.chat !== false); setSound(on); if (on) void window.term.sound.test('chat'); return window.term.prefs.set({ sounds: { ...p.sounds, chat: on } }) }).catch(() => {})
  // Channels: the whole team ('') and one per product. Someone limited to some products has only those.
  const [channel, setChannel] = useState<string>(() => cache.get(`tc:${company}:channel`, ''))
  const [channels, setChannels] = useState<Channels>(() => cache.get(`tc:${company}:channels`, { team: true, channels: [] }))
  const channelRef = useRef(channel); channelRef.current = channel
  // One-to-one chats opened from People or the search before anyone wrote in them, kept on this Mac.
  const [openedDms, setOpenedDms] = useState<Dm[]>(() => cache.get(`tc:${company}:dms`, []))
  const seenLatest = useRef<Record<string, string> | null>(null)
  useEffect(() => {
    const load = () => void window.term.teamchat.channels(company).then(c => {
      setChannels(c); cache.set(`tc:${company}:channels`, c)
      if (!c.team && !c.channels.includes(channelRef.current) && !channelRef.current.startsWith('dm:') && c.channels[0]) pick(c.channels[0])
      // Something new in another chat: a notification, once (the open chat has its own from the long poll).
      const before = seenLatest.current; seenLatest.current = Object.fromEntries(Object.entries(c.latest ?? {}).map(([k, v]) => [k, v.at]))
      if (before) for (const [k, v] of Object.entries(c.latest ?? {})) {
        if (v.from === c.me || before[k] === v.at || k === channelRef.current || v.at <= cache.get(`${keyOf(k)}:read`, '')) continue
        const where = k.startsWith('dm:') ? '' : ` · ${k || 'Team'}`
        void window.term.teamchat.notify(`${v.fromName}${where}`, v.body)
      }
    }).catch(() => {})
    load(); const t = window.setInterval(load, 10000)
    // Sending or reading anywhere refreshes the list at once.
    window.addEventListener('tc:channels', load)
    return () => { window.clearInterval(t); window.removeEventListener('tc:channels', load) }
  }, [company]) // eslint-disable-line react-hooks/exhaustive-deps
  const keyOf = (c: string) => `tc:${company}${c ? `:${c}` : ''}`
  const key = keyOf(channel)
  const [messages, setMessages] = useState<Message[]>(() => cache.get(`${key}:m`, []))
  const [people, setPeople] = useState<Person[]>(() => cache.get(`${key}:p`, []))
  const [me, setMe] = useState<string>(() => cache.get(`${key}:me`, ''))
  const [view, setView] = useState<'chat' | 'files' | 'people' | 'live'>('chat')
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
              const m = fresh.at(-1); void window.term.teamchat.notify(m.fromName, m.call ? (m.call.missed ? `Missed ${m.call.video ? 'video' : 'voice'} call` : `${m.call.video ? 'Video' : 'Voice'} call ended`) : m.body || (m.file ? 'Sent a file' : ''))
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
  const unreadHere = messages.filter(m => m.from !== me && m.at > lastRead).length
  // Every chat: Team, the products', one-to-one ones. Those with something unread are red and come first.
  const myId = channels.me || me
  const dmList = useMemo(() => { const all = new Map<string, Dm>(); for (const d of [...openedDms, ...(channels.dms ?? [])]) all.set(d.channel, d); return [...all.values()] }, [openedDms, channels.dms])
  const chats = useMemo(() => {
    const base: ChatItem[] = [...(channels.team ? [{ c: '', label: 'Team' }] : []), ...channels.channels.map(c => ({ c, label: c })), ...(channels.groups ?? []).map(g => ({ c: g.channel, label: g.name, group: g })), ...dmList.map(d => ({ c: d.channel, label: d.name, dm: d }))]
    if (channel && !base.some(x => x.c === channel)) base.push({ c: channel, label: channel.startsWith('dm:') ? 'Direct message' : channel.startsWith('g:') ? 'Group' : channel })
    const latest = channels.latest ?? {}
    const unreadOf = (c: string) => c === channel ? unreadHere > 0 : !!latest[c] && latest[c].from !== myId && latest[c].at > cache.get(`${keyOf(c)}:read`, '')
    const marked = base.map((x, i) => ({ ...x, unread: unreadOf(x.c), at: latest[x.c]?.at ?? '', i }))
    return marked.sort((a, b) => a.unread !== b.unread ? (a.unread ? -1 : 1) : a.unread ? b.at.localeCompare(a.at) : a.i - b.i)
  }, [channels, dmList, channel, unreadHere, myId, lastRead]) // eslint-disable-line react-hooks/exhaustive-deps
  const unread = unreadHere + chats.filter(x => x.unread && x.c !== channel).length
  useEffect(() => onUnread(unread), [unread, onUnread])
  const openDm = (p: { id: string; name: string }) => {
    if (!myId || p.id === myId) return
    const d: Dm = { channel: `dm:${[myId, p.id].sort().join(':')}`, id: p.id, name: p.name }
    setOpenedDms(prev => { const next = [d, ...prev.filter(x => x.channel !== d.channel)].slice(0, 50); cache.set(`tc:${company}:dms`, next); return next })
    pick(d.channel); setView('chat'); setSearching(false)
  }
  const [searching, setSearching] = useState(false)
  // A new group chat (or people added to the open one): its name and who is in it.
  const [groupForm, setGroupForm] = useState<null | { id?: string }>(null)
  const saveGroup = async (name: string, members: string[]) => {
    const r = await window.term.workspace.request(`/api/companies/${company}/chat/groups`, 'POST', groupForm?.id ? { id: groupForm.id, name, add: members } : { name, members })
    setGroupForm(null); setSearching(false); window.dispatchEvent(new Event('tc:channels'))
    if (r?.channel) { pick(r.channel); setView('chat') }
  }
  const openGroup = channels.groups?.find(g => g.channel === channel)

  const send = async (body: string, fileId?: string) => {
    const temp: Message = { id: `tmp-${Date.now()}`, body, at: new Date().toISOString(), from: meRef.current, fromName: 'You', file: null, pending: true }
    if (!fileId) setMessages(prev => [...prev, temp])
    try { await window.term.teamchat.send(company, body, fileId, channel); window.dispatchEvent(new Event('tc:channels')) } catch { setMessages(prev => prev.map(m => m.id === temp.id ? { ...m, body: `${m.body}`, fromName: 'failed' } : m)) }
  }
  const share = async (paths: string[]) => {
    for (const path of paths) { try { const { file } = await window.term.teamchat.upload(company, path, 'all', [], true); await send('', file.id) } catch (e) { alertLine(String((e as Error).message ?? e)) } }
  }
  const [notice, setNotice] = useState(''); const alertLine = (t: string) => { setNotice(t); setTimeout(() => setNotice(''), 5000) }

  const calls = useCalls(company, me, id => peopleRef.current.find(p => p.id === id)?.name ?? 'Someone')
  // In a one-to-one chat a call rings only the other person.
  const dmWith = channel.startsWith('dm:') ? channel.slice(3).split(':').find(id => id !== myId) : undefined
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
      <div className="tc-tabs" role="tablist">{(['chat', 'live', 'files', 'people'] as const).map(v => <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v === 'chat' ? 'Chat' : v === 'live' ? 'Live' : v === 'files' ? 'Files' : 'People'}</button>)}</div>
      {others.length > 0 && calls.phase === 'idle' && <span className="tc-calls">
        <button className="tc-x" title={`Voice call ${callTitle}`} aria-label="Voice call" onClick={() => void calls.start(false, dmWith)}><CallIcon n="phone" s={17} /></button>
        <button className="tc-x" title={`Video call ${callTitle}`} aria-label="Video call" onClick={() => void calls.start(true, dmWith)}><CallIcon n="video" s={17} /></button>
      </span>}
      <button className={`tc-x${searching ? ' on' : ''}`} title="Search chats and people" aria-label="Search chats and people" aria-pressed={searching} onClick={() => setSearching(v => !v)}><Ico n="search" s={17} /></button>
      <button className={`tc-x tc-bell${sound ? '' : ' off'}`} title={sound ? 'Chat sound on: click to mute' : 'Chat sound off: click to turn it on'} aria-label={sound ? 'Mute chat sound' : 'Turn chat sound on'} aria-pressed={sound} onClick={toggleSound}><Ico n={sound ? 'bell' : 'bellOff'} s={17} /></button>
      <button className="tc-x" title="Close" aria-label="Close" onClick={onClose}><Ico n="close" /></button>
    </header>
    {groupForm && <GroupForm company={company} me={myId} group={groupForm.id ? openGroup : undefined} onSave={(n, m) => void saveGroup(n, m).catch(e => alertLine(String((e as Error).message ?? e)))} onClose={() => setGroupForm(null)} />}
    {!groupForm && searching && <Search company={company} me={myId} chats={chats} keyOf={keyOf} onPick={c => { pick(c); setView('chat'); setSearching(false) }} onPerson={openDm} onNewGroup={() => setGroupForm({})} onClose={() => setSearching(false)} />}
    {!searching && !groupForm && view === 'chat' && <div className="tc-channels" role="tablist" aria-label="Chats">
      {chats.map(x => <button key={x.c} role="tab" aria-selected={channel === x.c} className={`${channel === x.c ? 'on' : ''}${x.unread && channel !== x.c ? ' unread' : ''}${x.dm ? ' dm' : ''}`} title={x.unread && channel !== x.c ? `${x.label}: new messages` : x.label} onClick={() => pick(x.c)}>
        {x.dm && <Avatar id={x.dm.id} name={x.dm.name} size={16} />}{x.group && <Ico n="group" s={13} />}{x.label}</button>)}
      <button className="tc-newgroup" title="New group chat" aria-label="New group chat" onClick={() => setGroupForm({})}>+</button>
      {openGroup && <button className="tc-newgroup" title={`Rename ${openGroup.name} or add people`} aria-label="Edit group" onClick={() => setGroupForm({ id: openGroup.channel.slice(2) })}>⋯</button>}
    </div>}
    {notice && <div className="tc-notice">{notice}</div>}
    {searching || groupForm ? null : view === 'chat' ? <Chat key={key} draftKey={`${key}:draft`} company={company} messages={messages} me={me} others={others} onSend={send} onShare={share} />
      : view === 'live' ? <LiveSessions company={company} me={myId} />
      : view === 'files' ? <Files company={company} admin={admin} me={me} onError={alertLine} />
      : <PeoplePanel company={company} me={me} onError={e => alertLine(String((e as Error).message ?? e))} online={id => people.find(p => p.id === id)?.online} onMessage={openDm} />}
  </aside></>
}

/** Live: every TerminAI conversation running right now across the team (what each person shares), by person, with its
 *  state; a click shows its last turns. */
type Live = { id: string; title: string; ownerId?: string; owner_id?: string; ownerName?: string; status?: string | null; live?: boolean; tab?: boolean; updatedAt?: string }
const STATE: Record<string, string> = { working: 'Working', question: 'Needs an answer', waiting: 'Waiting', idle: 'Idle', paused: 'Paused', done: 'Done' }
function LiveSessions({ company, me }: { company: string; me: string }): JSX.Element {
  const [rows, setRows] = useState<Live[] | null>(() => cache.get(`tc:${company}:live`, null))
  const [open, setOpen] = useState(''), [turns, setTurns] = useState<{ id: string; kind: string; content: string }[]>([])
  useEffect(() => {
    const load = () => void window.term.workspace.request(`/api/companies/${company}/conversations`).then(v => { const list = (Array.isArray(v) ? v : v.conversations ?? v.items ?? []) as Live[]; const live = list.filter(c => c.live); setRows(live); cache.set(`tc:${company}:live`, live) }).catch(() => {})
    load(); const t = window.setInterval(load, 8000); return () => window.clearInterval(t)
  }, [company])
  useEffect(() => {
    if (!open) return; let stop = false
    const load = () => void window.term.workspace.request(`/api/companies/${company}/conversations/${open}/messages`).then(v => { if (!stop) setTurns(((Array.isArray(v) ? v : v.messages ?? v.items ?? []) as { id: string; kind: string; content: string }[]).slice(-6)) }).catch(() => {})
    load(); const t = window.setInterval(load, 5000); return () => { stop = true; window.clearInterval(t) }
  }, [company, open])
  if (!rows) return <p className="tc-empty">Loading…</p>
  if (!rows.length) return <p className="tc-empty">No conversation is running right now.</p>
  const owner = (c: Live) => c.ownerId ?? c.owner_id ?? ''
  const people = [...new Set(rows.map(owner))].sort((a, b) => a === me ? -1 : b === me ? 1 : 0)
  return <div className="tc-live">{people.map(p => { const mine = rows.filter(c => owner(c) === p); return <section key={p}>
    <h4>{p === me ? 'You' : mine[0].ownerName ?? 'Someone'} · {mine.length} running</h4>
    {mine.map(c => <div key={c.id} className={`tc-live-row${open === c.id ? ' open' : ''}`}>
      <button onClick={() => { setTurns([]); setOpen(open === c.id ? '' : c.id) }}>
        <span className={`tc-live-dot ${c.status ?? 'idle'}`} aria-hidden="true" /><span className="tc-live-title">{c.title.replace(/^[✳◐◑◒◓⠂⠐·]\s*/, '')}</span><small>{STATE[c.status ?? ''] ?? 'Running'}</small></button>
      {open === c.id && <div className="tc-live-turns">{turns.length ? turns.map(t => <p key={t.id} className={t.kind}><b>{t.kind === 'user' ? 'Asked' : t.kind === 'assistant' ? 'Answer' : t.kind}</b> {t.content.slice(0, 400)}</p>) : <p className="tc-empty">No turns shared yet.</p>}</div>}
    </div>)}</section> })}</div>
}

/** A new group chat: a name and the people in it. For an open group: rename it and add more people. */
function GroupForm({ company, me, group, onSave, onClose }: { company: string; me: string; group?: Group; onSave: (name: string, members: string[]) => void; onClose: () => void }): JSX.Element {
  const [name, setName] = useState(group?.name ?? ''), [picked, setPicked] = useState<string[]>([])
  const [members, setMembers] = useState<{ id: string; name: string }[]>(() => cache.get(`tc:${company}:members`, []))
  useEffect(() => { void window.term.workspace.request(`/api/companies/${company}/members`).then(v => setMembers((v.members ?? []).map((x: { id: string; name: string }) => ({ id: x.id, name: x.name })))).catch(() => {}) }, [company])
  const others = members.filter(m => m.id !== me && !group?.members.includes(m.id))
  return <div className="tc-search tc-group-form">
    <div className="tc-search-box"><Ico n="group" s={15} /><input autoFocus value={name} placeholder="Name of the group chat" maxLength={80} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && name.trim()) onSave(name.trim(), picked) }} />
      <button className="tc-x" aria-label="Cancel" onClick={onClose}><Ico n="close" s={14} /></button></div>
    <div className="tc-search-list">
      {group && <p className="tc-empty">In it: {group.members.map(id => members.find(m => m.id === id)?.name ?? 'someone').join(', ')}</p>}
      <h4>{group ? 'Add people' : 'People in it'}</h4>
      {others.map(p => <button key={p.id} className={picked.includes(p.id) ? 'on' : ''} aria-pressed={picked.includes(p.id)} onClick={() => setPicked(v => v.includes(p.id) ? v.filter(x => x !== p.id) : [...v, p.id])}>
        <Avatar id={p.id} name={p.name} size={22} /><span>{p.name}</span><small>{picked.includes(p.id) ? '✓ added' : 'Add'}</small></button>)}
      {!others.length && <p className="tc-empty">Everyone is already in it.</p>}
      <div className="tc-group-actions"><button className="btn primary" disabled={!name.trim()} onClick={() => onSave(name.trim(), picked)}>{group ? 'Save' : 'Start group chat'}</button></div>
    </div>
  </div>
}

/** One search for the drawer: chats by name, people (a click opens a one-to-one chat) and the messages kept on this Mac. */
function Search({ company, me, chats, keyOf, onPick, onPerson, onNewGroup, onClose }: { company: string; me: string; chats: ChatItem[]; keyOf: (c: string) => string; onPick: (c: string) => void; onPerson: (p: { id: string; name: string }) => void; onNewGroup: () => void; onClose: () => void }): JSX.Element {
  const [q, setQ] = useState('')
  const [members, setMembers] = useState<{ id: string; name: string; email?: string }[]>(() => cache.get(`tc:${company}:members`, []))
  useEffect(() => { void window.term.workspace.request(`/api/companies/${company}/members`).then(v => { const m = (v.members ?? []).map((x: { id: string; name: string; email?: string }) => ({ id: x.id, name: x.name, email: x.email })); setMembers(m); cache.set(`tc:${company}:members`, m) }).catch(() => {}) }, [company])
  const t = q.trim().toLowerCase()
  const chatHits = chats.filter(x => !t || x.label.toLowerCase().includes(t))
  const people = members.filter(m => m.id !== me && (!t || m.name.toLowerCase().includes(t) || (m.email ?? '').toLowerCase().includes(t)))
  const found = t.length < 2 ? [] : chats.flatMap(x => cache.get<Message[]>(`${keyOf(x.c)}:m`, []).filter(m => m.body?.toLowerCase().includes(t)).map(m => ({ chat: x, m }))).sort((a, b) => b.m.at.localeCompare(a.m.at)).slice(0, 20)
  const mark = (text: string) => { const i = text.toLowerCase().indexOf(t); if (!t || i < 0) return text.slice(0, 120); const from = Math.max(0, i - 40)
    return <>{from ? '…' : ''}{text.slice(from, i)}<mark>{text.slice(i, i + t.length)}</mark>{text.slice(i + t.length, i + t.length + 80)}</> }
  return <div className="tc-search">
    <div className="tc-search-box"><Ico n="search" s={15} /><input autoFocus value={q} placeholder="Search chats, people and messages" onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') onClose() }} />
      <button className="tc-x" aria-label="Close search" onClick={onClose}><Ico n="close" s={14} /></button></div>
    <div className="tc-search-list">
      {!t && <button onClick={onNewGroup}><span className="tc-search-hash">+</span><span>New group chat</span></button>}
      {chatHits.length > 0 && <><h4>Chats</h4>{chatHits.map(x => <button key={x.c} className={x.unread ? 'unread' : ''} onClick={() => onPick(x.c)}>
        {x.dm ? <Avatar id={x.dm.id} name={x.dm.name} size={22} /> : <span className="tc-search-hash">{x.group ? <Ico n="group" s={13} /> : '#'}</span>}<span>{x.label}</span>{x.unread && <em>new</em>}</button>)}</>}
      {people.length > 0 && <><h4>People</h4>{people.map(p => <button key={p.id} onClick={() => onPerson(p)}><Avatar id={p.id} name={p.name} size={22} /><span>{p.name}</span><small>Message</small></button>)}</>}
      {found.length > 0 && <><h4>Messages</h4>{found.map(({ chat, m }) => <button key={`${chat.c}-${m.id}`} className="tc-search-msg" onClick={() => onPick(chat.c)}>
        <span><b>{m.fromName}</b> · {chat.label} · {dayLabel(m.at)} {clock(m.at)}</span><span>{mark(m.body)}</span></button>)}</>}
      {!chatHits.length && !people.length && !found.length && <p className="tc-empty">Nothing found for “{q}”.</p>}
    </div>
  </div>
}

/** Dragging a file or picture from the chat onto a tab: the tab gets the real file (downloaded once), never the picture's
 *  data as text (that pasted megabytes of base64 into Claude Code, chunk after chunk). */
function dragTeamFile(e: React.DragEvent, company: string, file: { id: string; name: string }): void {
  e.dataTransfer.clearData(); e.dataTransfer.setData('application/x-terminai-teamfile', JSON.stringify({ company, id: file.id, name: file.name })); e.dataTransfer.effectAllowed = 'copy'
}

/** A call in the chat, like WhatsApp: missed or declined, or who called and for how long. */
const callLine = (m: Message, mine: boolean) => {
  const c = m.call!, kind = c.video ? 'video call' : 'voice call', who = mine ? 'You' : m.fromName.split(' ')[0]
  if (c.missed) return mine ? `${who} called · no answer` : `Missed ${kind} from ${who}`
  if (c.declined) return `${kind[0].toUpperCase()}${kind.slice(1)} from ${who} · declined`
  const t = c.seconds >= 3600 ? `${Math.floor(c.seconds / 3600)} h ${Math.round((c.seconds % 3600) / 60)} min` : c.seconds >= 60 ? `${Math.floor(c.seconds / 60)} min ${c.seconds % 60} s` : `${c.seconds} s`
  return `${kind[0].toUpperCase()}${kind.slice(1)} · ${who} called · ${t}`
}

/** Links in a message are clickable: they open in the browser (the window's open handler sends them out). */
const URL_RE = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]|www\.[^\s<>"]+[^\s<>".,;:!?)\]])/g
function linkify(text: string): (string | JSX.Element)[] {
  const out: (string | JSX.Element)[] = []; let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const at = m.index ?? 0; if (at > last) out.push(text.slice(last, at))
    const href = m[0].startsWith('www.') ? `https://${m[0]}` : m[0]
    out.push(<a key={at} className="tc-link-out" href={href} target="_blank" rel="noreferrer">{m[0]}</a>); last = at + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function Chat({ draftKey, company, messages, me, others, onSend, onShare }: { draftKey: string; company: string; messages: Message[]; me: string; others: Person[]; onSend: (b: string) => void; onShare: (p: string[]) => void }): JSX.Element {
  // What you were writing stays as a draft (per chat, on this Mac) when the chat is closed, switched or the app restarts.
  const [text, setTextState] = useState(() => cache.get(draftKey, '')), [drag, setDrag] = useState(false)
  const setText = (v: string) => { setTextState(v); if (v) cache.set(draftKey, v); else { try { localStorage.removeItem(draftKey) } catch {} } }
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
          {m.call ? <div className={`tc-call${m.call.missed && !mine ? ' missed' : ''}`}><span><CallIcon n={m.call.video ? 'video' : 'phone'} s={14} />{callLine(m, mine)}</span><small>{clock(m.at)}</small></div> :
          <div className={`tc-msg${mine ? ' mine' : ''}${first ? ' first' : ''}`}>
            <div className="tc-bubble">
              {!mine && first && others.length > 1 && <b className="tc-from">{m.fromName}</b>}
              {m.file && <Attachment company={company} file={m.file} />}
              {m.body && <span className="tc-text">{linkify(m.body)}</span>}
              <span className="tc-meta">{m.fromName === 'failed' ? 'not sent' : clock(m.at)}{mine && <span className={`tc-ticks${readBy(m) ? ' read' : ''}`}><Ico n={m.pending ? 'clock' : readBy(m) || gotBy(m) ? 'checks' : 'check'} s={14} /></span>}</span>
            </div>
          </div>}
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
  return <button className="tc-file" draggable onDragStart={e => dragTeamFile(e, company, file)} onClick={() => void openInPane(company, file.id, file.name)}>
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
  const [big, setBig] = useState(false)
  return <>
    <button className="tc-img" draggable onDragStart={e => dragTeamFile(e, company, file)} title={`${file.name} · click to view or drag onto a tab`} onClick={() => src ? setBig(true) : void openInPane(company, file.id, file.name)}>
      {src ? <img src={src} alt={file.name} draggable={false} /> : <span className="tc-img-wait">{failed ? `${file.name} · click to open` : `Loading · ${size(file.size)}`}</span>}</button>
    {big && <Viewer src={src} name={file.name} onClose={() => setBig(false)}
      onFiles={() => { setBig(false); void openInPane(company, file.id, file.name) }} onFinder={() => void window.term.teamchat.open(company, file.id, file.name, 'reveal')} />}
  </>
}

const ACCESS: Record<TeamFile['access'], string> = { all: 'Everyone', admins: 'Admins only', products: 'Products' }
function Files({ company, admin, me, onError }: { company: string; admin: boolean; me: string; onError: (t: string) => void }): JSX.Element {
  const key = `tc:${company}:f`
  const [files, setFiles] = useState<TeamFile[]>(() => cache.get(key, []))
  const [q, setQ] = useState(''), [access, setAccess] = useState<Access>({ access: 'all', products: [] })
  const [busy, setBusy] = useState(0), [editing, setEditing] = useState<string | null>(null), [showChat, setShowChat] = useState(false), [choosing, setChoosing] = useState(false)
  // Folders: where you are ('' the top), and folders made here that hold no file yet.
  const [cwd, setCwd] = useState(''), [made, setMade] = useState<string[]>([]), [naming, setNaming] = useState(false), [newName, setNewName] = useState('')
  const options = useProducts(files.flatMap(f => f.products ?? []))
  const load = () => void window.term.teamchat.files(company).then(r => { setFiles(r.files); cache.set(key, r.files) }).catch(e => onError(String(e.message ?? e)))
  useEffect(load, [company]) // eslint-disable-line react-hooks/exhaustive-deps
  const upload = async (paths: string[]) => {
    setBusy(n => n + paths.length)
    for (const p of paths) { try { await window.term.teamchat.upload(company, p, access.access, access.products, false, cwd) } catch (e) { onError(String((e as Error).message ?? e)) } finally { setBusy(n => n - 1) } }
    load()
  }
  // Share link: copied to the clipboard; a shared file shows a link mark, and its menu can stop the link.
  const [copied, setCopied] = useState(''), [linkMenu, setLinkMenu] = useState<string | null>(null)
  const share = (f: TeamFile, on: boolean) => void window.term.teamchat.share(company, f.id, on).then(r => {
    setLinkMenu(null); if (r.url) { void navigator.clipboard.writeText(r.url); setCopied(f.id); window.setTimeout(() => setCopied(c => c === f.id ? '' : c), 2500) } load()
  }).catch(e => onError(String(e.message ?? e)))
  const change = (f: TeamFile, c: object | null) => void window.term.teamchat.change(company, f.id, c).then(load).catch(e => onError(String(e.message ?? e)))
  // Searching looks in every folder; otherwise the files of this folder and the folders inside it.
  const visible = useMemo(() => files.filter(f => showChat || !f.fromChat), [files, showChat])
  const shown = useMemo(() => q ? visible.filter(f => `${f.folder ?? ''}/${f.name}`.toLowerCase().includes(q.toLowerCase())) : visible.filter(f => (f.folder ?? '') === cwd), [visible, q, cwd])
  const subfolders = useMemo(() => {
    if (q) return []
    const inside = new Set<string>(), pre = cwd ? `${cwd}/` : ''
    for (const path of [...visible.map(f => f.folder ?? ''), ...made]) if (path.startsWith(pre) && path !== cwd) { const next = path.slice(pre.length).split('/')[0]; if (next) inside.add(next) }
    return [...inside].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }, [visible, made, cwd, q])
  const countIn = (path: string) => visible.filter(f => (f.folder ?? '') === path || (f.folder ?? '').startsWith(`${path}/`)).length
  const makeFolder = () => { const n = newName.replace(/\//g, ' ').trim(); if (n) { const path = cwd ? `${cwd}/${n}` : n; setMade(m => [...m, path]); setCwd(path) } setNaming(false); setNewName('') }
  return <div className="tc-files" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void upload([...e.dataTransfer.files].map(f => window.term.teamchat.pathOf(f)).filter(Boolean)) }}>
    <div className="tc-up">
      <button className="tc-access-btn" onClick={() => setChoosing(v => !v)} title="Who can see what you upload">
        <Ico n="lock" s={14} />{access.access === 'all' ? 'Everyone' : access.access === 'admins' ? 'Admins only' : access.products.length ? access.products.join(', ') : 'Choose products'}</button>
      <button className="tc-btn" onClick={() => void window.term.teamchat.pick().then(p => { if (p.length) void upload(p) })}>{busy ? `Uploading ${busy}…` : 'Upload'}</button>
    </div>
    {choosing && <div className="tc-access-pop"><small>New uploads can be seen by</small><AccessPicker value={access} onChange={setAccess} admin={admin} options={options} /></div>}
    <div className="tc-search"><input placeholder="Search files" value={q} onChange={e => setQ(e.target.value)} />
      <label><input type="checkbox" checked={showChat} onChange={e => setShowChat(e.target.checked)} /> From chat</label></div>
    <div className="tc-crumbs">
      {cwd ? <button className="tc-link" title="Up one folder" aria-label="Up one folder" onClick={() => setCwd(cwd.split('/').slice(0, -1).join('/'))}><Ico n="back" s={15} /></button> : null}
      <button className="tc-crumb" onClick={() => setCwd('')}>All files</button>
      {cwd.split('/').filter(Boolean).map((part, i, all) => <span key={i}><span className="tc-crumb-sep">/</span><button className="tc-crumb" onClick={() => setCwd(all.slice(0, i + 1).join('/'))}>{part}</button></span>)}
      <span className="tc-crumbs-gap" />
      {naming ? <input className="tc-newfolder" autoFocus placeholder="Folder name" value={newName} onChange={e => setNewName(e.target.value)} onBlur={makeFolder}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') makeFolder(); if (e.key === 'Escape') { setNaming(false); setNewName('') } }} />
        : <button className="tc-link" title="New folder here" aria-label="New folder" onClick={() => setNaming(true)}><Ico n="plusFolder" s={16} /></button>}
    </div>
    <div className="tc-flist">
      {subfolders.map(name => { const path = cwd ? `${cwd}/${name}` : name; return <div key={path} className="tc-frow tc-folder">
        <button className="tc-fmain" onClick={() => setCwd(path)} title={`Open ${name}`}>
          <span className="tc-file-ico folder"><Ico n="folder" /></span>
          <span className="tc-file-name">{name}<small>{countIn(path)} {countIn(path) === 1 ? 'file' : 'files'}</small></span></button></div> })}
      {!shown.length && !subfolders.length && <p className="tc-empty">{q ? 'Nothing matches.' : cwd ? 'This folder is empty. Drop files here or press Upload.' : 'No team files yet. Drop files here or press Upload.'}</p>}
      {shown.map(f => {
        const mine = admin || f.by === me
        return <div key={f.id}><div className="tc-frow">
          <button className="tc-fmain" onClick={() => void openInPane(company, f.id, f.name).catch(e => onError(String(e.message ?? e)))} title="Open (downloads it the first time)">
            <span className="tc-file-ico">{isImage(f.name) ? <Ico n="image" /> : (f.name.split('.').pop() ?? '').slice(0, 4).toUpperCase()}</span>
            <span className="tc-file-name">{f.name}<small>{q && f.folder ? `${f.folder} · ` : ''}{size(f.size)} · {f.byName ?? 'someone'} · {dayLabel(f.createdAt)}</small></span></button>
          {editing === f.id ? null
            : <span className={`tc-acc ${f.access}`} title="Who can see it">{f.access === 'products' ? (f.products ?? []).join(', ') || 'No one' : ACCESS[f.access]}</span>}
          <span className="tc-factions">
            <button className="tc-link" title="Show in Finder" aria-label="Show in Finder" onClick={() => void window.term.teamchat.open(company, f.id, f.name, 'reveal')}><Ico n="reveal" s={15} /></button>
            {mine && <button className={`tc-link${f.shared ? ' on' : ''}`} title={f.shared ? 'Shared by link: copy a new link or stop it' : 'Copy a share link anyone can open'} aria-label="Share link"
              onClick={() => f.shared ? setLinkMenu(linkMenu === f.id ? null : f.id) : share(f, true)}>{copied === f.id ? <span className="tc-copied">Copied</span> : <Ico n="link" s={15} />}</button>}
            {mine && <button className="tc-link" title="Who can see it" aria-label="Who can see it" onClick={() => setEditing(editing === f.id ? null : f.id)}><Ico n="lock" s={15} /></button>}
            {mine && <button className="tc-link" title="Delete" aria-label="Delete" onClick={() => change(f, null)}><Ico n="trash" s={15} /></button>}
          </span>
        </div>
        {linkMenu === f.id && <div className="tc-access-pop inline tc-linkmenu"><small>Anyone with the link can open this file.</small>
          <button className="tc-btn" onClick={() => share(f, true)}>Copy a new link</button><button className="tc-link danger" onClick={() => share(f, false)}>Stop sharing</button></div>}
        {editing === f.id && <div className="tc-access-pop inline"><AccessPicker value={{ access: f.access, products: f.products ?? [] }} admin={admin} options={options}
          onChange={v => change(f, { access: v.access, products: v.access === 'products' ? v.products : undefined })} /><button className="tc-link" onClick={() => setEditing(null)}>Done</button></div>}
      </div>
      })}
    </div>
  </div>
}

/** A picture from the chat, big over the app: Open in Files puts it in the Files pane, Esc or a click outside closes it. */
function Viewer({ src, name, onClose, onFiles, onFinder }: { src: string; name: string; onClose: () => void; onFiles: () => void; onFinder: () => void }): JSX.Element {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }; window.addEventListener('keydown', k, true); return () => window.removeEventListener('keydown', k, true) }, [onClose])
  return <div className="tc-viewer" role="dialog" aria-label={name} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="tc-viewer-bar"><span>{name}</span>
      <button className="tc-btn" onClick={onFiles}>Open in Files</button>
      <button className="tc-link" title="Show in Finder" aria-label="Show in Finder" onClick={onFinder}><Ico n="reveal" s={15} /></button>
      <button className="tc-link" title="Close  Esc" aria-label="Close" onClick={onClose}><Ico n="close" s={16} /></button></div>
    <img src={src} alt={name} />
  </div>
}

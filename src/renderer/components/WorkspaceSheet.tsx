import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { DEFAULT_WORKSPACE_URL, inviteTokenOf } from '../../shared/workspace'
import type { McpSetupResult, WorkspaceNote, WorkspaceState } from '../../shared/workspace'
import { snapshot } from '../snapshots'
import { tabLabel } from '../../shared/types'
import './workspace.css'

// The team workspace: the same server, account and data as the website and the iPhone app.
type Conversation = { id: string; title: string; visibility: string; ownerId?: string; owner_id?: string; updatedAt?: string }
type Message = { id: string; content: string; kind: string; authorName?: string; author_name?: string; createdAt?: string }
type Member = { id: string; name: string; email: string; role: string }
type Tab = { id: string; title: string; customTitle?: string }
type Section = 'notes' | 'conversations' | 'tools'
const items = <T,>(value: any): T[] => Array.isArray(value) ? value : value?.items ?? value?.conversations ?? value?.messages ?? value?.catalog ?? []
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'
const P = {
  notes: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2 2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2zM9 12l2 2 4-4',
  conversations: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  tools: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  out: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3', web: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  close: 'M6 6l12 12M18 6L6 18', trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3', live: 'M12 12h.01M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8',
}
const Icon = ({ d, size = 15 }: { d: string; size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>

export function WorkspaceSheet({ activeTab, tabs = [], onClose }: { activeTab?: Tab; tabs?: Tab[]; onClose: () => void }): JSX.Element {
  const [state, setState] = useState<WorkspaceState>({ url: '', signedIn: false })
  const [loading, setLoading] = useState(true)
  const [company, setCompany] = useState('')
  const [section, setSection] = useState<Section>('notes')
  const [error, setError] = useState('')
  const [tools, setTools] = useState<McpSetupResult[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const membership = state.identity?.companies.find(row => row.id === company)
  const base = `/api/companies/${company}`
  const fail = (err: unknown) => setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'The workspace could not be reached.')

  useEffect(() => {
    window.term.workspace.state().then(value => { setState(value); setCompany(value.identity?.companies[0]?.id ?? '') }).catch(fail).finally(() => setLoading(false))
  }, [])
  useEffect(() => {
    setTools([]); setMembers([])
    if (!company || !state.signedIn) return
    void window.term.workspace.request(`${base}/members`).then(v => setMembers(v.members ?? [])).catch(fail)
    void window.term.workspace.setupTools(company).then(setTools).catch(fail)
  }, [company, state.signedIn])
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('input,textarea')) onClose() }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key) }, [onClose])

  const signedIn = (value: WorkspaceState) => { setState(value); setCompany(value.identity?.companies[0]?.id ?? ''); setError('') }
  return <div className="workspace-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <section className="team-sheet" role="dialog" aria-modal="true" aria-label="TerminAI Sync">
      {error && <p className="team-error" role="alert" onClick={() => setError('')}>{error}</p>}
      {loading ? <div className="team-empty">Connecting…</div>
        : !state.signedIn ? <TeamSignIn onDone={signedIn} onError={fail} onClose={onClose} />
        : <div className="team-shell">
          <aside className="team-side">
            <div className="team-brand"><span className="team-mark">›_</span>Sync</div>
            {(state.identity?.companies.length ?? 0) > 1
              ? <select aria-label="Workspace" value={company} onChange={e => setCompany(e.target.value)}>{state.identity?.companies.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
              : <div className="team-company">{membership?.name}<small>{membership?.role}</small></div>}
            <nav>{(['notes', 'conversations', 'tools'] as Section[]).map(key => <button key={key} aria-current={section === key ? 'page' : undefined} onClick={() => setSection(key)}><Icon d={P[key]} />{key[0].toUpperCase() + key.slice(1)}</button>)}</nav>
            <div className="team-me">
              <span className="team-avatar">{initials(state.identity?.user.name)}</span>
              <div><strong>{state.identity?.user.name}</strong><small>{state.identity?.user.email}</small></div>
            </div>
            <div className="team-side-actions">
              <button title="Invite people and change settings on the web" onClick={() => void window.term.workspace.openManager().catch(fail)}><Icon d={P.web} size={13} />Manage on the web</button>
              <button onClick={() => void window.term.workspace.logout().catch(fail).finally(() => { setState({ url: state.url, signedIn: false }); setCompany('') })}><Icon d={P.out} size={13} />Sign out</button>
            </div>
          </aside>
          <main className="team-main">
            <button className="team-close" aria-label="Close sync" onClick={onClose}><Icon d={P.close} /></button>
            {company && section === 'notes' && <TeamNotes key={company} base={base} me={state.identity!.user.id} members={members} role={membership?.role ?? 'viewer'} teamName={membership?.name ?? ''} onError={fail} />}
            {company && section === 'conversations' && <TeamConversations key={company} base={base} me={state.identity!.user.id} membership={membership} activeTab={activeTab} tabs={tabs} onError={fail} />}
            {section === 'tools' && <div className="team-page">
              <header><h2>Tools</h2><p>The tools set up for you on this Mac. Change them on the web.</p></header>
              {tools.length ? <div className="team-list">{tools.map(tool => <div className="team-row" key={tool.id}><div><strong>{tool.id}</strong><small>{tool.message}</small></div><span className={`team-badge ${tool.status === 'configured' ? 'ok' : 'warn'}`}>{tool.status === 'configured' ? 'Ready' : tool.status === 'needs-setup' ? 'Needs setup' : 'Error'}</span></div>)}</div>
                : <p className="team-muted">No tools are assigned to your role.</p>}
            </div>}
          </main>
        </div>}
    </section>
  </div>
}

export function TeamSignIn({ onDone, onError, onClose }: { onDone: (s: WorkspaceState) => void; onError: (e: unknown) => void; onClose?: () => void }): JSX.Element {
  const [mode, setMode] = useState<'signin' | 'signup' | 'invite'>('signin')
  const [url, setUrl] = useState(DEFAULT_WORKSPACE_URL)
  const [form, setForm] = useState({ name: '', email: '', password: '', invite: '' })
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true)
    try {
      onDone(await window.term.workspace.login({ url, password: form.password,
        ...(mode === 'signin' ? { email: form.email } : mode === 'signup' ? { signup: true, name: form.name, email: form.email } : { name: form.name, inviteToken: inviteTokenOf(form.invite) }) }))
    } catch (err) { onError(err) } finally { setBusy(false) }
  }
  const titles = { signin: ['Sign in to sync', 'Your notes and conversations, the same on this Mac, the web and your iPhone.'], signup: ['Create an account', 'Free. Use it by yourself; invite people only if you want to.'], invite: ['Join with an invitation', 'Paste the link someone sent you.'] }
  return <div className="team-auth">
    {onClose && <button className="team-close" aria-label="Close" onClick={onClose}><Icon d={P.close} /></button>}
    <form onSubmit={submit}>
      <span className="team-mark big">›_</span>
      <h2>{titles[mode][0]}</h2><p className="team-muted">{titles[mode][1]}</p>
      {mode === 'invite' && <label>Invitation link<input required autoFocus value={form.invite} onChange={set('invite')} placeholder="https://…/#invite=…" /></label>}
      {mode !== 'signin' && <label>Your name<input required value={form.name} onChange={set('name')} autoFocus={mode === 'signup'} /></label>}
      {mode !== 'invite' && <label>Email<input required type="email" autoComplete="username" value={form.email} onChange={set('email')} autoFocus={mode === 'signin'} /></label>}
      <label>Password<input required type="password" minLength={mode === 'signin' ? 1 : 12} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} placeholder={mode === 'signin' ? '' : '12 characters or more'} value={form.password} onChange={set('password')} /></label>
      <button className="team-primary" disabled={busy}>{busy ? 'Connecting…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Join'}</button>
      <div className="team-switch">
        {mode !== 'signin' && <button type="button" onClick={() => setMode('signin')}>I have an account</button>}
        {mode !== 'signup' && <button type="button" onClick={() => setMode('signup')}>Create an account</button>}
        {mode !== 'invite' && <button type="button" onClick={() => setMode('invite')}>I have an invitation</button>}
      </div>
      <details className="team-server"><summary>Server</summary><label>Server address<input type="url" value={url} onChange={e => setUrl(e.target.value)} /></label><small>Leave it unless you run your own TerminAI server.</small></details>
    </form>
  </div>
}

const NOTE_MIME = 'application/x-terminai-note'
function TeamNotes({ base, me, members, role, teamName, onError }: { base: string; me: string; members: Member[]; role: string; teamName: string; onError: (e: unknown) => void }): JSX.Element {
  const [notes, setNotes] = useState<WorkspaceNote[]>([])
  const [view, setView] = useState<'private' | 'company'>('private')
  const [showDone, setShowDone] = useState(false)
  const canTeam = role !== 'viewer'
  const load = () => window.term.workspace.request(`${base}/notes`).then(v => setNotes((v.notes ?? []).filter((n: WorkspaceNote) => n.kind !== 'doc'))).catch(onError)
  useEffect(() => { void load(); const t = setInterval(() => void load(), 10000); return () => clearInterval(t) }, [base])
  const save = async (id: string, patch: Partial<WorkspaceNote>) => { try { await window.term.workspace.request(`${base}/notes/${id}`, 'PATCH', patch); await load() } catch (e) { onError(e) } }
  const add = async (title: string, assigneeId?: string | null) => { try { await window.term.workspace.request(`${base}/notes`, 'POST', { title, visibility: view, ...(assigneeId ? { assigneeId } : {}) }); await load() } catch (e) { onError(e) } }
  const visible = notes.filter(n => n.visibility === view && (showDone || n.status === 'open'))
  const done = notes.filter(n => n.visibility === view && n.status === 'done').length
  const drop = (items: WorkspaceNote[], assigneeId: string | null) => (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(NOTE_MIME); if (!id) return
    e.preventDefault(); (e.currentTarget as HTMLElement).classList.remove('over')
    const target = (e.target as HTMLElement).closest<HTMLElement>('.team-note'), rest = items.filter(n => n.id !== id)
    let at = rest.length
    if (target && target.dataset.id !== id) { const r = target.getBoundingClientRect(); at = rest.findIndex(n => n.id === target.dataset.id) + (e.clientY > r.top + r.height / 2 ? 1 : 0) }
    const before = rest[at - 1]?.position, after = rest[at]?.position
    const position = before === undefined && after === undefined ? 1 : before === undefined ? after! - 1 : after === undefined ? before + 1 : (before + after) / 2
    void save(id, { position, ...(view === 'company' ? { assigneeId } : {}) })
  }
  const zone = (items: WorkspaceNote[], assigneeId: string | null) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(NOTE_MIME)) { e.preventDefault(); e.currentTarget.classList.add('over') } },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) e.currentTarget.classList.remove('over') },
    onDrop: drop(items, assigneeId),
  })
  const card = (n: WorkspaceNote) => <NoteCard key={n.id} note={n} me={me} admin={['owner', 'admin'].includes(role)} canTeam={canTeam} save={save}
    remove={async () => { try { await window.term.workspace.request(`${base}/notes/${n.id}`, 'DELETE'); await load() } catch (e) { onError(e) } }} />
  return <div className="team-page wide">
    <header><div><h2>Notes</h2><p>{view === 'private' ? 'Only you can see these, on this Mac, the web and your iPhone.' : `Shared with everyone in ${teamName}.`}</p></div>
      <div className="team-head-actions">
        <div className="team-seg">{members.length > 1 && ([['private', 'My notes'], ['company', 'Shared board']] as const).map(([k, l]) => <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>{l}</button>)}</div>
        <button className="team-ghost" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide done' : `Show done${done ? ` (${done})` : ''}`}</button>
      </div></header>
    {view === 'private' ? <div className="team-notes-solo">
      <Adder placeholder="Add a note…" onAdd={t => add(t)} autoFocus />
      <div className="team-notes" {...zone(visible, null)}>{visible.length ? visible.map(card) : <p className="team-empty small">Nothing here yet. Type above and press Return.</p>}</div>
    </div> : <div className="team-board">
      {[...members.map(m => ({ id: m.id as string | null, label: m.id === me ? `${m.name} (you)` : m.name, avatar: initials(m.name) })), { id: null, label: 'Unassigned', avatar: '' }].map(col => {
        const items = visible.filter(n => (n.assigneeId || null) === col.id)
        return <section className="team-column" key={col.id ?? 'none'}>
          <header>{col.avatar && <span className="team-avatar sm">{col.avatar}</span>}<h3>{col.label}</h3><small>{items.filter(n => n.status === 'open').length}</small></header>
          {canTeam && <Adder placeholder={col.id === me ? 'Add for yourself…' : col.id ? `Add for ${col.label.split(' ')[0]}…` : 'Add…'} onAdd={t => add(t, col.id)} />}
          <div className="team-notes" {...zone(items, col.id)}>{items.map(card)}</div>
        </section>
      })}
    </div>}
  </div>
}

function Adder({ placeholder, onAdd, autoFocus }: { placeholder: string; onAdd: (title: string) => Promise<void>; autoFocus?: boolean }): JSX.Element {
  const [text, setText] = useState('')
  return <form className="team-adder" onSubmit={e => { e.preventDefault(); const t = text.trim(); if (!t) return; setText(''); void onAdd(t) }}>
    <input aria-label={placeholder} placeholder={placeholder} value={text} maxLength={500} autoFocus={autoFocus} onChange={e => setText(e.target.value)} />
  </form>
}

function NoteCard({ note, me, admin, canTeam, save, remove }: { note: WorkspaceNote; me: string; admin: boolean; canTeam: boolean; save: (id: string, p: Partial<WorkspaceNote>) => Promise<void>; remove: () => Promise<void> }): JSX.Element {
  const [title, setTitle] = useState(note.title), [body, setBody] = useState(note.body)
  useEffect(() => { setTitle(note.title); setBody(note.body) }, [note.title, note.body])
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { const a = area.current; if (a) { a.style.height = 'auto'; a.style.height = a.scrollHeight + 'px' } }, [body])
  const readOnly = note.visibility === 'company' && !canTeam
  return <article className={`team-note ${note.status}`} data-id={note.id}>
    <span className="team-grip" draggable={!readOnly} title="Drag to move" onDragStart={e => { e.dataTransfer.setData(NOTE_MIME, note.id); e.dataTransfer.effectAllowed = 'move' }}>⋮⋮</span>
    <input type="checkbox" aria-label="Done" checked={note.status === 'done'} disabled={readOnly} onChange={e => void save(note.id, { status: e.target.checked ? 'done' : 'open' })} />
    <div className="team-note-main">
      <input className="team-note-title" aria-label="Title" value={title} readOnly={readOnly} maxLength={500} onChange={e => setTitle(e.target.value)} onBlur={() => { if (title.trim() && title !== note.title) void save(note.id, { title }) }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
      <textarea ref={area} className="team-note-body" rows={1} aria-label="Details" placeholder="Details…" value={body} readOnly={readOnly} onChange={e => setBody(e.target.value)} onBlur={() => { if (body !== note.body) void save(note.id, { body }) }} />
      {note.visibility === 'company' && note.updatedByName && <small>{note.updatedBy === me ? 'You' : note.updatedByName} · {new Date(note.updatedAt).toLocaleDateString()}</small>}
    </div>
    <div className="team-note-tools">
      {note.visibility === 'private' && canTeam && <button onClick={() => void save(note.id, { visibility: 'company' })}>Move to shared board</button>}
      {note.visibility === 'company' && note.ownerId === me && <button onClick={() => void save(note.id, { visibility: 'private' })}>Make private</button>}
      {(note.ownerId === me || admin) && <button aria-label="Delete" title="Delete" onClick={() => { if (confirm(`Delete “${note.title}”?`)) void remove() }}><Icon d={P.trash} size={13} /></button>}
    </div>
  </article>
}

function TeamConversations({ base, me, membership, activeTab, tabs, onError }: { base: string; me: string; membership?: { role: string; allowCompanySharing: boolean; defaultVisibility: string }; activeTab?: Tab; tabs: Tab[]; onError: (e: unknown) => void }): JSX.Element {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [filter, setFilter] = useState<'all' | 'shared' | 'mine'>('all')
  const [selected, setSelected] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [live, setLive] = useState<{ conversation: string; tab: string } | null>(null)
  const [sharePick, setSharePick] = useState('')
  const [naming, setNaming] = useState(false)
  const lastSnapshot = useRef('')
  const owner = (c?: Conversation) => (c?.ownerId ?? c?.owner_id) === me
  const viewer = membership?.role === 'viewer'
  const load = () => window.term.workspace.request(`${base}/conversations`).then(v => setConversations(items(v))).catch(onError)
  useEffect(() => { void load(); const t = setInterval(() => void load(), 8000); return () => clearInterval(t) }, [base])
  useEffect(() => { if (!selected && conversations.length) setSelected(conversations[0].id) }, [conversations, selected])
  useEffect(() => {
    setMessages([]); if (!selected) return
    let stopped = false
    const refresh = () => window.term.workspace.request(`${base}/conversations/${selected}/messages`).then(v => { if (!stopped) setMessages(items(v)) }).catch(onError)
    void refresh(); const t = setInterval(() => void refresh(), 4000)
    return () => { stopped = true; clearInterval(t) }
  }, [base, selected])
  // Live sharing posts the chosen tab's visible screen every few seconds, only while this panel is open.
  useEffect(() => {
    if (!live) return
    const tab = tabs.find(t => t.id === live.tab); if (!tab) return
    let inFlight = false
    const share = async () => {
      const text = snapshot(tab.id, 30).join('\n').slice(-12000)
      if (!text.trim() || text === lastSnapshot.current || inFlight) return
      inFlight = true
      try { await window.term.workspace.request(`${base}/conversations/${live.conversation}/messages`, 'POST', { content: `Screen of ${tabLabel(tab)}\n\n${text}`, kind: 'note', clientMessageId: crypto.randomUUID() }); lastSnapshot.current = text }
      catch (err) { onError(err); setLive(null) } finally { inFlight = false }
    }
    void share(); const t = setInterval(() => void share(), 8000)
    return () => clearInterval(t)
  }, [live?.conversation, live?.tab, base])

  async function startShare(tabId: string) {
    const tab = tabs.find(t => t.id === tabId); if (!tab) return
    try {
      const result = await window.term.workspace.request(`${base}/conversations`, 'POST', { title: tabLabel(tab), visibility: membership?.allowCompanySharing ? 'company' : 'owner' })
      const row: Conversation = result.conversation ?? result
      setConversations(v => [row, ...v]); setSelected(row.id); setLive({ conversation: row.id, tab: tab.id }); setSharePick('')
    } catch (e) { onError(e) }
  }
  async function newThread(title: string) {
    try {
      const result = await window.term.workspace.request(`${base}/conversations`, 'POST', { title, visibility: membership?.allowCompanySharing ? 'company' : 'owner' })
      const row: Conversation = result.conversation ?? result
      setConversations(v => [row, ...v]); setSelected(row.id); setNaming(false)
    } catch (e) { onError(e) }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault(); if (!draft.trim()) return
    try { await window.term.workspace.request(`${base}/conversations/${selected}/messages`, 'POST', { content: draft, kind: 'user', clientMessageId: crypto.randomUUID() }); setDraft(''); setMessages(items(await window.term.workspace.request(`${base}/conversations/${selected}/messages`))) }
    catch (e) { onError(e) }
  }
  const shown = conversations.filter(c => filter === 'all' || (filter === 'shared' ? c.visibility === 'company' : owner(c)))
  const active = conversations.find(c => c.id === selected)
  return <div className="team-page wide">
    <header><div><h2>Conversations</h2><p>Your conversation threads, private unless you share them. Share a session to post its screen live while this panel is open; nothing is ever run on anyone’s Mac.</p></div>
      {!viewer && <div className="team-head-actions">
        <select className="team-share-pick" aria-label="Share a session" value={sharePick} onChange={e => { setSharePick(e.target.value); void startShare(e.target.value) }}>
          <option value="">Share a session…</option>
          {activeTab && <option value={activeTab.id}>This tab: {tabLabel(activeTab)}</option>}
          {tabs.filter(t => t.id !== activeTab?.id).map(t => <option key={t.id} value={t.id}>{tabLabel(t)}</option>)}
        </select>
        <button className="team-primary small" onClick={() => setNaming(true)}>New thread</button>
      </div>}</header>
    <div className="team-convo">
      <div className="team-convo-list">
        <div className="team-seg full">{(['all', 'shared', 'mine'] as const).map(k => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{k === 'all' ? `All ${conversations.length}` : k === 'shared' ? 'Shared' : 'Mine'}</button>)}</div>
        {naming && <Adder placeholder="Thread title, then Return" autoFocus onAdd={newThread} />}
        {shown.map(c => <button key={c.id} className={`team-convo-item ${c.id === selected ? 'active' : ''}`} onClick={() => setSelected(c.id)}>
          <span>{c.title}</span>
          <small>{live?.conversation === c.id ? <b className="team-live"><Icon d={P.live} size={11} />Live</b> : c.visibility === 'company' ? 'Shared' : 'Private'}</small>
        </button>)}
        {!shown.length && <p className="team-empty small">No conversations yet. Share a session or start a thread.</p>}
      </div>
      <div className="team-thread">
        {active ? <>
          <div className="team-thread-head"><h3>{active.title}</h3>
            {owner(active) && !viewer && (live?.conversation === active.id
              ? <button className="team-ghost live" onClick={() => setLive(null)}><Icon d={P.live} size={13} />Stop sharing</button>
              : activeTab && <button className="team-ghost" onClick={() => setLive({ conversation: active.id, tab: activeTab.id })}><Icon d={P.live} size={13} />Share this tab live</button>)}
          </div>
          <div className="team-messages" aria-live="polite">{messages.map(m => <article key={m.id} className={m.kind}><header><strong>{m.authorName || m.author_name || m.kind}</strong>{m.createdAt && <small>{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>}</header><pre>{m.content}</pre></article>)}
            {!messages.length && <p className="team-empty small">No messages yet.</p>}</div>
          {!viewer && <form className="team-compose" onSubmit={send}><textarea aria-label="Message" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e) }} maxLength={16000} placeholder="Write a message…  ⌘Return to send" /><button className="team-primary small" disabled={!draft.trim()}>Send</button></form>}
        </> : <p className="team-empty">Pick a conversation.</p>}
      </div>
    </div>
  </div>
}

/** TerminAI needs an account: until this Mac is signed in, this covers the whole window. The code is open; using the app takes an account. */
export function AccountGate({ onDone }: { onDone: () => void }): JSX.Element {
  const [error, setError] = useState('')
  const fail = (err: unknown) => setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'The server could not be reached.')
  return <div className="account-gate" role="dialog" aria-modal="true" aria-label="Sign in to TerminAI">
    {error && <p className="team-error" role="alert" onClick={() => setError('')}>{error}</p>}
    <TeamSignIn onDone={onDone} onError={fail} />
    <p className="account-gate-foot">An account is free. It keeps your notes and conversations in sync across your Mac, the web and your iPhone.</p>
  </div>
}

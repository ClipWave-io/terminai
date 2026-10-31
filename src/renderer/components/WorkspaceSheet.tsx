import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { DEFAULT_WORKSPACE_URL, inviteTokenOf } from '../../shared/workspace'
import type { McpSetupResult, WorkspaceState } from '../../shared/workspace'
import { snapshot } from '../snapshots'
import { tabLabel } from '../../shared/types'
import './workspace.css'

// The team workspace: the same server, account and data as the website and the iPhone app.
type Conversation = { id: string; title: string; visibility: string; ownerId?: string; owner_id?: string; updatedAt?: string }
type Message = { id: string; content: string; kind: string; authorName?: string; author_name?: string; createdAt?: string }
type Member = { id: string; name: string; email: string; role: string }
type Tab = { id: string; title: string; customTitle?: string }
type Section = 'people' | 'conversations' | 'tools'
const items = <T,>(value: any): T[] => Array.isArray(value) ? value : value?.items ?? value?.conversations ?? value?.messages ?? value?.catalog ?? []
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'
const P = {
  people: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8',
  notes: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2 2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2zM9 12l2 2 4-4',
  conversations: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  tools: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  out: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3', web: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  close: 'M6 6l12 12M18 6L6 18', trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3', live: 'M12 12h.01M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8',
}
const Icon = ({ d, size = 15 }: { d: string; size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>

export function WorkspaceSheet({ activeTab, tabs = [], onClose, onTodos }: { activeTab?: Tab; tabs?: Tab[]; onClose: () => void; onTodos: () => void }): JSX.Element {
  const [state, setState] = useState<WorkspaceState>({ url: '', signedIn: false })
  const [loading, setLoading] = useState(true)
  const [company, setCompany] = useState('')
  const [section, setSection] = useState<Section>('people')
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
            <nav>
              {/* The tasks and the shared notes are one place, the To-do: this opens it (and closes this panel). */}
              <button onClick={onTodos}><Icon d={P.notes} />To-do &amp; notes</button>
              {(['people', 'conversations', 'tools'] as Section[]).map(key => <button key={key} aria-current={section === key ? 'page' : undefined} onClick={() => setSection(key)}><Icon d={P[key]} />{key === 'people' ? 'Members' : key[0].toUpperCase() + key.slice(1)}</button>)}
            </nav>
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
            {company && section === 'people' && <TeamPeople key={company} base={base} state={state} members={members} admin={['owner', 'admin'].includes(membership?.role ?? '')}
              onRenamed={name => setState(v => v.identity ? { ...v, identity: { ...v.identity, user: { ...v.identity.user, name } } } : v)}
              onInvited={() => void window.term.workspace.request(`${base}/members`).then(v => setMembers(v.members ?? [])).catch(fail)} onError={fail} />}
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
  /** The code of a browser sign-in in progress: the website shows the same one. */
  const [waiting, setWaiting] = useState('')
  async function viaBrowser() {
    try {
      const { code } = await window.term.workspace.browserLoginStart(url)
      setWaiting(code)
      onDone(await window.term.workspace.browserLoginWait())
    } catch (err) { if (!String(err).includes('Cancelled.')) onError(err) } finally { setWaiting('') }
  }
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
      {mode !== 'invite' && (waiting
        ? <div className="team-browser-wait" role="status"><span>Allow it in your browser. It shows this code:</span><strong>{waiting}</strong>
            <button type="button" onClick={() => void window.term.workspace.browserLoginCancel()}>Cancel</button></div>
        : <><button type="button" className="team-primary team-browser" onClick={() => void viaBrowser()}>Sign in with browser</button>
            <div className="team-or"><span>or with your email</span></div></>)}
      {mode === 'invite' && <label>Invitation link<input required autoFocus value={form.invite} onChange={set('invite')} placeholder="https://…/#invite=…" /></label>}
      {mode !== 'signin' && <label>Your name<input required value={form.name} onChange={set('name')} autoFocus={mode === 'signup'} /></label>}
      {mode !== 'invite' && <label>Email<input required type="email" autoComplete="username" value={form.email} onChange={set('email')} autoFocus={mode === 'signin'} /></label>}
      {mode !== 'invite' && <label>Password<input required type="password" minLength={mode === 'signin' ? 1 : 12} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} placeholder={mode === 'signin' ? '' : '12 characters or more'} value={form.password} onChange={set('password')} /></label>}
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

/** Who is in the workspace, your own name, and an invitation link to send someone (no password needed to join). */
function TeamPeople({ base, state, members, admin, onRenamed, onInvited, onError }: { base: string; state: WorkspaceState; members: Member[]; admin: boolean; onRenamed: (name: string) => void; onInvited: () => void; onError: (e: unknown) => void }): JSX.Element {
  const me = state.identity!.user
  const [name, setName] = useState(me.name)
  const [email, setEmail] = useState('')
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [code, setCode] = useState('')
  const [allowed, setAllowed] = useState('')
  const allow = async () => { try { await window.term.workspace.request('/api/auth/device/approve', 'POST', { code: code.trim() }); setAllowed(code.trim().toUpperCase()); setCode('') } catch (e) { onError(e) } }
  const rename = async () => { if (!name.trim() || name.trim() === me.name) return; try { await window.term.workspace.request('/api/me', 'PATCH', { name: name.trim() }); onRenamed(name.trim()) } catch (e) { onError(e) } }
  const invite = async () => {
    try { const v = await window.term.workspace.request(`${base}/invites`, 'POST', { email: email.trim(), role: 'admin' }); setLink(v.inviteUrl); setCopied(false); onInvited() } catch (e) { onError(e) }
  }
  return <div className="team-page">
    <header><div><h2>Members</h2><p>Everyone here shares the To-do, the notes and the conversations you share.</p></div></header>
    <div className="team-list">{members.map(m => <div className="team-row" key={m.id}><div><strong>{m.name}{m.id === me.id ? ' (you)' : ''}</strong><small>{m.email}</small></div><span className="team-badge">{m.role}</span></div>)}</div>
    <form className="team-form" onSubmit={e => { e.preventDefault(); void rename() }}>
      <label>Your name<input value={name} maxLength={120} onChange={e => setName(e.target.value)} onBlur={() => void rename()} /></label>
    </form>
    <form className="team-form" onSubmit={e => { e.preventDefault(); void allow() }}>
      <label>Sign in a phone or another Mac<input value={code} placeholder="Code it shows, e.g. ABCD-EFGH" autoComplete="off" onChange={e => { setCode(e.target.value); setAllowed('') }} /></label>
      <button className="btn" type="submit" disabled={code.trim().replace('-', '').length !== 8}>Allow</button>
      {allowed && <small>{allowed} is allowed: that device signs in as you in a moment.</small>}
    </form>
    {admin && <form className="team-form" onSubmit={e => { e.preventDefault(); void invite() }}>
      <label>Invite someone<input type="email" required placeholder="their email" value={email} onChange={e => setEmail(e.target.value)} /></label>
      <button className="btn primary" type="submit">Create invitation link</button>
      {link && <div className="team-invite"><code>{link}</code>
        <button type="button" className="btn" onClick={() => { void navigator.clipboard.writeText(link); setCopied(true) }}>{copied ? 'Copied' : 'Copy'}</button>
        <small>Send it to them. Opening it on the web, or pasting it in TerminAI › Sync › I have an invitation, signs them in. No password needed. It works for 48 hours.</small></div>}
    </form>}
  </div>
}

function Adder({ placeholder, onAdd, autoFocus }: { placeholder: string; onAdd: (title: string) => Promise<void>; autoFocus?: boolean }): JSX.Element {
  const [text, setText] = useState('')
  return <form className="team-adder" onSubmit={e => { e.preventDefault(); const t = text.trim(); if (!t) return; setText(''); void onAdd(t) }}>
    <input aria-label={placeholder} placeholder={placeholder} value={text} maxLength={500} autoFocus={autoFocus} onChange={e => setText(e.target.value)} />
  </form>
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

import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { DEFAULT_WORKSPACE_URL } from '../../shared/workspace'
import type { McpSetupResult, WorkspaceState } from '../../shared/workspace'
import { snapshot } from '../snapshots'
import './workspace.css'

type Conversation = { id: string; title: string; visibility: string; ownerId?: string; owner_id?: string }
type Message = { id: string; content: string; kind: string; authorName?: string; author_name?: string }
const items = <T,>(value: any): T[] => Array.isArray(value) ? value : value?.items ?? value?.conversations ?? value?.messages ?? value?.catalog ?? []

export function WorkspaceSheet({ activeTab, onClose }: { activeTab?: { id: string; title: string }; onClose: () => void }): JSX.Element {
  const [state, setState] = useState<WorkspaceState>({ url: '', signedIn: false })
  const [url, setUrl] = useState(DEFAULT_WORKSPACE_URL)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [invite, setInvite] = useState('')
  const [joining, setJoining] = useState(false)
  const [company, setCompany] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selected, setSelected] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [title, setTitle] = useState('')
  const [visibility, setVisibility] = useState('owner')
  const [sharing, setSharing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tools, setTools] = useState<McpSetupResult[]>([])
  const lastSnapshot = useRef('')
  const base = `/api/companies/${company}`
  const membership = state.identity?.companies.find(row => row.id === company)
  const activeConversation = conversations.find(row => row.id === selected)
  const ownConversation = (activeConversation?.ownerId ?? activeConversation?.owner_id) === state.identity?.user.id
  const context = useRef({ company, selected })
  context.current = { company, selected }
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : 'The workspace could not be reached.')

  useEffect(() => {
    let stopped = false
    window.term.workspace.state().then(value => {
      if (stopped) return
      setState(value); setUrl(value.url || DEFAULT_WORKSPACE_URL); setCompany(value.identity?.companies[0]?.id ?? '')
    }).catch(fail)
    return () => { stopped = true }
  }, [])
  useEffect(() => {
    setSelected(''); setMessages([]); setConversations([]); setSharing(false); setTools([]); setDraft(''); setVisibility('owner')
    if (!company || !state.signedIn) return
    let stopped = false
    const refresh = async () => {
      try { const result = await window.term.workspace.request(`${base}/conversations`); if (!stopped) { const rows = items<Conversation>(result); setConversations(rows); if (context.current.selected && !rows.some(row => row.id === context.current.selected)) { setSelected(''); setMessages([]); setSharing(false) } } }
      catch (err) { if (!stopped) { setConversations([]); setSelected(''); setMessages([]); setSharing(false); fail(err) } }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 8000)
    // New members receive the catalog assigned to their role during onboarding.
    void window.term.workspace.setupTools(company).then(value => { if (!stopped) setTools(value) }).catch(fail)
    return () => { stopped = true; clearInterval(timer) }
  }, [company, state.signedIn])
  useEffect(() => {
    setMessages([]); setSharing(false); lastSnapshot.current = ''
    if (!selected || !company) return
    let stopped = false
    const refresh = async () => {
      try { const result = await window.term.workspace.request(`${base}/conversations/${selected}/messages`); if (!stopped) setMessages(items(result)) }
      catch (err) { if (!stopped) { setMessages([]); setSharing(false); fail(err) } }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 4000)
    return () => { stopped = true; clearInterval(timer) }
  }, [company, selected])
  useEffect(() => {
    if (!sharing || !activeTab || !selected || !ownConversation) return
    let inFlight = false
    const share = async () => {
      const text = snapshot(activeTab.id, 30).join('\n').slice(-12000)
      if (!text.trim() || text === lastSnapshot.current || inFlight) return
      inFlight = true
      try {
        await window.term.workspace.request(`${base}/conversations/${selected}/messages`, 'POST', {
          content: `Terminal snapshot — ${activeTab.title}\n\n${text}`, kind: 'note', clientMessageId: crypto.randomUUID(),
        })
        lastSnapshot.current = text
      } catch (err) { fail(err); setSharing(false) }
      finally { inFlight = false }
    }
    void share()
    const timer = setInterval(() => void share(), 8000)
    return () => clearInterval(timer)
  }, [sharing, activeTab?.id, company, selected, ownConversation])

  async function signIn(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const value = await window.term.workspace.login({ url, email, password, ...(joining ? { name, inviteToken: invite } : {}) })
      setState(value); setPassword(''); setInvite(''); setCompany(value.identity?.companies[0]?.id ?? '')
    } catch (err) { fail(err) } finally { setBusy(false) }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const result = await window.term.workspace.request(`${base}/conversations`, 'POST', { title: title || activeTab?.title || 'New conversation', visibility })
      const row: Conversation = result.conversation ?? result
      if (context.current.company !== company) return
      setConversations(value => [row, ...value]); setSelected(row.id); setTitle('')
    } catch (err) { fail(err) } finally { setBusy(false) }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault(); if (!draft.trim()) return
    setBusy(true); setError('')
    try {
      await window.term.workspace.request(`${base}/conversations/${selected}/messages`, 'POST', { content: draft, kind: 'user', clientMessageId: crypto.randomUUID() })
      const result = await window.term.workspace.request(`${base}/conversations/${selected}/messages`)
      if (context.current.company === company && context.current.selected === selected) { setDraft(''); setMessages(items(result)) }
    } catch (err) { fail(err) } finally { setBusy(false) }
  }
  return <div className="workspace-overlay" role="presentation"><section className="team-sheet" role="dialog" aria-modal="true" aria-labelledby="team-title">
    <header><div><h2 id="team-title">Your team workspace</h2><p>Conversations, shared work, and tools for your role. Drag the bottom-right corner to resize.</p></div><button className="btn" onClick={onClose} aria-label="Close team workspace">Close</button></header>
    {error && <p className="team-error" role="alert">{error}</p>}
    {!state.signedIn ? <form className="team-login" onSubmit={signIn}>
      <label>Workspace address<input required type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://your-manager.up.railway.app" /></label>
      <label>Email<input required type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} /></label>
      {joining && <><label>Your name<input required value={name} onChange={event => setName(event.target.value)} /></label><label>Invitation code<input required value={invite} onChange={event => setInvite(event.target.value)} autoComplete="off" /></label></>}
      <label>Password<input required type="password" minLength={joining ? 12 : 1} autoComplete={joining ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} /></label>
      <p className="team-muted">Use your company invitation to join. Your assigned tools are configured after sign-in. Existing terminal sessions remain local until you choose to share them.</p>
      <button className="btn primary" disabled={busy}>{busy ? 'Connecting…' : joining ? 'Join workspace' : 'Sign in'}</button>
      <button className="btn" type="button" onClick={() => void window.term.workspace.openManager().catch(fail)}>Set up your company / manage workspace</button>
      <button className="btn" type="button" onClick={() => setJoining(!joining)}>{joining ? 'I already have an account' : 'I have an invitation'}</button>
    </form> : <>
      <div className="team-account"><span>{state.identity?.user.name}</span><select aria-label="Company" value={company} onChange={event => setCompany(event.target.value)}>{state.identity?.companies.map(row => <option key={row.id} value={row.id}>{row.name} · {row.classification}</option>)}</select><button className="btn" onClick={() => { setSharing(false); void window.term.workspace.logout().catch(fail).finally(() => { setState({ url, signedIn: false }); setCompany(''); setMessages([]); setConversations([]); setTools([]) }) }}>Sign out</button></div>
      {tools.length > 0 && <details className="team-tools"><summary>Tools for your role</summary>{tools.map(tool => <p key={tool.id}><strong>{tool.id}</strong> · {tool.message}</p>)}</details>}
      <div className="team-columns"><aside>
        <form onSubmit={create}><label>New conversation<input value={title} onChange={event => setTitle(event.target.value)} placeholder={activeTab?.title || 'Conversation title'} maxLength={160} /></label><select aria-label="Conversation visibility" value={visibility} onChange={event => setVisibility(event.target.value)}><option value="owner">Only me</option>{membership?.allowCompanySharing && <option value="company">Company</option>}</select><button className="btn" disabled={busy || !company || membership?.role === 'viewer'}>Create</button></form>
        <nav aria-label="Conversations">{conversations.map(row => <button key={row.id} className={`team-conversation ${selected === row.id ? 'selected' : ''}`} onClick={() => setSelected(row.id)}>{row.title}<small>{row.visibility === 'company' ? 'Shared with company' : 'Private'}</small></button>)}</nav>
      </aside><div className="team-thread">{selected ? <>
        <h3>{activeConversation?.title}</h3>
        {ownConversation && activeTab && <label className="team-share"><input type="checkbox" checked={sharing} onChange={event => setSharing(event.target.checked)} />Share visible output from “{activeTab.title}” while this panel is open. Anyone with access to this conversation can read it.</label>}
        <div className="team-messages" aria-live="polite">{messages.map(message => <article key={message.id}><small>{message.authorName || message.author_name || message.kind}</small><pre>{message.content}</pre></article>)}{!messages.length && <p className="team-muted">Start a conversation or share the visible output of your session.</p>}</div>
        {membership?.role !== 'viewer' && <form className="team-compose" onSubmit={send}><textarea aria-label="Message" value={draft} onChange={event => setDraft(event.target.value)} maxLength={16000} placeholder="Ask a teammate or share an update…" /><button className="btn primary" disabled={busy || !draft.trim()}>Send</button></form>}
        <p className="team-muted">Messages appear here; they are never executed in another person’s terminal.</p>
      </> : <p className="team-muted">Select a conversation to see your team’s work.</p>}</div></div>
    </>}
  </section></div>
}

import { useEffect, useState, type JSX } from 'react'
import type { TabShare } from '../../shared/types'

type Person = { id: string; name: string; email?: string }
type Org = { id: string; name: string; role?: string; people: Person[] }

/**
 * Share with…: one conversation with one person (or a few of the same organisation), without moving the rest of TerminAI
 * to that organisation. The people are grouped by your organisations; "Invite someone new…" makes an invite link to one
 * of them (or a new one). The conversation is then mirrored there readable only by you and them (teambridge.ts).
 */
export function ShareSheet({ name, share, onChange, onClose }: { name: string; share?: TabShare; onChange: (share: TabShare | undefined) => void; onClose: () => void }): JSX.Element {
  const [orgs, setOrgs] = useState<Org[] | null>(null)
  const [error, setError] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteOrg, setInviteOrg] = useState('')
  const [newOrg, setNewOrg] = useState('')
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)
  const fail = (e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
  const load = async (): Promise<void> => {
    setError('')
    try {
      const state = await window.term.workspace.state()
      if (!state.signedIn || !state.identity) { setOrgs([]); setError('Sign in to TerminAI Sync first (the people icon): sharing goes through your organisations.'); return }
      const list = await Promise.all(state.identity.companies.map(async c => {
        const { members } = await window.term.workspace.request(`/api/companies/${c.id}/members`).catch(() => ({ members: [] }))
        return { id: c.id, name: c.name, role: c.role, people: (members as Person[]).filter(m => m.id !== state.identity!.user.id) }
      }))
      setOrgs(list)
      setInviteOrg(v => v || list.find(o => o.role !== 'viewer')?.id || '')
    } catch (e) { fail(e) }
  }
  useEffect(() => { void load() }, [])
  const pick = (org: Org, p: Person): void => {
    // The same organisation: add them (or take them off); another one: the conversation moves its sharing there.
    const same = share?.company === org.id ? share.people : []
    const people = same.some(x => x.id === p.id) ? same.filter(x => x.id !== p.id) : [...same, { id: p.id, name: p.name }]
    onChange(people.length ? { company: org.id, companyName: org.name, people } : undefined)
  }
  const makeLink = async (): Promise<void> => {
    setError('')
    try {
      let company = inviteOrg
      if (company === 'new') {
        if (!newOrg.trim()) return setError('Give the new organisation a name.')
        company = (await window.term.workspace.request('/api/companies', 'POST', { name: newOrg.trim() })).id
        await load(); setInviteOrg(company)
      }
      const v = await window.term.workspace.request(`/api/companies/${company}/invites/link`, 'POST', { role: 'member' })
      setLink(v.inviteUrl); setCopied(false)
    } catch (e) { fail(e) }
  }
  return <div className="sheet-backdrop" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="sheet share-sheet" role="dialog" aria-label="Share with">
      <h2>Share “{name}” with…</h2>
      <p className="hint">Only the people you pick, and their agents, can read this conversation and message it. Nothing else of yours moves: your other conversations, To-do and organisation stay as they are.</p>
      {share?.people.length ? <div className="share-now">
        <span>Shared with <b>{share.people.map(p => p.name).join(', ')}</b>{share.companyName ? <> in {share.companyName}</> : null}</span>
        <button className="btn danger" onClick={() => onChange(undefined)}>Stop sharing</button>
      </div> : null}
      {error && <p className="share-error">{error}</p>}
      {!orgs ? <p className="hint">Loading your organisations…</p> : orgs.map(org => <section key={org.id} className="share-org">
        <h3>{org.name}</h3>
        {org.people.length === 0 ? <p className="hint">Only you so far.</p> : org.people.map(p => {
          const on = share?.company === org.id && share.people.some(x => x.id === p.id)
          return <button key={p.id} className={`share-person${on ? ' on' : ''}`} aria-pressed={on} onClick={() => pick(org, p)}>
            <span className="team-avatar">{p.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()}</span>
            <span className="share-who"><b>{p.name}</b>{p.email && <small>{p.email}</small>}</span>
            <span className="share-state">{on ? 'Shared ✓' : 'Share'}</span>
          </button>
        })}
      </section>)}
      {orgs && <section className="share-org">
        {!inviting ? <button className="share-person invite" onClick={() => setInviting(true)}><span className="team-avatar">+</span><span className="share-who"><b>Invite someone new…</b><small>They join one of your organisations (or a new one) with a link; then pick them above.</small></span></button>
          : <div className="share-invite">
            <h3>Invite someone new</h3>
            <label>Into <select value={inviteOrg} onChange={e => { setInviteOrg(e.target.value); setLink('') }}>
              {orgs.filter(o => o.role !== 'viewer').map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              <option value="new">A new organisation…</option></select></label>
            {inviteOrg === 'new' && <input placeholder="Name of the new organisation" value={newOrg} onChange={e => setNewOrg(e.target.value)} maxLength={200} autoFocus />}
            {!link ? <button className="btn primary" onClick={() => void makeLink()}>Make invite link</button>
              : <div className="share-link"><code>{link}</code><button className="btn" onClick={() => { void navigator.clipboard.writeText(link); setCopied(true) }}>{copied ? 'Copied' : 'Copy'}</button></div>}
            {link && <p className="hint">Send it to them. Once they have joined, <button className="todo-link" onClick={() => void load()}>refresh</button> and pick them above. The link works for 24 hours and makes them a member of that organisation.</p>}
          </div>}
      </section>}
      <div className="recovery-actions"><button className="btn primary" onClick={onClose} autoFocus>Done</button></div>
    </div>
  </div>
}

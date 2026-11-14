import { useEffect, useState, type JSX } from 'react'
import './teamchat.css'

/**
 * Products and permissions, shared by Sync › Members and the team drawer. Products are picked from a list: the
 * products used in the shared To-do, plus any already given to someone or to a file, plus new ones typed in.
 */
export type Member = { id: string; name: string; email: string; role: string; products?: string[] | null; app_version?: string | null; app_seen?: string | null }
/** When someone's TerminAI was last seen, short: now, 5 min ago, 3 h ago, 12 Nov. */
export const seenAgo = (at: string) => { const m = Math.round((Date.now() - new Date(at).getTime()) / 60000); return m < 2 ? 'now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' }) }
export const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'
const HUES = [212, 262, 330, 24, 160, 190, 45, 290]
/** A steady colour per person, so the same face reads the same everywhere. */
export const hueOf = (id: string) => HUES[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % HUES.length]
export function Avatar({ id, name, size = 28, online }: { id: string; name: string; size?: number; online?: boolean }): JSX.Element {
  return <span className="pp-avatar" title={name} style={{ width: size, height: size, fontSize: Math.round(size * 0.38), background: `hsl(${hueOf(id)} 45% 42%)` }}>
    {initials(name)}{online !== undefined && <i className={online ? 'on' : ''} />}</span>
}

let known: Promise<string[]> | null = null
export function useProducts(extra: (string | null | undefined)[] = []): string[] {
  const [list, setList] = useState<string[]>([])
  useEffect(() => {
    known ??= window.term.todos.list().then(v => [...new Set(v.shared.map(t => t.product).filter(Boolean) as string[])]).catch(() => [])
    void known.then(setList)
  }, [])
  return [...new Set([...list, ...extra.filter(Boolean) as string[]])].sort((a, b) => a.localeCompare(b))
}

/** Chips to switch products on and off, and a field to add a new one. */
export function ProductPicker({ value, onChange, options }: { value: string[]; onChange: (v: string[]) => void; options: string[] }): JSX.Element {
  const [adding, setAdding] = useState(false), [name, setName] = useState('')
  const all = [...new Set([...options, ...value])].sort((a, b) => a.localeCompare(b))
  const toggle = (p: string) => onChange(value.includes(p) ? value.filter(x => x !== p) : [...value, p])
  return <div className="pp-chips">
    {all.map(p => <button type="button" key={p} className={`pp-chip${value.includes(p) ? ' on' : ''}`} aria-pressed={value.includes(p)} onClick={() => toggle(p)}>{p}</button>)}
    {adding ? <input className="pp-new" autoFocus placeholder="Product name" value={name} onChange={e => setName(e.target.value)}
        onBlur={() => { setAdding(false); setName('') }}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && name.trim()) { onChange([...new Set([...value, name.trim()])]); setName(''); setAdding(false) } if (e.key === 'Escape') setAdding(false) }} />
      : <button type="button" className="pp-chip add" onClick={() => setAdding(true)}>+ New</button>}
  </div>
}

/** Who can see something: everyone, admins, or the members of some products. */
export type Access = { access: 'all' | 'admins' | 'products'; products: string[] }
export function AccessPicker({ value, onChange, admin, options }: { value: Access; onChange: (v: Access) => void; admin: boolean; options: string[] }): JSX.Element {
  const kinds: [Access['access'], string][] = [['all', 'Everyone'], ...(admin ? [['admins', 'Admins'] as [Access['access'], string]] : []), ['products', 'Products']]
  return <div className="pp-access">
    <span className="pp-seg">{kinds.map(([k, l]) => <button type="button" key={k} className={value.access === k ? 'on' : ''} onClick={() => onChange({ ...value, access: k })}>{l}</button>)}</span>
    {value.access === 'products' && <ProductPicker value={value.products} onChange={products => onChange({ ...value, products })} options={options} />}
  </div>
}

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' }
/**
 * People and permissions (admins): each person's role and the products they see. Owners and admins see every
 * product and every shared session; a member limited to products sees only those tasks, notes and files.
 */
export function Permissions({ base, members, me, owner, onChanged, onError, online, onMessage }: { base: string; members: Member[]; me: string; owner: boolean; sessionVisibility: string; onChanged: () => void; onError: (e: unknown) => void; online?: (id: string) => boolean | undefined; onMessage?: (m: { id: string; name: string }) => void }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const options = useProducts(members.flatMap(m => m.products ?? []))
  const patch = (id: string, body: object) => void window.term.workspace.request(`${base}/members/${id}`, 'PATCH', body).then(onChanged).catch(onError)
  return <section className="pp">
    <div className="pp-head"><h3>People and permissions</h3></div>
    <ul className="pp-list">{members.map(m => {
      const self = m.id === me, fixed = self || m.role === 'owner' || (m.role === 'admin' && !owner), full = m.role === 'owner' || m.role === 'admin'
      const limited = Array.isArray(m.products), scope = full || !limited ? 'All products' : m.products!.length ? m.products!.join(', ') : 'No products'
      return <li key={m.id} className={open === m.id ? 'open' : ''}>
        <div className="pp-row">
          <Avatar id={m.id} name={m.name} online={online?.(m.id)} />
          <div className="pp-who" title={m.email}><strong>{m.name}{self && <em> · you</em>}{!self && onMessage && <MessageButton onClick={() => onMessage(m)} />}</strong><small>{m.app_seen ? `Active ${seenAgo(m.app_seen)}` : 'Not signed in to TerminAI yet'}{m.app_version ? ` · ${m.app_version}` : ''}</small><small className="pp-email">{m.email}</small></div>
          {fixed ? <span className="pp-role">{ROLE[m.role]}</span>
            : <select className="pp-select" value={m.role} onChange={e => patch(m.id, { role: e.target.value })}>
              {(owner ? ['admin', 'member', 'viewer'] : ['member', 'viewer']).map(r => <option key={r} value={r}>{ROLE[r]}</option>)}</select>}
          <button className="pp-scope" disabled={full} title={full ? 'Owners and admins see every product' : 'Choose the products this person sees'} onClick={() => setOpen(open === m.id ? null : m.id)}>
            {scope}{!full && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={open === m.id ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg>}</button>
        </div>
        {open === m.id && !full && <div className="pp-edit">
          <span className="pp-seg"><button className={!limited ? 'on' : ''} onClick={() => patch(m.id, { products: null })}>All products</button>
            <button className={limited ? 'on' : ''} onClick={() => patch(m.id, { products: m.products ?? [] })}>Only some</button></span>
          {limited && <ProductPicker value={m.products!} options={options} onChange={products => patch(m.id, { products })} />}
          <small>{limited ? 'Sees only these products’ tasks, notes and files. No shared sessions unless set to Everyone above.' : 'Sees every product.'}</small>
        </div>}
      </li>
    })}</ul>
  </section>
}

/** The People tab of the team drawer: permissions for admins, who is in the team for everyone. */
/** A small "Message" button beside a name: opens a one-to-one chat with that person. */
const MessageButton = ({ onClick }: { onClick: () => void }) => <button className="pp-dm" title="Message privately" aria-label="Message privately" onClick={onClick}>
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4Z" /></svg>Message</button>

export function PeoplePanel({ company, me, onError, online, onMessage }: { company: string; me: string; onError: (e: unknown) => void; online: (id: string) => boolean | undefined; onMessage?: (m: { id: string; name: string }) => void }): JSX.Element {
  const base = `/api/companies/${company}`
  const [members, setMembers] = useState<Member[]>([]), [role, setRole] = useState(''), [vis, setVis] = useState('admins'), [loaded, setLoaded] = useState(false)
  const load = () => void window.term.workspace.request(`${base}/members`).then(v => { setMembers(v.members ?? []); setLoaded(true) }).catch(onError)
  useEffect(() => { load(); void window.term.workspace.state().then(s => { const c = s.identity?.companies.find(x => x.id === company) as { role: string; sessionVisibility?: string } | undefined; setRole(c?.role ?? ''); setVis(c?.sessionVisibility ?? 'admins') }) }, [company]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!loaded) return <p className="tc-empty">Loading…</p>
  if (role === 'owner' || role === 'admin') return <div className="tc-people"><Permissions key={vis} base={base} members={members} me={me} owner={role === 'owner'} sessionVisibility={vis} onChanged={load} onError={onError} online={online} onMessage={onMessage} /></div>
  return <div className="tc-people"><ul className="pp-list">{members.map(m => <li key={m.id}><div className="pp-row"><Avatar id={m.id} name={m.name} online={online(m.id)} />
    <div className="pp-who"><strong>{m.name}{m.id === me && <em> · you</em>}{m.id !== me && onMessage && <MessageButton onClick={() => onMessage(m)} />}</strong><small>{ROLE[m.role]}</small></div></div></li>)}</ul></div>
}

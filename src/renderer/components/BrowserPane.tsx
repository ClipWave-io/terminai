import { useEffect, useRef, useState, type JSX } from 'react'
import type { BrowserState, BrowserTab } from '../../shared/browser'

// Arc-like: a slim sidebar holds the address, the vertical tabs and their groups; the page fills the rest.
const host = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } }
const I = {
  back: 'M15 18l-6-6 6-6', forward: 'M9 18l6-6-6-6', reload: 'M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5',
  plus: 'M12 5v14M5 12h14', close: 'M6 6l12 12M18 6L6 18', external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', hide: 'M15 18l-6-6 6-6M20 4v16', side: 'M4 5h16v14H4zM9 5v14',
  group: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', chevron: 'M9 6l6 6-6 6',
  incognito: 'M3 10h18M7 10l2-6h6l2 6M9 17h6', person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
}
const Icon = ({ d, size = 15 }: { d: string; size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>

export function BrowserPane({ visible, layoutKey, onClose, browserOnly, onToggleOnly }: { visible: boolean; layoutKey: string; onClose: () => void; browserOnly: boolean; onToggleOnly: () => void }): JSX.Element {
  const view = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [state, setState] = useState<BrowserState>({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: '' })
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [sidebar, setSidebar] = useState(true)
  const [error, setError] = useState('')
  const [edit, setEdit] = useState<{ type: 'profile' | 'group'; id?: string; value: string } | null>(null)
  const run = (p: Promise<unknown>) => { setError(''); void p.catch(e => setError(String(e?.message ?? e))) }
  useEffect(() => {
    const update = (next: BrowserState) => { setState(next); if (!editing) setAddress(next.url || '') }
    void window.term.browser.state().then(update)
    return window.term.browser.onState(update)
  }, [editing])
  useEffect(() => {
    const element = view.current
    if (!element) return
    const layout = () => {
      const { x, y, width, height } = element.getBoundingClientRect()
      void window.term.browser.layout({ x, y, width, height, visible: visible && Boolean(state.url) })
    }
    const observer = new ResizeObserver(layout)
    observer.observe(element)
    window.addEventListener('resize', layout)
    layout()
    return () => { observer.disconnect(); window.removeEventListener('resize', layout); void window.term.browser.layout({ x: 0, y: 0, width: 0, height: 0, visible: false }) }
  }, [visible, layoutKey, sidebar, Boolean(state.url), Boolean(error || state.error)])

  const tabs = state.tabs || [], groups = [...new Set(tabs.map(t => t.group || ''))].sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1))
  const action = (type: string, input: Record<string, unknown> = {}) => run(window.term.browser.action(type, input))
  const profile = state.profiles?.find(p => p.id === state.profileId)
  const tabRow = (tab: BrowserTab) => {
    const site = host(tab.url)
    return <div key={tab.id} className={`arc-tab ${state.activeId === tab.id ? 'active' : ''}`} role="tab" aria-selected={state.activeId === tab.id} title={`${tab.title}\n${tab.url}`} onClick={() => action('select', { id: tab.id })}>
      <span className="arc-fav">{(site || tab.title || '·')[0].toUpperCase()}</span>
      <span className="arc-title">{tab.title || site || 'New tab'}</span>
      <button title="Move to a group" aria-label={`Group ${tab.title}`} onClick={e => { e.stopPropagation(); setEdit({ type: 'group', id: tab.id, value: tab.group }) }}><Icon d={I.group} size={13} /></button>
      <button title="Close tab" aria-label={`Close ${tab.title}`} onClick={e => { e.stopPropagation(); action('close', { id: tab.id }) }}><Icon d={I.close} size={13} /></button>
    </div>
  }
  const message = error || state.error
  return <aside className={`browser-pane arc ${sidebar ? '' : 'arc-collapsed'}`} aria-label="Browser">
    {sidebar && <nav className="arc-side" aria-label="Browser tabs">
      <div className="arc-nav">
        <button className="arc-icon" aria-label="Back" title="Back" disabled={!state.canGoBack} onClick={() => run(window.term.browser.command('back'))}><Icon d={I.back} /></button>
        <button className="arc-icon" aria-label="Forward" title="Forward" disabled={!state.canGoForward} onClick={() => run(window.term.browser.command('forward'))}><Icon d={I.forward} /></button>
        <button className={`arc-icon ${state.loading ? 'spin' : ''}`} aria-label="Reload" title="Reload" disabled={!state.url} onClick={() => run(window.term.browser.command('reload'))}><Icon d={I.reload} /></button>
        <span className="arc-grow" />
        <button className="arc-icon" aria-label="Hide sidebar" title="Hide sidebar" onClick={() => setSidebar(false)}><Icon d={I.side} /></button>
      </div>
      <form className="arc-address" onSubmit={e => { e.preventDefault(); setEditing(false); (document.activeElement as HTMLElement)?.blur(); run(window.term.browser.navigate(address)) }}>
        <input aria-label="Web address" placeholder="Search or enter address" value={editing ? address : (host(state.url) || address)} onFocus={e => { setEditing(true); setAddress(state.url); requestAnimationFrame(() => e.target.select()) }} onBlur={() => setEditing(false)} onChange={e => setAddress(e.target.value)} spellCheck={false} autoCapitalize="off" />
      </form>
      <div className="arc-tabs" role="tablist">
        <button className="arc-new" onClick={() => action('new')}><Icon d={I.plus} size={14} />New tab</button>
        {groups.map(group => <div className="arc-group" key={group || '_'}>
          {group && <button className="arc-group-label" aria-expanded={!collapsed.includes(group)} onClick={() => setCollapsed(p => p.includes(group) ? p.filter(g => g !== group) : [...p, group])}><span className="arc-chev"><Icon d={I.chevron} size={11} /></span>{group}<small>{tabs.filter(t => (t.group || '') === group).length}</small></button>}
          {!collapsed.includes(group) && tabs.filter(t => (t.group || '') === group).map(tabRow)}
        </div>)}
      </div>
      {edit && <form className="arc-edit" onSubmit={e => { e.preventDefault(); action(edit.type, { id: edit.id, name: edit.value }); setEdit(null) }}>
        <input autoFocus aria-label={edit.type === 'profile' ? 'Profile name' : 'Group name'} placeholder={edit.type === 'profile' ? 'New profile name' : 'Group name (empty to ungroup)'} maxLength={60} value={edit.value} onChange={e => setEdit({ ...edit, value: e.target.value })} onKeyDown={e => { if (e.key === 'Escape') setEdit(null) }} />
      </form>}
      <div className="arc-foot">
        <label className="arc-profile" title="Browser profile"><Icon d={profile?.private ? I.incognito : I.person} size={14} />
          <select aria-label="Browser profile" value={state.profileId || 'default'} onChange={e => e.target.value === '__new' ? setEdit({ type: 'profile', value: '' }) : action('use-profile', { id: e.target.value })}>
            {(state.profiles || [{ id: 'default', name: 'Personal' }]).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="__new">New profile…</option>
          </select></label>
        <button className="arc-icon" title="New private tab" aria-label="New private tab" onClick={() => action('private')}><Icon d={I.incognito} /></button>
        <button className="arc-icon" title="Open in Chrome" aria-label="Open in Chrome" disabled={!state.url} onClick={() => run(window.term.browser.command('external'))}><Icon d={I.external} /></button>
        <button className="arc-icon" title={browserOnly ? 'Restore other panes' : 'Browser only'} aria-label="Toggle browser only" aria-pressed={browserOnly} onClick={onToggleOnly}><Icon d={I.expand} /></button>
        <button className="arc-icon" title="Hide browser" aria-label="Close browser" onClick={onClose}><Icon d={I.close} /></button>
      </div>
    </nav>}
    {!sidebar && <div className="arc-mini"><button className="arc-icon" aria-label="Show sidebar" title="Show sidebar" onClick={() => setSidebar(true)}><Icon d={I.side} /></button>
      <button className="arc-icon" aria-label="Back" title="Back" disabled={!state.canGoBack} onClick={() => run(window.term.browser.command('back'))}><Icon d={I.back} /></button>
      <button className="arc-icon" aria-label="Reload" title="Reload" disabled={!state.url} onClick={() => run(window.term.browser.command('reload'))}><Icon d={I.reload} /></button></div>}
    <div className="arc-page">
      {(message || profile?.private) && <div className="browser-status" role="status">{message || 'Private browsing · nothing is saved after this session closes.'}</div>}
      {!state.url && <div className="browser-start"><span className="arc-start-mark"><Icon d={I.plus} size={22} /></span>{profile?.private ? 'Private tab' : 'New tab'}<span>Type an address in the sidebar to start browsing.</span></div>}
      <div className="browser-viewport" ref={view} />
    </div>
  </aside>
}

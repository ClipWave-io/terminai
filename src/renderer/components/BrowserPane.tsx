import { useEffect, useRef, useState, type JSX } from 'react'
import type { BrowserState } from '../../shared/browser'

export function BrowserPane({ visible, layoutKey, onClose, browserOnly, onToggleOnly }: { visible: boolean; layoutKey: string; onClose: () => void; browserOnly: boolean; onToggleOnly: () => void }): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState('https://www.google.com')
  const [state, setState] = useState<BrowserState>({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: '' })
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [error, setError] = useState('')
  const [edit, setEdit] = useState<{type:'profile'|'group';id?:string;value:string}|null>(null)
  const run = (action: Promise<unknown>) => { setError(''); void action.catch(e => setError(String(e))) }
  useEffect(() => {
    const update = (next: BrowserState) => { setState(next); if (next.url) setAddress(next.url) }
    void window.term.browser.state().then(update)
    return window.term.browser.onState(update)
  }, [])
  useEffect(() => {
    const element = host.current
    if (!element) return
    const layout = () => {
      const { x, y, width, height } = element.getBoundingClientRect()
      void window.term.browser.layout({ x, y, width, height, visible })
    }
    const observer = new ResizeObserver(layout)
    observer.observe(element)
    window.addEventListener('resize', layout)
    layout()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', layout)
      void window.term.browser.layout({ x: 0, y: 0, width: 0, height: 0, visible: false })
    }
  }, [visible, layoutKey, state.tabs?.length, collapsed.join('|'), Boolean(edit)])
  const tabs=state.tabs||[], groups=[...new Set(tabs.map(t=>t.group||''))]
  const action=(type:string,input:Record<string,unknown>={})=>run(window.term.browser.action(type,input))
  return <aside className="browser-pane" aria-label="Browser">
    <div className="browser-heading"><strong>Browser</strong>
      <select aria-label="Browser profile" value={state.profileId||'default'} onChange={e=>action('use-profile',{id:e.target.value})}>{(state.profiles||[{id:'default',name:'Personal'}]).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <button className="btn" title="Create browser profile" aria-label="Create browser profile" onClick={()=>setEdit({type:'profile',value:''})}>⊕</button>
      <button className="btn" title={browserOnly?'Show terminal alongside browser':'Browser only — hide terminal'} aria-label="Toggle browser only" aria-pressed={browserOnly} onClick={onToggleOnly}>⛶</button>
      <button className="btn" title="Hide browser" onClick={onClose} aria-label="Close browser">×</button>
    </div>
    {edit&&<form className="browser-toolbar" onSubmit={event=>{event.preventDefault();action(edit.type,{id:edit.id,name:edit.value});setEdit(null)}}><label>{edit.type==='profile'?'New profile':'Tab group'}<input autoFocus aria-label={edit.type==='profile'?'Profile name':'Group name'} maxLength={60} value={edit.value} onChange={event=>setEdit({...edit,value:event.target.value})}/></label><button className="btn" disabled={edit.type==='profile'&&!edit.value.trim()} type="submit">Save</button><button className="btn" type="button" onClick={()=>setEdit(null)}>Cancel</button></form>}
    <div className="browser-tabs" role="tablist" aria-label="Browser tabs">{groups.map(group=><div className="browser-tab-group" key={group}>
      {group&&<button className="browser-group-label" title="Collapse or expand group" onClick={()=>setCollapsed(prev=>prev.includes(group)?prev.filter(g=>g!==group):[...prev,group])}>{group}</button>}
      {!collapsed.includes(group)&&tabs.filter(t=>(t.group||'')===group).map(tab=><div className="browser-tab" key={tab.id}>
        <button role="tab" aria-selected={state.activeId===tab.id} title={`${tab.title}
${tab.url}`} onClick={()=>action('select',{id:tab.id})}>{tab.title||'New tab'}</button>
        <button title="Move to group" aria-label={`Group ${tab.title}`} onClick={()=>setEdit({type:'group',id:tab.id,value:tab.group})}>⋯</button>
        <button title="Close tab" aria-label={`Close ${tab.title}`} onClick={()=>action('close',{id:tab.id})}>×</button>
      </div>)}
    </div>)}<button className="btn" aria-label="New browser tab" title="New browser tab" onClick={()=>action('new')}>+</button></div>
    <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); run(window.term.browser.navigate(address)) }}>
      <button className="btn" type="button" aria-label="Back" disabled={!state.canGoBack} onClick={() => run(window.term.browser.command('back'))}>←</button>
      <button className="btn" type="button" aria-label="Forward" disabled={!state.canGoForward} onClick={() => run(window.term.browser.command('forward'))}>→</button>
      <button className="btn" type="button" aria-label="Reload" disabled={!state.url} onClick={() => run(window.term.browser.command('reload'))}>↻</button>
      <input aria-label="Web address" value={address} onChange={event => setAddress(event.target.value)} spellCheck={false} autoCapitalize="off" />
      <button className="btn" type="submit">Go</button>
    </form>
    <div className="browser-status"><span role="status">{error || state.error || (state.loading ? 'Loading…' : state.title || 'Enter a web address to begin')}</span><button className="btn" disabled={!state.url} onClick={() => run(window.term.browser.command('external'))}>Open in Chrome</button></div>
    <div className="browser-viewport" ref={host} />
  </aside>
}

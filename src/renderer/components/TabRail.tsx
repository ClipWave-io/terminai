import { useRef, useState } from 'react'
import { groupOf, tabLabel, type TabInfo, type TabStatus } from '../../shared/types'
import type { JSX } from 'react'

interface Props {
  filter: string
  filterOpen: boolean
  onFilter: (value: string) => void
  /** Escape in the filter, or Enter once it has picked a session */
  onFilterClose: () => void
  /** an empty name hands the row back to the terminal's own title */
  onRename: (id: string, name: string) => void
  /** tuck a session out of its folder in the rail, or bring it back */
  onHide: (id: string, hidden: boolean) => void
  onReorderGroups: (from: string, to: string) => void
  tabs: TabInfo[]
  activeId: string | null
  speakingId: string | null
  width: number
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onNewIn: () => void
  onSettings: () => void
  onReorder: (from: number, to: number) => void
  /** bucket the rows under a heading per group, or per folder for tabs without one */
  grouped: boolean
}

/** Trailing path segment, with $HOME collapsed to ~ the way a prompt would. */
function shortCwd(cwd: string): string {
  const home = '/Users/'
  if (!cwd) return ''
  const parts = cwd.split('/').filter(Boolean)
  if (cwd.startsWith(home) && parts.length <= 2) return '~'
  return parts.slice(-2).join('/')
}

/** Green: free to use. Yellow: busy. Blue: it stopped and wants you. Accent
 * with a "?": it stopped on a prompt and needs an answer. */
function dotClass(tab: TabInfo, speaking: boolean): string {
  if (tab.exited) return 'tab-dot exited'
  if (speaking) return 'tab-dot speaking'
  return `tab-dot ${tab.status}`
}

// The flat rail's "show hidden" switch, kept beside the per-folder ones.
const ALL = '\0all'

// Dragged folder headers carry this; rows check for it so the two drags never
// answer each other's drops.
const GROUP_MIME = 'application/terminai-group'

const DOT_TITLE: Record<TabStatus, string> = {
  ready: 'Idle — nothing running',
  working: 'Working…',
  waiting: 'Waiting on you',
  question: 'Waiting for your answer',
  exited: 'Session ended',
}

export function TabRail({
  tabs, filter, filterOpen, onFilter, onFilterClose, onRename, onHide, onReorderGroups,
  activeId,
  speakingId,
  width,
  onSelect,
  onClose,
  onNew,
  onNewIn,
  onSettings,
  onReorder,
  grouped,
}: Props): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  // Escape unmounts the field, and the blur that can follow must not save what Escape dropped.
  const editDone = useRef(false)
  const startEdit = (tab: TabInfo) => { editDone.current = false; setEditingId(tab.id); setDraftTitle(tabLabel(tab)) }
  const endEdit = (id: string, save: boolean) => { if (editDone.current) return; editDone.current = true; if (save) onRename(id, draftTitle.trim()); setEditingId(null) }
  const [dragGroup, setDragGroup] = useState<string | null>(null)
  const [overGroup, setOverGroup] = useState<string | null>(null)
  const matches = (tab: TabInfo) => !filter || `${tabLabel(tab)} ${tab.cwd} ${tab.group ?? ''}`.toLowerCase().includes(filter.toLowerCase())
  // Folders whose hidden sessions are showing for now; not saved, so they tuck away again on relaunch.
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set())
  const toggleRevealed = (key: string) => setRevealed((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })
  // A search finds hidden sessions too, and a hidden session stopped on a question
  // comes back while it waits: hiding it must not hide that it needs an answer.
  const shown = (tab: TabInfo, key: string) => !tab.hidden || tab.status === 'question' || !!filter || revealed.has(key)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  // The dragged row's bucket, read during dragover where state from the same gesture can still be stale.
  const dragKey = useRef<string | null>(null)
  const clearDrag = () => { setDragFrom(null); setDragOver(null); setDragGroup(null); setOverGroup(null); dragKey.current = null }

  // Buckets in first-appearance order, so turning grouping on rearranges as
  // little as possible: the folder you were just in stays near the top.
  const groups: { key: string; name?: string; hidden: number; tabs: { tab: TabInfo; i: number }[] }[] = []
  if (grouped) {
    tabs.forEach((tab, i) => {
      if (!matches(tab)) return
      const key = groupOf(tab)
      let bucket = groups.find((g) => g.key === key)
      if (!bucket) groups.push(bucket = { key, name: tab.group, hidden: 0, tabs: [] })
      if (tab.hidden && tab.status !== 'question') bucket.hidden++
      if (shown(tab, key)) bucket.tabs.push({ tab, i })
    })
  }
  const hiddenCount = tabs.filter((t) => t.hidden && t.status !== 'question' && matches(t)).length
  const hiddenToggle = (key: string, count: number): JSX.Element | null => count && !filter ? (
    <button className="rail-hidden-toggle" draggable={false} onMouseDown={(e) => e.stopPropagation()} onClick={() => toggleRevealed(key)} title={revealed.has(key) ? 'Tuck the hidden sessions away again' : 'Show the hidden sessions'}>
      {revealed.has(key) ? `Hide ${count}` : `${count} hidden`}
    </button>
  ) : null

  const row = (tab: TabInfo, i: number): JSX.Element => (
    <div
      key={tab.id}
      className={[
        'tab',
        tab.id === activeId ? 'active' : '',
        dragOver === i && dragFrom !== null && dragFrom !== i ? 'dropping' : '',
        dragFrom === i ? 'dragging' : '',
        tab.hidden ? 'is-hidden' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      // Grouping *is* the order while it is on: a row dragged across
      // folders would snap straight back when the buckets re-form.
      draggable={editingId !== tab.id}
      onDragStart={(e) => {
        // Chromium refuses to start a drag whose dataTransfer is empty,
        // which is why `draggable` alone did nothing here.
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(i))
        dragKey.current = groupOf(tab)
        setDragFrom(i)
      }}
      onDragOver={(e) => {
        // Only a row of this rail lands here: not a folder header, not a file from Finder.
        if (e.dataTransfer.types.includes(GROUP_MIME) || dragKey.current === null) return
        // Grouped, a session only moves inside its own bucket.
        if (grouped && dragKey.current !== groupOf(tab)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDragOver(i)
      }}
      onDragEnd={clearDrag}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(GROUP_MIME)) return
        e.preventDefault()
        // Prefer the payload over React state: selecting the tab on
        // mousedown re-renders mid-drag and can lose it. An empty payload is
        // not row 0.
        const carried = e.dataTransfer.getData('text/plain')
        const from = /^\d+$/.test(carried) ? Number(carried) : dragFrom
        if (from !== null && from !== i) onReorder(from, i)
        clearDrag()
      }}
      onMouseDown={() => onSelect(tab.id)}
      onDoubleClick={() => startEdit(tab)}
      title={`${tabLabel(tab)}\n${tab.cwd}\nDouble-click to rename`}
    >
      <span
        className={dotClass(tab, tab.id === speakingId)}
        title={tab.id === speakingId ? 'Speaking its summary' : DOT_TITLE[tab.status]}
      >{!tab.exited && tab.id !== speakingId && tab.status === 'question' ? '?' : ''}</span>
      <span className="tab-body">
        {editingId===tab.id ? <input className="tab-title-input" aria-label="Session title" autoFocus spellCheck={false} maxLength={100} placeholder={tab.title || 'session'} value={draftTitle} onChange={e=>setDraftTitle(e.target.value)} onFocus={e=>e.target.select()} onMouseDown={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onBlur={()=>endEdit(tab.id,true)} onKeyDown={e=>{e.stopPropagation();if(e.key==='Enter')endEdit(tab.id,true);if(e.key==='Escape')endEdit(tab.id,false)}}/> : <div className={tab.customTitle ? 'tab-title named' : 'tab-title'}>{tabLabel(tab)}</div>}
        <div className="tab-cwd">{shortCwd(tab.cwd)}</div>
      </span>
      <button
        className="tab-hide"
        aria-label={tab.hidden ? 'Unhide session' : 'Hide session'}
        onMouseDown={(e) => {
          e.stopPropagation()
          onHide(tab.id, !tab.hidden)
        }}
        title={tab.hidden ? 'Unhide: show it in its folder again' : 'Hide from the sidebar (the session keeps running)'}
      >
        {tab.hidden ? (
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z" fill="none" stroke="currentColor" strokeWidth="1.3" /><circle cx="8" cy="8" r="1.9" fill="currentColor" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M2.5 13.5l11-11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
        )}
      </button>
      <button
        className="tab-close"
        onMouseDown={(e) => {
          e.stopPropagation()
          onClose(tab.id)
        }}
        title="Close tab  ⌘W"
      >
        ×
      </button>
    </div>
  )

  return (
    <aside className="rail" style={{ width, flexBasis: width }}>
      {/* leaves room for the traffic lights and drags the window */}
      <div className="rail-top" />

      {/* Keys stay in the field: the window shortcuts must not fire while typing here. */}
      {filterOpen && <input className="rail-filter no-drag" aria-label="Filter sessions" autoFocus value={filter} onChange={e=>onFilter(e.target.value)} onFocus={e=>e.target.select()} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape')onFilterClose();if(e.key==='Enter'){const first=tabs.find(matches);if(first)onSelect(first.id);onFilterClose()}}} placeholder="Find session or folder…"/>}
      <div className="rail-scroll">
        {grouped
          ? groups.map((g) => (
              <div key={g.key} className={['rail-group', dragGroup === g.key ? 'dragging' : '', overGroup === g.key && dragGroup !== null && dragGroup !== g.key ? 'dropping' : ''].filter(Boolean).join(' ')}>
                {/* Only another folder lands on a header, never a single session. */}
                <div className="rail-group-head" title={`${g.key}\nDrag to move this folder`} draggable onDragStart={e=>{e.stopPropagation();e.dataTransfer.effectAllowed='move';e.dataTransfer.setData(GROUP_MIME,g.key);setDragGroup(g.key)}} onDragOver={e=>{if(!e.dataTransfer.types.includes(GROUP_MIME))return;e.preventDefault();e.dataTransfer.dropEffect='move';setOverGroup(g.key)}} onDrop={e=>{if(!e.dataTransfer.types.includes(GROUP_MIME))return;e.preventDefault();e.stopPropagation();const from=e.dataTransfer.getData(GROUP_MIME)||dragGroup;if(from&&from!==g.key)onReorderGroups(from,g.key);clearDrag()}} onDragEnd={clearDrag}>
                  <span className="rail-group-name">{g.name || shortCwd(g.key) || '/'}</span>
                  {hiddenToggle(g.key, g.hidden)}
                </div>
                {g.tabs.map(({ tab, i }) => row(tab, i))}
              </div>
            ))
          : tabs.map((tab, i) => matches(tab) && shown(tab, ALL) ? row(tab, i) : null)}
        {!grouped && hiddenCount > 0 && !filter && <div className="rail-hidden-footer">{hiddenToggle(ALL, hiddenCount)}</div>}
      </div>

      <div className="rail-actions">
        <button className="btn primary" onClick={onNew} title="New tab  ⌘T">
          + New tab
        </button>
        {/* Drawn rather than set as a glyph: the folder codepoints render as
            tofu in the UI font, which is how this button ended up as ⌁. */}
        <button className="btn icon" onClick={onNewIn} title="New tab in folder…  ⇧⌘O">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M1.5 12.5v-9a1 1 0 0 1 1-1h3.2a1 1 0 0 1 .7.3l1 1a1 1 0 0 0 .7.3h5.4a1 1 0 0 1 1 1v7.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button className="btn icon" onClick={onSettings} title="Settings  ⌘,">
          ⚙
        </button>
      </div>
    </aside>
  )
}

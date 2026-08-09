import { useState } from 'react'
import type { TabInfo, TabStatus } from '../../shared/types'
import type { JSX } from 'react'

interface Props {
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
  /** bucket the rows under a heading per folder */
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

/** Green: free to use. Yellow: busy. Blue: it stopped and wants you. */
function dotClass(tab: TabInfo, speaking: boolean): string {
  if (tab.exited) return 'tab-dot exited'
  if (speaking) return 'tab-dot speaking'
  return `tab-dot ${tab.status}`
}

const DOT_TITLE: Record<TabStatus, string> = {
  ready: 'Idle — nothing running',
  working: 'Working…',
  waiting: 'Waiting on you',
  exited: 'Session ended',
}

export function TabRail({
  tabs,
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
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  // Buckets in first-appearance order, so turning grouping on rearranges as
  // little as possible: the folder you were just in stays near the top.
  const groups: { cwd: string; tabs: { tab: TabInfo; i: number }[] }[] = []
  if (grouped) {
    tabs.forEach((tab, i) => {
      const bucket = groups.find((g) => g.cwd === tab.cwd)
      if (bucket) bucket.tabs.push({ tab, i })
      else groups.push({ cwd: tab.cwd, tabs: [{ tab, i }] })
    })
  }

  const row = (tab: TabInfo, i: number): JSX.Element => (
    <div
      key={tab.id}
      className={[
        'tab',
        tab.id === activeId ? 'active' : '',
        dragOver === i && dragFrom !== null && dragFrom !== i ? 'dropping' : '',
        dragFrom === i ? 'dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      // Grouping *is* the order while it is on: a row dragged across
      // folders would snap straight back when the buckets re-form.
      draggable={!grouped}
      onDragStart={(e) => {
        // Chromium refuses to start a drag whose dataTransfer is empty,
        // which is why `draggable` alone did nothing here.
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(i))
        setDragFrom(i)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDragOver(i)
      }}
      onDragEnd={() => {
        setDragFrom(null)
        setDragOver(null)
      }}
      onDrop={(e) => {
        e.preventDefault()
        // Prefer the payload over React state: selecting the tab on
        // mousedown re-renders mid-drag and can lose it.
        const carried = Number(e.dataTransfer.getData('text/plain'))
        const from = Number.isInteger(carried) ? carried : dragFrom
        if (from !== null && from !== i) onReorder(from, i)
        setDragFrom(null)
        setDragOver(null)
      }}
      onMouseDown={() => onSelect(tab.id)}
      title={`${tab.title}\n${tab.cwd}`}
    >
      <span
        className={dotClass(tab, tab.id === speakingId)}
        title={tab.id === speakingId ? 'Speaking its summary' : DOT_TITLE[tab.status]}
      />
      <span className="tab-body">
        <div className="tab-title">{tab.title}</div>
        <div className="tab-cwd">{shortCwd(tab.cwd)}</div>
      </span>
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

      <div className="rail-scroll">
        {grouped
          ? groups.map((g) => (
              <div key={g.cwd} className="rail-group">
                <div className="rail-group-head" title={g.cwd}>
                  {shortCwd(g.cwd) || '/'}
                </div>
                {g.tabs.map(({ tab, i }) => row(tab, i))}
              </div>
            ))
          : tabs.map((tab, i) => row(tab, i))}
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

import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { TabInfo } from '../../shared/types'
import * as snapshots from '../snapshots'

interface Props {
  tabs: TabInfo[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onReorder: (from: number, to: number) => void
  onNotes: (id: string, notes: string) => void
  onNew: () => void
  onClose_: () => void
}

/** "2h 14m", "6m", "just now" — compact enough for a card header. */
function duration(ms: number): string {
  if (ms < 60_000) return 'just now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  if (hrs < 24) return rem ? `${hrs}h ${rem}m` : `${hrs}h`
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`
}

function state(tab: TabInfo): { label: string; cls: string } {
  if (tab.exited) return { label: 'exited', cls: 'exited' }
  if (tab.process === 'claude') return { label: 'claude', cls: 'claude' }
  if (tab.process === '' || /^-?(zsh|bash|sh|fish)$/.test(tab.process)) {
    return { label: 'idle', cls: '' }
  }
  return { label: tab.process, cls: 'busy' }
}

export function TabGrid({
  tabs,
  activeId,
  onSelect,
  onClose,
  onReorder,
  onNotes,
  onNew,
  onClose_,
}: Props): JSX.Element {
  // Re-render on a timer so the ages tick up while the grid is open.
  const [, tick] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(iv)
  }, [])

  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) noteRef.current?.focus()
  }, [editing])

  const now = Date.now()

  return (
    <div className="grid-backdrop" onMouseDown={onClose_}>
      <div className="grid-shell" onMouseDown={(e) => e.stopPropagation()}>
        <header className="grid-head">
          <h2>All sessions</h2>
          <span className="hint">
            Drag a card to set your priority order · click to jump ·{' '}
            <span className="kbd">⌘G</span> to close
          </span>
          <button className="chip" onClick={onNew}>
            + New tab
          </button>
        </header>

        <div className="grid">
          {tabs.map((tab, i) => {
            const s = state(tab)
            const lines = snapshots.snapshot(tab.id, 7).filter((l) => l.length)
            return (
              <article
                key={tab.id}
                className={[
                  'card',
                  tab.id === activeId ? 'active' : '',
                  dragOver === i && dragFrom !== null && dragFrom !== i ? 'dropping' : '',
                  dragFrom === i ? 'dragging' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                draggable
                onDragStart={() => setDragFrom(i)}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(i)
                }}
                onDragEnd={() => {
                  setDragFrom(null)
                  setDragOver(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragFrom !== null && dragFrom !== i) onReorder(dragFrom, i)
                  setDragFrom(null)
                  setDragOver(null)
                }}
                onClick={() => onSelect(tab.id)}
              >
                <div className="card-head">
                  <span className="rank">{i + 1}</span>
                  <span className={`tab-dot ${s.cls}`} />
                  <span className="card-title">{tab.title}</span>
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose(tab.id)
                    }}
                    title="Close session"
                  >
                    ×
                  </button>
                </div>

                <div className="card-cwd">{tab.cwd.replace(/^\/Users\/[^/]+/, '~')}</div>

                <div className="card-stats">
                  <span title="How long this session has been open">
                    open <b>{duration(now - tab.createdAt)}</b>
                  </span>
                  <span title="Total time this tab has been the focused one">
                    focused{' '}
                    <b>
                      {duration(
                        tab.focusedMs + (tab.id === activeId ? now - tab.lastActiveAt : 0),
                      )}
                    </b>
                  </span>
                  <span title="Foreground process">{s.label}</span>
                </div>

                <pre className="card-preview">
                  {lines.length ? lines.join('\n') : '(nothing on screen yet)'}
                </pre>

                {editing === tab.id ? (
                  <textarea
                    ref={noteRef}
                    className="card-notes editing"
                    value={tab.notes}
                    placeholder="What is this session for?"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onNotes(tab.id, e.target.value)}
                    onBlur={() => setEditing(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setEditing(null)
                      e.stopPropagation()
                    }}
                  />
                ) : (
                  <div
                    className={`card-notes${tab.notes ? '' : ' empty'}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditing(tab.id)
                    }}
                    title="Click to edit this session's note"
                  >
                    {tab.notes || '+ add a note'}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      </div>
    </div>
  )
}

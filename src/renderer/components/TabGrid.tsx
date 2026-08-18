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

/** The foreground-process name shown in the card stats. The dot colour comes
    from tab.status now, so this only needs the label. */
function processLabel(tab: TabInfo): string {
  if (tab.exited) return 'exited'
  if (tab.process === 'claude') return 'claude'
  if (tab.process === '' || /^-?(zsh|bash|sh|fish)$/.test(tab.process)) return 'idle'
  return tab.process
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
  const gridRef = useRef<HTMLDivElement>(null)

  // Arrow-key cursor. Starts on the active session so the first keypress moves
  // from where the user already is.
  const [cursor, setCursor] = useState(() => Math.max(0, tabs.findIndex((t) => t.id === activeId)))

  useEffect(() => {
    if (editing) noteRef.current?.focus()
  }, [editing])

  // Keep the cursor pointing at something real as tabs open and close.
  useEffect(() => {
    setCursor((c) => Math.min(Math.max(c, 0), Math.max(0, tabs.length - 1)))
  }, [tabs.length])

  // Scroll the cursor into view without yanking the page around when it is
  // already visible.
  useEffect(() => {
    gridRef.current?.children[cursor]?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  /** Cards per row, read off the live layout rather than assumed. */
  const columns = (): number => {
    const grid = gridRef.current
    if (!grid) return 1
    const cards = Array.from(grid.children) as HTMLElement[]
    if (!cards.length) return 1
    const top = cards[0]!.offsetTop
    const n = cards.filter((c) => c.offsetTop === top).length
    return Math.max(1, n)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A note being edited owns its own keys, arrows included.
      if (editing) return
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', ' ']
      if (!keys.includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return

      // Capture phase + stopPropagation, because the focused xterm would
      // otherwise forward these straight to the PTY behind the overlay.
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') return onClose_()
      if (e.key === 'Enter' || e.key === ' ') {
        const tab = tabs[cursor]
        if (tab) onSelect(tab.id)
        return
      }
      if (!tabs.length) return

      const cols = columns()
      setCursor((c) => {
        switch (e.key) {
          case 'ArrowLeft':
            return (c - 1 + tabs.length) % tabs.length
          case 'ArrowRight':
            return (c + 1) % tabs.length
          case 'ArrowUp':
            return c - cols >= 0 ? c - cols : c
          case 'ArrowDown':
            return c + cols < tabs.length ? c + cols : c
          default:
            return c
        }
      })
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [tabs, cursor, editing, onSelect, onClose_])

  const now = Date.now()

  return (
    <div className="grid-backdrop" onMouseDown={onClose_}>
      <div className="grid-shell" onMouseDown={(e) => e.stopPropagation()}>
        <header className="grid-head">
          <h2>All sessions</h2>
          <span className="hint">
            <span className="kbd">↑↓←→</span> move · <span className="kbd">↵</span> jump · drag to
            reorder · <span className="kbd">⌘G</span> to close
          </span>
          <button className="chip" onClick={onNew}>
            + New tab
          </button>
        </header>

        <div className="grid" ref={gridRef}>
          {tabs.map((tab, i) => {
            const label = processLabel(tab)
            const lines = snapshots.snapshot(tab.id, 7).filter((l) => l.length)
            return (
              <article
                key={tab.id}
                className={[
                  'card',
                  tab.id === activeId ? 'active' : '',
                  i === cursor ? 'cursor' : '',
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
                onMouseEnter={() => setCursor(i)}
                onClick={() => onSelect(tab.id)}
              >
                <div className="card-head">
                  <span className="rank">{i + 1}</span>
                  {/* Same live status dot as the sidebar — green/yellow/blue —
                      not the process-name colour, which never had CSS here. */}
                  <span className={`tab-dot ${tab.exited ? 'exited' : tab.status}`} />
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
                  <span title="Foreground process">{label}</span>
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

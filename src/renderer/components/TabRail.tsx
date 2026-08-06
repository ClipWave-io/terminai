import type { TabInfo } from '../../shared/types'
import type { JSX } from 'react'

interface Props {
  tabs: TabInfo[]
  activeId: string | null
  speakingId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onNewIn: () => void
  onSettings: () => void
}

/** Trailing path segment, with $HOME collapsed to ~ the way a prompt would. */
function shortCwd(cwd: string): string {
  const home = '/Users/'
  if (!cwd) return ''
  const parts = cwd.split('/').filter(Boolean)
  if (cwd.startsWith(home) && parts.length <= 2) return '~'
  return parts.slice(-2).join('/')
}

function dotClass(tab: TabInfo, speaking: boolean): string {
  if (tab.exited) return 'tab-dot exited'
  if (speaking) return 'tab-dot speaking'
  if (tab.process === 'claude') return 'tab-dot claude'
  // A plain login shell sitting at the prompt reports as the shell itself.
  const idle = tab.process === '' || /^-?(zsh|bash|sh|fish)$/.test(tab.process)
  return idle ? 'tab-dot' : 'tab-dot busy'
}

export function TabRail({
  tabs,
  activeId,
  speakingId,
  onSelect,
  onClose,
  onNew,
  onNewIn,
  onSettings,
}: Props): JSX.Element {
  return (
    <aside className="rail">
      {/* leaves room for the traffic lights and drags the window */}
      <div className="rail-top" />

      <div className="rail-scroll">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab${tab.id === activeId ? ' active' : ''}`}
            onMouseDown={() => onSelect(tab.id)}
            title={`${tab.title}\n${tab.cwd}`}
          >
            <span className={dotClass(tab, tab.id === speakingId)} />
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
        ))}
      </div>

      <div className="rail-actions">
        <button className="btn primary" onClick={onNew} title="New tab  ⌘T">
          + New tab
        </button>
        <button className="btn icon" onClick={onNewIn} title="New tab in folder…  ⇧⌘O">
          ⌁
        </button>
        <button className="btn icon" onClick={onSettings} title="Settings  ⌘,">
          ⚙
        </button>
      </div>
    </aside>
  )
}

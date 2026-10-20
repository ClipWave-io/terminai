import type { JSX } from 'react'
import type { SavedTab } from '../../shared/types'

interface Props {
  tabs: SavedTab[]
  onResume: () => void
  onDiscard: () => void
}

/** After a run that never quit cleanly: ask before spinning every session back
 *  up. An in-window sheet, not window.confirm, so the app stays scriptable. */
export function RecoverySheet({ tabs, onResume, onDiscard }: Props): JSX.Element {
  return (
    <div className="sheet-backdrop">
      <div className="sheet recovery" role="dialog" aria-label="Resume sessions">
        <h2>Your sessions were interrupted</h2>
        <p className="welcome-lead">
          TerminAI did not shut down cleanly last time — a crash, a forced quit or a restart. Resume
          brings every tab back and picks up each Claude Code and Codex conversation where it left off.
        </p>

        <div className="recovery-list">
          {tabs.map((t, i) => {
            const kind = t.agent || (t.claude ? 'claude' : '')
            return (
              <div key={`${t.ptyId ?? ''}-${i}`} className="recovery-row">
                <div className="recovery-main">
                  <div className="recovery-title">
                    {t.customTitle || t.name || t.title || t.cwd.split('/').filter(Boolean).slice(-1)[0] || 'shell'}
                  </div>
                  <div className="recovery-cwd">{t.cwd}</div>
                </div>
                <span className={`recovery-badge ${kind || 'shell'}`}>
                  {kind === 'codex' ? 'Codex' : kind === 'claude' ? 'Claude Code' : 'shell'}
                </span>
              </div>
            )
          })}
        </div>

        <div className="recovery-actions">
          <button className="btn" onClick={onDiscard}>
            Start fresh
          </button>
          <button className="btn primary" autoFocus onClick={onResume}>
            {tabs.length === 1 ? 'Resume session' : `Resume all ${tabs.length} sessions`}
          </button>
        </div>
      </div>
    </div>
  )
}

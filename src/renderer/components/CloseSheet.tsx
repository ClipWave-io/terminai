import type { JSX } from 'react'

interface Props {
  name: string
  kind: string
  onConfirm: () => void
  onCancel: () => void
}

/** Closing a tab with an agent still running in it. Enter closes, Escape keeps it. */
export function CloseSheet({ name, kind, onConfirm, onCancel }: Props): JSX.Element {
  const who = kind === 'codex' ? 'Codex' : 'Claude Code'
  return (
    <div
      className="sheet-backdrop"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        onCancel()
      }}
    >
      <div className="sheet" role="dialog" aria-label="Close this tab">
        <h2>Close this tab?</h2>
        <p className="welcome-lead">
          {who} is still running in “{name}”. Closing keeps the process alive for a minute, so ⇧⌘T can
          bring it back untouched.
        </p>
        <div className="recovery-actions">
          <button className="btn" onClick={onCancel}>
            Keep it open
          </button>
          <button className="btn primary" autoFocus onClick={onConfirm}>
            Close tab
          </button>
        </div>
      </div>
    </div>
  )
}

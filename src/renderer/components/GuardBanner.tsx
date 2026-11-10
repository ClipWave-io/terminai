import { useState } from 'react'
import type { JSX } from 'react'

type GuardState = Awaited<ReturnType<typeof window.term.macguard.state>>

/**
 * On top of a chat that MacGuard paused: when and why, and Resume right here. The marker goes only when MacGuard's own
 * list drops the tab (it does the resuming), so what shows is always what MacGuard did.
 */
export function GuardBanner({ id, at, others, running, onState }: { id: string; at: string; others: number; running: boolean; onState: (s: GuardState) => void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const resume = (ids: string[]) => {
    setBusy(true); setError('')
    void window.term.macguard.resume(ids).then(onState).catch(e => setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').split('\n')[0])).finally(() => setBusy(false))
  }
  return (
    <div className="guard-banner" role="status">
      <span className="guard-icon" aria-hidden="true" />
      <span className="guard-text"><strong>Paused by MacGuard{at ? ` at ${at.slice(0, 5)}` : ''}</strong> so the Mac would not freeze. Nothing in the chat is lost: a reply in progress picks up when it resumes (after a very long pause it may have to be asked again).
        {!running && ' MacGuard is not running, so it will not resume it by itself.'}{error && <em> Could not resume: {error}</em>}</span>
      <button className="btn primary" disabled={busy} onClick={() => resume([id])}>{busy ? 'Resuming…' : 'Resume'}</button>
      {others > 0 && <button className="btn" disabled={busy} onClick={() => resume([])}>Resume all ({others + 1})</button>}
    </div>
  )
}

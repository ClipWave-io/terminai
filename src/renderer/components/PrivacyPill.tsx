import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import './accounts.css'

type Mode = 'shared' | 'private' | 'off'
const LABEL: Record<Mode, string> = { shared: 'Shared', private: 'Only me', off: 'Off the record' }
const HINT: Record<Mode, string> = {
  shared: 'Your partner and their agents can read this chat and message it.',
  private: 'The chat goes to the TerminAI server, readable by you alone (iPhone and web).',
  off: 'Nothing of this chat leaves this Mac.',
}
const isMode = (m: unknown): m is Mode => m === 'shared' || m === 'private' || m === 'off'

/**
 * Beside the account in the bottom-right corner: what of the active chat leaves this Mac, and a menu to set it for
 * this chat alone (like the account picker). Without a choice the chat follows the folder rules, Off the record by default.
 */
export function PrivacyPill({ tabKey }: { tabKey: string }): JSX.Element | null {
  const [state, setState] = useState<{ mode: Mode; own: boolean; rule: Mode } | null>(null)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const load = () => window.term.team.tabs().then(s => {
    const t = s.tabs.find(x => x.key === tabKey)
    setState(t && isMode(t.mode) ? { mode: t.mode, own: !!t.own, rule: isMode(t.rule) ? t.rule : 'off' } : null)
  }).catch(() => {})
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [tabKey])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [open])
  if (!state) return null
  const pick = (mode: Mode | null) => void window.term.team.tabMode(tabKey, mode).then(load).finally(() => setOpen(false))
  return (
    <div ref={box} className="account-menu privacy-menu" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }}>
      {open && (
        <div className="account-pop" role="menu" aria-label="Privacy of this chat">
          <div className="account-head">Privacy of this chat</div>
          <p className="account-note">{state.own ? 'Set for this chat.' : `From the folder rules: ${LABEL[state.rule]}.`} It only changes what leaves this Mac; the chat works the same.</p>
          {(['off', 'private', 'shared'] as Mode[]).map(m => (
            <div key={m} className={`account-row${m === state.mode ? ' current' : ''}`}>
              <button className="account-pick" role="menuitemradio" aria-checked={m === state.mode} onClick={() => pick(m)}>
                <span className="account-check">{m === state.mode ? '✓' : ''}</span>
                <span className="account-main">
                  <span className="account-line"><span className={`privacy-dot ${m}`} aria-hidden="true" /><span className="account-name">{LABEL[m]}</span></span>
                  <span className="privacy-hint">{HINT[m]}</span>
                </span>
              </button>
            </div>
          ))}
          {state.own && <div className="account-row"><button className="account-pick" role="menuitem" onClick={() => pick(null)}>
            <span className="account-check" /><span className="account-main"><span className="account-name">Follow the folder rules ({LABEL[state.rule]})</span></span></button></div>}
        </div>
      )}
      <button className={`corner-privacy ${state.mode}`} aria-haspopup="menu" aria-expanded={open} title={`Privacy of this chat: ${LABEL[state.mode]}. ${HINT[state.mode]}`}
        onClick={() => setOpen(v => !v)}>
        <span className={`privacy-dot ${state.mode}`} aria-hidden="true" />{LABEL[state.mode]}<span className="privacy-caret" aria-hidden="true">▾</span>
      </button>
    </div>
  )
}

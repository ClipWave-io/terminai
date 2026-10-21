import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { AccountFlow, ChromeProfile, ClaudeAccount, ClaudeAccounts } from '../../shared/types'
import './accounts.css'

/** "15:45", or "Fri 15:45" when the reset is not today. Europe/Rome like the rest of the app. */
function resetTime(at: number): string {
  const zone = { timeZone: 'Europe/Rome' }
  const day = (d: Date) => d.toLocaleDateString('en-GB', zone)
  const time = new Date(at).toLocaleTimeString('en-GB', { ...zone, hour: '2-digit', minute: '2-digit' })
  return day(new Date(at)) === day(new Date()) ? time : `${new Date(at).toLocaleDateString('en-GB', { ...zone, weekday: 'short' })} ${time}`
}

/**
 * The account the active Claude tab runs on, in the bottom-right corner where Claude Code draws its
 * status line. Picking another one moves that tab's next request to it, with nothing restarted;
 * other tabs keep theirs.
 */
export function AccountMenu({ ptyId }: { ptyId: string }): JSX.Element | null {
  const [data, setData] = useState<ClaudeAccounts | null>(null)
  const [current, setCurrent] = useState('')
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<ClaudeAccount | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null)
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    const [list, id] = await Promise.all([window.term.accounts.list(), window.term.accounts.forTab(ptyId)])
    setData(list)
    setCurrent(id)
  }, [ptyId])
  useEffect(() => {
    void refresh()
    return window.term.accounts.onChanged(() => void refresh())
  }, [refresh])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [open])

  // Opening the menu asks for numbers on accounts not seen for a while; they land through onChanged.
  useEffect(() => { if (open) void window.term.accounts.refreshUsage() }, [open])

  if (!data) return null
  const active = data.accounts.find(a => a.id === current) ?? data.accounts[0]
  const pick = async (id: string) => {
    setOpen(false)
    if (id === current) return
    setError('')
    await window.term.accounts.use(ptyId, id).catch((e: Error) => setError(e.message))
  }
  const run = (p: Promise<unknown>) => p.catch((e: Error) => setError(e.message))

  return (
    <div
      ref={box}
      className="account-menu"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        setOpen(false)
        setRenaming(null)
      }}
    >
      {open && (
        <div className="account-pop" role="menu" aria-label="Claude account for this tab">
          <div className="account-head">Claude account for this tab</div>
          {data.accounts.map(a => (
            <div key={a.id} className={`account-row${a.id === active.id ? ' current' : ''}`}>
              {renaming?.id === a.id ? (
                <form className="account-rename" onSubmit={(e) => { e.preventDefault(); void run(window.term.accounts.rename(a.id, renaming.label)); setRenaming(null) }}>
                  <input autoFocus value={renaming.label} maxLength={40} onChange={(e) => setRenaming({ id: a.id, label: e.target.value })} onBlur={() => setRenaming(null)} aria-label="Account name" />
                </form>
              ) : (
                <button className="account-pick" role="menuitemradio" aria-checked={a.id === active.id} onClick={() => void pick(a.id)}>
                  <span className="account-check">{a.id === active.id ? '✓' : ''}</span>
                  <span className="account-main">
                    <span className="account-line">
                      <span className="account-name">{a.label}</span>
                      {a.login && <span className="account-tag">login</span>}
                      {a.exhaustedUntil > 0 && <span className="account-limit">limit until {resetTime(a.exhaustedUntil)}</span>}
                    </span>
                    {a.usage
                      ? <span className="account-bars"><UsageBar label="5h" value={a.usage.fiveHour} reset={a.usage.fiveReset} /><UsageBar label="7d" value={a.usage.week} reset={a.usage.weekReset} /></span>
                      : <span className="account-nousage">Usage not read yet</span>}
                  </span>
                </button>
              )}
              {renaming?.id !== a.id && (
                <span className="account-actions">
                  <button title="Rename" aria-label={`Rename ${a.label}`} onClick={() => setRenaming({ id: a.id, label: a.label })}>✎</button>
                  {!a.login && <button title="Remove" aria-label={`Remove ${a.label}`} onClick={() => { setOpen(false); setRemoving(a) }}>×</button>}
                </span>
              )}
            </div>
          ))}
          <label className="account-auto">
            <input type="checkbox" checked={data.mode === 'auto'} onChange={(e) => void run(window.term.accounts.setMode(e.target.checked ? 'auto' : 'manual'))} />
            <span>Switch automatically when a plan runs out</span>
          </label>
          <label className="account-default">
            <span>New tabs start on</span>
            <select value={data.defaultId} onChange={(e) => void run(window.term.accounts.setDefault(e.target.value))} aria-label="Account new tabs start on">
              {data.accounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </label>
          <button className="account-add" onClick={() => { setOpen(false); setAdding(true) }}>Add account…</button>
        </div>
      )}
      {error && <div className="account-error" onClick={() => setError('')}>{error}</div>}
      <button
        className={`account-pill${active.exhaustedUntil > 0 ? ' limited' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={data.mode === 'auto' ? 'Claude account · switches automatically when a plan runs out' : 'Claude account for this tab'}
        onClick={() => setOpen(v => !v)}
      >
        {active.label}{data.mode === 'auto' ? ' · auto' : ''} ▾
      </button>
      {adding && <AddAccountSheet onClose={() => setAdding(false)} />}
      {removing && (
        <div className="sheet-backdrop" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRemoving(null) } }}>
          <div className="sheet" role="dialog" aria-label="Remove account">
            <h2>Remove {removing.label}?</h2>
            <p className="welcome-lead">Its token is deleted from the keychain. Tabs on it go back to the login account.</p>
            <div className="recovery-actions">
              <button className="btn" autoFocus onClick={() => setRemoving(null)}>Keep it</button>
              <button className="btn primary" onClick={() => { void run(window.term.accounts.remove(removing.id)); setRemoving(null) }}>Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** One window of a plan, as a short bar: 5-hour or weekly share used, with its reset in the tooltip. */
function UsageBar({ label, value, reset }: { label: string; value: number; reset: number }): JSX.Element {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)))
  return (
    <span className="usage-bar" title={reset ? `${label} window resets ${resetTime(reset)}` : undefined}>
      <span className="usage-label">{label}</span>
      <span className="usage-track"><span className={`usage-fill${pct >= 80 ? ' high' : pct >= 50 ? ' mid' : ''}`} style={{ width: `${pct}%` }} /></span>
      <span className="usage-pct">{pct}%</span>
    </span>
  )
}

/** Name the account, pick the Chrome profile signed in to it, approve in Chrome: the token never shows. */
function AddAccountSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const [label, setLabel] = useState('')
  const [profiles, setProfiles] = useState<ChromeProfile[]>([])
  const [profile, setProfile] = useState('')
  const [flow, setFlow] = useState<AccountFlow | null>(null)
  const [error, setError] = useState('')
  const opened = useRef('')
  useEffect(() => { void window.term.accounts.chromeProfiles().then(list => { setProfiles(list); setProfile(p => p || list[0]?.dir || '') }) }, [])
  useEffect(() => window.term.accounts.onFlow(f => setFlow(prev => prev && prev.id === f.id ? f : prev)), [])
  // The link opens by itself, once, in the profile picked before asking for it.
  useEffect(() => {
    if (!flow?.url || opened.current === flow.url || !profile) return
    opened.current = flow.url
    void window.term.accounts.openInChrome(flow.id, profile).catch((e: Error) => setError(e.message))
  }, [flow, profile])
  const close = () => {
    if (flow && flow.stage !== 'saved' && flow.stage !== 'error') void window.term.accounts.cancel(flow.id)
    onClose()
  }
  const start = async () => {
    setError('')
    try { setFlow(await window.term.accounts.add(label)) } catch (e) { setError((e as Error).message) }
  }
  const profileName = profiles.find(p => p.dir === profile)?.name ?? 'Chrome'

  return (
    <div className="sheet-backdrop" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}>
      <div className="sheet account-sheet" role="dialog" aria-label="Add a Claude account">
        <h2>Add a Claude account</h2>
        {!flow && (
          <form onSubmit={(e) => { e.preventDefault(); void start() }}>
            <p className="welcome-lead">TerminAI asks Claude Code for a one-year token for this account and keeps it in the macOS keychain. You approve it in Chrome, in the profile signed in to that account on claude.ai.</p>
            <label className="account-field"><span>Name</span><input autoFocus value={label} maxLength={40} placeholder="Matteo" onChange={(e) => setLabel(e.target.value)} /></label>
            <label className="account-field"><span>Chrome profile</span>
              <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                {profiles.map(p => <option key={p.dir} value={p.dir}>{p.name}</option>)}
              </select>
            </label>
            {error && <p className="account-sheet-error">{error}</p>}
            <div className="recovery-actions">
              <button type="button" className="btn" onClick={close}>Cancel</button>
              <button type="submit" className="btn primary" disabled={!label.trim() || !profile}>Get sign-in link</button>
            </div>
          </form>
        )}
        {flow && flow.stage !== 'saved' && flow.stage !== 'error' && (
          <>
            <p className="welcome-lead">{flow.url
              ? `The sign-in page is open in Chrome (${profileName}). Check that it shows ${flow.label}'s account, then click Authorize. This window moves on by itself once you have.`
              : 'Asking Claude Code for a sign-in link…'}</p>
            {error && <p className="account-sheet-error">{error}</p>}
            <div className="recovery-actions">
              <button className="btn" onClick={close}>Cancel</button>
              {flow.url && <button className="btn" onClick={() => void navigator.clipboard.writeText(flow.url!)}>Copy link</button>}
              {flow.url && <button className="btn" onClick={() => void window.term.accounts.openInChrome(flow.id, profile).catch((e: Error) => setError(e.message))}>Open again</button>}
            </div>
          </>
        )}
        {flow?.stage === 'saved' && (
          <>
            <p className="welcome-lead">{flow.label} is saved. Pick it from the account menu of any Claude tab.</p>
            <div className="recovery-actions"><button className="btn primary" autoFocus onClick={onClose}>Done</button></div>
          </>
        )}
        {flow?.stage === 'error' && (
          <>
            <p className="account-sheet-error">{flow.error}</p>
            <div className="recovery-actions"><button className="btn primary" autoFocus onClick={onClose}>Close</button></div>
          </>
        )}
      </div>
    </div>
  )
}

import { useEffect, useState, type JSX } from 'react'

/** Feedback, at the bottom left of Settings: a button that opens a small panel above it. */
export function FeedbackButton({ nav = false }: { nav?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false), [email, setEmail] = useState(''), [message, setMessage] = useState(''), [state, setState] = useState<'' | 'sending' | 'sent' | 'mail'>('')
  useEffect(() => { if (open && !email) void window.term.workspace.state().then(s => setEmail(s.identity?.user.email ?? '')).catch(() => {}) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const send = async () => {
    if (!message.trim()) return
    setState('sending')
    const r = await window.term.window.feedback(message.trim(), email.trim() || undefined).catch(() => 'mail' as const)
    setState(r); setMessage('')
    setTimeout(() => { setState(''); setOpen(false) }, 2200)
  }
  return <span className={nav ? 'fb-wrap' : 'fb-wrap-rail'}>
    <button className={nav ? 'fb-nav' : 'btn icon fb-button'} title="Send feedback" aria-label="Send feedback" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <svg width={nav ? 16 : 14} height={nav ? 16 : 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>{nav && 'Send feedback'}
    </button>
    {open && <div className="fb-backdrop" onMouseDown={() => setOpen(false)} />}
    {open && <div className={nav ? 'fb-anchor' : 'fb-fixed'}>
      <section className="fb-panel" role="dialog" aria-label="Send feedback" onMouseDown={e => e.stopPropagation()}>
        <header><strong>Send feedback</strong><button className="fb-x" aria-label="Close" onClick={() => setOpen(false)}>×</button></header>
        {state === 'sent' || state === 'mail' ? <div className="fb-done">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 12.75l6 6 9-13.5" /></svg>
          <p>{state === 'sent' ? 'Thanks for your feedback!' : 'It opened in Mail: press Send there.'}</p></div>
          : <>
            <input type="email" placeholder="Email address (for a reply)" value={email} onChange={e => setEmail(e.target.value)} />
            <textarea autoFocus rows={4} placeholder="What can we improve? Report a bug, request a feature…" value={message} onChange={e => setMessage(e.target.value)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send() }} />
            <button className="fb-send" disabled={!message.trim() || state === 'sending'} onClick={() => void send()}>{state === 'sending' ? 'Sending…' : 'Send feedback'}</button>
          </>}
      </section>
    </div>}
  </span>
}

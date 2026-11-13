import { PermissionsSetup } from './PermissionsSetup'
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import './welcome.css'

interface Props {
  onDismiss: () => void
  /** Opens Sync's sign-in (or create account) once the tour closes. */
  onSignIn: () => void
}

/**
 * The first launch: three short animated steps, no settings. The terminal works without an account; signing in is
 * offered for what needs one (to-dos, notes and the agent log on every device and with a team), and LocalFlow for talking.
 */
const LINES = ['claude', '› Fixing the login bug in api/auth.ts…', '✓ Tests pass. Summary read aloud.', 'codex', '› Writing the landing page…']
export function WelcomeSheet({ onDismiss, onSignIn }: Props): JSX.Element {
  const [step, setStep] = useState(0)
  const [typed, setTyped] = useState(0)
  useEffect(() => { if (step !== 0) return; const t = window.setInterval(() => setTyped(n => n >= LINES.length ? n : n + 1), 650); return () => window.clearInterval(t) }, [step])
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); if (e.key === 'Enter' && step < 4 && step !== 2) setStep(s => s + 1) }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [step, onDismiss])
  return <div className="onb" role="dialog" aria-modal="true" aria-label="Welcome to TerminAI">
    <div className="onb-glow" aria-hidden="true" />
    <div className="onb-card" key={step}>
      {step === 0 && <>
        <div className="onb-mark">›_</div>
        <h1>Welcome to TerminAI</h1>
        <p className="onb-lead">A new terminal experience: your Claude Code and Codex sessions side by side, each one coming back as you left it.</p>
        <div className="onb-term" aria-hidden="true">
          <div className="onb-term-bar"><i /><i /><i /></div>
          {LINES.slice(0, typed).map((l, i) => <div key={i} className={`onb-line${l.startsWith('✓') ? ' ok' : l.startsWith('›') ? ' dim' : ''}`}>{!l.startsWith('›') && !l.startsWith('✓') && <b>$ </b>}{l}</div>)}
          <span className="onb-cursor" />
        </div>
        <button className="onb-primary" onClick={() => setStep(1)}>Get started</button>
      </>}
      {step === 1 && <>
        <h1>Two quick permissions</h1>
        <p className="onb-lead">macOS asks for each one once. Both can be changed later in Settings.</p>
        <PermissionsSetup />
        <button className="onb-primary" onClick={() => setStep(2)}>Continue</button>
      </>}
      {step === 2 && <Agents onNext={() => setStep(3)} />}
      {step === 3 && <>
        <div className="onb-icons" aria-hidden="true"><span>✓</span><span>✎</span><span>◷</span></div>
        <h1>Notes, tasks and agent logs</h1>
        <p className="onb-lead">A To-do and notes next to your sessions, and a daily log of what your agents finished. On your Mac they work right away; sign in to have them on your iPhone and the web, and to share them with your team.</p>
        <ul className="onb-points">
          <li><b>To-do and notes</b> on Mac, iPhone and the web</li>
          <li><b>Agent log</b>: hours and finished work, every day</li>
          <li><b>Team</b>: shared tasks, and agents that can ask each other</li>
        </ul>
        <div className="onb-row">
          <button className="onb-primary" onClick={() => { onDismiss(); onSignIn() }}>Set up sync</button>
          <button className="onb-ghost" onClick={() => setStep(4)}>Skip for now</button>
        </div>
        <small className="onb-foot">Free. You can sign in any time from the people icon.</small>
      </>}
      {step === 4 && <>
        <div className="onb-wave" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 90}ms` }} />)}</div>
        <h1>Talk instead of typing</h1>
        <p className="onb-lead">TerminAI reads each finished step aloud. To speak your prompts, add LocalFlow: hold fn, talk, and your words appear in any app. On your Mac, offline and completely free.</p>
        <div className="onb-row">
          <button className="onb-primary" onClick={onDismiss}>Start using TerminAI</button>
          <a className="onb-ghost" href="https://terminai.xyz/localflow" target="_blank" rel="noreferrer">Get LocalFlow</a>
        </div>
      </>}
      <div className="onb-dots" aria-hidden="true">{[0, 1, 2, 3, 4].map(i => <i key={i} className={i === step ? 'on' : ''} onClick={() => setStep(i)} />)}</div>
    </div>
    <button className="onb-skip" onClick={onDismiss}>Skip</button>
  </div>
}

/** Your agents: Claude Code (ticked) and Codex, installed now in a tab you can watch when this Mac does not have them. */
function Agents({ onNext }: { onNext: () => void }): JSX.Element {
  type Kind = 'claude' | 'codex' | 'chrome'
  const [has, setHas] = useState<{ claude: boolean; codex: boolean; chrome: boolean; chromeApp: boolean } | null>(null)
  const [pick, setPick] = useState<Record<Kind, boolean>>({ claude: true, codex: false, chrome: true })
  const [busy, setBusy] = useState(false)
  useEffect(() => { void window.term.agents.status().then(h => { setHas(h); setPick({ claude: !h.claude, codex: false, chrome: !h.chrome && h.chromeApp }) }).catch(() => setHas({ claude: false, codex: false, chrome: false, chromeApp: false })) }, [])
  const missing = (['claude', 'codex', 'chrome'] as const).filter(a => pick[a] && has && !has[a])
  const go = async () => { if (missing.length) { setBusy(true); await window.term.agents.install([...missing]).catch(() => false) } onNext() }
  const row = (a: Kind, name: string, what: string, off = false) => <label className={`onb-agent${has?.[a] ? ' done' : ''}`}>
    <input type="checkbox" checked={!!has?.[a] || pick[a]} disabled={!has || has[a] || off} onChange={e => setPick(p => ({ ...p, [a]: e.target.checked }))} />
    <span><b>{name}</b><small>{has?.[a] ? 'Already on this Mac' : what}</small></span></label>
  const names = { claude: 'Claude Code', codex: 'Codex', chrome: 'the Chrome extension' }
  return <>
    <h1>Your AI agents</h1>
    <p className="onb-lead">TerminAI runs them in its tabs. Tick what to install now: it opens a tab that installs it, then you sign in there with your account.</p>
    <div className="onb-agents">
      {row('claude', 'Claude Code', "Anthropic's agent. Sign in with a Claude Pro or Max plan.")}
      {row('chrome', 'Claude in Chrome', has && !has.chromeApp ? 'Needs Google Chrome on this Mac first.' : 'Lets Claude Code use your Chrome: Chrome opens at the extension, click Add to Chrome.', !!has && !has.chromeApp)}
      {row('codex', 'Codex', "OpenAI's agent. Sign in with ChatGPT.")}
    </div>
    <div className="onb-row">
      <button className="onb-primary" disabled={!has || busy} onClick={() => void go()}>{missing.length ? `Install ${missing.length > 1 ? missing.length === 3 ? 'all three' : `${names[missing[0]]} and ${names[missing[1]]}` : names[missing[0]]}` : 'Continue'}</button>
      {missing.length > 0 && <button className="onb-ghost" onClick={onNext}>Not now</button>}
    </div>
  </>
}

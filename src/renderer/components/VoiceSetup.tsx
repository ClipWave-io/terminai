import { useEffect, useState, type JSX } from 'react'
import type { LocalFlowStatus } from '../../shared/localflow'

/**
 * Voice dictation (LocalFlow: hold fn, talk, the words are typed), in Onboarding and Settings › Voice.
 * "Set up voice dictation" downloads and installs LocalFlow, frees the fn key, starts it and downloads its speech model
 * (src/main/localflow.ts); then each thing it still needs is a card with one plain sentence, and a button that opens
 * the right System Settings page. When everything is there: "Ready: hold fn and talk".
 */
const Check = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5 9.5 17 19 7" /></svg>
const icon = (d: string) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
const MIC = 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3'
const DOWN = 'M12 4v11m0 0-4-4m4 4 4-4M5 19h14'
const WAVE = 'M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2'
const HAND = 'M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V11m0-.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.5a6 6 0 0 1-5-2.7L4 15.5a1.5 1.5 0 0 1 2.5-1.7L8 16'
const KEY = 'M4 7h16v10H4zM8 13h8M7.5 10h.01M11 10h.01M14.5 10h.01'
const pct = (n: number) => `${Math.round(n * 100)}%`

export function VoiceSetup({ compact = false }: { compact?: boolean }): JSX.Element {
  const [st, setSt] = useState<LocalFlowStatus | null>(null)
  const [asked, setAsked] = useState(false)
  useEffect(() => {
    let live = true
    const tick = () => void window.term.localflow.status().then(s => { if (live) setSt(s) }).catch(() => {})
    tick(); const t = window.setInterval(tick, 1000)
    return () => { live = false; window.clearInterval(t) }
  }, [])
  const busy = !!st && (st.phase === 'download' || st.phase === 'install' || st.phase === 'model')
  const start = () => { setAsked(true); void window.term.localflow.setup() }
  if (!st) return <div className={`ps${compact ? ' compact' : ''}`} />

  if (!st.installed && !busy) return <div className={`ps${compact ? ' compact' : ''}`}>
    <div className="ps-card">
      <span className="ps-icon">{icon(WAVE)}</span>
      <div className="ps-text"><strong>Voice dictation</strong>
        <small>{st.error ? `Setup stopped: ${st.error}.` : 'Hold fn, talk, and your words are typed in any app. Installs LocalFlow and its speech model (about 2.7 GB), offline and free.'}</small></div>
      <button className="ps-btn" disabled={asked && !st.error} onClick={start}>{st.error ? 'Try again' : 'Set up voice dictation'}</button>
    </div>
  </div>

  const card = (key: string, ic: string, title: string, text: string, ok: boolean, action?: JSX.Element, progress?: number) =>
    <div key={key} className={`ps-card${ok ? ' ok' : ''}`}>
      <span className="ps-icon">{icon(ic)}</span>
      <div className="ps-text"><strong>{title}</strong><small>{text}</small>
        {progress !== undefined && !ok && <span className="vs-bar" aria-label={`${title}: ${pct(progress)}`}><i style={{ width: pct(progress) }} /></span>}</div>
      {ok ? <span className="ps-done"><Check />{title === 'LocalFlow' ? 'Installed' : title === 'Speech model' ? 'Downloaded' : 'Allowed'}</span> : action}
    </div>
  const settings = (which: 'microphone' | 'accessibility') => <button className="ps-btn" onClick={() => void window.term.localflow.pane(which)}>Open Settings</button>
  const appText = st.phase === 'download' ? `Downloading, ${pct(st.appProgress)}.` : st.phase === 'install' ? 'Checking the signature and installing.' : 'Installed in Applications.'
  const modelText = st.modelReady ? 'On this Mac: dictation works offline.'
    : st.phase === 'model' ? `Downloading in the background, ${pct(st.modelProgress)} of 2.5 GB. You can keep going.` : 'Downloads once LocalFlow is installed.'
  const micKnown = st.microphone !== 'unknown'
  const micText = st.microphone === 'denied' || st.microphone === 'restricted' ? 'Turned off for LocalFlow: open Settings and turn LocalFlow on.'
    : st.microphone === 'authorized' ? 'LocalFlow can hear you while you hold fn.' : 'So LocalFlow can hear you while you hold fn. Click Allow when macOS asks.'
  const axText = st.accessibility ? 'LocalFlow can notice the fn key and type your words where your cursor is.' : 'So LocalFlow can notice the fn key and type your words where your cursor is: turn LocalFlow on.'
  return <div className={`ps${compact ? ' compact' : ''}`}>
    {st.ready && <div className="vs-ready" role="status"><Check />Ready: hold fn and talk.</div>}
    {card('app', DOWN, 'LocalFlow', appText, st.installed && st.phase !== 'download' && st.phase !== 'install', undefined, st.appProgress)}
    {card('model', WAVE, 'Speech model', modelText, st.modelReady, undefined, st.phase === 'model' ? st.modelProgress : undefined)}
    {st.installed && micKnown && card('mic', MIC, 'Microphone', micText, st.microphone === 'authorized', settings('microphone'))}
    {st.installed && card('ax', HAND, 'Accessibility', axText, st.accessibility === true, settings('accessibility'))}
    {st.installed && card('fn', KEY, 'fn key', st.fnKey ? 'Hold fn to talk, release it to type. If fn still opens the emoji picker, log out and back in once.' : 'Set when the setup runs: fn starts dictation instead of the emoji picker.', st.fnKey)}
    {!st.ready && !busy && (!st.running || !st.modelReady || !st.fnKey || !!st.error) && <div className="vs-row">
      {st.error && <small className="vs-err">Setup stopped: {st.error}.</small>}
      <button className="ps-btn" onClick={start}>{st.error ? 'Try again' : st.running ? 'Finish setup' : 'Start LocalFlow'}</button>
    </div>}
  </div>
}

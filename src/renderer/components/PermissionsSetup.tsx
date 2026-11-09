import { useEffect, useState, type JSX } from 'react'

/**
 * The macOS permissions TerminAI needs, as cards with one button each: notifications (finished conversations, chat,
 * requests) and the Downloads, Documents and Desktop folders (the Files pane and the agents in your tabs). Pressing a
 * button makes macOS show its own question; when it was refused earlier, the button opens the right System Settings page.
 */
type State = 'ask' | 'ok' | 'off'
const Check = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5 9.5 17 19 7" /></svg>
const Bell = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15ZM10 20a2 2 0 0 0 4 0" /></svg>
const Folder = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 19V6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" /></svg>
export function PermissionsSetup({ compact = false }: { compact?: boolean }): JSX.Element {
  const [notify, setNotify] = useState<State>('ask'), [folders, setFolders] = useState<State>('ask'), [missing, setMissing] = useState<string[]>([])
  // macOS's own answer: allowed, refused (only System Settings can change it), or not asked yet.
  const fromMac = (p: string): State => p === 'authorized' || p === 'provisional' ? 'ok' : p === 'denied' ? 'off' : 'ask'
  useEffect(() => { void window.term.teamchat.notifyPermission().then(p => setNotify(fromMac(p))) }, [])
  const askNotify = async () => {
    if (notify === 'off') return void window.term.teamchat.notificationSettings()
    const p = await window.term.teamchat.notifyPermission(true)
    setNotify(fromMac(p))
    if (fromMac(p) === 'ok') void window.term.teamchat.notify('TerminAI', 'Notifications are on: you will hear when a conversation finishes.')
  }
  const askFolders = async () => {
    if (folders === 'off') return void window.term.project.privacy()
    const r = await window.term.teamchat.askFolders(), no = Object.keys(r).filter(k => !r[k])
    setMissing(no); setFolders(no.length ? 'off' : 'ok')
  }
  const card = (icon: JSX.Element, title: string, text: string, state: State, ask: () => void, label: string) =>
    <div className={`ps-card ${state}`}>
      <span className="ps-icon">{icon}</span>
      <div className="ps-text"><strong>{title}</strong><small>{text}</small></div>
      {state === 'ok' ? <span className="ps-done"><Check />Allowed</span>
        : <button className="ps-btn" onClick={() => void ask()}>{state === 'off' ? 'Open Settings' : label}</button>}
    </div>
  return <div className={`ps${compact ? ' compact' : ''}`}>
    {card(<Bell />, 'Notifications', notify === 'ok' ? 'On: finished conversations, team messages and requests.' : notify === 'off' ? 'Turned off for TerminAI in macOS: Open Settings and allow it.' : 'Know when a conversation finishes, and get team messages and requests.', notify, askNotify, 'Turn on')}
    {card(<Folder />, 'Your folders', folders === 'off' ? `Not allowed yet: ${missing.join(', ')}. Turn TerminAI on under Files and Folders.` : 'Downloads, Documents and Desktop, for the Files pane and the agents in your tabs.', folders, askFolders, 'Allow')}
  </div>
}

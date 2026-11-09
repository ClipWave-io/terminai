import { useEffect, useState } from 'react'
import type React from 'react'
import {
  DEFAULT_PREFS,
  type Prefs,
  type RailSide,
  type ThemeName,
  type VoiceEngine,
} from '../../shared/types'

/** Mirrors VOICES in src/main/tts/local.ts. */
const LOCAL_VOICES = [
  { id: 'af_heart', label: 'Heart — warm female' },
  { id: 'af_bella', label: 'Bella — bright female' },
  { id: 'af_nicole', label: 'Nicole — soft female' },
  { id: 'af_sarah', label: 'Sarah — neutral female' },
  { id: 'am_adam', label: 'Adam — deep male' },
  { id: 'am_michael', label: 'Michael — neutral male' },
  { id: 'bf_emma', label: 'Emma — British female' },
  { id: 'bm_george', label: 'George — British male' },
]
import { THEMES } from '../../shared/themes'
import { PermissionsSetup } from './PermissionsSetup'
import { GrokConnection } from './GrokConnection'
import { Bots } from './WorkspaceSheet'
import './workspace.css'
import './welcome.css'
import type { JSX } from 'react'

interface Props {
  prefs: Prefs
  onChange: (patch: Partial<Prefs>) => void
  onClose: () => void
  onCustomize: () => void
  tabs: { id: string; label: string }[]
  onCloseTab: (id: string) => void
  onOpenTab: (id: string) => void
}

/** Every binding registered in App.tsx's keydown handler, grouped for reading. */
const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: 'Tabs',
    items: [
      ['⌘T / ⌘N', 'New tab'],
      ['⇧⌘O', 'Open a folder in a new tab'],
      ['⌘W', 'Close tab'],
      ['⇧⌘T', 'Reopen the tab you just closed'],
      ['⌘F', 'Filter sessions'],
      ['⌃⇥ / ⌃⇧⇥', 'Cycle forward / back'],
      ['⌘[ / ⌘]', 'Previous / next tab'],
      ['⌘1–⌘9', 'Jump to tab by position'],
    ],
  },
  {
    group: 'View',
    items: [
      ['⌘G', 'All sessions grid'],
      ['⌘S', 'Show or hide the sidebar'],
      ['⌥⌘S', 'Move the sidebar to the other edge'],
      ['⌘D', 'Show or hide the voice dock'],
      ['⇧⌘L', 'Next theme'],
      ['⌘+ / ⌘−', 'Font size'],
      ['⌘,', 'Settings'],
    ],
  },
  {
    group: 'Voice',
    items: [
      ['⇧⌘S', 'Replay the latest summary'],
      ['⇧⌘M', 'Mute or unmute spoken summaries'],
    ],
  },
]

interface ElevenVoice {
  id: string
  name: string
  category: string
  description: string
}

export function SettingsSheet({ prefs, onChange, onClose, onCustomize, tabs, onCloseTab, onOpenTab }: Props): JSX.Element {
  const [voices, setVoices] = useState<string[]>([])
  const [hasEleven, setHasEleven] = useState(false)
  const [elevenVoices, setElevenVoices] = useState<ElevenVoice[]>([])
  const [elevenError, setElevenError] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [hasLocal, setHasLocal] = useState(false)

  const loadEleven = (): void => {
    void window.term.voice.hasElevenKey().then((has) => {
      setHasEleven(has)
      if (!has) {
        setElevenVoices([])
        return
      }
      void window.term.voice.elevenVoices().then((res) => {
        if (res.ok) {
          setElevenVoices(res.voices)
          setElevenError(null)
        } else {
          setElevenError(res.error)
        }
      })
    })
  }

  useEffect(() => {
    void window.term.voice.voices().then(setVoices)
    void window.term.voice.hasLocal().then(setHasLocal)
    loadEleven()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveKey = async (): Promise<void> => {
    setBusy(true)
    const res = await window.term.voice.setElevenKey(keyDraft)
    setBusy(false)
    if (!res.ok) {
      setElevenError(res.error ?? 'could not save the key')
      return
    }
    setKeyDraft('')
    setElevenError(null)
    loadEleven()
  }

  // Synthesizes and plays through the normal pipeline, so what you hear is
  // exactly what a real summary will sound like.
  const preview = (): void => {
    void window.term.voice
      .speak('This is how your summaries will sound.')
      .then((clip) => void new Audio(clip.url).play())
      .catch(() => setElevenError('preview failed'))
  }

  const [section, setSection] = useState<SettingsSection>('general')
  const [company, setCompany] = useState('')
  useEffect(() => { void window.term.workspace.state().then(v => setCompany(v.identity?.companies[0]?.id ?? '')).catch(() => {}) }, [])
  const patchVoice = (p: Partial<Prefs['voice']>): void =>
    onChange({ voice: { ...prefs.voice, ...p } })

  // One row of a card: what it is on the left, its control on the right.
  const Row = ({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) =>
    <div className="st-row"><div className="st-label"><strong>{label}</strong>{hint && <small>{hint}</small>}</div><div className="st-control">{children}</div></div>
  const Toggle = ({ on, set }: { on: boolean; set: (v: boolean) => void }) =>
    <button type="button" role="switch" aria-checked={on} className={`st-switch${on ? ' on' : ''}`} onClick={() => set(!on)}><i /></button>
  const page = (title: string, text: string, body: React.ReactNode) => <div className="team-page st-page"><header><div><h2>{title}</h2><p>{text}</p></div></header>{body}</div>
  const pages: Record<SettingsSection, () => React.ReactNode> = {
    general: () => page('General', 'How TerminAI starts, updates and behaves.', <>
      <AppVersion />
      <div className="st-card">
        <Row label="New tabs start" hint="Opens a new conversation right away, with permissions skipped.">
          <select value={prefs.newTabAgent} onChange={e => onChange({ newTabAgent: e.target.value as 'claude' })}>
            <option value="claude">Claude Code</option><option value="codex">Codex</option><option value="none">Just a shell</option></select></Row>
        <Row label="Install updates at night" hint="Between 3 and 6, when no tab is working: TerminAI restarts into the new version and your conversations come back."><Toggle on={prefs.nightUpdates} set={v => onChange({ nightUpdates: v })} /></Row>
        <Row label="Team chat button" hint="The round chat button at the bottom right."><Toggle on={prefs.chatButton} set={v => onChange({ chatButton: v })} /></Row>
        <Row label="Browser (beta)" hint="The built-in browser pane. Off until it is finished."><Toggle on={prefs.browserBeta} set={v => onChange({ browserBeta: v })} /></Row>
        <Row label="Customise the design" hint="Opens Claude Code in this app's own source, then rebuilds and relaunches."><button className="btn" onClick={onCustomize}>Open Claude Code</button></Row>
      </div>
    </>),
    appearance: () => page('Appearance', 'Theme, sidebar and text size.', <div className="st-card">
      <Row label="Theme" hint={<>Cycle all {Object.keys(THEMES).length} with <span className="kbd">⇧⌘L</span></>}>
        <select value={prefs.theme} onChange={e => onChange({ theme: e.target.value as ThemeName })}>{Object.values(THEMES).map(t => <option key={t.name} value={t.name}>{t.label}</option>)}</select></Row>
      <Row label="Sidebar" hint={<><span className="kbd">⌥⌘S</span> to flip · <span className="kbd">⌘S</span> to hide</>}>
        <select value={prefs.railSide} onChange={e => onChange({ railSide: e.target.value as RailSide })}><option value="left">Left</option><option value="right">Right</option></select></Row>
      <Row label="Group by folder" hint="Sessions sit under the folder they are in."><Toggle on={prefs.groupByFolder} set={v => onChange({ groupByFolder: v })} /></Row>
      <Row label="Font size" hint={<><span className="kbd">⌘+</span> / <span className="kbd">⌘−</span></>}>
        <select value={prefs.fontSize} onChange={e => onChange({ fontSize: Number(e.target.value) })}>{[11, 12, 13, 14, 15, 16, 18].map(n => <option key={n} value={n}>{n}px</option>)}</select></Row>
    </div>),
    voice: () => page('Voice', 'Each finished turn read aloud from its SPOKEN line.', <div className="st-card">
      <Row label="Spoken summaries" hint="Reads the SPOKEN: line each turn ends with."><Toggle on={prefs.voice.enabled} set={v => patchVoice({ enabled: v })} /></Row>
      <Row label="Play automatically" hint="Off: the dock waits for you to press play."><Toggle on={prefs.voice.autoplay} set={v => patchVoice({ autoplay: v })} /></Row>
      <Row label="Engine" hint={prefs.voice.engine === 'local' && !hasLocal ? 'Not installed: run scripts/setup-local-tts.sh, falling back to say' : prefs.voice.engine === 'local' ? 'Free, on-device, no API cost' : prefs.voice.engine === 'elevenlabs' && !hasEleven ? 'No key saved: falling back to macOS say' : prefs.voice.engine === 'elevenlabs' ? 'Best quality, billed per character' : 'Built into macOS'}>
        <select value={prefs.voice.engine} onChange={e => patchVoice({ engine: e.target.value as VoiceEngine })}>
          <option value="local">Local (Kokoro){hasLocal ? '' : ', not installed'}</option><option value="elevenlabs">ElevenLabs{hasEleven ? '' : ', no key'}</option><option value="say">macOS say</option></select></Row>
      {prefs.voice.engine === 'elevenlabs' && !hasEleven && <Row label="API key" hint="Stored in your login Keychain, never in a file.">
        <span className="st-inline"><input type="password" placeholder="sk_…" value={keyDraft} onChange={e => setKeyDraft(e.target.value)} /><button className="btn" onClick={() => void saveKey()} disabled={busy || !keyDraft}>Save</button></span></Row>}
      {prefs.voice.engine === 'local' && hasLocal && <Row label="Voice"><select value={prefs.voice.localVoice} onChange={e => patchVoice({ localVoice: e.target.value })}>{LOCAL_VOICES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</select></Row>}
      {prefs.voice.engine === 'say' && <Row label="Voice"><select value={prefs.voice.sayVoice} onChange={e => patchVoice({ sayVoice: e.target.value })}>{(voices.length ? voices : [prefs.voice.sayVoice]).map(v => <option key={v} value={v}>{v}</option>)}</select></Row>}
      {prefs.voice.engine === 'elevenlabs' && hasEleven && <Row label="Voice" hint={elevenError ? elevenError : elevenVoices.length ? `${elevenVoices.length} from your library` : 'loading…'}>
        <select value={prefs.voice.elevenVoiceId} onChange={e => patchVoice({ elevenVoiceId: e.target.value })}>
          {!elevenVoices.some(v => v.id === prefs.voice.elevenVoiceId) && <option value={prefs.voice.elevenVoiceId}>{prefs.voice.elevenVoiceId === DEFAULT_PREFS.voice.elevenVoiceId ? 'Rachel, ElevenLabs default' : 'Current voice, not in your library'}</option>}
          {elevenVoices.map(v => <option key={v.id} value={v.id}>{v.name}{v.description ? `, ${v.description}` : ''}</option>)}</select></Row>}
      <Row label="Preview" hint="Hear the current engine and voice."><button className="btn" onClick={preview}>Play sample</button></Row>
      <Row label="Volume"><input type="range" min={0} max={1} step={0.05} value={prefs.voice.volume} onChange={e => patchVoice({ volume: Number(e.target.value) })} /></Row>
    </div>),
    memory: () => page('Memory', 'What your sessions and the rest of the Mac use, and what to put to sleep.', <>
      <MemoryPanel tabs={tabs} onCloseTab={onCloseTab} onOpenTab={onOpenTab} /><MemoryDetailPanel /><StoragePanel /></>),
    notifications: () => page('Notifications', 'What macOS lets TerminAI do, and when it tells you.', <>
      <PermissionsSetup compact />
      <div className="st-card"><Row label="Notify when a chat is done" hint="A notice with its summary when you are not looking at that tab; click it to open the tab."><Toggle on={prefs.doneNotices} set={v => onChange({ doneNotices: v })} /></Row></div>
    </>),
    connections: () => page('Connections', 'Your own bots: your sessions can ask them, and they can reach your Shared sessions.', <>
      <GrokConnection />{company ? <Bots base={`/api/companies/${company}`} onError={e => console.warn(e)} /> : null}</>),
    shortcuts: () => page('Keyboard shortcuts', 'Everything you can do from the keyboard.', <div className="st-keys">
      {SHORTCUTS.map(g => <div key={g.group} className="st-card"><div className="st-keys-title">{g.group}</div>
        {g.items.map(([keys, what]) => <div key={keys} className="st-key"><span>{what}</span><span className="kbd">{keys}</span></div>)}</div>)}</div>),
  }
  return (
    <div className="workspace-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <section className="team-sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="team-shell">
          <aside className="team-side">
            <div className="team-brand"><span className="team-mark">›_</span>Settings</div>
            <nav>{SECTIONS.map(([key, label, icon]) => <button key={key} aria-current={section === key ? 'page' : undefined} onClick={() => setSection(key)}><SIcon d={icon} />{label}</button>)}</nav>
          </aside>
          <main className="team-main">
            <button className="team-close" aria-label="Close settings" onClick={onClose}><SIcon d="M6 6l12 12M18 6 6 18" /></button>
            {pages[section]()}
          </main>
        </div>
      </section>
    </div>
  )
}

type SettingsSection = 'general' | 'appearance' | 'voice' | 'memory' | 'notifications' | 'connections' | 'shortcuts'
const SECTIONS: [SettingsSection, string, string][] = [
  ['general', 'General', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z'],
  ['appearance', 'Appearance', 'M12 3a9 9 0 1 0 9 9c0-.8-.7-1.5-1.5-1.5H17a2.5 2.5 0 0 1 0-5h.5A1.5 1.5 0 0 0 19 4 9 9 0 0 0 12 3ZM7.5 11.5h.01M10 7.5h.01M15 7.5h.01'],
  ['voice', 'Voice', 'M4 9h4l5-4v14l-5-4H4ZM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12'],
  ['memory', 'Memory', 'M6 6h12v12H6ZM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4'],
  ['notifications', 'Notifications', 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15ZM10 20a2 2 0 0 0 4 0'],
  ['connections', 'Connections', 'M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1'],
  ['shortcuts', 'Shortcuts', 'M3 6h18v12H3ZM7 10h.01M11 10h.01M15 10h.01M7 14h10'],
]
const SIcon = ({ d }: { d: string }) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>

/** The version this Mac runs, and the same check as TerminAI › Check for Updates… in the menu bar. */
function AppVersion(): JSX.Element {
  const [version, setVersion] = useState('')
  const [status, setStatus] = useState('')
  useEffect(() => { void window.term.window.version().then(setVersion) }, [])
  return <div className="row">
    <label>TerminAI {version}<span className="hint">{status || 'New versions download by themselves; they install when you click Restart now.'}</span></label>
    <button className="btn settings-update" disabled={status === 'Checking…'} onClick={() => { setStatus('Checking…'); void window.term.window.checkForUpdates().then(setStatus).catch(e => setStatus(`Could not check: ${e?.message ?? e}`)) }}>{status === 'Checking…' ? 'Checking…' : 'Check for updates'}</button>
  </div>
}

/** Memory: the Mac's pressure, TerminAI's own use, and each session's, biggest first (memory.ts). An idle Claude Code or
 *  Codex still holds its memory while it waits; Sleep closes it and opening the tab brings the conversation back. */
function MemoryPanel({ tabs, onCloseTab, onOpenTab }: { tabs: { id: string; label: string }[]; onCloseTab: (id: string) => void; onOpenTab: (id: string) => void }): JSX.Element {
  const [r, setR] = useState<Awaited<ReturnType<typeof window.term.window.memory>> | null>(null)
  const [all, setAll] = useState(false)
  const load = () => void window.term.window.memory().then(setR)
  useEffect(() => { load(); const t = window.setInterval(load, 4000); return () => window.clearInterval(t) }, [])
  if (!r) return <></>
  const gb = (mb: number) => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
  const max = Math.max(1, ...r.tabs.map(t => t.mb)), idle = r.tabs.filter(t => t.idle)
  const sleep = (ids: string[]) => void window.term.window.sleep(ids).then(() => window.setTimeout(load, 2500))
  const other = Math.max(0, r.usedMb - r.tabsMb - r.appMb - r.macosMb - r.compressedMb), free = Math.max(0, r.totalMb - r.usedMb)
  const parts: [string, number, string][] = [['TerminAI sessions', r.tabsMb, 'var(--accent)'], ['TerminAI app', r.appMb, 'color-mix(in srgb, var(--accent) 55%, var(--pane))'],
    ['Other apps', other, 'hsl(265 40% 62%)'], ['macOS', r.macosMb, 'var(--dim)'], ['Compressed', r.compressedMb, 'var(--warn)'], ['Free', free, 'transparent']]
  const why = r.pressure === 'normal' ? `${gb(free)} free` : `${gb(r.compressedMb)} squeezed by macOS${r.swapMb ? ` and ${gb(r.swapMb)} written to disk` : ''}`
  return <section className="mem" id="memory">
    <div className="mem-head"><strong>Memory</strong>
      <span className={`mem-level ${r.pressure}`} title={why}>{r.pressure === 'normal' ? 'Mac memory OK' : r.pressure === 'warning' ? 'Memory is tight' : 'Out of memory'}</span></div>
    <div className="mem-bar" role="img" aria-label={`Memory: ${gb(r.usedMb)} of ${gb(r.totalMb)} in use`}>
      {parts.map(([n, mb, c]) => mb > 0 && <i key={n} title={`${n} · ${gb(mb)}`} style={{ flexGrow: mb, background: c }} />)}</div>
    <div className="mem-legend">
      {parts.map(([n, mb, c]) => <span key={n}><i style={{ background: c, outline: c === 'transparent' ? '1px solid var(--border)' : undefined }} />{n} <b>{gb(mb)}</b></span>)}</div>
    <p className="hint">{r.pressure === 'normal' ? `${gb(r.usedMb)} of ${gb(r.totalMb)} in use.` : `${gb(r.usedMb)} of ${gb(r.totalMb)} in use: ${why}. `}
      {r.pressure !== 'normal' && <>Biggest other apps: {r.apps.slice(0, 3).map(a => `${a.name} ${gb(a.mb)}`).join(', ')}. </>}
      Idle sessions hold memory too, and the numbers below leave out the part macOS compressed. <b>Sleep</b> closes one; opening the tab brings it back.</p>
    {idle.length > 0 && <button className="btn mem-sleep" onClick={() => sleep(idle.map(t => t.id))}>Sleep {idle.length} idle {idle.length === 1 ? 'session' : 'sessions'} · frees ~{gb(idle.reduce((n, t) => n + t.mb, 0))}</button>}
    <div className="mem-list">{(all ? r.tabs : r.tabs.slice(0, 8)).map(t => { const tab = tabs.find(x => x.id === t.id); return <div key={t.id} className="mem-row">
      <span className="mem-name" title={tab?.label}>{tab?.label ?? 'Session'}{t.asleep && <em className="mem-tag"> · asleep</em>}</span>
      <span className="mem-track"><i style={{ width: `${Math.max(2, (t.mb / max) * 100)}%` }} /></span><em>{gb(t.mb)}</em>
      <span className="mem-acts">{tab && <>{t.idle ? <button className="todo-link" onClick={() => sleep([t.id])}>Sleep</button> : <span />}<button className="todo-link" onClick={() => onOpenTab(tab.id)}>Open</button><button className="todo-link" onClick={() => onCloseTab(tab.id)}>Close</button></>}</span>
    </div> })}</div>
    {r.tabs.length > 8 && <button className="todo-link" onClick={() => setAll(v => !v)}>{all ? 'Show fewer' : `Show all ${r.tabs.length}`}</button>}
  </section>
}

/** What uses the memory: every app and macOS itself by real footprint (compressed and swapped parts included), each one
 *  opened into its biggest processes; Details says what a process is and Stop / Force stop ends it (memoryDetail.ts). */
function MemoryDetailPanel(): JSX.Element {
  type D = Awaited<ReturnType<typeof window.term.window.memoryDetail>>; type P = Awaited<ReturnType<typeof window.term.window.processInfo>>
  const [d, setD] = useState<D | null>(null), [busy, setBusy] = useState(false), [open, setOpen] = useState<string | null>(null)
  const [info, setInfo] = useState<P | null>(null), [msg, setMsg] = useState('')
  const load = () => { setBusy(true); void window.term.window.memoryDetail().then(setD).finally(() => setBusy(false)) }
  const gb = (mb: number) => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
  const look = (pid: number) => { setMsg(''); void window.term.window.processInfo(pid).then(setInfo) }
  const stop = (pid: number, force: boolean) => void window.term.window.stopProcess(pid, force).then(m => { setMsg(m); setInfo(null); window.setTimeout(load, 800) })
  if (!d) return <section className="mem"><div className="mem-head"><strong>What uses memory</strong>
    <button className="btn" disabled={busy} onClick={load}>{busy ? 'Measuring…' : 'Show breakdown'}</button></div>
    <p className="hint">Every app and macOS itself, with what each really holds, and a way to look inside or stop a process.</p></section>
  const total = d.groups.reduce((n, g) => n + g.mb, 0), max = Math.max(1, ...d.groups.map(g => g.mb))
  return <section className="mem" id="memory-detail">
    <div className="mem-head"><strong>What uses memory</strong><button className="btn" disabled={busy} onClick={load}>{busy ? 'Measuring…' : 'Refresh'}</button></div>
    <p className="hint">Apps together want {gb(total)}; the part beyond the Mac's memory is compressed or written to disk. macOS's own share includes {gb(d.wiredMb)} it keeps fixed (kernel and graphics).</p>
    {msg && <p className="hint mem-msg">{msg}</p>}
    <div className="mem-list">{d.groups.slice(0, 14).map(g => <div key={g.name} className="mem-row">
      <span className="mem-name">{g.name}<em className="mem-tag"> · {g.count} {g.count === 1 ? 'process' : 'processes'}{g.kind === 'macos' ? ' · macOS' : ''}</em></span>
      <span className="mem-track"><i style={{ width: `${Math.max(2, (g.mb / max) * 100)}%` }} /></span><em>{gb(g.mb)}</em>
      <span className="mem-acts"><button className="todo-link" onClick={() => setOpen(open === g.name ? null : g.name)}>{open === g.name ? 'Hide' : 'Processes'}</button></span>
      {open === g.name && <div className="mem-procs">{g.procs.slice(0, 12).map(p => <div key={p.pid} className="mem-proc">
        <span className="mem-name" title={`pid ${p.pid}`}>{p.name} <em className="mem-tag">pid {p.pid}</em></span><em>{gb(p.mb)}</em>
        <button className="todo-link" onClick={() => look(p.pid)}>Details</button>
        {g.kind !== 'macos' && <button className="todo-link" onClick={() => stop(p.pid, false)}>Stop</button>}</div>)}</div>}
    </div>)}</div>
    {info && <div className="mem-info">{info.ok ? <>
      <div><b>pid {info.pid}</b> · {info.user} · started {info.started} · CPU {info.cpu}% · {gb(info.mb)} in memory now</div>
      <code>{info.command}</code>
      {info.parents.length > 0 && <div>Started by: {info.parents.join(' ← ')}</div>}
      {info.cwd && <div>Folder: {info.cwd}</div>}
      {info.ports.length > 0 && <div>Listening on: {info.ports.join(', ')}</div>}
      <div className="mem-acts">{info.stoppable ? <><button className="btn" onClick={() => stop(info.pid, false)}>Stop</button>
        <button className="btn danger" onClick={() => stop(info.pid, true)}>Force stop</button></> : <span className="hint">{info.why}</span>}
        <button className="todo-link" onClick={() => setInfo(null)}>Close</button></div></> : <span className="hint">{info.why}</span>}</div>}
  </section>
}

/** Storage: used and free on the disk, and which folders hold it; measuring the folders takes up to a minute. */
function StoragePanel(): JSX.Element {
  const [s, setS] = useState<Awaited<ReturnType<typeof window.term.window.storage>> | null>(null), [busy, setBusy] = useState(false)
  const load = () => { setBusy(true); void window.term.window.storage().then(setS).finally(() => setBusy(false)) }
  const g = (n: number) => n >= 1 ? `${n.toFixed(1)} GB` : `${Math.round(n * 1024)} MB`
  const max = Math.max(0.01, ...(s?.folders ?? []).map(f => f.gb))
  return <section className="mem" id="storage">
    <div className="mem-head"><strong>Storage</strong><button className="btn" disabled={busy} onClick={load}>{busy ? 'Measuring folders… (up to a minute)' : s ? 'Measure again' : 'Measure storage'}</button></div>
    {!s ? <p className="hint">The disk's used and free space, and which folders hold the most.</p> : <>
      <div className="mem-bar" role="img" aria-label={`Disk: ${g(s.usedGb)} of ${g(s.totalGb)} used`}>
        <i style={{ flexGrow: s.usedGb, background: 'var(--accent)' }} /><i style={{ flexGrow: s.freeGb, background: 'transparent' }} /></div>
      <p className="hint">{g(s.usedGb)} of {g(s.totalGb)} used, {g(s.freeGb)} free.</p>
      <div className="mem-list">{s.folders.map(f => <div key={f.path} className="mem-row">
        <span className="mem-name" title={f.path}>{f.name}</span>
        <span className="mem-track"><i style={{ width: `${Math.max(2, (f.gb / max) * 100)}%` }} /></span><em>{g(f.gb)}</em>
        <span className="mem-acts"><button className="todo-link" onClick={() => void window.term.project.openFolder(f.path)}>Open</button></span>
      </div>)}</div></>}
  </section>
}



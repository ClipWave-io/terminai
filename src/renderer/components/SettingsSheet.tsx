import { useEffect, useState } from 'react'
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

  const patchVoice = (p: Partial<Prefs['voice']>): void =>
    onChange({ voice: { ...prefs.voice, ...p } })

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div className="sheet" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <AppVersion />
        <MemoryPanel tabs={tabs} onCloseTab={onCloseTab} onOpenTab={onOpenTab} />
        <div className="row">
          <label>New tabs start<span className="hint">Opens a new conversation right away, with permissions skipped.</span></label>
          <select value={prefs.newTabAgent} onChange={e => onChange({ newTabAgent: e.target.value as 'claude' })}>
            <option value="claude">Claude Code</option><option value="codex">Codex</option><option value="none">Just a shell</option></select>
        </div>
        <div className="row">
          <label>Install updates at night<span className="hint">Between 3 and 6, when no tab is working: TerminAI restarts into the new version and your conversations come back.</span></label>
          <input type="checkbox" checked={prefs.nightUpdates} onChange={e => onChange({ nightUpdates: e.target.checked })} />
        </div>
        <div className="row"><label>Permissions<span className="hint">What macOS lets TerminAI do.</span></label></div>
        <PermissionsSetup compact />
        <div className="row">
          <label>Browser (beta)<span className="hint">The built-in browser pane. Off until it is finished.</span></label>
          <input type="checkbox" checked={prefs.browserBeta} onChange={e => onChange({ browserBeta: e.target.checked })} />
        </div>
        <Feedback />
        <div className="row">
          <label>Notify when a chat is done<span className="hint">A notice with its summary; click it to open that tab.</span></label>
          <input type="checkbox" checked={prefs.doneNotices} onChange={e => onChange({ doneNotices: e.target.checked })} />
        </div>

        <div className="row">
          <label>
            Theme
            <span className="hint">
              Cycle all {Object.keys(THEMES).length} with <span className="kbd">⇧⌘L</span>
            </span>
          </label>
          <select
            value={prefs.theme}
            onChange={(e) => onChange({ theme: e.target.value as ThemeName })}
          >
            {Object.values(THEMES).map((t) => (
              <option key={t.name} value={t.name}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="row">
          <label>
            Sidebar
            <span className="hint">
              <span className="kbd">⌥⌘S</span> to flip · <span className="kbd">⌘S</span> to hide
            </span>
          </label>
          <select
            value={prefs.railSide}
            onChange={(e) => onChange({ railSide: e.target.value as RailSide })}
          >
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </div>

        <div className="row">
          <label>
            Group by folder
            <span className="hint">Sessions sit under the folder they are in</span>
          </label>
          <input
            type="checkbox"
            checked={prefs.groupByFolder}
            onChange={(e) => onChange({ groupByFolder: e.target.checked })}
          />
        </div>

        <div className="row">
          <label>
            Font size
            <span className="hint">
              <span className="kbd">⌘+</span> / <span className="kbd">⌘−</span>
            </span>
          </label>
          <select
            value={prefs.fontSize}
            onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
          >
            {[11, 12, 13, 14, 15, 16, 18].map((n) => (
              <option key={n} value={n}>
                {n}px
              </option>
            ))}
          </select>
        </div>

        <div className="row">
          <label>
            Spoken summaries
            <span className="hint">Reads the SPOKEN: line each turn ends with</span>
          </label>
          <input
            type="checkbox"
            checked={prefs.voice.enabled}
            onChange={(e) => patchVoice({ enabled: e.target.checked })}
          />
        </div>

        <div className="row">
          <label>
            Play automatically
            <span className="hint">Off = the dock waits for you to press play</span>
          </label>
          <input
            type="checkbox"
            checked={prefs.voice.autoplay}
            onChange={(e) => patchVoice({ autoplay: e.target.checked })}
          />
        </div>

        <div className="row">
          <label>
            Engine
            <span className="hint">
              {prefs.voice.engine === 'local' && !hasLocal
                ? 'Not installed — run scripts/setup-local-tts.sh, falling back to say'
                : prefs.voice.engine === 'local'
                  ? 'Free, on-device, no API cost'
                  : prefs.voice.engine === 'elevenlabs' && !hasEleven
                    ? 'No key saved — falling back to macOS say'
                    : 'Best quality, billed per character'}
            </span>
          </label>
          <select
            value={prefs.voice.engine}
            onChange={(e) => patchVoice({ engine: e.target.value as VoiceEngine })}
          >
            <option value="local">Local (Kokoro){hasLocal ? '' : ' — not installed'}</option>
            <option value="elevenlabs">ElevenLabs{hasEleven ? '' : ' — no key'}</option>
            <option value="say">macOS say</option>
          </select>
        </div>

        {prefs.voice.engine === 'elevenlabs' && !hasEleven && (
          <div className="row">
            <label>
              API key
              <span className="hint">Stored in your login Keychain, never in a file</span>
            </label>
            <span style={{ display: 'flex', gap: 6 }}>
              <input
                type="password"
                placeholder="sk_…"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                style={{ minWidth: 150 }}
              />
              <button className="chip" onClick={() => void saveKey()} disabled={busy || !keyDraft}>
                Save
              </button>
            </span>
          </div>
        )}

        {prefs.voice.engine === 'local' && hasLocal && (
          <div className="row">
            <label>Voice</label>
            <select
              value={prefs.voice.localVoice}
              onChange={(e) => patchVoice({ localVoice: e.target.value })}
            >
              {LOCAL_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {prefs.voice.engine === 'say' && (
          <div className="row">
            <label>Voice</label>
            <select
              value={prefs.voice.sayVoice}
              onChange={(e) => patchVoice({ sayVoice: e.target.value })}
            >
              {(voices.length ? voices : [prefs.voice.sayVoice]).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        )}

        {prefs.voice.engine === 'elevenlabs' && hasEleven && (
          <div className="row">
            <label>
              Voice
              <span className="hint">
                {elevenError
                  ? elevenError
                  : elevenVoices.length
                    ? `${elevenVoices.length} from your library`
                    : 'loading…'}
              </span>
            </label>
            <select
              value={prefs.voice.elevenVoiceId}
              onChange={(e) => patchVoice({ elevenVoiceId: e.target.value })}
            >
              {/* The stored voice may be one of ElevenLabs' premade voices,
                  which are not part of the account's own library listing. It
                  still synthesizes fine, so keep it selectable and say so. */}
              {!elevenVoices.some((v) => v.id === prefs.voice.elevenVoiceId) && (
                <option value={prefs.voice.elevenVoiceId}>
                  {prefs.voice.elevenVoiceId === DEFAULT_PREFS.voice.elevenVoiceId
                    ? 'Rachel — ElevenLabs default'
                    : 'Current voice — not in your library'}
                </option>
              )}
              {elevenVoices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.description ? ` — ${v.description}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="row">
          <label>
            Preview
            <span className="hint">Hear the current engine and voice</span>
          </label>
          <button className="chip" onClick={preview}>
            ▶ Play sample
          </button>
        </div>

        <div className="row">
          <label>Volume</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={prefs.voice.volume}
            onChange={(e) => patchVoice({ volume: Number(e.target.value) })}
          />
        </div>

        <div className="row">
          <label>
            Customise the design
            <span className="hint">
              Opens Claude Code in this app's own source, then rebuilds and relaunches
            </span>
          </label>
          <button className="chip on" onClick={onCustomize}>
            Open Claude Code
          </button>
        </div>

        <h3 className="sheet-section">Keyboard shortcuts</h3>
        {SHORTCUTS.map((g) => (
          <div key={g.group} className="keys-group">
            <div className="keys-title">{g.group}</div>
            {g.items.map(([keys, what]) => (
              <div key={keys} className="keys-row">
                <span className="keys-what">{what}</span>
                <span className="kbd">{keys}</span>
              </div>
            ))}
          </div>
        ))}

        <div className="row" style={{ paddingTop: 14, justifyContent: 'flex-end' }}>
          <button className="btn" style={{ flex: '0 0 auto' }} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

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

/** Feedback to Maracuya Labs: opens an email in the Mail app with the version filled in. */
function Feedback(): JSX.Element {
  const [text, setText] = useState('')
  return <div className="row feedback">
    <label>Feedback<span className="hint">A bug, an idea, an error you saw: it goes to info@maracuyalabs.com.</span></label>
    <span className="feedback-box"><textarea rows={2} placeholder="What happened, or what you'd like" value={text} onChange={e => setText(e.target.value)} />
      <button className="btn" onClick={() => { void window.term.window.feedback(text); setText('') }}>Send feedback</button></span>
  </div>
}


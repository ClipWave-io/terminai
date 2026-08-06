import { useEffect, useState } from 'react'
import { DEFAULT_PREFS, type Prefs, type ThemeName } from '../../shared/types'
import { THEMES } from '../../shared/themes'
import type { JSX } from 'react'

interface Props {
  prefs: Prefs
  onChange: (patch: Partial<Prefs>) => void
  onClose: () => void
}

interface ElevenVoice {
  id: string
  name: string
  category: string
  description: string
}

export function SettingsSheet({ prefs, onChange, onClose }: Props): JSX.Element {
  const [voices, setVoices] = useState<string[]>([])
  const [hasEleven, setHasEleven] = useState(false)
  const [elevenVoices, setElevenVoices] = useState<ElevenVoice[]>([])
  const [elevenError, setElevenError] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)

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

        <div className="row">
          <label>
            Theme
            <span className="hint">
              Toggle any time with <span className="kbd">⇧⌘L</span>
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
              {hasEleven
                ? 'ElevenLabs sounds far better than the built-in voices'
                : 'No ElevenLabs key saved — falling back to macOS say'}
            </span>
          </label>
          <select
            value={prefs.voice.engine}
            onChange={(e) => patchVoice({ engine: e.target.value as 'say' | 'elevenlabs' })}
          >
            <option value="elevenlabs">ElevenLabs</option>
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

        <div className="row" style={{ paddingTop: 14 }}>
          <span className="hint">
            <span className="kbd">⌘T</span> new · <span className="kbd">⌘W</span> close ·{' '}
            <span className="kbd">⌘1–9</span> jump · <span className="kbd">⌃⇥</span> cycle ·{' '}
            <span className="kbd">⇧⌘S</span> speak
          </span>
          <button className="btn" style={{ flex: '0 0 auto' }} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

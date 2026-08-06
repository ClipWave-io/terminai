import { useEffect, useState } from 'react'
import type { Prefs, ThemeName } from '../../shared/types'
import { THEMES } from '../../shared/themes'
import type { JSX } from 'react'

interface Props {
  prefs: Prefs
  onChange: (patch: Partial<Prefs>) => void
  onClose: () => void
}

export function SettingsSheet({ prefs, onChange, onClose }: Props): JSX.Element {
  const [voices, setVoices] = useState<string[]>([])
  const [hasEleven, setHasEleven] = useState(false)

  useEffect(() => {
    void window.term.voice.voices().then(setVoices)
    void window.term.voice.hasElevenKey().then(setHasEleven)
  }, [])

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
            {!hasEleven && (
              <span className="hint">ElevenLabs needs ELEVENLABS_API_KEY in the environment</span>
            )}
          </label>
          <select
            value={prefs.voice.engine}
            onChange={(e) => patchVoice({ engine: e.target.value as 'say' | 'elevenlabs' })}
          >
            <option value="say">macOS say</option>
            <option value="elevenlabs" disabled={!hasEleven}>
              ElevenLabs
            </option>
          </select>
        </div>

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

        {prefs.voice.engine === 'elevenlabs' && (
          <div className="row">
            <label>
              Voice ID
              <span className="hint">From your ElevenLabs voice library</span>
            </label>
            <input
              style={{ minWidth: 132 }}
              value={prefs.voice.elevenVoiceId}
              onChange={(e) => patchVoice({ elevenVoiceId: e.target.value })}
            />
          </div>
        )}

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

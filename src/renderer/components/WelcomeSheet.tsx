import { useEffect, useState } from 'react'
import type { JSX } from 'react'

interface Props {
  onDismiss: () => void
  onOpenSettings: () => void
  onOpenWorkspace: () => void
}

/** What the voice pipeline can actually do right now, so the tour never
 *  promises audio that isn't wired up on this machine. */
type VoiceState = 'checking' | 'local' | 'elevenlabs' | 'say'

const TOUR: { title: string; blurb: string; keys: [string, string][] }[] = [
  {
    title: 'Sessions live in the sidebar',
    blurb:
      'Every tab is its own shell in its own folder. The dot beside each one tracks what it is doing — green is idle, yellow is working, blue is waiting on you.',
    keys: [
      ['⌘T', 'New tab'],
      ['⇧⌘O', 'New tab in a folder you pick'],
      ['⌘S', 'Show or hide the sidebar'],
    ],
  },
  {
    title: 'See everything at once',
    blurb:
      'The grid puts all your sessions side by side with their notes, so you can tell at a glance which one needs you.',
    keys: [
      ['⌘G', 'Open the session grid'],
      ['⌘1–⌘9', 'Jump straight to a tab'],
    ],
  },
]

export function WelcomeSheet({ onDismiss, onOpenSettings, onOpenWorkspace }: Props): JSX.Element {
  const [voice, setVoice] = useState<VoiceState>('checking')

  useEffect(() => {
    void (async () => {
      if (await window.term.voice.hasLocal()) return setVoice('local')
      if (await window.term.voice.hasElevenKey()) return setVoice('elevenlabs')
      setVoice('say')
    })()
  }, [])

  const voiceBlurb =
    voice === 'checking'
      ? 'Checking what is available on this machine…'
      : voice === 'local'
        ? 'The free on-device voice is installed, so summaries are read aloud at no cost.'
        : voice === 'elevenlabs'
          ? 'Your ElevenLabs key is saved, so summaries are read aloud in your chosen voice.'
          : 'Falling back to the built-in macOS voice. Settings can switch you to the free on-device voice or ElevenLabs.'

  return (
    <div className="sheet-backdrop" onMouseDown={onDismiss}>
      <div className="sheet welcome" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Welcome to TerminAI</h2>
        <p className="welcome-lead">
          A terminal built around long-running Claude Code sessions. Here is what is worth knowing
          before you start.
        </p>

        {TOUR.map((s) => (
          <div key={s.title} className="welcome-step">
            <div className="welcome-title">{s.title}</div>
            <p className="welcome-blurb">{s.blurb}</p>
            {s.keys.map(([k, what]) => (
              <div key={k} className="keys-row">
                <span className="keys-what">{what}</span>
                <span className="kbd">{k}</span>
              </div>
            ))}
          </div>
        ))}

        <div className="welcome-step">
          <div className="welcome-title">
            Summaries are spoken
            <span className={`welcome-badge${voice === 'say' ? ' warn' : ''}`}>
              {voice === 'checking'
                ? '…'
                : voice === 'local'
                  ? 'Local voice ready'
                  : voice === 'elevenlabs'
                    ? 'ElevenLabs connected'
                    : 'macOS voice'}
            </span>
          </div>
          <p className="welcome-blurb">
            When a turn ends, its one-line summary is read aloud and kept in the dock at the bottom,
            so you can step away and still know what happened. {voiceBlurb}
          </p>
          {(
            [
              ['⇧⌘S', 'Replay the latest summary'],
              ['⇧⌘M', 'Mute or unmute'],
              ['⌘D', 'Show or hide the dock'],
            ] as [string, string][]
          ).map(([k, what]) => (
            <div key={k} className="keys-row">
              <span className="keys-what">{what}</span>
              <span className="kbd">{k}</span>
            </div>
          ))}
        </div>

        <div className="welcome-step">
          <div className="welcome-title">Work with your team</div>
          <p className="welcome-blurb">Sign in or use your company invitation to see shared conversations and the tools assigned to your role. Your terminal sessions stay private until you choose to share them.</p>
          <button className="btn primary" onClick={onOpenWorkspace}>Sign in to your workspace</button>
        </div>

        <p className="welcome-foot">
          The full shortcut list lives in Settings — <span className="kbd">⌘,</span> any time.
        </p>

        <div className="row" style={{ paddingTop: 12, justifyContent: 'flex-end' }}>
          <button className="btn" style={{ flex: '0 0 auto' }} onClick={onOpenSettings}>
            Open Settings
          </button>
          <button className="btn primary" style={{ flex: '0 0 auto' }} onClick={onDismiss}>
            Continue locally
          </button>
        </div>
      </div>
    </div>
  )
}

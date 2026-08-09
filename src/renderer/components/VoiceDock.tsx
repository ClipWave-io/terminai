import { useEffect, useRef, useState } from 'react'
import type { VoiceClip } from '../../shared/types'
import type { JSX } from 'react'

interface Props {
  clips: VoiceClip[]
  autoplay: boolean
  /** false = summaries are not synthesized at all; toggled with ⌘⇧M. */
  enabled: boolean
  volume: number
  /** bumped by the parent to request playback of the newest clip */
  playToken: number
  /** collapsed out of view; toggled with ⌘D. Playback keeps working underneath. */
  hidden: boolean
  onPlayingChange: (clip: VoiceClip | null) => void
  onToggleAutoplay: () => void
  onToggleEnabled: () => void
}

const ENGINE_LABEL: Record<VoiceClip['engine'], string> = {
  elevenlabs: 'ElevenLabs',
  local: 'Local',
  say: 'macOS say',
}

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
}

export function VoiceDock({
  clips,
  autoplay,
  enabled,
  volume,
  playToken,
  hidden,
  onPlayingChange,
  onToggleAutoplay,
  onToggleEnabled,
}: Props): JSX.Element | null {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(0)

  const [src, setSrc] = useState<string | null>(null)

  const clip = clips[index] ?? null

  // A newly arrived clip becomes the selected one.
  useEffect(() => {
    if (clips.length) setIndex(0)
  }, [clips.length])

  // The clipaudio:// handler streams the file without a Content-Length, so
  // Chromium can't seek it and never resolves a duration — the dock sat at
  // 0:00 / 0:00 and refused to play. Pulling the bytes into a blob first gives
  // the element a fully-buffered, seekable source.
  const url = clip?.url ?? null
  useEffect(() => {
    if (!url) {
      setSrc(null)
      return
    }
    let dead = false
    let objectUrl: string | null = null
    setDur(0)
    setPos(0)
    void fetch(url)
      .then((r) => r.blob())
      .then((b) => {
        if (dead) return
        objectUrl = URL.createObjectURL(b)
        setSrc(objectUrl)
      })
      .catch(() => {
        // Fall back to the raw protocol URL: playback may still work even when
        // the duration doesn't.
        if (!dead) setSrc(url)
      })
    return () => {
      dead = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [url])

  useEffect(() => {
    const el = audioRef.current
    if (el) el.volume = volume
  }, [volume, clip])

  // Parent bumps playToken on arrival (when autoplay is on) and on ⌘⇧S. The
  // source is fetched asynchronously, so the request may land before there is
  // anything to play — the ref lets the effect re-fire on src without replaying
  // when the user is just browsing older summaries.
  const playedToken = useRef(0)
  useEffect(() => {
    if (playToken === 0 || playToken === playedToken.current) return
    const el = audioRef.current
    if (!el || !src) return
    playedToken.current = playToken
    el.currentTime = 0
    void el.play().catch(() => setPlaying(false))
  }, [playToken, src])

  // Muting mid-sentence should actually go quiet, not just stop future clips.
  useEffect(() => {
    if (!enabled) audioRef.current?.pause()
  }, [enabled])

  useEffect(() => {
    onPlayingChange(playing ? clip : null)
  }, [playing, clip, onPlayingChange])

  if (!clip) return null

  const rootClass = hidden ? 'dock hidden' : 'dock'

  const toggle = (): void => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) void el.play().catch(() => setPlaying(false))
    else el.pause()
  }

  const keepDur = (d: number): void => {
    if (Number.isFinite(d) && d > 0) setDur(d)
  }

  const seek = (e: React.MouseEvent<HTMLDivElement>): void => {
    const el = audioRef.current
    if (!el || !Number.isFinite(el.duration)) return
    const rect = e.currentTarget.getBoundingClientRect()
    el.currentTime = ((e.clientX - rect.left) / rect.width) * el.duration
  }

  return (
    <div className={rootClass}>
      <button className="dock-play" onClick={toggle} title={playing ? 'Pause' : 'Play  ⌘⇧S'}>
        {playing ? '❚❚' : '▶'}
      </button>

      <div className="dock-body">
        <div className="dock-text" title={clip.text}>
          {clip.text}
        </div>
        <div className="dock-scrub" onClick={seek}>
          <div className="dock-progress" style={{ width: `${dur ? (pos / dur) * 100 : 0}%` }} />
        </div>
        <div className="dock-meta">
          <span>
            {clock(pos)} / {clock(dur)}
          </span>
          <span>·</span>
          <span>{ENGINE_LABEL[clip.engine] ?? clip.engine}</span>
          {!enabled && (
            <>
              <span>·</span>
              <span>muted</span>
            </>
          )}
          <span>·</span>
          <span>{ago(clip.createdAt)}</span>
          {clips.length > 1 && (
            <>
              <span>·</span>
              <span>
                {index + 1}/{clips.length}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="dock-actions">
        <button
          className="chip"
          onClick={() => setIndex((i) => Math.min(i + 1, clips.length - 1))}
          disabled={index >= clips.length - 1}
          title="Previous summary"
        >
          ↑
        </button>
        <button
          className="chip"
          onClick={() => setIndex((i) => Math.max(i - 1, 0))}
          disabled={index === 0}
          title="Next summary"
        >
          ↓
        </button>
        <button
          className={`chip${autoplay ? ' on' : ''}`}
          onClick={onToggleAutoplay}
          title="Play new summaries automatically"
        >
          auto
        </button>
        <button
          className={`chip${enabled ? '' : ' on'}`}
          onClick={onToggleEnabled}
          title={enabled ? 'Mute spoken summaries  ⌘⇧M' : 'Unmute spoken summaries  ⌘⇧M'}
        >
          {enabled ? '🔊' : '🔇'}
        </button>
        <button
          className="chip"
          onClick={() => void window.term.voice.save(clip.path, clip.text)}
          title="Save a copy of this audio"
        >
          ⤓
        </button>
      </div>

      <audio
        ref={audioRef}
        src={src ?? undefined}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setPos(0)
        }}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        // Duration can land on any of these depending on how the source was
        // buffered; take it from whichever fires first with a real number.
        onLoadedMetadata={(e) => keepDur(e.currentTarget.duration)}
        onDurationChange={(e) => keepDur(e.currentTarget.duration)}
        onCanPlay={(e) => keepDur(e.currentTarget.duration)}
      />
    </div>
  )
}

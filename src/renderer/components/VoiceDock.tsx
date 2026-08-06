import { useEffect, useRef, useState } from 'react'
import type { VoiceClip } from '../../shared/types'
import type { JSX } from 'react'

interface Props {
  clips: VoiceClip[]
  autoplay: boolean
  volume: number
  /** bumped by the parent to request playback of the newest clip */
  playToken: number
  onPlayingChange: (clip: VoiceClip | null) => void
  onToggleAutoplay: () => void
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
  volume,
  playToken,
  onPlayingChange,
  onToggleAutoplay,
}: Props): JSX.Element | null {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(0)

  const clip = clips[index] ?? null

  // A newly arrived clip becomes the selected one.
  useEffect(() => {
    if (clips.length) setIndex(0)
  }, [clips.length])

  useEffect(() => {
    const el = audioRef.current
    if (el) el.volume = volume
  }, [volume, clip])

  // Parent bumps playToken on arrival (when autoplay is on) and on ⌘⇧S.
  useEffect(() => {
    if (playToken === 0 || !clip) return
    const el = audioRef.current
    if (!el) return
    el.currentTime = 0
    void el.play().catch(() => setPlaying(false))
  }, [playToken, clip])

  useEffect(() => {
    onPlayingChange(playing ? clip : null)
  }, [playing, clip, onPlayingChange])

  if (!clip) return null

  const toggle = (): void => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) void el.play().catch(() => setPlaying(false))
    else el.pause()
  }

  const seek = (e: React.MouseEvent<HTMLDivElement>): void => {
    const el = audioRef.current
    if (!el || !Number.isFinite(el.duration)) return
    const rect = e.currentTarget.getBoundingClientRect()
    el.currentTime = ((e.clientX - rect.left) / rect.width) * el.duration
  }

  return (
    <div className="dock">
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
          <span>{clip.engine === 'elevenlabs' ? 'ElevenLabs' : 'macOS say'}</span>
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
          className="chip"
          onClick={() => void window.term.voice.save(clip.path, clip.text)}
          title="Save a copy of this audio"
        >
          ⤓
        </button>
      </div>

      <audio
        ref={audioRef}
        src={clip.url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setPos(0)
        }}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
      />
    </div>
  )
}

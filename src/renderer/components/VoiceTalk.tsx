import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import './accounts.css'

type Phase = 'off' | 'starting' | 'listening' | 'hearing' | 'transcribing' | 'working' | 'speaking'
const LABEL: Record<Phase, string> = { off: 'Talk', starting: 'Starting…', listening: 'Listening', hearing: 'Listening', transcribing: 'Got it…', working: 'Working…', speaking: 'Speaking' }

const RATE = 16000
const FRAME = 1024                 // 64 ms
const END_SILENCE_MS = 1200        // a pause this long ends what was said
const MAX_MS = 90_000

/** Sentences grouped into pieces of about two, so the first is heard quickly and the voice keeps a natural pace. */
function pieces(text: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const s of text.replace(/\n+/g, '. ').match(/[^.!?]+[.!?]*\s*/g) ?? []) {
    if (cur && (cur + s).length > 220) { out.push(cur.trim()); cur = '' }
    cur += s
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(p => /[a-z0-9]/i.test(p))
}

/**
 * The mic beside Shared: a spoken conversation with the active tab. What is said goes in when there is a pause,
 * the agent's answer is read aloud as it is written, then it listens again. The agent ends the conversation itself
 * before long work (VOICE: off); a click or Esc ends it any time. ⌥⌘T starts and stops it.
 */
export function VoiceTalk({ tabId, volume }: { tabId: string; volume: number }): JSX.Element {
  const [phase, setPhaseState] = useState<Phase>('off')
  const [note, setNote] = useState('')
  const [level, setLevel] = useState(0)
  const phaseRef = useRef<Phase>('off')
  const setPhase = (p: Phase) => { phaseRef.current = p; setPhaseState(p) }
  const mic = useRef<{ stream: MediaStream; ctx: AudioContext; node: ScriptProcessorNode } | null>(null)
  const heard = useRef<Float32Array[]>([])
  const vad = useRef({ floor: 0.004, speech: 0, silence: 0, startedAt: 0 })
  const queue = useRef<Promise<string>[]>([])
  const playing = useRef<HTMLAudioElement | null>(null)
  const draining = useRef(false)
  const turnOver = useRef(true)
  const offAfter = useRef(false)
  const spokeThisTurn = useRef(false)

  const stopAudio = () => { queue.current = []; playing.current?.pause(); playing.current = null }
  const end = (why = '') => {
    stopAudio()
    mic.current?.node.disconnect(); mic.current?.stream.getTracks().forEach(t => t.stop()); void mic.current?.ctx.close().catch(() => {})
    mic.current = null; heard.current = []
    void window.term.voiceChat.cancel(tabId)
    void window.term.voiceChat.stop()
    setPhase('off'); setLevel(0); setNote(why)
  }

  const listen = () => { heard.current = []; vad.current = { ...vad.current, speech: 0, silence: 0, startedAt: 0 }; setPhase('listening') }

  /** Plays the queue in order; when it runs dry and the turn is over, listens again (or ends, if the agent said so). */
  const drain = async () => {
    if (draining.current) return
    draining.current = true
    try {
      while (queue.current.length && phaseRef.current !== 'off') {
        const url = await queue.current[0].catch(() => '')
        queue.current.shift()
        if (!url || (phaseRef.current as Phase) === 'off') continue
        setPhase('speaking')
        await new Promise<void>(resolve => {
          const a = new Audio(url); a.volume = Math.max(0, Math.min(1, volume)); playing.current = a
          a.onended = a.onerror = a.onpause = () => resolve()
          void a.play().catch(() => resolve())
        })
        playing.current = null
      }
    } finally { draining.current = false }
    if ((phaseRef.current as Phase) === 'off') return
    if (offAfter.current && !queue.current.length) { end('Voice off: it is doing longer work. You get the usual notice when it is done.'); return }
    if (turnOver.current) listen(); else setPhase('working')
  }
  const say = (text: string) => { for (const p of pieces(text)) queue.current.push(window.term.voiceChat.speak(p)); void drain() }

  // What the agent writes for this tab, as it writes it.
  useEffect(() => {
    const offSaid = window.term.voiceChat.onSaid(e => {
      if (e.tabId !== tabId || phaseRef.current === 'off') return
      if (e.off) offAfter.current = true
      if (e.text) { spokeThisTurn.current = true; say(e.text) }
    })
    const offEnd = window.term.voiceChat.onEnd(e => {
      if (e.tabId !== tabId || phaseRef.current === 'off') return
      turnOver.current = true
      if (!spokeThisTurn.current) say(e.spoken || 'Done.')
      else void drain()
    })
    return () => { offSaid(); offEnd() }
  }, [tabId, volume])

  // A finished utterance: to text, into the tab.
  const finish = async () => {
    const chunks = heard.current; heard.current = []
    const n = chunks.reduce((s, c) => s + c.length, 0)
    if (n < RATE * 0.4) { listen(); return }
    const all = new Float32Array(n); let o = 0
    for (const c of chunks) { all.set(c, o); o += c.length }
    setPhase('transcribing')
    let text = ''
    try { text = (await window.term.voiceChat.transcribe(all)).trim() } catch { setNote('Could not understand that. Try again.') }
    if (phaseRef.current === 'off') return
    if (!text || !/[a-z0-9]/i.test(text)) { listen(); return }
    if (/^(stop|cancel|bye|goodbye|that'?s all|thanks,? that'?s it)[.!]?$/i.test(text)) { end(); return }
    setNote(`“${text.length > 90 ? text.slice(0, 90) + '…' : text}”`)
    turnOver.current = false; offAfter.current = false; spokeThisTurn.current = false
    setPhase('working')
    await window.term.voiceChat.send(tabId, text)
  }

  const onFrame = (buf: Float32Array) => {
    const p = phaseRef.current
    let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    const rms = Math.sqrt(sum / buf.length)
    const v = vad.current
    const loud = rms > Math.max(0.012, v.floor * 3)
    setLevel(Math.min(1, rms * 12))
    // Talking over the voice stops it and listens.
    if (p === 'speaking') { if (rms > Math.max(0.05, v.floor * 8)) { if (++v.speech > 4) { stopAudio(); listen() } } else v.speech = 0; return }
    if (p !== 'listening' && p !== 'hearing') return
    if (!loud) v.floor = v.floor * 0.95 + rms * 0.05
    if (p === 'listening') {
      // Keep about half a second before the voice starts, so the first word is not clipped.
      heard.current.push(buf.slice()); if (heard.current.length > 8) heard.current.shift()
      if (loud) { if (++v.speech >= 2) { v.silence = 0; v.startedAt = Date.now(); setPhase('hearing') } } else v.speech = 0
      return
    }
    heard.current.push(buf.slice())
    v.silence = loud ? 0 : v.silence + (FRAME / RATE) * 1000
    if (v.silence >= END_SILENCE_MS || Date.now() - v.startedAt > MAX_MS) void finish()
  }

  const start = async () => {
    setNote(''); setPhase('starting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
      const ready = window.term.voiceChat.begin()
      const ctx = new AudioContext({ sampleRate: RATE })
      const node = ctx.createScriptProcessor(FRAME, 1, 1)
      node.onaudioprocess = e => onFrame(e.inputBuffer.getChannelData(0))
      ctx.createMediaStreamSource(stream).connect(node); node.connect(ctx.destination)
      mic.current = { stream, ctx, node }
      setNote('Loading the voice (the first time takes a few seconds)…')
      await ready
      if (phaseRef.current !== 'starting') return
      setNote(''); turnOver.current = true; listen()
    } catch (e) {
      const m = String((e as Error)?.message ?? e)
      end(/mic|Permission|NotAllowed/i.test(m) ? 'TerminAI may not use the microphone: allow it in System Settings › Privacy › Microphone.' : 'The voice could not start: ' + m.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  const toggle = () => { if (phaseRef.current === 'off') void start(); else end() }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.altKey && e.metaKey && (e.key === 't' || e.key === '†' || e.code === 'KeyT')) { e.preventDefault(); toggle() }
      else if (e.key === 'Escape' && phaseRef.current === 'speaking') { stopAudio(); void drain() }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [tabId])
  useEffect(() => () => { if (phaseRef.current !== 'off') end() }, [tabId])

  const on = phase !== 'off'
  return (
    <div className="voice-talk">
      {on && note && <div className="voice-note" role="status">{note}</div>}
      {!on && note && <div className="voice-note" role="status" onClick={() => setNote('')}>{note}</div>}
      <button className={`corner-privacy voice-btn ${phase}`} aria-pressed={on} onClick={toggle}
        title={on ? 'End the voice conversation (⌥⌘T). Esc skips what is being read.' : 'Talk to this chat: say what you want, it answers out loud (⌥⌘T). Runs on this Mac, free.'}>
        <span className="voice-icon" aria-hidden="true" style={{ ['--lv' as string]: phase === 'hearing' || phase === 'listening' ? level : 0 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4" /></svg>
        </span>
        {LABEL[phase]}
      </button>
    </div>
  )
}

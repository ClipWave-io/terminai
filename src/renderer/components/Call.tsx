import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { Avatar } from './Permissions'

/**
 * Voice and video calls with the team. terminai.xyz only passes each Mac's connection details to the other (WebRTC
 * signalling: an offer, an answer and network candidates); the sound and picture then go directly Mac to Mac,
 * encrypted end to end by WebRTC. When two networks cannot reach each other directly, a TURN relay carries it.
 * With more than two people each pair connects directly (a mesh), which is fine for a small team.
 */
type Signal = { seq: string; from: string; fromName: string; to: string | null; callId: string; kind: string; data: any }
type PeerState = { name: string; stream: MediaStream; state: RTCPeerConnectionState | 'new'; video: boolean; screen: boolean; muted: boolean; since?: number }
type Phase = 'idle' | 'outgoing' | 'incoming' | 'live'
type Incoming = { callId: string; from: string; fromName: string; video: boolean }

const I: Record<string, string> = {
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z',
  video: 'M3 7h12v10H3ZM15 10l6-3v10l-6-3',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3ZM5 11a7 7 0 0 0 14 0M12 18v3',
  micOff: 'M3 3l18 18M9 9v3a3 3 0 0 0 5 2.2M15 9.5V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v3',
  videoOff: 'M3 3l18 18M15 11V7H8M3 7v10h12v-2M15 10l6-3v10l-3-1.5',
  screen: 'M3 4h18v12H3ZM8 20h8M12 16v4', min: 'M5 12h14', expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', shrink: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5', pop: 'M14 4h6v6M20 4l-8 8M18 14v6H4V6h6', hang: 'M3 14c5-5 13-5 18 0l-2.5 2.5-3-1.5v-2a10 10 0 0 0-5 0v2l-3 1.5Z',
}
export const CallIcon = ({ n, s = 18 }: { n: keyof typeof I; s?: number }) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={I[n]} /></svg>
const newId = () => `c-${crypto.randomUUID()}`
const timer = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

/** A soft two-tone ring while a call rings, made with Web Audio (no sound files). */
function useRing(on: boolean, incoming: boolean): void {
  useEffect(() => {
    if (!on) return
    let ctx: AudioContext | null = null
    try { ctx = new AudioContext(); void ctx.resume() } catch { return }
    const beep = () => {
      if (!ctx) return
      const t = ctx.currentTime, g = ctx.createGain(); g.connect(ctx.destination)
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(incoming ? 0.2 : 0.1, t + 0.05); g.gain.setValueAtTime(incoming ? 0.2 : 0.1, t + 0.9); g.gain.linearRampToValueAtTime(0, t + 1)
      for (const [f, d] of [[440, 0], [480, 0]] as const) { const o = ctx.createOscillator(); o.frequency.value = f; o.connect(g); o.start(t + d); o.stop(t + 1) }
    }
    // Settings › Notifications › Sounds › Calls off: it rings silently.
    let id: ReturnType<typeof setInterval> | undefined, stopped = false
    void window.term.prefs.get().then(p => { if (stopped || p.sounds?.call === false) return; beep(); id = setInterval(beep, incoming ? 2500 : 4000) }).catch(() => {})
    return () => { stopped = true; if (id) clearInterval(id); void ctx?.close() }
  }, [on, incoming])
}

export function useCalls(company: string, me: string, names: (id: string) => string) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [incoming, setIncoming] = useState<Incoming | null>(null)
  const [peers, setPeers] = useState<Record<string, PeerState>>({})
  const [local, setLocal] = useState<MediaStream | null>(null)
  const [media, setMedia] = useState({ muted: false, video: false, screen: false })
  const [since, setSince] = useState(0), [ended, setEnded] = useState('')
  const r = useRef({
    callId: '', caller: false, pcs: new Map<string, RTCPeerConnection>(), pending: new Map<string, RTCIceCandidateInit[]>(), streams: new Map<string, MediaStream>(),
    local: null as MediaStream | null, camera: null as MediaStreamTrack | null, screen: null as MediaStreamTrack | null, ice: null as RTCIceServer[] | null,
    done: new Set<string>(), ringTimer: 0 as any, phase: 'idle' as Phase, incoming: null as Incoming | null, media: { muted: false, video: false, screen: false },
  })
  r.current.phase = phase; r.current.incoming = incoming; r.current.media = media
  const meRef = useRef(me); meRef.current = me
  const namesRef = useRef(names); namesRef.current = names
  const send = useCallback((kind: string, to: string | null, data?: unknown) => window.term.teamchat.callSend(company, { callId: r.current.callId, kind, to: to ?? undefined, data }).catch(() => {}), [company])
  const patchPeer = (id: string, p: Partial<PeerState>) => setPeers(prev => prev[id] ? { ...prev, [id]: { ...prev[id], ...p } } : prev)

  const cleanup = useCallback((why = '') => {
    const c = r.current
    clearTimeout(c.ringTimer)
    c.pcs.forEach(pc => { try { pc.close() } catch {} }); c.pcs.clear(); c.pending.clear(); c.streams.clear()
    c.local?.getTracks().forEach(t => t.stop()); c.screen?.stop(); c.local = null; c.camera = null; c.screen = null
    if (c.callId) c.done.add(c.callId)
    c.callId = ''; c.caller = false
    setPeers({}); setLocal(null); setMedia({ muted: false, video: false, screen: false }); setPhase('idle'); setSince(0)
    if (why) { setEnded(why); setTimeout(() => setEnded(e => e === why ? '' : e), 4000) }
  }, [])

  const getLocal = async (video: boolean) => {
    if (!(await window.term.teamchat.mediaAccess(video))) throw new Error(video ? 'TerminAI may not use the microphone or camera. Allow it in System Settings › Privacy & Security.' : 'TerminAI may not use the microphone. Allow it in System Settings › Privacy & Security › Microphone.')
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: video ? { width: 1280, height: 720 } : false }) }
    catch (e) { if (!video) throw e; stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    const c = r.current; c.local = stream; c.camera = stream.getVideoTracks()[0] ?? null
    setLocal(stream); setMedia({ muted: false, video: !!c.camera, screen: false })
    if (!c.ice) c.ice = (await window.term.teamchat.ice(company).catch(() => ({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }))).iceServers
    return stream
  }
  const sendState = (to: string | null = null) => { const m = r.current.media; void send('state', to, { video: m.video || m.screen, screen: m.screen, muted: m.muted }) }

  const peer = (id: string, initiator: boolean): RTCPeerConnection => {
    const c = r.current
    const old = c.pcs.get(id); if (old) return old
    const pc = new RTCPeerConnection({ iceServers: c.ice ?? [] })
    c.pcs.set(id, pc)
    const stream = new MediaStream(); c.streams.set(id, stream)
    setPeers(prev => ({ ...prev, [id]: { name: namesRef.current(id), stream, state: 'new', video: false, screen: false, muted: false, since: Date.now() } }))
    if (initiator) {
      const a = c.local?.getAudioTracks()[0] ?? null, v = c.screen ?? c.camera
      pc.addTransceiver(a ?? 'audio', { direction: 'sendrecv', streams: c.local ? [c.local] : [] })
      pc.addTransceiver(v ?? 'video', { direction: 'sendrecv', streams: c.local ? [c.local] : [] })
    }
    // Each new track makes a new MediaStream: a player handed a stream before its tracks came may never start playing them.
    pc.ontrack = e => { if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track); const fresh = new MediaStream(stream.getTracks()); e.track.onunmute = () => setPeers(prev => prev[id] ? { ...prev, [id]: { ...prev[id], stream: new MediaStream(stream.getTracks()) } } : prev); setPeers(prev => prev[id] ? { ...prev, [id]: { ...prev[id], stream: fresh } } : prev) }
    pc.onicecandidate = e => { if (e.candidate) void send('ice', id, e.candidate.toJSON()) }
    pc.onconnectionstatechange = () => {
      patchPeer(id, { state: pc.connectionState })
      if (pc.connectionState === 'connected') { clearTimeout(c.ringTimer); setPhase('live'); setSince(s => s || Date.now()); sendState(id) }
      if (pc.connectionState === 'failed') { try { pc.restartIce() } catch {} }
    }
    return pc
  }
  const flushIce = async (id: string) => { const pc = r.current.pcs.get(id), q = r.current.pending.get(id) ?? []; r.current.pending.delete(id); for (const cand of q) await pc?.addIceCandidate(cand).catch(() => {}) }
  const dropPeer = (id: string) => {
    const c = r.current; c.pcs.get(id)?.close(); c.pcs.delete(id); c.streams.delete(id)
    setPeers(prev => { const n = { ...prev }; delete n[id]; return n })
    if (!c.pcs.size && c.phase === 'live') { void send('hangup', null); cleanup('Call ended') }
  }

  const handle = async (s: Signal) => {
    const c = r.current
    if (s.kind === 'ring') {
      if (c.done.has(s.callId)) return
      // Both pressed call at once: one call, not two "busy". The lower id answers the other's call; the other just waits for it.
      if (c.callId && c.phase === 'outgoing' && !c.pcs.size && !c.incoming) {
        if (meRef.current < s.from) {
          const mine = c.callId; clearTimeout(c.ringTimer); c.done.add(mine)
          void window.term.teamchat.callSend(company, { callId: mine, kind: 'hangup' }).catch(() => {})
          c.callId = s.callId; c.caller = false; setPhase('live')
          await send('accept', null, { video: !!c.camera })
        }
        return
      }
      if (c.callId || c.incoming) { if (c.callId !== s.callId && c.incoming?.callId !== s.callId) void window.term.teamchat.callSend(company, { callId: s.callId, kind: 'decline', to: s.from, data: { busy: true } }).catch(() => {}); return }
      const inc = { callId: s.callId, from: s.from, fromName: s.fromName, video: !!s.data?.video }
      setIncoming(inc); setPhase('incoming')
      void window.term.teamchat.callNotify(s.fromName, inc.video ? 'Video call' : 'Voice call')
      return
    }
    if (s.kind === 'hangup' && c.incoming?.callId === s.callId) { c.done.add(s.callId); setIncoming(null); setPhase(c.callId ? c.phase : 'idle'); void window.term.teamchat.callNotify(s.fromName, 'Missed call'); return }
    if (s.callId !== c.callId) return
    if (s.kind === 'accept') {
      // The caller connects to everyone who answers; two who answer connect to each other, the lower id offering.
      if (c.pcs.has(s.from) || !(c.caller || meRef.current < s.from)) return
      const pc = peer(s.from, true)
      await pc.setLocalDescription(await pc.createOffer())
      void send('offer', s.from, pc.localDescription?.toJSON())
    } else if (s.kind === 'offer') {
      const pc = peer(s.from, false)
      await pc.setRemoteDescription(s.data)
      for (const t of pc.getTransceivers()) {
        const kind = t.receiver.track.kind, track = kind === 'audio' ? c.local?.getAudioTracks()[0] ?? null : c.screen ?? c.camera
        await t.sender.replaceTrack(track); t.direction = 'sendrecv'; if (c.local) t.sender.setStreams?.(c.local)
      }
      await pc.setLocalDescription(await pc.createAnswer())
      void send('answer', s.from, pc.localDescription?.toJSON())
      await flushIce(s.from)
    } else if (s.kind === 'answer') {
      const pc = c.pcs.get(s.from); if (pc && pc.signalingState === 'have-local-offer') { await pc.setRemoteDescription(s.data); await flushIce(s.from) }
    } else if (s.kind === 'ice') {
      const pc = c.pcs.get(s.from)
      if (pc?.remoteDescription) await pc.addIceCandidate(s.data).catch(() => {})
      else c.pending.set(s.from, [...(c.pending.get(s.from) ?? []), s.data])
    } else if (s.kind === 'state') {
      patchPeer(s.from, { video: !!s.data?.video, screen: !!s.data?.screen, muted: !!s.data?.muted })
    } else if (s.kind === 'decline') {
      if (c.phase === 'outgoing' && !c.pcs.size) cleanup(s.data?.busy ? `${s.fromName} is on another call` : `${s.fromName} declined`)
    } else if (s.kind === 'hangup') dropPeer(s.from)
  }

  // The signal long poll, while signed in. Signals are handled one at a time, in order.
  useEffect(() => {
    if (!company) return
    let stop = false, after: string | undefined
    void (async () => {
      while (!stop) {
        try {
          const v = await window.term.teamchat.call(company, after)
          if (stop) return
          after = v.after
          for (const s of v.signals as Signal[]) { try { await handle(s) } catch (e) { console.warn('[call]', s.kind, e) } }
        } catch { if (stop) return; await new Promise(res => setTimeout(res, 3000)) }
      }
    })()
    return () => { stop = true }
  }, [company]) // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (video: boolean, to?: string) => {
    if (r.current.callId) return
    try {
      r.current.callId = newId(); r.current.caller = true; setPhase('outgoing'); setEnded('')
      await getLocal(video)
      await send('ring', to ?? null, { video })
      r.current.ringTimer = setTimeout(() => { if (r.current.phase === 'outgoing') { void send('hangup', null); cleanup('No answer') } }, 45000)
    } catch (e) { void send('hangup', null); cleanup(String((e as Error).message ?? e)) }
  }
  const accept = async (video: boolean) => {
    const inc = r.current.incoming; if (!inc) return
    setIncoming(null); r.current.callId = inc.callId; r.current.caller = false; setPhase('live'); setSince(0)
    try { await getLocal(video); await send('accept', null, { video }) } catch (e) { void send('hangup', null); cleanup(String((e as Error).message ?? e)) }
  }
  const decline = () => { const inc = r.current.incoming; if (!inc) return; r.current.done.add(inc.callId); void window.term.teamchat.callSend(company, { callId: inc.callId, kind: 'decline', to: inc.from }).catch(() => {}); setIncoming(null); if (!r.current.callId) setPhase('idle') }
  const hangup = () => { void send('hangup', null); cleanup() }

  const setVideoTrack = async (track: MediaStreamTrack | null) => { for (const pc of r.current.pcs.values()) for (const t of pc.getTransceivers()) if (t.receiver.track.kind === 'video') await t.sender.replaceTrack(track).catch(() => {}) }
  const toggleMute = () => { const m = !media.muted; r.current.local?.getAudioTracks().forEach(t => { t.enabled = !m }); r.current.media = { ...media, muted: m }; setMedia(r.current.media); sendState() }
  const toggleCamera = async () => {
    const c = r.current
    if (c.camera) { c.camera.stop(); c.local?.removeTrack(c.camera); c.camera = null; if (!c.screen) await setVideoTrack(null) }
    else {
      if (!(await window.term.teamchat.mediaAccess(true))) return setEnded('Allow the camera in System Settings › Privacy & Security › Camera.')
      const v = (await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })).getVideoTracks()[0]; c.camera = v; c.local?.addTrack(v)
      if (!c.screen) await setVideoTrack(v)
    }
    c.media = { ...c.media, video: !!c.camera }; setMedia(c.media); setLocal(c.local ? new MediaStream(c.local.getTracks()) : null); sendState()
  }
  const toggleScreen = async () => {
    const c = r.current
    if (c.screen) { c.screen.stop(); c.screen = null; await setVideoTrack(c.camera) }
    else {
      try { const s = (await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false })).getVideoTracks()[0]; c.screen = s; s.onended = () => { if (c.screen === s) void toggleScreen() }; await setVideoTrack(s) }
      catch { return }
    }
    c.media = { ...c.media, screen: !!c.screen }; setMedia(c.media); sendState()
  }
  useEffect(() => () => { if (r.current.callId) { void send('hangup', null); cleanup() } }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useRing(phase === 'incoming' || phase === 'outgoing', phase === 'incoming')
  return { phase, incoming, peers, local, media, since, ended, start, accept, decline, hangup, toggleMute, toggleCamera, toggleScreen, screenTrack: () => r.current.screen }
}
export type Calls = ReturnType<typeof useCalls>

function Media({ stream, muted, mirror, className, ref: outer }: { stream: MediaStream; muted?: boolean; mirror?: boolean; className?: string; ref?: React.RefObject<HTMLVideoElement | null> }): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => { const v = ref.current; if (outer) outer.current = v; if (v && v.srcObject !== stream) { v.srcObject = stream; void v.play().catch(() => {}) } })
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} style={mirror ? { transform: 'scaleX(-1)' } : undefined} />
}
function Sound({ stream }: { stream: MediaStream }): JSX.Element {
  const ref = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    const a = ref.current; if (!a) return
    if (a.srcObject !== stream) a.srcObject = stream
    // Start it, and again whenever it is paused with sound to play (a track that arrived late, a device change).
    const go = () => { if (a.paused && stream.getAudioTracks().length) void a.play().catch(() => {}) }
    go(); const t = window.setInterval(go, 1000); return () => window.clearInterval(t)
  }, [stream])
  return <audio ref={ref} autoPlay />
}

/** The call window: a floating card over the app, whether the chat is open or not. */
/** The call window: a floating card over the app. Drag it by its top, shrink it to a pill, make it big, or pop the
 *  picture out into macOS's own small floating window (picture in picture, over every app). */
export function CallView({ calls, title, beside = false }: { calls: Calls; title: string; beside?: boolean }): JSX.Element | null {
  const { phase, incoming, peers, local, media, since, ended } = calls
  const [, tick] = useState(0)
  useEffect(() => { if (phase === 'idle') return; const id = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(id) }, [phase])
  const [big, setBig] = useState(false), [mini, setMini] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const card = useRef<HTMLDivElement>(null), remote = useRef<HTMLVideoElement | null>(null)
  useEffect(() => { if (phase === 'idle') { setPos(null); setMini(false); setBig(false) } }, [phase])
  const drag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button') || !card.current) return
    const r0 = card.current.getBoundingClientRect(), dx = e.clientX - r0.left, dy = e.clientY - r0.top
    const move = (m: MouseEvent) => setPos({ x: Math.max(4, Math.min(window.innerWidth - r0.width - 4, m.clientX - dx)), y: Math.max(4, Math.min(window.innerHeight - 60, m.clientY - dy)) })
    // Released outside the window (or the window lost focus mid-drag): stop too, so the card never stays stuck to the mouse.
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); window.removeEventListener('blur', up); document.removeEventListener('mouseleave', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); window.addEventListener('blur', up); document.addEventListener('mouseleave', up); e.preventDefault()
  }
  // Bigger, smaller or the window resized: the card is pulled back so all of it stays on screen.
  useEffect(() => {
    const fit = () => { const el = card.current; if (!el || !pos) return; const r = el.getBoundingClientRect()
      const x = Math.max(4, Math.min(window.innerWidth - r.width - 4, pos.x)), y = Math.max(4, Math.min(window.innerHeight - r.height - 4, pos.y))
      if (x !== pos.x || y !== pos.y) setPos({ x, y }) }
    fit(); const ro = new ResizeObserver(fit); if (card.current) ro.observe(card.current); window.addEventListener('resize', fit)
    return () => { ro.disconnect(); window.removeEventListener('resize', fit) }
  })
  const style = pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined
  if (phase === 'idle' && !incoming) return ended ? <div className={`call-toast${beside ? ' beside' : ''}`} role="status">{ended}</div> : null
  if (phase === 'incoming' && incoming) return <div className={`call card incoming${beside ? ' beside' : ''}`} data-state="incoming" role="dialog" aria-label={`Call from ${incoming.fromName}`}>
    <div className="call-who"><Avatar id={incoming.from} name={incoming.fromName} size={44} /><div><strong>{incoming.fromName}</strong><small>{incoming.video ? 'Video call' : 'Voice call'}</small></div></div>
    <div className="call-bar">
      <button className="call-btn end" title="Decline" aria-label="Decline" onClick={calls.decline}><CallIcon n="hang" /></button>
      <button className="call-btn ok" title="Answer with voice" aria-label="Answer" onClick={() => void calls.accept(false)}><CallIcon n="phone" /></button>
      <button className="call-btn ok" title="Answer with video" aria-label="Answer with video" onClick={() => void calls.accept(true)}><CallIcon n="video" /></button>
    </div>
  </div>
  const list = Object.entries(peers), live = list.some(([, p]) => p.state === 'connected')
  const shown = list.find(([, p]) => p.video && p.stream.getVideoTracks().length)
  // 20 s without a connection: say why instead of "Connecting…" forever.
  const stuck = !live && phase === 'live' && list.length > 0 && list.every(([, p]) => p.state === 'failed' || Date.now() - (p.since ?? Date.now()) > 20000)
  const status = phase === 'outgoing' ? 'Ringing…' : stuck ? 'Cannot connect: a VPN or this network blocks direct calls' : !live ? 'Connecting…' : list.some(([, p]) => p.state === 'disconnected') ? 'Reconnecting…' : since ? timer(Date.now() - since) : ''
  const name = list.length ? list.map(([, p]) => p.name.split(' ')[0]).join(', ') : title
  const pop = () => { const v = remote.current; if (!v) return; if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {}); else void v.requestPictureInPicture().catch(() => {}) }
  const sounds = list.map(([id, p]) => <Sound key={id} stream={p.stream} />)
  if (mini) return <div ref={card} className={`call card mini${beside && !pos ? ' beside' : ''}`} style={style} data-state={live ? 'live' : phase} role="dialog" aria-label="Call" onMouseDown={drag}>
    {sounds}
    {shown && <Media className="call-hidden" stream={shown[1].stream} muted ref={remote} />}
    <span className="call-dot" /><div className="call-mini-text"><strong>{name}</strong><small>{status}</small></div>
    <button className={`call-btn small${media.muted ? ' off' : ''}`} title={media.muted ? 'Unmute' : 'Mute'} aria-label={media.muted ? 'Unmute' : 'Mute'} onClick={calls.toggleMute}><CallIcon n={media.muted ? 'micOff' : 'mic'} s={15} /></button>
    <button className="call-btn small" title="Show the call" aria-label="Show the call" onClick={() => setMini(false)}><CallIcon n="expand" s={15} /></button>
    <button className="call-btn small end" title="Hang up" aria-label="Hang up" onClick={calls.hangup}><CallIcon n="hang" s={15} /></button>
  </div>
  return <div ref={card} className={`call card${beside && !pos ? ' beside' : ''}${big ? ' big' : ''}${shown ? ' has-video' : ''}`} style={style} data-state={live ? 'live' : phase} role="dialog" aria-label="Call">
    {sounds}
    <div className="call-top" onMouseDown={drag} title="Drag to move">
      <span className="call-grip" aria-hidden="true" />
      {shown && <button className="call-tool" title="Pop out into a small window over every app" aria-label="Pop out" onClick={pop}><CallIcon n="pop" s={14} /></button>}
      <button className="call-tool" title={big ? 'Smaller' : 'Bigger'} aria-label={big ? 'Smaller' : 'Bigger'} onClick={() => setBig(b => !b)}><CallIcon n={big ? 'shrink' : 'expand'} s={14} /></button>
      <button className="call-tool" title="Minimize" aria-label="Minimize" onClick={() => setMini(true)}><CallIcon n="min" s={14} /></button>
    </div>
    <div className="call-stage" onDoubleClick={() => setBig(b => !b)}>
      {shown ? <Media className="call-remote" stream={shown[1].stream} muted ref={remote} />
        : <div className="call-faces">{(list.length ? list.map(([id, p]) => [id, p.name] as const) : [['', title] as const]).map(([id, n]) => <Avatar key={id || n} id={id || n} name={n} size={56} />)}</div>}
      {local && media.video && <Media className="call-self" stream={local} muted mirror />}
    </div>
    <div className="call-who slim"><div><strong>{name}</strong>
      <small>{status}{list.some(([, p]) => p.muted) ? ' · muted' : ''}{shown?.[1].screen ? ' · sharing screen' : ''}</small></div></div>
    <div className="call-bar">
      <button className={`call-btn${media.muted ? ' off' : ''}`} title={media.muted ? 'Unmute' : 'Mute'} aria-label={media.muted ? 'Unmute' : 'Mute'} onClick={calls.toggleMute}><CallIcon n={media.muted ? 'micOff' : 'mic'} /></button>
      <button className={`call-btn${media.video ? '' : ' off'}`} title={media.video ? 'Turn camera off' : 'Turn camera on'} aria-label="Camera" onClick={() => void calls.toggleCamera()}><CallIcon n={media.video ? 'video' : 'videoOff'} /></button>
      <button className={`call-btn${media.screen ? ' on' : ''}`} title={media.screen ? 'Stop sharing' : 'Share your screen'} aria-label="Share screen" onClick={() => void calls.toggleScreen()}><CallIcon n="screen" /></button>
      <button className="call-btn end" title="Hang up" aria-label="Hang up" onClick={calls.hangup}><CallIcon n="hang" /></button>
    </div>
  </div>
}

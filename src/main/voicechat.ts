import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { writeFile, rm, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import type { WebContents } from 'electron'
import * as ptys from './pty'
import { cursor, readAppended, type Cursor } from './transcripts'
import { cacheDir, audioUrl, synthesize } from './voice'
import * as store from './store'
import workerSource from './voice_chat.py?raw'

/**
 * Talking to a tab: the renderer records what is said and stops at a pause, the worker (voice_chat.py) turns it
 * into text with Parakeet, the model LocalFlow uses, the text goes into the tab as if typed and submitted, and
 * what the agent writes back is read out by Kokoro as it arrives. Both models run on this Mac for free and stay
 * loaded only while a conversation is on.
 */

const VENV = join(homedir(), '.clipwave-term', 'tts')
const PYTHON = join(VENV, 'bin', 'python')
const SCRIPT = join(homedir(), '.clipwave-term', 'voice_chat.py')

let worker: ChildProcess | null = null
let ready: Promise<{ stt: boolean; tts: boolean }> | null = null
let seq = 0
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

export function installed(): boolean { return existsSync(PYTHON) }

function startWorker(): Promise<{ stt: boolean; tts: boolean }> {
  if (ready) return ready
  ready = new Promise((resolve, reject) => {
    if (!installed()) { reject(new Error('setup')); return }
    mkdirSync(join(homedir(), '.clipwave-term'), { recursive: true })
    writeFileSync(SCRIPT, workerSource)
    const child = spawn(PYTHON, ['-u', SCRIPT], { env: { ...process.env, VIRTUAL_ENV: VENV, PATH: `${join(VENV, 'bin')}:${process.env.PATH ?? ''}`, HF_HUB_DISABLE_PROGRESS_BARS: '1' }, stdio: ['pipe', 'pipe', 'ignore'] })
    worker = child
    let started = false
    createInterface({ input: child.stdout! }).on('line', line => {
      let m: any; try { m = JSON.parse(line) } catch { return }   // libraries print plain lines on stdout too
      if (m.ready) { started = true; resolve({ stt: !!m.stt, tts: !!m.tts }); return }
      const w = waiting.get(m.id); if (!w) return
      waiting.delete(m.id)
      if (m.error) w.reject(new Error(m.error)); else w.resolve(m)
    })
    child.on('exit', () => {
      worker = null; ready = null
      for (const w of waiting.values()) w.reject(new Error('The voice worker stopped'))
      waiting.clear()
      if (!started) reject(new Error('The voice worker did not start'))
    })
  })
  ready.catch(() => { ready = null })
  return ready
}

function ask(req: object, ms = 60_000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!worker?.stdin) { reject(new Error('The voice worker is not running')); return }
    const id = ++seq
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('The voice worker took too long')) }, ms)
    waiting.set(id, { resolve: v => { clearTimeout(timer); resolve(v) }, reject: e => { clearTimeout(timer); reject(e) } })
    worker.stdin.write(JSON.stringify({ id, ...req }) + '\n')
  })
}

export function stopWorker(): void {
  worker?.kill(); worker = null; ready = null
  for (const t of follows.values()) clearInterval(t.timer)
  follows.clear()
}

/** One-time setup on a Mac that has neither: Kokoro's environment, plus Parakeet. Uses the Hugging Face cache LocalFlow already filled. */
export function setup(): Promise<void> {
  return new Promise((resolve, reject) => {
    const sh = `set -e; command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH";
[ -x "${PYTHON}" ] || uv venv "${VENV}" --python 3.11; uv pip install --python "${PYTHON}" mlx-audio "misaki[en]" parakeet-mlx soundfile`
    const child = spawn('/bin/zsh', ['-lc', sh], { stdio: 'ignore' })
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('Setting up the voice failed')))
  })
}

export async function begin(): Promise<{ stt: boolean; tts: boolean }> {
  const r = await startWorker()
  if (!r.stt) {
    // Older setups have Kokoro only: add Parakeet once, then start again.
    stopWorker(); await setup(); return startWorker()
  }
  return r
}

export async function transcribe(samples: Float32Array): Promise<string> {
  await startWorker()
  await mkdir(cacheDir(), { recursive: true })
  const file = join(cacheDir(), `heard-${Date.now()}.f32`)
  await writeFile(file, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
  try { return String((await ask({ stt: file })).text ?? '') } finally { rm(file, { force: true }).catch(() => {}) }
}

export async function speak(text: string): Promise<string> {
  await mkdir(cacheDir(), { recursive: true })
  const out = join(cacheDir(), `said-${Date.now()}-${++seq}.wav`)
  try {
    const r = await startWorker()
    if (!r.tts) throw new Error('no local voice')
    await ask({ tts: text, out, voice: store.load().voice.localVoice || 'af_heart' })
    if ((await stat(out)).size > 4096) return audioUrl(out)
  } catch {}
  // The worker's voice is missing: the app's own engine ladder (ElevenLabs, Kokoro, then macOS say).
  const { path } = await synthesize(text, { ...store.load().voice, engine: store.load().voice.engine })
  return audioUrl(path)
}

/** Strips what does not read aloud: code, links, paths, markdown, the SPOKEN line (said separately when nothing else is). */
export function forEar(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*SPOKEN:.*$/gim, '')
    .replace(/^\s*VOICE:\s*off\s*$/gim, '')
    .replace(/`([^`]{1,40})`/g, '$1').replace(/`[^`]*`/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:~|\.{0,2})?\/[\w.\-/ ]*\/[\w.\-]+/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^#+\s*/gm, '').replace(/[*_>#]+/g, '').replace(/^\s*[-•]\s+/gm, '')
    .replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
}

/** Said with every spoken message, so the agent answers for the ear and can end the conversation for long work. */
const NOTE = ' [said by voice in TerminAI: answer briefly and conversationally, it is read aloud; if this needs long-running work, say so in one sentence and put VOICE: off on its own line]'

type Follow = { timer: ReturnType<typeof setInterval>; cur: Cursor; file: string; started: number }
const follows = new Map<string, Follow>()

/**
 * After a message is sent, reads the tab's transcript as it grows and hands each piece of text the agent writes
 * to the renderer, then says when the turn is over. Claude marks the end with a turn_duration line, Codex with
 * task_complete; a tab whose transcript cannot be found ends when its terminal goes quiet.
 */
export function send(wc: WebContents, tabId: string, text: string): void {
  const prev = follows.get(tabId); if (prev) { clearInterval(prev.timer); follows.delete(tabId) }
  const file = transcriptFor(tabId)
  const f: Follow = { timer: undefined as unknown as ReturnType<typeof setInterval>, cur: cursor(), file, started: Date.now() }
  follows.set(tabId, f)
  const emit = (ch: string, payload: object) => { if (!wc.isDestroyed()) wc.send(ch, { tabId, ...payload }) }
  const begin = async () => {
    // Everything written before the message is skipped: only the answer is read.
    if (file) { try { f.cur.at = (await stat(file)).size } catch {} }
    ptys.write(tabId, text + NOTE)
    await Promise.race([ptys.written(tabId), new Promise(r => setTimeout(r, 2e4))])
    await new Promise(r => setTimeout(r, 150))
    ptys.write(tabId, '\r')
    let saidSpoken = '', anything = false, ended = false, quietSince = 0
    f.timer = setInterval(async () => {
      if (ended) return
      const finish = () => { ended = true; clearInterval(f.timer); follows.delete(tabId); emit('voicechat:end', { spoken: anything ? '' : saidSpoken }) }
      if (file) {
        await readAppended(file, f.cur, line => {
          let d: any; try { d = JSON.parse(line) } catch { return }
          const texts: string[] = []
          if (d.type === 'assistant') for (const b of d.message?.content ?? []) { if (b?.type === 'text' && b.text) texts.push(b.text) }
          if (d.type === 'response_item' && d.payload?.type === 'message' && d.payload.role === 'assistant') for (const b of d.payload.content ?? []) { if (b?.text) texts.push(b.text) }
          for (const t of texts) {
            const sp = t.match(/^\s*SPOKEN:\s*(.+)$/im); if (sp) saidSpoken = sp[1].trim()
            const off = /^\s*VOICE:\s*off\s*$/im.test(t)
            const ear = forEar(t)
            if (ear) { anything = true; emit('voicechat:said', { text: ear, off }) }
            else if (off) emit('voicechat:said', { text: '', off })
          }
          if ((d.type === 'system' && d.subtype === 'turn_duration') || (d.type === 'event_msg' && d.payload?.type === 'task_complete')) finish()
        }, () => {})
      }
      if (ended) return
      // No transcript, or the end line never came (an interrupted turn): a quiet tab after a while is done.
      const st = ptys.statusOf(tabId)
      if (st === 'exited') { finish(); return }
      if (Date.now() - f.started > 8000 && (st === 'waiting' || st === 'ready' || st === 'question')) { quietSince ||= Date.now(); if (Date.now() - quietSince > (file ? 15000 : 4000)) finish() }
      else quietSince = 0
    }, 600)
  }
  begin().catch(() => emit('voicechat:end', { spoken: '' }))
}

export function cancel(tabId: string): void {
  const f = follows.get(tabId); if (f) { clearInterval(f.timer); follows.delete(tabId) }
}

let transcriptFor: (tabId: string) => string = () => ''
export function setTranscriptLookup(fn: (tabId: string) => string): void { transcriptFor = fn }

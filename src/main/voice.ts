import { app, type WebContents } from 'electron'
import { readFileSync, appendFileSync, watchFile, unwatchFile } from 'node:fs'
import { readFile, mkdir, access, stat, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import type { VoiceClip, VoicePrefs } from '../shared/types'
import * as say from './tts/say'
import * as eleven from './tts/elevenlabs'

/**
 * The file `~/.claude/speak-summary.sh` (a Stop hook) writes the last
 * `SPOKEN:` line into. We are a read-only consumer of it — the existing
 * hotkey in speak-file.sh keeps working whether or not this app is running.
 */
export const SPOKEN_FILE = join(homedir(), '.claude', 'spoken.txt')

let watching = false
let lastText = ''

/**
 * Set CLIPWAVE_TERM_DEBUG=1 to trace the summary pipeline to a file. The main
 * process's stdout is not reliably captured when the packaged app is launched
 * from Finder, so a file is the only trace that always survives.
 */
const DEBUG_LOG = process.env.CLIPWAVE_TERM_DEBUG ? '/tmp/clipwave-term-voice.log' : null

function trace(line: string): void {
  if (!DEBUG_LOG) return
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* tracing must never break the feature */
  }
}

export function cacheDir(): string {
  return join(app.getPath('userData'), 'voice')
}

/**
 * Audio is served over a custom scheme rather than file://. In dev the renderer
 * is an http:// origin, and Chromium refuses to load file:// subresources from
 * one — clips would synthesize correctly and then play silence.
 */
export const AUDIO_SCHEME = 'clipaudio'

export function audioUrl(path: string): string {
  return `${AUDIO_SCHEME}://clip/${basename(path)}`
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Cache key is the text plus the engine settings that change how it sounds, so
 * switching voice re-synthesizes but replaying the same line is instant.
 */
function cacheKey(text: string, prefs: VoicePrefs): string {
  const voice = prefs.engine === 'elevenlabs' ? prefs.elevenVoiceId : prefs.sayVoice
  return createHash('sha1').update(`${prefs.engine}:${voice}:${text}`).digest('hex').slice(0, 16)
}

export async function synthesize(
  text: string,
  prefs: VoicePrefs,
): Promise<{ path: string; engine: 'say' | 'elevenlabs' }> {
  await mkdir(cacheDir(), { recursive: true })

  const wantEleven = prefs.engine === 'elevenlabs' && (await eleven.hasKey())
  const key = cacheKey(text, prefs)
  const ext = wantEleven ? 'mp3' : 'wav'
  const out = join(cacheDir(), `${key}.${ext}`)

  if (await exists(out)) {
    return { path: out, engine: wantEleven ? 'elevenlabs' : 'say' }
  }

  if (wantEleven) {
    try {
      await eleven.synthesize(text, out, prefs.elevenVoiceId)
      return { path: out, engine: 'elevenlabs' }
    } catch (err) {
      // Degrade the voice, don't lose the clip.
      console.warn('[voice] ElevenLabs failed, falling back to say:', err)
    }
  }

  const fallback = join(cacheDir(), `${cacheKey(text, { ...prefs, engine: 'say' })}.wav`)
  if (!(await exists(fallback))) {
    await say.synthesize(text, fallback, prefs.sayVoice)
    await assertHasAudio(fallback)
  }
  return { path: fallback, engine: 'say' }
}

/**
 * A WAV that is only a header plays as silence, and once cached it would keep
 * playing as silence forever. Refuse to cache one.
 */
async function assertHasAudio(path: string): Promise<void> {
  const { size } = await stat(path)
  if (size <= 4096) {
    await rm(path, { force: true })
    throw new Error(`synthesis produced no audio (${size} bytes)`)
  }
}

export function toClip(
  text: string,
  path: string,
  engine: 'say' | 'elevenlabs',
  tabId: string | null,
): VoiceClip {
  return {
    id: randomUUID(),
    text,
    path,
    url: audioUrl(path),
    engine,
    createdAt: Date.now(),
    tabId,
  }
}

async function onSpokenChanged(
  wc: WebContents,
  getPrefs: () => VoicePrefs,
  getActiveTab: () => string | null,
): Promise<void> {
  const prefs = getPrefs()
  if (!prefs.enabled) return

  let text = ''
  try {
    text = (await readFile(SPOKEN_FILE, 'utf8')).trim()
  } catch {
    return
  }

  // fs.watch fires more than once per write on macOS, and the hook rewrites the
  // file even when the summary is unchanged.
  if (!text || text === lastText) return
  lastText = text

  trace(`change detected: ${text.slice(0, 60)}`)

  try {
    const { path, engine } = await synthesize(text, prefs)
    if (wc.isDestroyed()) {
      trace('renderer gone, dropping clip')
      return
    }
    wc.send('voice:clip', toClip(text, path, engine, getActiveTab()))
    trace(`sent clip (${engine}) ${path}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    trace(`FAILED: ${message}`)
    if (!wc.isDestroyed()) wc.send('voice:error', { message })
  }
}

export function startWatching(
  wc: WebContents,
  getPrefs: () => VoicePrefs,
  getActiveTab: () => string | null,
): void {
  stopWatching()

  // Seed with whatever is already there so the first real change is detected as
  // a change, rather than replaying the previous session's last summary.
  try {
    lastText = readFileSync(SPOKEN_FILE, 'utf8').trim()
  } catch {
    lastText = ''
  }

  // Deliberately stat-polling rather than fs.watch. fs.watch on a single file is
  // unreliable on macOS — it misses events when the file is truncated and
  // rewritten in place, which is exactly what the `printf > spoken.txt` in
  // speak-summary.sh does. watchFile also keeps working when the file does not
  // exist yet, so a first-ever summary is picked up without special casing.
  watchFile(SPOKEN_FILE, { interval: 700 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return
    void onSpokenChanged(wc, getPrefs, getActiveTab)
  })

  watching = true
  trace(`watching ${SPOKEN_FILE}, seeded with ${lastText.length} chars`)
}

export function stopWatching(): void {
  if (watching) unwatchFile(SPOKEN_FILE)
  watching = false
}

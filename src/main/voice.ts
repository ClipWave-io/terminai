import { app, type WebContents } from 'electron'
import { appendFileSync } from 'node:fs'
import { readFile, mkdir, access, stat, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import type { VoiceClip, VoiceEngine, VoicePrefs } from '../shared/types'
import * as say from './tts/say'
import * as eleven from './tts/elevenlabs'
import * as local from './tts/local'

/**
 * `~/.claude/speak-summary.sh` (a Stop hook) writes the last `SPOKEN:` line
 * into `~/.claude/spoken.txt` unconditionally, so the pre-existing on-demand
 * hotkey (speak-file.sh) keeps working whether or not this app is running.
 * But that file is a single global path shared by every Claude Code session
 * on the machine — an unrelated session finishing a turn elsewhere would
 * clobber it and get narrated here instead. The hook also writes a copy keyed
 * by a hash of the session's cwd into SPOKEN_DIR; this app only reacts to the
 * ones matching a cwd it actually has a tab open on.
 */
export const SPOKEN_DIR = join(homedir(), '.claude', 'spoken')

/** Must match the hashing done in speak-summary.sh (`shasum -a 1 | cut -c1-16`). */
export function hashCwd(cwd: string): string {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 16)
}

function pathForCwd(cwd: string): string {
  return join(SPOKEN_DIR, `${hashCwd(cwd)}.txt`)
}

interface OpenTab {
  id: string
  cwd: string
}

let pollTimer: ReturnType<typeof setInterval> | null = null
/** path -> last-seen stat, so a poll tick can tell a rewrite from a no-op. */
const seenStat = new Map<string, { mtimeMs: number; size: number }>()
/** path -> last text spoken from it, to dedupe the hook rewriting unchanged content. */
const lastTextByPath = new Map<string, string>()

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
  const voice =
    prefs.engine === 'elevenlabs'
      ? prefs.elevenVoiceId
      : prefs.engine === 'local'
        ? prefs.localVoice
        : prefs.sayVoice
  return createHash('sha1').update(`${prefs.engine}:${voice}:${text}`).digest('hex').slice(0, 16)
}

/**
 * Engine ladder: whatever the user picked, then degrade rather than lose the
 * clip. `say` is always last because it is the only one that cannot fail —
 * no key, no model, no network.
 */
export async function synthesize(
  text: string,
  prefs: VoicePrefs,
): Promise<{ path: string; engine: VoiceEngine }> {
  await mkdir(cacheDir(), { recursive: true })

  const wantEleven = prefs.engine === 'elevenlabs' && (await eleven.hasKey())
  const wantLocal = prefs.engine === 'local' && local.isAvailable()
  const key = cacheKey(text, prefs)
  const ext = wantEleven ? 'mp3' : 'wav'
  const out = join(cacheDir(), `${key}.${ext}`)

  if (await exists(out)) {
    return { path: out, engine: wantEleven ? 'elevenlabs' : wantLocal ? 'local' : 'say' }
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

  if (wantLocal) {
    try {
      await local.synthesize(text, out, prefs.localVoice)
      await assertHasAudio(out)
      return { path: out, engine: 'local' }
    } catch (err) {
      console.warn('[voice] local Kokoro failed, falling back to say:', err)
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
  engine: VoiceEngine,
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

async function speakFrom(
  wc: WebContents,
  prefs: VoicePrefs,
  path: string,
  tabId: string,
): Promise<void> {
  let text = ''
  try {
    text = (await readFile(path, 'utf8')).trim()
  } catch {
    return
  }

  // The hook rewrites the file even when the summary is unchanged.
  if (!text || lastTextByPath.get(path) === text) return
  lastTextByPath.set(path, text)

  trace(`change detected (tab ${tabId}): ${text.slice(0, 60)}`)

  try {
    const { path: clipPath, engine } = await synthesize(text, prefs)
    if (wc.isDestroyed()) {
      trace('renderer gone, dropping clip')
      return
    }
    wc.send('voice:clip', toClip(text, clipPath, engine, tabId))
    trace(`sent clip (${engine}) ${clipPath}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    trace(`FAILED: ${message}`)
    if (!wc.isDestroyed()) wc.send('voice:error', { message })
  }
}

/**
 * One tick: for every currently open tab, check whether its per-cwd summary
 * file changed since last tick, and if so speak it — attributed to that exact
 * tab. Tabs whose cwd has no summary file yet, or whose file belongs to some
 * other machine-wide Claude Code session, are silently untouched.
 */
async function poll(
  wc: WebContents,
  getPrefs: () => VoicePrefs,
  getOpenTabs: () => OpenTab[],
): Promise<void> {
  const prefs = getPrefs()
  const tabs = getOpenTabs()

  const livePaths = new Set(tabs.map((t) => pathForCwd(t.cwd)))
  for (const path of [...seenStat.keys()]) {
    if (!livePaths.has(path)) {
      seenStat.delete(path)
      lastTextByPath.delete(path)
    }
  }

  for (const tab of tabs) {
    const path = pathForCwd(tab.cwd)
    let s
    try {
      s = await stat(path)
    } catch {
      continue
    }

    const prev = seenStat.get(path)
    seenStat.set(path, { mtimeMs: s.mtimeMs, size: s.size })

    if (!prev) continue // first sighting: seed silently, don't replay old text
    if (prev.mtimeMs === s.mtimeMs && prev.size === s.size) continue
    if (!prefs.enabled) continue

    await speakFrom(wc, prefs, path, tab.id)
  }
}

export function startWatching(
  wc: WebContents,
  getPrefs: () => VoicePrefs,
  getOpenTabs: () => OpenTab[],
): void {
  stopWatching()
  pollTimer = setInterval(() => void poll(wc, getPrefs, getOpenTabs), 700)
  trace(`watching ${SPOKEN_DIR} for open tabs' cwds`)
}

export function stopWatching(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  seenStat.clear()
  lastTextByPath.clear()
}

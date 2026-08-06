import { writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const API = 'https://api.elevenlabs.io/v1'
const API_V2 = 'https://api.elevenlabs.io/v2'

/** Keychain item the app reads its key from. See README for how to set it. */
export const KEYCHAIN_SERVICE = 'clipwave-term-elevenlabs'

let cachedKey: string | null | undefined

/**
 * Resolve the API key: environment first (handy in `npm run dev`), then the
 * login Keychain. The Keychain is the one that matters — an app launched from
 * the Dock inherits none of the shell environment, so a key that lives only in
 * a .env or .zshrc is invisible to the packaged build.
 */
export async function getKey(): Promise<string | null> {
  if (cachedKey !== undefined) return cachedKey

  const fromEnv = process.env.ELEVENLABS_API_KEY?.trim()
  if (fromEnv) {
    cachedKey = fromEnv
    return cachedKey
  }

  try {
    const { stdout } = await run(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 10_000 },
    )
    cachedKey = stdout.trim() || null
  } catch {
    // No such item, or the user declined the Keychain prompt.
    cachedKey = null
  }
  return cachedKey
}

/** Call after the key changes so the next request re-resolves it. */
export function forgetKey(): void {
  cachedKey = undefined
}

export async function hasKey(): Promise<boolean> {
  return (await getKey()) !== null
}

export interface ElevenVoice {
  id: string
  name: string
  category: string
  description: string
}

/** The user's own ElevenLabs library, for the settings dropdown. */
export async function listVoices(): Promise<ElevenVoice[]> {
  const key = await getKey()
  if (!key) return []

  const res = await fetch(`${API_V2}/voices?page_size=100`, {
    headers: { 'xi-api-key': key },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}`)

  const body = (await res.json()) as {
    voices?: { voice_id: string; name: string; category?: string; labels?: Record<string, string> }[]
  }

  return (body.voices ?? []).map((v) => {
    const l = v.labels ?? {}
    return {
      id: v.voice_id,
      name: v.name,
      category: v.category ?? '',
      description: [l.gender, l.accent, l.description].filter(Boolean).join(' · '),
    }
  })
}

/**
 * Returns mp3, which Chromium plays natively. Callers fall back to `say` when
 * this throws — a dead network should degrade the voice, not lose the clip.
 */
export async function synthesize(text: string, outPath: string, voiceId: string): Promise<void> {
  const key = await getKey()
  if (!key) throw new Error('no ElevenLabs API key (set one in Settings)')

  const res = await fetch(`${API}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'content-type': 'application/json',
      accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      // multilingual_v2 over turbo: a one-sentence summary is short enough that
      // the extra latency is invisible, and the quality gap is not.
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
    signal: AbortSignal.timeout(25_000),
  })

  if (!res.ok) {
    throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }

  await writeFile(outPath, Buffer.from(await res.arrayBuffer()))
}

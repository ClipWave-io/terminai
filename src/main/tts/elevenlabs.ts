import { writeFile } from 'node:fs/promises'

const ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech'

export function hasKey(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY)
}

/**
 * Optional engine. Returns mp3, which Chromium plays natively.
 * Callers are expected to fall back to `say` when this throws — a dead network
 * should degrade the voice, not lose the clip.
 */
export async function synthesize(text: string, outPath: string, voiceId: string): Promise<void> {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set')

  const ctl = new AbortController()
  const timeout = setTimeout(() => ctl.abort(), 20_000)

  try {
    const res = await fetch(`${ENDPOINT}/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: ctl.signal,
    })

    if (!res.ok) {
      throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }

    await writeFile(outPath, Buffer.from(await res.arrayBuffer()))
  } finally {
    clearTimeout(timeout)
  }
}

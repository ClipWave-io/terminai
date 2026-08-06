import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { app } from 'electron'

/**
 * Free, on-device TTS: Kokoro-82M running on Apple MLX. No key, no network
 * after the first model download, no per-character cost.
 *
 * Installed out-of-tree by scripts/setup-local-tts.sh so the app never carries
 * a Python runtime, and the whole thing can be removed with one rm -rf.
 */

const VENV = join(homedir(), '.clipwave-term', 'tts')
const PYTHON = join(VENV, 'bin', 'python')

/** Ships inside the asar in a packaged build, and next to the source in dev. */
function scriptPath(): string {
  const packaged = join(process.resourcesPath ?? '', 'tts_local.py')
  if (app.isPackaged && existsSync(packaged)) return packaged
  return join(__dirname, '../../scripts/tts_local.py')
}

export function isAvailable(): boolean {
  return existsSync(PYTHON) && existsSync(scriptPath())
}

/** Kokoro's built-in speakers. 'a' = American English. */
export const VOICES = [
  { id: 'af_heart', label: 'Heart — warm female' },
  { id: 'af_bella', label: 'Bella — bright female' },
  { id: 'af_nicole', label: 'Nicole — soft female' },
  { id: 'af_sarah', label: 'Sarah — neutral female' },
  { id: 'am_adam', label: 'Adam — deep male' },
  { id: 'am_michael', label: 'Michael — neutral male' },
  { id: 'bf_emma', label: 'Emma — British female' },
  { id: 'bm_george', label: 'George — British male' },
]

export async function synthesize(text: string, outPath: string, voice: string): Promise<void> {
  if (!isAvailable()) {
    throw new Error('local TTS not installed — run scripts/setup-local-tts.sh')
  }

  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      PYTHON,
      [scriptPath(), outPath, voice || 'af_heart'],
      {
        // misaki shells out to `uv pip install` for its spaCy model on first use
        // and fails outright if it cannot see an active virtualenv. Handing it
        // one is the difference between working and silently producing nothing.
        env: {
          ...process.env,
          VIRTUAL_ENV: VENV,
          PATH: `${join(VENV, 'bin')}:${process.env.PATH ?? ''}`,
        },
        // First call in a session loads the model; later ones are ~1s.
        timeout: 120_000,
        maxBuffer: 4 << 20,
      },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`local TTS failed: ${String(stderr).slice(-300) || err.message}`))
          return
        }
        resolve()
      },
    )
    child.stdin?.end(text)
  })
}

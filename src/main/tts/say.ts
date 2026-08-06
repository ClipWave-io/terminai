import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * macOS `say` writing to a file rather than straight to the speakers. Going via
 * a file is what makes replay, scrubbing and "save a copy" free — and it means
 * the renderer owns playback, so pausing actually works.
 *
 * WAVE/LEI16 rather than `say`'s default AIFF: Chromium's <audio> will not
 * decode AIFF, so an .aiff clip would synthesize fine and then play silence.
 */
export async function synthesize(text: string, outPath: string, voice: string): Promise<void> {
  // The text goes in argv, NOT down stdin. `say -f -` blocks forever waiting on
  // a stdin that never closes, leaving a 4KB header-only file behind. execFile
  // spawns without a shell, so quotes, backticks and newlines need no escaping;
  // the one hazard is a leading dash being read as a flag.
  const safe = text.startsWith('-') ? ` ${text}` : text

  await run(
    'say',
    ['-v', voice, '-o', outPath, '--file-format=WAVE', '--data-format=LEI16@22050', safe],
    // A summary is one sentence; anything past this is a wedged process.
    { timeout: 30_000, maxBuffer: 1 << 20 },
  )
}

export async function availableVoices(): Promise<string[]> {
  try {
    const { stdout } = await run('say', ['-v', '?'], { timeout: 10_000 })
    return stdout
      .split('\n')
      .map((line) => line.match(/^(\S+(?: \S+)*?)\s{2,}/)?.[1] ?? '')
      .filter(Boolean)
  } catch {
    return []
  }
}

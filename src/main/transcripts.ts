import { open, stat } from 'node:fs/promises'

/**
 * Reading Claude Code and Codex transcripts (JSONL) on the main process without ever holding it: the first time in
 * full, after that only what was appended, a slice at a time with a turn of the event loop between slices, so
 * typing and the window stay responsive. Transcripts reach hundreds of MB, and the sharing bridge reads them every
 * 5 seconds, the work log every 10 minutes: read whole and parsed in one go, they froze the app for seconds.
 */
const SLICE = 2 << 20
const pause = () => new Promise<void>(resolve => setImmediate(resolve))

/** Where a reader of one file stopped: the next byte to read and an unfinished last line. */
export type Cursor = { at: number; rest: Buffer; busy?: Promise<void> }
export const cursor = (): Cursor => ({ at: 0, rest: Buffer.alloc(0) })

/**
 * Hands each whole line added to `file` since the cursor to `line`. A line still being written waits for the next
 * call (a newline byte never sits inside a UTF-8 character). A file that shrank was rewritten: `reset` is called
 * and it is read again from the start. One read at a time per cursor.
 */
export async function readAppended(file: string, cur: Cursor, line: (text: string) => void, reset: () => void): Promise<void> {
  while (cur.busy) await cur.busy
  let done = () => {}
  cur.busy = new Promise<void>(resolve => { done = resolve })
  try {
    let size = 0
    try { size = (await stat(file)).size } catch { return }
    if (size < cur.at) { cur.at = 0; cur.rest = Buffer.alloc(0); reset() }
    if (size === cur.at) return
    const handle = await open(file, 'r').catch(() => null)
    if (!handle) return
    try {
      while (cur.at < size) {
        const chunk = Buffer.alloc(Math.min(SLICE, size - cur.at))
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, cur.at)
        if (!bytesRead) break
        const all = cur.rest.length ? Buffer.concat([cur.rest, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
        const end = all.lastIndexOf(10) + 1
        cur.at += bytesRead; cur.rest = Buffer.from(all.subarray(end))
        for (const text of all.toString('utf8', 0, end).split('\n')) if (text) line(text)
        await pause()
      }
    } finally { await handle.close().catch(() => {}) }
  } finally { cur.busy = undefined; done() }
}

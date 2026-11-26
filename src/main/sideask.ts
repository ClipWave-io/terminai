import { stat } from 'node:fs/promises'
import * as ptys from './pty'
import { cursor, readAppended } from './transcripts'

/**
 * `terminai ask <tab> <question>`: a side conversation (opened for a partner's request) asks the conversation it was
 * opened beside. The question waits until that conversation is free (never typed into a running turn), its answer is
 * read from the transcript when the turn ends, and it is typed back into the side conversation once that one is free.
 * One question at a time per conversation; the command itself returns at once.
 */
const queues = new Map<string, Promise<void>>()
/** Per asking conversation: questions whose answer has not been typed back yet (a requests session takes no new request meanwhile). */
const open = new Map<string, number>()
export const asksPending = (from: string): number => open.get(from) ?? 0
const delay = (ms: number) => new Promise(r => setTimeout(r, ms))
const LIMIT = 3 * 60 * 60 * 1000

function free(id: string): boolean {
  return ptys.liveIds().includes(id) && ptys.agentOf(id).alive && ptys.statusOf(id) === 'waiting' && !ptys.atShellPrompt(id)
}
async function untilFree(id: string, wake?: (id: string) => unknown): Promise<boolean> {
  const t = Date.now()
  for (let woke = false; Date.now() - t < LIMIT; await delay(1000)) {
    if (!ptys.liveIds().includes(id)) return false
    if (!ptys.agentOf(id).alive && !woke) { woke = true; await wake?.(id) }
    // Free for two checks in a row: a turn that just ended can still be writing.
    if (free(id)) { await delay(1500); if (free(id)) return true }
  }
  return false
}
async function type(id: string, text: string): Promise<void> {
  ptys.write(id, `\x1b[200~${text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')}\x1b[201~`)
  await Promise.race([ptys.written(id), delay(5000)]); await delay(200)
  ptys.write(id, '\r')
}
/** The assistant's text of the turn that follows, from the transcript; without one, the terminal's last lines. */
async function answerOf(id: string, file: string, from: number): Promise<string> {
  const cur = cursor(); cur.at = from
  const texts: string[] = []
  const started = Date.now()
  let ended = false, quietSince = 0
  while (!ended && Date.now() - started < LIMIT) {
    await delay(1000)
    if (file) await readAppended(file, cur, line => {
      let d: any; try { d = JSON.parse(line) } catch { return }
      if (d.type === 'assistant') for (const b of d.message?.content ?? []) { if (b?.type === 'text' && b.text) texts.push(b.text) }
      if (d.type === 'response_item' && d.payload?.type === 'message' && d.payload.role === 'assistant') for (const b of d.payload.content ?? []) { if (b?.text) texts.push(b.text) }
      if ((d.type === 'system' && d.subtype === 'turn_duration') || (d.type === 'event_msg' && d.payload?.type === 'task_complete')) ended = true
    }, () => {})
    const st = ptys.statusOf(id)
    if (st === 'exited' || !ptys.liveIds().includes(id)) break
    if (Date.now() - started > 8000 && (st === 'waiting' || st === 'question')) { quietSince ||= Date.now(); if (Date.now() - quietSince > (file ? 15000 : 4000)) break }
    else quietSince = 0
  }
  const said = texts.join('\n\n').replace(/^\s*SPOKEN:.*$/gim, '').trim()
  if (said) return said.slice(-20000)
  // eslint-disable-next-line no-control-regex
  return ptys.bufferOf(id).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b./g, '').split('\n').slice(-40).join('\n').trim()
}

export function askTab(o: { from: string; to: string; question: string; fromName: string; toName: string; transcript: (id: string) => string; wake?: (id: string) => unknown }): { queued: true; note: string } {
  const { from, to } = o
  if (from === to) throw Error('That is this conversation.')
  if (!ptys.liveIds().includes(to) || !ptys.agentOf(to).kind) throw Error('No Claude Code or Codex conversation in that tab.')
  const busy = !free(to)
  open.set(from, asksPending(from) + 1)
  const run = async () => {
    if (!await untilFree(to, o.wake)) return
    const file = o.transcript(to)
    let at = 0; if (file) { try { at = (await stat(file)).size } catch {} }
    await type(to, `[TerminAI · question from the side conversation "${o.fromName}" (tab ${from}), which is answering a request for you so this conversation is not interrupted. Answer it briefly from what you know here; your answer is passed back to it automatically, do not run terminai send or team reply for it.] ${o.question}`)
    const answer = await answerOf(to, file, at)
    if (!await untilFree(from, o.wake)) return
    await type(from, `[TerminAI · answer from the conversation "${o.toName}" (tab ${to}) to your question] ${answer || '(no answer)'}`)
  }
  const next = (queues.get(to) ?? Promise.resolve()).then(run).catch(err => console.warn('[sideask]', err))
    .finally(() => { const n = asksPending(from) - 1; if (n > 0) open.set(from, n); else open.delete(from) })
  queues.set(to, next)
  return { queued: true, note: busy ? `That conversation is busy: your question is typed in when its turn ends, and the answer is typed back here. Stop your turn now and wait for it.` : `Asked. The answer is typed back here when it comes: stop your turn now and wait for it.` }
}

import { app, safeStorage } from 'electron'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Connections to the person's own bots, for now Grok Bot: its routine's webhook (URL, key, header), kept on this Mac
 * only and encrypted with the keychain, never synced or shown again after saving. `terminai ask-grok` posts a question
 * there; the bot answers into the asking tab through its TerminAI bot key (POST /agent), which arrives as a message.
 */
type Grok = { url: string; key: string; header: string; agent: string }
type Status = { ok: boolean; at: string; error?: string }
export type GrokPublic = { configured: boolean; host: string; agent: string; status: Status | null }
const file = () => join(app.getPath('userData'), 'connections.enc')
let grok: Grok | null = null, loaded = false, status: Status | null = null

async function load(): Promise<Grok | null> {
  if (loaded) return grok
  loaded = true
  try { if (safeStorage.isEncryptionAvailable()) grok = JSON.parse(safeStorage.decryptString(await readFile(file()))).grok ?? null } catch { grok = null }
  return grok
}
async function store(): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Unlock your macOS keychain first.')
  await writeFile(`${file()}.tmp`, safeStorage.encryptString(JSON.stringify({ grok })), { mode: 0o600 }); await rename(`${file()}.tmp`, file())
}
export async function grokPublic(): Promise<GrokPublic> {
  const g = await load()
  return { configured: !!g, host: g ? new URL(g.url).host : '', agent: g?.agent ?? 'general', status }
}
export async function grokSave(input: unknown): Promise<GrokPublic> {
  const v = (input ?? {}) as Record<string, unknown>
  if (v.clear === true) { grok = null; loaded = true; status = null; await store(); return grokPublic() }
  const old = await load()
  const url = String(v.url ?? old?.url ?? '').trim(), key = String(v.key ?? '').trim() || old?.key || '', header = String(v.header ?? old?.header ?? '').trim()
  let parsed: URL; try { parsed = new URL(url) } catch { throw new Error('Paste the Webhook URL from Grok Bot.') }
  // Test builds may use a webhook on this Mac (UI tests); the installed app never does.
  const local = !!process.env.TERMINAI_TEST_BUILD && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !local) throw new Error('The Webhook URL must start with https://')
  if (!key && !header) throw new Error('Paste the Webhook key, or the Authorization header.')
  if (key.length > 4000 || header.length > 4000) throw new Error('That value is too long.')
  grok = { url: parsed.toString(), key, header, agent: String(v.agent ?? old?.agent ?? 'general').trim().slice(0, 60) || 'general' }
  loaded = true; status = null; await store()
  return grokPublic()
}
/** The header as Grok Bot shows it ("Authorization: Bearer …", maybe with <key> to fill in); just the key means a Bearer token. */
function headers(g: Grok): Record<string, string> {
  const out: Record<string, string> = { 'Content-Type': 'application/json' }
  const h = g.header.replace(/<(webhook )?key>/gi, g.key)
  const m = /^([A-Za-z0-9-]+)\s*:\s*(.+)$/.exec(h)
  if (m) out[m[1]] = m[2]
  else if (h) out.Authorization = /^(Bearer|Basic|Token)\s/i.test(h) ? h : `Bearer ${h}`
  else out.Authorization = `Bearer ${g.key}`
  if (g.key && m && !h.includes(g.key)) out['X-Webhook-Key'] = g.key
  return out
}
async function post(body: object): Promise<void> {
  const g = await load()
  if (!g) throw new Error('Grok Bot is not connected: Settings › Connections › Grok Bot.')
  try {
    const r = await fetch(g.url, { method: 'POST', headers: headers(g), body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error(`Grok Bot answered ${r.status}.`)
    status = { ok: true, at: new Date().toISOString() }
  } catch (e) {
    status = { ok: false, at: new Date().toISOString(), error: e instanceof Error ? e.message.slice(0, 160) : String(e) }
    throw new Error(status.error)
  }
}
export async function grokTest(): Promise<GrokPublic> {
  await post({ question: "ping, reply 'pong'", from: 'TerminAI settings test', session_id: null }).catch(() => {})
  return grokPublic()
}
/** From a tab: returns at once; the answer comes later into that tab as a message from the bot. */
export async function grokAsk(question: unknown, agent: unknown, from: string, sessionId: string | null): Promise<{ ok: true; note: string }> {
  if (typeof question !== 'string' || !question.trim() || question.length > 20000) throw new Error('usage: terminai ask-grok "<question>" [--agent <name>]')
  const g = await load()
  await post({ question: question.trim(), from, session_id: sessionId, agent: typeof agent === 'string' && agent.trim() ? agent.trim() : g?.agent ?? 'general' })
  return { ok: true, note: sessionId ? 'Sent. The answer arrives in this session as a message from the bot; do not wait for it in a loop.' : 'Sent, but this tab is Off the record or not synced yet, so the bot cannot answer into it: it will answer in its own chat.' }
}

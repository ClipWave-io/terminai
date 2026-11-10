import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The person's own bots (Grok Bot and the like), as many as they like: each one's routine webhook (URL, key, header),
 * kept on this Mac only and encrypted with the keychain, never synced or shown again after saving, plus the TerminAI
 * bot key it answers with (its id on the server). `terminai ask-grok [--bot <name>]` posts a question to one; it
 * answers into the asking tab with its bot key (POST /agent), which arrives there as a message.
 */
type Bot = { id: string; name: string; keyId?: string; url: string; key: string; header: string; agent: string; isDefault?: boolean }
type Status = { ok: boolean; at: string; error?: string }
export type BotPublic = { id: string; name: string; keyId?: string; host: string; agent: string; isDefault: boolean; status: Status | null }
const file = () => join(app.getPath('userData'), 'connections.enc')
let bots: Bot[] = [], loaded = false
const status = new Map<string, Status>()

async function load(): Promise<Bot[]> {
  if (loaded) return bots
  loaded = true
  try {
    if (!safeStorage.isEncryptionAvailable()) return bots
    const v = JSON.parse(safeStorage.decryptString(await readFile(file())))
    // Before several bots: one Grok Bot under `grok`.
    bots = Array.isArray(v.bots) ? v.bots : v.grok ? [{ id: randomUUID(), name: 'Grok Bot', ...v.grok, isDefault: true }] : []
  } catch { bots = [] }
  return bots
}
async function store(): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Unlock your macOS keychain first.')
  await writeFile(`${file()}.tmp`, safeStorage.encryptString(JSON.stringify({ bots })), { mode: 0o600 }); await rename(`${file()}.tmp`, file())
}
const pub = (b: Bot): BotPublic => ({ id: b.id, name: b.name, keyId: b.keyId, host: b.url ? new URL(b.url).host : '', agent: b.agent, isDefault: !!b.isDefault, status: status.get(b.id) ?? null })
export async function botList(): Promise<BotPublic[]> { return (await load()).map(pub) }

/** Adds or changes a bot; a field left empty keeps what was saved (the webhook key is never sent back). */
export async function botSave(input: unknown): Promise<BotPublic[]> {
  const v = (input ?? {}) as Record<string, unknown>
  await load()
  const old = typeof v.id === 'string' ? bots.find(b => b.id === v.id) : undefined
  const name = String(v.name ?? old?.name ?? '').trim().slice(0, 60)
  if (!name) throw new Error('Give the bot a name.')
  if (bots.some(b => b !== old && b.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a bot named ${name}.`)
  const url = String(v.url ?? old?.url ?? '').trim(), key = String(v.key ?? '').trim() || old?.key || '', header = String(v.header ?? '').trim() || old?.header || ''
  if (url) {
    let parsed: URL; try { parsed = new URL(url) } catch { throw new Error('Paste the Webhook URL from the bot.') }
    // Test builds may use a webhook on this Mac (UI tests); the installed app never does.
    const local = !!process.env.TERMINAI_TEST_BUILD && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
    if (parsed.protocol !== 'https:' && !local) throw new Error('The Webhook URL must start with https://')
    if (!key && !header) throw new Error('Paste the Webhook key, or the Authorization header.')
  }
  if (key.length > 4000 || header.length > 4000) throw new Error('That value is too long.')
  const next: Bot = { id: old?.id ?? randomUUID(), name, keyId: typeof v.keyId === 'string' ? v.keyId : old?.keyId, url: url ? new URL(url).toString() : '', key, header,
    agent: String(v.agent ?? old?.agent ?? 'general').trim().slice(0, 60) || 'general', isDefault: old?.isDefault ?? !bots.some(b => b.isDefault) }
  bots = old ? bots.map(b => b === old ? next : b) : [...bots, next]
  if (v.isDefault === true) bots = bots.map(b => ({ ...b, isDefault: b.id === next.id }))
  status.delete(next.id); await store()
  return bots.map(pub)
}
export async function botRemove(id: unknown): Promise<BotPublic[]> {
  await load()
  const gone = bots.find(b => b.id === id); bots = bots.filter(b => b.id !== id)
  if (gone?.isDefault && bots[0]) bots[0].isDefault = true
  await store(); return bots.map(pub)
}
/** The header as the bot shows it ("Authorization: Bearer …", maybe with <key> to fill in); just the key means a Bearer token. */
function headers(b: Bot): Record<string, string> {
  const out: Record<string, string> = { 'Content-Type': 'application/json' }
  const h = b.header.replace(/<(webhook )?key>/gi, b.key)
  const m = /^([A-Za-z0-9-]+)\s*:\s*(.+)$/.exec(h)
  if (m) out[m[1]] = m[2]
  else if (h) out.Authorization = /^(Bearer|Basic|Token)\s/i.test(h) ? h : `Bearer ${h}`
  else out.Authorization = `Bearer ${b.key}`
  if (b.key && m && !h.includes(b.key)) out['X-Webhook-Key'] = b.key
  return out
}
async function post(b: Bot, body: object): Promise<void> {
  if (!b.url) throw new Error(`${b.name} has no webhook yet: Settings › Connections › ${b.name} › Edit.`)
  try {
    const r = await fetch(b.url, { method: 'POST', headers: headers(b), body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error(`${b.name} answered ${r.status}.`)
    status.set(b.id, { ok: true, at: new Date().toISOString() })
  } catch (e) {
    const s = { ok: false, at: new Date().toISOString(), error: e instanceof Error ? e.message.slice(0, 160) : String(e) }
    status.set(b.id, s); throw new Error(s.error)
  }
}
export async function botTest(id: unknown): Promise<BotPublic[]> {
  const b = (await load()).find(x => x.id === id)
  if (b) await post(b, { question: "ping, reply 'pong'", from: 'TerminAI settings test', session_id: null }).catch(() => {})
  return bots.map(pub)
}
/** From a tab: returns at once; the answer comes later into that tab as a message from the bot. */
export async function botAsk(question: unknown, agent: unknown, botName: unknown, from: string, sessionId: string | null): Promise<{ ok: true; bot: string; keyId?: string; note: string }> {
  if (typeof question !== 'string' || !question.trim() || question.length > 20000) throw new Error('usage: terminai ask-grok "<question>" [--bot <name>] [--agent <name>]')
  const all = (await load()).filter(b => b.url)
  if (!all.length) throw new Error('No bot is connected: Settings › Connections › Add a bot.')
  const want = typeof botName === 'string' ? botName.trim().toLowerCase() : ''
  const b = want ? all.find(x => x.name.toLowerCase() === want) ?? all.find(x => x.name.toLowerCase().includes(want)) : all.find(x => x.isDefault) ?? all[0]
  if (!b) throw new Error(`No connected bot named ${String(botName)}. Connected: ${all.map(x => x.name).join(', ')}.`)
  await post(b, { question: question.trim(), from, session_id: sessionId, agent: typeof agent === 'string' && agent.trim() ? agent.trim() : b.agent })
  return { ok: true, bot: b.name, keyId: b.keyId, note: sessionId ? `Sent to ${b.name}. The answer arrives in this session as a message from the bot; do not wait for it in a loop.` : `Sent to ${b.name}, but this tab is Off the record or not synced yet, so the bot cannot answer into it: it answers in its own chat.` }
}

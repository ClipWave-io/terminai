import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import * as store from './store'
import type { FolderMode } from '../shared/types'

/**
 * What the partner (and their agents) may see of a conversation, by folder. Only sharing is concerned: a session works
 * on its own Mac exactly the same whatever its folder says.
 *  shared   the partner sees it, reads it and can message it; the log shows its finished steps
 *  private  only you (your iPhone): the partner neither sees nor reaches it; the shared log says only "Private work"
 *  off      nothing leaves this Mac: not uploaded, not reachable from the phone; the shared log says only "Private work"
 * Order: a tab's own choice (the selector beside its account, then Sync › Conversations), then the deepest folder rule, then a git repo rule (git:<origin>,
 * covering every clone and worktree of that repo), then the default, which is Off the record unless set to Shared.
 */
const norm = (p: string) => resolve(p.startsWith('~') ? homedir() + p.slice(1) : p)
const origins = new Map<string, { url: string; at: number }>()
/** The repo a folder belongs to, as its normalised origin URL ('' outside a repo or without a remote). Cached a minute. */
export function repoOf(cwd: string): string {
  const hit = origins.get(cwd)
  if (hit && Date.now() - hit.at < 60_000) return hit.url
  let url = ''
  try { url = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
  url = url.replace(/^git@([^:]+):/, 'https://$1/').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase()
  origins.set(cwd, { url, at: Date.now() })
  return url
}
export function folderMode(cwd: string): FolderMode | null {
  const rules = store.load().folderSharing ?? {}, at = norm(cwd || homedir())
  let best: [string, FolderMode] | null = null
  for (const [folder, mode] of Object.entries(rules)) {
    if (folder.startsWith('git:')) continue
    const f = norm(folder)
    if ((at === f || at.startsWith(f.endsWith(sep) ? f : f + sep)) && (!best || f.length > best[0].length)) best = [f, mode]
  }
  if (best) return best[1]
  const repo = Object.keys(rules).some(k => k.startsWith('git:')) ? repoOf(at) : ''
  return repo && rules[`git:${repo}`] ? rules[`git:${repo}`] : null
}
/** What applies to a folder with no tab choice: its rule, else the default. */
export const defaultMode = (cwd: string): FolderMode => folderMode(cwd) ?? (store.load().shareConversations ? 'shared' : 'off')
export function tabMode(key: string, cwd: string): FolderMode {
  const p = store.load(), chosen = p.tabModes?.[key], own = p.tabSharing?.[key]
  if (chosen) return chosen
  if (own !== undefined) return own ? 'shared' : 'private'
  return defaultMode(cwd)
}
/** A conversation remembered with the tab it runs in (by session id: the last 36 characters of its transcript's name). */
export function rememberSession(session: string, key: string): void {
  const id = session.slice(-36), p = store.load()
  if (id && p.sessionTabs?.[id] !== key) store.save({ sessionTabs: { ...p.sessionTabs, [id]: key } })
}
/** What applies to one conversation of the work log: the choice of the tab it ran in (even once closed), else its folder's. */
export function conversationMode(cwd: string, session: string, liveKey?: string): FolderMode {
  const key = liveKey ?? store.load().sessionTabs?.[session.slice(-36)]
  return key ? tabMode(key, cwd) : defaultMode(cwd)
}
/** Keys, tokens and anything written as a password, taken out of whatever goes to the server. */
const SECRET = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abp]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[A-Za-z0-9_+/=-]{40,})/g
// Labelled ones in English, Italian and Spanish ("password: …", "la contraseña es …"); Telegram bot tokens; fal keys (id:secret).
const LABELLED = /\b(pass(word|wd|code)?|pwd|secret|token|api[_ -]?key|otp|pin|parola d'ordine|chiave|codice|contrase(ñ|n)a|clave|c(ó|o)digo)\b(\s*[:=]\s*|\s+(is|è|e|es)\s+)("[^"]+"|'[^']+'|\S+)/gi
const SHAPED = /\b(\d{8,10}:[A-Za-z0-9_-]{35,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32})\b/gi
export const scrub = (text: string) => text.replace(SHAPED, '[hidden]').replace(SECRET, '[hidden]').replace(LABELLED, (...m: string[]) => `${m[1]}${m[5]}[hidden]`)

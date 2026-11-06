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
 * The deepest folder with a rule decides; a tab's own choice in Sync › Conversations goes over it; otherwise the default.
 */
const norm = (p: string) => resolve(p.startsWith('~') ? homedir() + p.slice(1) : p)
export function folderMode(cwd: string): FolderMode | null {
  const rules = store.load().folderSharing ?? {}, at = norm(cwd || homedir())
  let best: [string, FolderMode] | null = null
  for (const [folder, mode] of Object.entries(rules)) {
    const f = norm(folder)
    if ((at === f || at.startsWith(f.endsWith(sep) ? f : f + sep)) && (!best || f.length > best[0].length)) best = [f, mode]
  }
  return best ? best[1] : null
}
export function tabMode(key: string, cwd: string): FolderMode {
  const p = store.load(), own = p.tabSharing?.[key]
  if (own !== undefined) return own ? 'shared' : 'private'
  return folderMode(cwd) ?? (p.shareConversations ? 'shared' : 'private')
}
/** Keys, tokens and anything written as a password, taken out of whatever goes to the server. */
const SECRET = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abp]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[A-Za-z0-9_+/=-]{40,})/g
const LABELLED = /\b(pass(word|wd|code)?|pwd|secret|token|api[_ -]?key|otp|pin)\b(\s*[:=]\s*|\s+is\s+)("[^"]+"|'[^']+'|\S+)/gi
export const scrub = (text: string) => text.replace(SECRET, '[hidden]').replace(LABELLED, (_m, word, _a, sepr) => `${word}${sepr}[hidden]`)

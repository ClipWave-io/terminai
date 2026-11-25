import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Import from Chrome: the person's Chrome logins (cookies), saved passwords and bookmarks into TerminAI Browser's
 * profile, so sites open signed in there too. Chrome encrypts cookies and passwords with a key in the macOS keychain
 * ("Chrome Safe Storage"); TerminAI Browser (Chromium) with its own ("Chromium Safe Storage"). Each value is decrypted
 * with Chrome's key and encrypted again with Chromium's, in this process; nothing is shown or sent anywhere. macOS asks
 * the person once to allow reading each key. A copy, not a sync: run it again to bring newer logins over.
 */
const run = (cmd: string, args: string[], input?: string) => new Promise<string>((resolve, reject) => {
  const p = execFile(cmd, args, { maxBuffer: 512 << 20 }, (e, out, err) => e ? reject(new Error(String(err || e.message).trim())) : resolve(out))
  if (input !== undefined) { p.stdin?.end(input) }
})
export const keyFrom = (secret: string) => pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1')
const IV = Buffer.alloc(16, ' ')
export function reencrypt(blob: Buffer, from: Buffer, to: Buffer): Buffer | null {
  if (blob.length < 4 || blob.subarray(0, 3).toString() !== 'v10') return null
  const d = createDecipheriv('aes-128-cbc', from, IV), plain = Buffer.concat([d.update(blob.subarray(3)), d.final()])
  const c = createCipheriv('aes-128-cbc', to, IV)
  return Buffer.concat([Buffer.from('v10'), c.update(plain), c.final()])
}
async function secret(service: string, account: string): Promise<string> {
  return (await run('/usr/bin/security', ['find-generic-password', '-w', '-s', service, '-a', account])).trim()
}
/** Copies `src` (a Chrome SQLite file) to `dst`, with every encrypted value of `table.column` re-encrypted. */
export async function copyTable(src: string, dst: string, table: string, column: string, from: Buffer, to: Buffer): Promise<number> {
  const work = join(tmpdir(), `terminai-import-${process.pid}-${Date.now()}.db`)
  await copyFile(src, work)
  const rows = (await run('/usr/bin/sqlite3', ['-readonly', work, `select rowid, hex(${column}) from ${table} where length(${column}) > 3`])).split('\n').filter(Boolean)
  const sql: string[] = ['BEGIN;']
  let n = 0
  for (const r of rows) {
    const [id, hex] = r.split('|'); if (!/^\d+$/.test(id) || !hex) continue
    let out: Buffer | null = null
    try { out = reencrypt(Buffer.from(hex, 'hex'), from, to) } catch { out = null }
    if (out) { sql.push(`UPDATE ${table} SET ${column} = X'${out.toString('hex')}' WHERE rowid = ${id};`); n++ }
    else sql.push(`DELETE FROM ${table} WHERE rowid = ${id};`)
  }
  sql.push('COMMIT;')
  await run('/usr/bin/sqlite3', [work], sql.join('\n'))
  await rm(`${dst}-journal`, { force: true }); await rm(`${dst}-wal`, { force: true }); await rm(`${dst}-shm`, { force: true })
  await copyFile(work, dst); await rm(work, { force: true })
  return n
}

export type ImportResult = { cookies: number; passwords: number; bookmarks: boolean; profile: string }
/** Chrome's profile last used (from its Local State), with its name. */
export async function chromeProfile(): Promise<{ dir: string; name: string }> {
  const root = join(process.env.HOME ?? '', 'Library/Application Support/Google/Chrome')
  try { const s = JSON.parse(await readFile(join(root, 'Local State'), 'utf8')); const p = s.profile?.last_used || 'Default'; return { dir: join(root, p), name: s.profile?.info_cache?.[p]?.name || p } }
  catch { return { dir: join(root, 'Default'), name: 'Default' } }
}
export async function importFromChrome(browserProfile: string): Promise<ImportResult> {
  const chrome = await chromeProfile()
  if (!existsSync(chrome.dir)) throw Error('No Google Chrome profile found on this Mac.')
  const from = keyFrom(await secret('Chrome Safe Storage', 'Chrome').catch(() => { throw Error('macOS did not allow reading Chrome\'s key (click Always Allow when it asks).') }))
  const to = keyFrom(await secret('Chromium Safe Storage', 'Chromium').catch(() => { throw Error('Open TerminAI Browser once first, then import.') }))
  const dst = join(browserProfile, 'Default'); await mkdir(dst, { recursive: true })
  const cookiesSrc = existsSync(join(chrome.dir, 'Network/Cookies')) ? join(chrome.dir, 'Network/Cookies') : join(chrome.dir, 'Cookies')
  const cookiesDst = existsSync(join(dst, 'Network')) || cookiesSrc.includes('/Network/') ? join(dst, 'Network/Cookies') : join(dst, 'Cookies')
  await mkdir(join(cookiesDst, '..'), { recursive: true })
  const cookies = await copyTable(cookiesSrc, cookiesDst, 'cookies', 'encrypted_value', from, to)
  const passwords = existsSync(join(chrome.dir, 'Login Data')) ? await copyTable(join(chrome.dir, 'Login Data'), join(dst, 'Login Data'), 'logins', 'password_value', from, to) : 0
  let bookmarks = false
  if (existsSync(join(chrome.dir, 'Bookmarks'))) { await writeFile(join(dst, 'Bookmarks'), await readFile(join(chrome.dir, 'Bookmarks'))); await rm(join(dst, 'Bookmarks.bak'), { force: true }); bookmarks = true }
  return { cookies, passwords, bookmarks, profile: chrome.name }
}

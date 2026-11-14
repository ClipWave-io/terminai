import { app, session } from 'electron'
import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Keeps TerminAI lean on disk, at launch and once a day, touching only what it can make again:
 * - spoken clips (voice/) older than a week: they are synthesized again when needed;
 * - team files downloaded to open them (team-files/) not opened for two weeks: downloaded again on the next open;
 * - the built-in browser's web cache and compiled-code cache once they pass 150 MB (cookies and sign-ins stay);
 * - update downloads of a version already installed (or older).
 * Never conversations, settings, notes or sign-ins.
 */
const DAY = 86_400_000
async function size(dir: string): Promise<number> {
  let total = 0
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? await size(p) : (await stat(p).catch(() => null))?.size ?? 0
  }
  return total
}
async function dropOlder(dir: string, days: number): Promise<number> {
  let freed = 0
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name), s = await stat(p).catch(() => null)
    if (!s || Date.now() - Math.max(s.mtimeMs, s.atimeMs) < days * DAY) continue
    const n = e.isDirectory() ? await size(p) : s.size
    await rm(p, { recursive: true, force: true }).then(() => { freed += n }).catch(() => {})
  }
  return freed
}
const newer = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false }

export async function housekeeping(): Promise<number> {
  const data = app.getPath('userData')
  let freed = await dropOlder(join(data, 'voice'), 7) + await dropOlder(join(data, 'team-files'), 14)
  // The built-in browser: each profile's caches, and the app's own.
  const parts = (await readdir(join(data, 'Partitions')).catch(() => [] as string[])).filter(n => n.startsWith('terminai-profile-'))
  for (const [ses, dir] of [[session.defaultSession, data], ...parts.map(n => [session.fromPartition(`persist:${n}`), join(data, 'Partitions', n)] as const)] as const) {
    const n = await size(join(dir, 'Cache')) + await size(join(dir, 'Code Cache'))
    if (n < 150 * 1024 * 1024) continue
    await ses.clearCache().catch(() => {}); await ses.clearCodeCaches({}).catch(() => {})
    freed += n
  }
  // Update downloads of this version or older: already installed.
  const pending = join(homedir(), 'Library', 'Caches', 'clipwave-term-updater', 'pending')
  for (const f of await readdir(pending).catch(() => [] as string[])) {
    const v = f.match(/(\d+\.\d+\.\d+)/)?.[1]
    if (v && !newer(v, app.getVersion())) { const s = await stat(join(pending, f)).catch(() => null); await rm(join(pending, f), { force: true }).catch(() => {}); freed += s?.size ?? 0 }
  }
  return freed
}

export function watchHousekeeping(): void {
  const run = () => void housekeeping().then(n => { if (n > 1024 * 1024) console.log(`[housekeeping] freed ${(n / 1048576).toFixed(0)} MB`) }).catch(() => {})
  setTimeout(run, 60_000); setInterval(run, DAY)
}

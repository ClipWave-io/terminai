import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Cloud: the compute pool this Mac shares work with (~/Clipwave/compute: the Mac plus rented Hetzner, later RunPod, boxes).
 * Its scheduler rewrites status.json every minute; TerminAI only reads it (no SSH, no cloud keys here). Macs without the
 * pool get null and the Memory page shows nothing extra.
 */
export type CloudMachine = { name: string; kind: string; type?: string; role?: string; ok: boolean; total_mb?: number; used_mb?: number
  avail_mb?: number; swap_mb?: number; pressure?: number; cores?: number; load?: number; price_h?: number; temporary?: boolean; auto?: boolean
  created?: string; running: string[]; scheduled: string[] }
export type CloudJob = { id: string; name: string; state: string; machine?: string; peak_mb?: number; created?: string; started?: string
  ended?: string; exit?: number; log?: string; owner?: string }
export type CloudStatus = { at: string; mode: string; spent_today_eur: number; budget_eur_day: number; dashboard: string
  machines: CloudMachine[]; jobs: CloudJob[]; events: { t: string; msg: string }[]; stale: boolean }

export const CLOUD_DIR = process.env.TERMINAI_COMPUTE_DIR || join(homedir(), 'Clipwave', 'compute')

export async function cloudStatus(): Promise<CloudStatus | null> {
  try {
    const s = JSON.parse(await readFile(join(CLOUD_DIR, 'status.json'), 'utf8')) as Omit<CloudStatus, 'stale'>
    // The scheduler runs every minute; older than 5 minutes means it stopped (Mac asleep, job unloaded).
    return { ...s, stale: Date.now() - new Date(s.at).getTime() > 5 * 60_000 }
  } catch { return null }
}

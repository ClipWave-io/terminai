import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { DEFAULT_PREFS, normalizePaneOrder, RAIL_MIN, RAIL_MAX, RAIL_DEFAULT, type Prefs } from '../shared/types'

let cache: Prefs | null = null

function file(): string {
  return join(app.getPath('userData'), 'prefs.json')
}

/** Merge one level deep so a new pref key added later still gets its default. */
function hydrate(raw: unknown): Prefs {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFS }
  const p = raw as Partial<Prefs>
  return {
    ...DEFAULT_PREFS,
    ...p,
    paneOrder: normalizePaneOrder(p.paneOrder),
    hiddenToolbarItems: Array.isArray(p.hiddenToolbarItems) ? p.hiddenToolbarItems.filter(item => ['files','terminal','browser','team','todo','sessions','maximize','sidebar'].includes(item)) : [],
    // Clamped on read as well as on write: a stale or hand-edited prefs file
    // must never be able to leave the rail off-screen or at zero width.
    railWidth: Math.min(RAIL_MAX, Math.max(RAIL_MIN, p.railWidth ?? RAIL_DEFAULT)),
    railHidden: p.railHidden === true,
    railSide: p.railSide === 'right' ? 'right' : 'left',
    voice: { ...DEFAULT_PREFS.voice, ...(p.voice ?? {}) },
    // Anything but an explicit true means the tour has not been dismissed, so
    // an upgrade from a prefs file that predates this field shows it once.
    seenWelcome: p.seenWelcome === true,
    groupByFolder: p.groupByFolder !== false,
    tasksUser: p.tasksUser === 'livio' || p.tasksUser === 'ilai' ? p.tasksUser : '',
    tabs: Array.isArray(p.tabs) ? p.tabs : [],
  }
}

export function load(): Prefs {
  if (cache) return cache
  try {
    cache = hydrate(JSON.parse(readFileSync(file(), 'utf8')))
  } catch {
    // First launch, or a prefs file we can't parse. Either way defaults are correct.
    cache = { ...DEFAULT_PREFS }
  }
  return cache
}

export function save(patch: Partial<Prefs>): Prefs {
  const next = hydrate({ ...load(), ...patch })
  cache = next
  try {
    mkdirSync(dirname(file()), { recursive: true })
    // Write-then-rename. Tabs are saved on every open/close, so a plain write
    // leaves a window where a truncated file is on disk; reading that back
    // silently resets every preference to its default.
    const tmp = `${file()}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file())
  } catch (err) {
    console.error('[store] could not persist prefs:', err)
  }
  return next
}

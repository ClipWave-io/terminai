import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, renameSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LocalFlowStatus } from '../shared/localflow'

/**
 * LocalFlow (hold fn and talk, Parakeet on the Mac) beside TerminAI.
 *
 * Keeping it running: when TerminAI starts, and every few minutes after, it is started again if it is installed but
 * not running (it used to stop after a stuck microphone and stay off until opened by hand). It opens in the background
 * (-g) and never takes focus.
 *
 * Setting it up (Onboarding and Settings › Voice, "Set up voice dictation"): downloads the signed, notarized
 * LocalFlow.app built by localflow-dist/build.sh from its GitHub release, checks it, puts it in /Applications (or
 * ~/Applications when that is not writable), frees the fn key from the emoji picker, starts it, and downloads the
 * speech model with LocalFlow's own Python. The app asks macOS for the microphone itself and writes what macOS allows
 * to ~/.local/share/localflow/permissions.json; Accessibility shows there too.
 * TERMINAI_LOCALFLOW_HOME / TERMINAI_LOCALFLOW_APPS point the setup at a test home and folder.
 */
const RELEASE = 'https://github.com/ClipWave-io/terminai/releases/download/localflow-v0.2.0/manifest.json'
const TEAM_ID = '99PQ34696X'
const MODEL = 'mlx-community/parakeet-tdt-0.6b-v3'
const MODEL_BYTES = 2_509_000_000
const HOME = process.env.TERMINAI_LOCALFLOW_HOME || homedir()
const APP_DIRS = process.env.TERMINAI_LOCALFLOW_APPS ? [process.env.TERMINAI_LOCALFLOW_APPS] : ['/Applications', join(HOME, 'Applications')]
const DATA = join(HOME, '.local/share/localflow')
const MODEL_DIR = join(process.env.HF_HOME || join(HOME, '.cache/huggingface'), 'hub', `models--${MODEL.replace('/', '--')}`)

export function installedApp(): string | null {
  for (const d of APP_DIRS) { const a = join(d, 'LocalFlow.app'); if (existsSync(a)) return a }
  return null
}
function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => execFile(cmd, args, { env: env ?? process.env, maxBuffer: 4 << 20 }, (e, so, se) => resolve({ ok: !e, out: `${so}${se}` })))
}
async function runningPid(): Promise<number | null> {
  const r = await run('/usr/bin/pgrep', ['-x', 'LocalFlow'])
  const pid = Number(r.out.trim().split('\n')[0])
  return r.ok && pid ? pid : null
}
async function check(): Promise<void> {
  const app = installedApp()
  if (!app || await runningPid()) return
  execFile('/usr/bin/open', ['-g', '-a', app], () => {})
}
export function keepLocalFlow(): void {
  if (process.env.TERMINAI_TEST_BUILD) return
  setTimeout(() => void check(), 5_000)
  setInterval(() => void check(), 5 * 60_000).unref()
}


let phase: LocalFlowStatus['phase'] = 'idle', appProgress = 0, lastError: string | undefined, busy: Promise<void> | null = null

function modelOnDisk(): number {
  let n = 0
  const walk = (d: string) => { try { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) n += statSync(p).size } } catch {} }
  walk(join(MODEL_DIR, 'blobs'))
  return n
}
function modelReady(): boolean {
  try {
    const snaps = join(MODEL_DIR, 'snapshots')
    return readdirSync(snaps).some(s => { try { return statSync(join(snaps, s, 'model.safetensors')).size > 10_000_000 } catch { return false } })
  } catch { return false }
}
function permissions(): { microphone: LocalFlowStatus['microphone']; accessibility: boolean | null; pid?: number } {
  try { const j = JSON.parse(readFileSync(join(DATA, 'permissions.json'), 'utf8')); return { microphone: j.microphone ?? 'unknown', accessibility: !!j.accessibility, pid: j.pid } } catch { return { microphone: 'unknown', accessibility: null } }
}
/** What LocalFlow logged since its process started: "hotkey armed" means Accessibility works and fn listens. */
async function loggedSinceStart(pid: number): Promise<{ armed: boolean; model: boolean }> {
  const started = Date.parse((await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)])).out.trim())
  let tail = ''
  try { const buf = readFileSync(join(DATA, 'localflow.log')); tail = buf.subarray(Math.max(0, buf.length - 400_000)).toString('utf8') } catch {}
  let armed = false, model = false
  for (const line of tail.split('\n')) {
    const t = Date.parse(line.slice(0, 19).replace(' ', 'T'))
    if (!t || (started && t < started - 2000)) continue
    if (line.includes('hotkey armed')) armed = true
    if (line.includes('model ready')) model = true
  }
  return { armed, model }
}
async function fnKeyFree(): Promise<boolean> {
  return (await run('/usr/bin/defaults', ['read', 'com.apple.HIToolbox', 'AppleFnUsageType'])).out.trim() === '0'
}

export type { LocalFlowStatus }
export async function localFlowStatus(): Promise<LocalFlowStatus> {
  const app = installedApp(), pid = app ? await runningPid() : null
  let ours = false
  if (app) try { ours = readFileSync(join(app, 'Contents/Info.plist'), 'utf8').includes('xyz.terminai.localflow') } catch {}
  const perm = ours ? permissions() : { microphone: 'unknown' as const, accessibility: null }
  const log = pid ? await loggedSinceStart(pid) : { armed: false, model: false }
  const mReady = modelReady()
  const st: LocalFlowStatus = {
    installed: !!app, ours, running: !!pid, phase, appProgress,
    modelProgress: mReady ? 1 : Math.min(0.99, modelOnDisk() / MODEL_BYTES), modelReady: mReady,
    microphone: perm.microphone, accessibility: log.armed ? true : perm.accessibility, hotkeyArmed: log.armed,
    fnKey: await fnKeyFree(), ready: false, error: lastError,
  }
  st.ready = !!pid && log.armed && mReady && st.microphone !== 'denied' && st.microphone !== 'restricted'
  if (st.ready && phase !== 'error') st.phase = 'ready'
  return st
}

async function download(url: string, to: string, size: number): Promise<string> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`)
  const hash = createHash('sha256'), out = createWriteStream(to)
  let got = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk); got += chunk.length; appProgress = Math.min(0.99, got / (size || 1))
    if (!out.write(chunk)) await new Promise<void>(r => out.once('drain', () => r()))
  }
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => e ? reject(e) : resolve()))
  return hash.digest('hex')
}

async function installApp(): Promise<string> {
  phase = 'download'; appProgress = 0
  const m = await (await fetch(RELEASE)).json() as { version: string; url: string; sha256: string; size: number }
  const work = join(tmpdir(), `terminai-localflow-${Date.now()}`); mkdirSync(work, { recursive: true })
  try {
    const zip = join(work, 'LocalFlow.zip')
    if (await download(m.url, zip, m.size) !== m.sha256) throw new Error('the download did not match its checksum')
    phase = 'install'; appProgress = 1
    if (!(await run('/usr/bin/ditto', ['-x', '-k', zip, work])).ok) throw new Error('could not unpack LocalFlow')
    const fresh = join(work, 'LocalFlow.app')
    const sig = await run('/usr/bin/codesign', ['-dv', '--verbose=2', fresh])
    if (!(await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', fresh])).ok || !sig.out.includes(`TeamIdentifier=${TEAM_ID}`)) throw new Error('LocalFlow is not signed by TerminAI')
    const dir = APP_DIRS.find(d => { try { mkdirSync(d, { recursive: true }); accessSync(d, constants.W_OK); return true } catch { return false } })
    if (!dir) throw new Error('no Applications folder can be written')
    const dest = join(dir, 'LocalFlow.app')
    if (existsSync(dest)) return dest
    try { renameSync(fresh, dest) } catch { if (!(await run('/usr/bin/ditto', [fresh, dest])).ok) throw new Error(`could not copy LocalFlow to ${dir}`) }
    return dest
  } finally { rmSync(work, { recursive: true, force: true }) }
}

/** The model with LocalFlow's own Python (huggingface_hub resumes a broken download); a few tries. */
async function downloadModel(app: string): Promise<void> {
  const py = join(app, 'Contents/Resources/python/bin/python3')
  const env = { ...process.env, HOME, PYTHONDONTWRITEBYTECODE: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1' }
  for (let i = 0; i < 3 && !modelReady(); i++) {
    await new Promise<void>(resolve => {
      const p = spawn(py, ['-c', `from huggingface_hub import snapshot_download; snapshot_download(${JSON.stringify(MODEL)})`], { env, stdio: 'ignore' })
      p.on('exit', () => resolve()); p.on('error', () => resolve())
    })
  }
  if (!modelReady()) throw new Error('the speech model did not download: check the internet connection and try again')
}

async function startApp(app: string, restart = false): Promise<void> {
  if (restart) { await run('/usr/bin/pkill', ['-x', 'LocalFlow']); for (let i = 0; i < 20 && await runningPid(); i++) await new Promise(r => setTimeout(r, 300)) }
  if (!await runningPid()) await run('/usr/bin/open', ['-g', '-a', app])
}

/** Runs the whole setup once; calling it again while it runs returns the same run. */
export function setupLocalFlow(): Promise<void> {
  if (busy) return busy
  lastError = undefined
  busy = (async () => {
    try {
      const app = installedApp() ?? await installApp()
      // The globe/fn key must do nothing else, or releasing it opens the emoji picker (LocalFlow checks this too).
      if (!process.env.TERMINAI_LOCALFLOW_HOME) await run('/usr/bin/defaults', ['write', 'com.apple.HIToolbox', 'AppleFnUsageType', '-int', '0'])
      phase = 'model'
      // Started now so macOS asks for the microphone and Accessibility while the model downloads.
      if (!process.env.TERMINAI_LOCALFLOW_HOME) await startApp(app)
      const hadModel = modelReady()
      await downloadModel(app)
      // LocalFlow tried to load the model at start; when it was not there yet, start it again now that it is.
      const pid = await runningPid()
      if (!hadModel && pid && !process.env.TERMINAI_LOCALFLOW_HOME) {
        for (let i = 0; i < 20 && !(await loggedSinceStart(pid)).model; i++) await new Promise(r => setTimeout(r, 1000))
        if (!(await loggedSinceStart(pid)).model) await startApp(app, true)
      }
      phase = 'idle'
    } catch (e) {
      phase = 'error'; lastError = e instanceof Error ? e.message : String(e)
    } finally { busy = null }
  })()
  return busy
}

export function setupRunning(): boolean { return !!busy }

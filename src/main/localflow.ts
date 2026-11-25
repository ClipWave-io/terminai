import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * LocalFlow (hold fn and talk) runs beside TerminAI: when TerminAI starts, and every few minutes after, it is started
 * again if it is installed but not running (it used to stop after a stuck microphone and stay off until opened by hand).
 * It opens in the background (-g) and never takes focus.
 */
const APP = '/Applications/LocalFlow.app'
function running(): Promise<boolean> {
  return new Promise(resolve => execFile('/usr/bin/pgrep', ['-x', 'LocalFlow'], e => resolve(!e)))
}
async function check(): Promise<void> {
  if (!existsSync(APP) || await running()) return
  execFile('/usr/bin/open', ['-g', '-a', APP], () => {})
}
export function keepLocalFlow(): void {
  if (process.env.TERMINAI_TEST_BUILD) return
  setTimeout(() => void check(), 5_000)
  setInterval(() => void check(), 5 * 60_000).unref()
}

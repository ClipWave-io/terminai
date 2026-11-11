import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { notice } from './notices'

/**
 * Claude Code turns its fullscreen interface off by itself after two starts that died before it was up
 * (`fullscreenAutoDisabled` in ~/.claude.json, for the version installed), and every new chat then opens in the classic
 * one: no clicking in the prompt, a status bar that moves with the text. `/tui fullscreen` in any chat turns it back on
 * and clears the flag. TerminAI only says so: it never edits the file, which every session rewrites.
 */
const FILE = process.env.TERMINAI_CLAUDE_JSON || join(homedir(), '.claude.json')

export function watchFullscreenOff(): void {
  // Test runs read this Mac's real settings otherwise: only the tests that point it at their own file get the notice.
  if (process.env.TERMINAI_TEST_BUILD && !process.env.TERMINAI_CLAUDE_JSON) return
  let mtime = 0, told = ''
  const check = async (): Promise<void> => {
    try {
      const m = (await stat(FILE)).mtimeMs
      if (m === mtime) return
      mtime = m
      const off = JSON.parse(await readFile(FILE, 'utf8')).fullscreenAutoDisabled
      const at = off && typeof off === 'object' ? String(off.at ?? '') : ''
      if (!at || at === told) return
      told = at
      notice('agent', 'Claude Code turned fullscreen off',
        'After starts that failed, new chats open in the classic screen: no clicking in the prompt, and the status bar moves with the text. Type /tui fullscreen in any chat to turn it back on.')
    } catch {}
  }
  void check()
  setInterval(() => void check(), 60_000).unref()
}

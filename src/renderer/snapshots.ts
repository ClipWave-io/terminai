/**
 * Lets the grid show what each tab is actually doing without giving it a second
 * xterm per card. Each TerminalPane registers a cheap "read the last N visible
 * lines" function here; the grid calls it only while it is open.
 */

type Snapshot = (lines: number) => string[]

const readers = new Map<string, Snapshot>()

export function register(ptyId: string, read: Snapshot): void {
  readers.set(ptyId, read)
}

export function unregister(ptyId: string): void {
  readers.delete(ptyId)
}

export function snapshot(ptyId: string, lines = 8): string[] {
  try {
    return readers.get(ptyId)?.(lines) ?? []
  } catch {
    return []
  }
}

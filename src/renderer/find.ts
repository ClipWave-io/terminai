/**
 * ⌘F inside a conversation: each terminal (and each Clean view while it is shown) registers how to search its own
 * text; the find bar asks the one in view. `find` returns where it landed: the match number and how many there are.
 */
export type FindResult = { index: number; count: number }
export type Finder = { find: (query: string, back: boolean, incremental: boolean) => Promise<FindResult>; clear: () => void }
export const finders = new Map<string, Finder>()

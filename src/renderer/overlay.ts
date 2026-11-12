/**
 * One overlay at a time: opening a sheet (Settings, Sync, To-do, All sessions), the notifications or the toolbar
 * menu tells the others, which close. The team chat is the one exception: it stays open and always sits on top.
 */
export type Overlay = 'sheet' | 'notices' | 'toolbar'
export const overlayOpened = (name: Overlay): void => { window.dispatchEvent(new CustomEvent('overlay:open', { detail: name })) }
export function onOverlayOpened(fn: (name: Overlay) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<Overlay>).detail)
  window.addEventListener('overlay:open', h); return () => window.removeEventListener('overlay:open', h)
}

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Prefs, VoiceClip } from '../shared/types'

/**
 * The only surface the renderer gets. contextIsolation is on and nodeIntegration
 * is off, so terminal output can never reach a Node API even if something in it
 * is hostile.
 */
const api = {
  pty: {
    create: (opts: { cwd?: string; cols?: number; rows?: number }): Promise<{ id: string; cwd: string }> =>
      ipcRenderer.invoke('pty:create', opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', { id, data }),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id: string): void => ipcRenderer.send('pty:kill', { id }),
    process: (id: string): Promise<string> => ipcRenderer.invoke('pty:process', { id }),
    cwd: (id: string): Promise<string> => ipcRenderer.invoke('pty:cwd', { id }),

    onData: (cb: (id: string, data: string) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, p: { id: string; data: string }): void => cb(p.id, p.data)
      ipcRenderer.on('pty:data', h)
      return () => ipcRenderer.removeListener('pty:data', h)
    },
    onExit: (cb: (id: string, code: number) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, p: { id: string; exitCode: number }): void =>
        cb(p.id, p.exitCode)
      ipcRenderer.on('pty:exit', h)
      return () => ipcRenderer.removeListener('pty:exit', h)
    },
  },

  tabs: {
    setActive: (id: string | null): void => ipcRenderer.send('tab:active', { id }),
  },

  prefs: {
    get: (): Promise<Prefs> => ipcRenderer.invoke('prefs:get'),
    set: (patch: Partial<Prefs>): Promise<Prefs> => ipcRenderer.invoke('prefs:set', patch),
  },

  voice: {
    speak: (text: string): Promise<VoiceClip> => ipcRenderer.invoke('voice:speak', { text }),
    voices: (): Promise<string[]> => ipcRenderer.invoke('voice:voices'),
    hasElevenKey: (): Promise<boolean> => ipcRenderer.invoke('voice:hasElevenKey'),
    elevenVoices: (): Promise<
      | { ok: true; voices: { id: string; name: string; category: string; description: string }[] }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('voice:elevenVoices'),
    setElevenKey: (key: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('voice:setElevenKey', { key }),
    save: (path: string, text: string): Promise<{ saved: boolean; filePath?: string }> =>
      ipcRenderer.invoke('voice:save', { path, text }),

    onClip: (cb: (clip: VoiceClip) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, clip: VoiceClip): void => cb(clip)
      ipcRenderer.on('voice:clip', h)
      return () => ipcRenderer.removeListener('voice:clip', h)
    },
    onError: (cb: (message: string) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, p: { message: string }): void => cb(p.message)
      ipcRenderer.on('voice:error', h)
      return () => ipcRenderer.removeListener('voice:error', h)
    },
  },

  dialog: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
  },
}

contextBridge.exposeInMainWorld('term', api)

export type TermApi = typeof api

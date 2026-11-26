/** Voice dictation (LocalFlow) setup, as Onboarding and Settings › Voice show it; src/main/localflow.ts fills it. */
export interface LocalFlowStatus {
  installed: boolean
  /** Our signed copy (it reports its permissions); false for an older copy built by hand. */
  ours: boolean
  running: boolean
  phase: 'idle' | 'download' | 'install' | 'model' | 'ready' | 'error'
  appProgress: number
  modelProgress: number
  modelReady: boolean
  microphone: 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown'
  accessibility: boolean | null
  hotkeyArmed: boolean
  fnKey: boolean
  ready: boolean
  error?: string
}

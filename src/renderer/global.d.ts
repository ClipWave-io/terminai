import type { TermApi } from '../preload/index'

declare global {
  interface Window {
    term: TermApi
  }
}

export {}

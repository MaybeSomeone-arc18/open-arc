import type { OpenArcApi } from '../../shared/types'

declare global {
  interface Window {
    openArc: OpenArcApi
  }
}

export {}

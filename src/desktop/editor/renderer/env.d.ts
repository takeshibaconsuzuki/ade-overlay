import type { EditorApi } from '../api'

declare global {
  interface Window {
    editor: EditorApi
  }
}

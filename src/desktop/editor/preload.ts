import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  type EditorApi,
  type EditorState,
  EDITOR_INITIALIZE,
  EDITOR_STATE_CHANGED,
  EDITOR_RETRY,
} from './api'

let onEditorStateChangedListener: ((state: EditorState) => void) | undefined
ipcRenderer.on(
  EDITOR_STATE_CHANGED,
  (_event: IpcRendererEvent, state: EditorState) => {
    onEditorStateChangedListener?.(state)
  },
)

const api: EditorApi = {
  initializeEditorWindow: () => ipcRenderer.send(EDITOR_INITIALIZE),
  retryEditor: () => ipcRenderer.invoke(EDITOR_RETRY),
  setOnEditorStateChangedListener(listener) {
    onEditorStateChangedListener = listener
  },
}
contextBridge.exposeInMainWorld('editor', api)

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  companionChannels,
  type CompanionAPI,
  type CompanionState,
} from '../shared/ipc.ts'

const companion: CompanionAPI = {
  getState: () => ipcRenderer.invoke(companionChannels.getState),
  reconnect: () => ipcRenderer.invoke(companionChannels.reconnect),
  refreshWorktrees: () =>
    ipcRenderer.invoke(companionChannels.refreshWorktrees),
  createWorktree: (input) =>
    ipcRenderer.invoke(companionChannels.createWorktree, input),
  deleteWorktree: (input) =>
    ipcRenderer.invoke(companionChannels.deleteWorktree, input),
  setWorktreeError: (input) =>
    ipcRenderer.invoke(companionChannels.setWorktreeError, input),
  openEditor: (input) =>
    ipcRenderer.invoke(companionChannels.openEditor, input),
  onState: (callback) => {
    const listener = (_event: IpcRendererEvent, state: CompanionState): void =>
      callback(state)
    ipcRenderer.on(companionChannels.state, listener)
    return () => {
      ipcRenderer.removeListener(companionChannels.state, listener)
    }
  },
}

contextBridge.exposeInMainWorld('companion', companion)

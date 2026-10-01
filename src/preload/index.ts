import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  companionChannels,
  pickerChannels,
  type CompanionAPI,
  type CompanionState,
  type PickerWindowAPI,
} from '../shared/ipc.ts'

const companion: CompanionAPI = {
  getState: () => ipcRenderer.invoke(companionChannels.getState),
  reconnect: () => ipcRenderer.invoke(companionChannels.reconnect),
  refreshWorktrees: () =>
    ipcRenderer.invoke(companionChannels.refreshWorktrees),
  createWorktree: (input) =>
    ipcRenderer.invoke(companionChannels.createWorktree, input),
  getWorktreePathTemplates: () =>
    ipcRenderer.invoke(companionChannels.getWorktreePathTemplates),
  getWorktreeBranches: (project) =>
    ipcRenderer.invoke(companionChannels.getWorktreeBranches, project),
  deleteWorktree: (input) =>
    ipcRenderer.invoke(companionChannels.deleteWorktree, input),
  setWorktreeError: (input) =>
    ipcRenderer.invoke(companionChannels.setWorktreeError, input),
  openEditor: (input) =>
    ipcRenderer.invoke(companionChannels.openEditor, input),
  stopEditor: (input) =>
    ipcRenderer.invoke(companionChannels.stopEditor, input),
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

const pickerWindow: PickerWindowAPI = {
  hide: () => ipcRenderer.invoke(pickerChannels.hide),
  onHidden: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on(pickerChannels.hidden, listener)
    return () => ipcRenderer.removeListener(pickerChannels.hidden, listener)
  },
}

contextBridge.exposeInMainWorld('pickerWindow', pickerWindow)

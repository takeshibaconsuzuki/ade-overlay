import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  companionChannels,
  type CompanionAPI,
  type CompanionStatus,
  type WorktreeUpdate,
} from '../shared/companion.ts'

const companion: CompanionAPI = {
  getStatus: () => ipcRenderer.invoke(companionChannels.getStatus),
  reconnect: () => ipcRenderer.invoke(companionChannels.reconnect),
  listWorktrees: () => ipcRenderer.invoke(companionChannels.listWorktrees),
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
  onWorktreesUpdated: (callback) => {
    const listener = (_event: IpcRendererEvent, update: WorktreeUpdate): void =>
      callback(update)
    ipcRenderer.on(companionChannels.worktreesUpdated, listener)
    return () =>
      ipcRenderer.removeListener(companionChannels.worktreesUpdated, listener)
  },
  onStatus: (callback) => {
    const listener = (
      _event: IpcRendererEvent,
      status: CompanionStatus,
    ): void => callback(status)
    ipcRenderer.on(companionChannels.status, listener)
    return () => {
      ipcRenderer.removeListener(companionChannels.status, listener)
    }
  },
}

contextBridge.exposeInMainWorld('companion', companion)

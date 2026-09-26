import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  companionChannels,
  type CompanionAPI,
  type CompanionStatus,
} from '../shared/companion.ts'

const companion: CompanionAPI = {
  getStatus: () => ipcRenderer.invoke(companionChannels.getStatus),
  reconnect: () => ipcRenderer.invoke(companionChannels.reconnect),
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

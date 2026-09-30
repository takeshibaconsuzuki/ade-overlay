import { contextBridge, ipcRenderer } from 'electron'
import { pasteChannels, type PasteBridge } from '../shared/paste'

// Native menu pastes and file drops are trusted events without transient DOM
// activation. Track that proof in the isolated world, never in page arguments.
let trustedTransfer: string | undefined
for (const type of ['paste', 'drop'])
  document.addEventListener(
    type,
    (event) => {
      if (!event.isTrusted) return
      trustedTransfer = type
      setTimeout(() => {
        trustedTransfer = undefined
      })
    },
    true,
  )

const bridge: PasteBridge = {
  reservePaste: () => {
    const trusted = trustedTransfer
    trustedTransfer = undefined
    return ipcRenderer.invoke(pasteChannels.reserve, trusted)
  },
  paste: (id, items) => ipcRenderer.invoke(pasteChannels.paste, id, items),
}
contextBridge.exposeInMainWorld('adePaste', bridge)

import { contextBridge, ipcRenderer } from 'electron'
import { pasteChannels, type PasteBridge } from '../shared/paste'

// Native menu pastes can be trusted clipboard events without transient DOM
// activation. Track that proof in the isolated world, never in page arguments.
let nativePaste = false
document.addEventListener(
  'paste',
  (event) => {
    if (!event.isTrusted) return
    nativePaste = true
    setTimeout(() => {
      nativePaste = false
    })
  },
  true,
)

const bridge: PasteBridge = {
  reservePaste: () => {
    const trustedPaste = nativePaste
    nativePaste = false
    return ipcRenderer.invoke(pasteChannels.reserve, trustedPaste)
  },
  paste: (id, items) => ipcRenderer.invoke(pasteChannels.paste, id, items),
}
contextBridge.exposeInMainWorld('adePaste', bridge)

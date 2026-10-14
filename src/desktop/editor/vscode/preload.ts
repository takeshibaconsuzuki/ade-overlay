import { contextBridge, ipcRenderer } from 'electron'
import {
  EDITOR_RPC_CONNECT,
  EDITOR_RPC_MESSAGE,
  isEditorMessage,
  type DesktopBridge,
  type EditorMessage,
} from '../../../shared/editor-rpc'

const session = crypto.randomUUID()
let receive: ((call: EditorMessage) => void) | undefined
ipcRenderer.on(EDITOR_RPC_MESSAGE, (_event, id: unknown, call: unknown) => {
  if (id === session && isEditorMessage(call)) receive?.(call)
})
const bridge: DesktopBridge = {
  async setHandleCall(callback) {
    if (receive) throw new Error('Workbench RPC is already connected')
    receive = callback
    await ipcRenderer.invoke(EDITOR_RPC_CONNECT, session)
  },
  async post(call) {
    await ipcRenderer.invoke(EDITOR_RPC_MESSAGE, session, call)
  },
}
contextBridge.exposeInMainWorld('adeDesktop', bridge)

import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  sidebarStateSchema,
  type SidebarAction,
  type SidebarState,
} from '../../../../src/shared/sidebar.ts'
import { Sidebar } from './Sidebar'

declare function acquireVsCodeApi(): {
  postMessage(message: SidebarAction): void
}
const api = acquireVsCodeApi()
const send = (message: SidebarAction) => api.postMessage(message)
function App() {
  const [state, setState] = useState<SidebarState>({
    type: 'state',
    chats: [],
    selectedProvider: 'codex',
  })
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const message = sidebarStateSchema.safeParse(event.data).data
      if (message) setState(message)
    }
    window.addEventListener('message', receive)
    send({ type: 'ready' })
    return () => window.removeEventListener('message', receive)
  }, [])
  return <Sidebar state={state} send={send} />
}
createRoot(document.getElementById('root')!).render(<App />)

import { useEffect, useState } from 'react'
import type { Chat } from '../../src/shared/api'
import type { ChatsMessage } from '../shared/api'
import { ChatList } from './ChatList'

declare function acquireVsCodeApi(): {
  postMessage(message: { type: 'ready' }): void
}

const vscode = acquireVsCodeApi()

export function App() {
  const [chats, setChats] = useState<Record<string, Chat>>()
  useEffect(() => {
    const receive = (event: MessageEvent<ChatsMessage>) => {
      if (event.data.type === 'chats') setChats(event.data.chats)
    }
    window.addEventListener('message', receive)
    vscode.postMessage({ type: 'ready' })
    return () => window.removeEventListener('message', receive)
  }, [])
  return <ChatList chats={chats} />
}

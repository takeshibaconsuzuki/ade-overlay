import { useEffect, useState } from 'react'
import { Box, Button } from '@radix-ui/themes'
import type { Chat } from '../../src/shared/api'
import type { ChatsMessage, SidebarMessage } from '../shared/api'
import { ChatList } from './ChatList'

declare function acquireVsCodeApi(): {
  postMessage(message: SidebarMessage): void
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
  return (
    <>
      <Box px="4" py="3">
        <Button onClick={() => vscode.postMessage({ type: 'startCodex' })}>
          Codex
        </Button>
      </Box>
      <ChatList
        chats={chats}
        onOpenChat={(id) => vscode.postMessage({ type: 'openChat', id })}
      />
    </>
  )
}

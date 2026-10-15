import { useEffect, useState } from 'react'
import { Box, Button } from '@radix-ui/themes'
import type { ChatsMessage, SidebarMessage } from '../shared/api'
import { ChatList } from './ChatList'

declare function acquireVsCodeApi(): {
  postMessage(message: SidebarMessage): void
}

const vscode = acquireVsCodeApi()

export function App() {
  const [snapshot, setSnapshot] = useState<ChatsMessage>()
  useEffect(() => {
    const receive = (event: MessageEvent<ChatsMessage>) => {
      if (event.data.type === 'chats') setSnapshot(event.data)
    }
    window.addEventListener('message', receive)
    vscode.postMessage({ type: 'ready' })
    return () => window.removeEventListener('message', receive)
  }, [])
  return (
    <>
      <Box px="4" py="3">
        <Button
          style={{ width: '100%' }}
          onClick={() => vscode.postMessage({ type: 'startCodex' })}
        >
          Codex
        </Button>
      </Box>
      <ChatList
        chats={snapshot?.chats}
        selectedChatId={snapshot?.selectedChatId}
        onOpenChat={(id) => vscode.postMessage({ type: 'openChat', id })}
      />
    </>
  )
}

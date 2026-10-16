import { useEffect, useState } from 'react'
import { ChevronDownIcon } from '@radix-ui/react-icons'
import { Box, Button, DropdownMenu, Flex, IconButton } from '@radix-ui/themes'
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
  const selectedProvider = snapshot?.providers.find(
    (provider) => provider.id === snapshot.selectedProviderId,
  )
  return (
    <>
      <Box px="4" py="3">
        <Flex role="group" aria-label="Start chat">
          <Button
            className="chat-start-button"
            disabled={!selectedProvider}
            onClick={() => {
              if (selectedProvider)
                vscode.postMessage({
                  type: 'startChat',
                  providerId: selectedProvider.id,
                })
            }}
          >
            <span className="chat-provider-name">
              {selectedProvider?.name ?? 'Start chat'}
            </span>
          </Button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <IconButton
                className="chat-provider-trigger"
                aria-label="Select chat provider"
                title="Select chat provider"
                disabled={!snapshot?.providers.length}
              >
                <ChevronDownIcon />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content className="chat-provider-menu" align="end">
              <DropdownMenu.RadioGroup value={selectedProvider?.id ?? ''}>
                {snapshot?.providers.map((provider) => (
                  <DropdownMenu.RadioItem
                    key={provider.id}
                    value={provider.id}
                    onSelect={() =>
                      vscode.postMessage({
                        type: 'startChat',
                        providerId: provider.id,
                      })
                    }
                  >
                    {provider.name}
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </Flex>
      </Box>
      <ChatList
        chats={snapshot?.chats}
        selectedChatId={snapshot?.selectedChatId}
        onOpenChat={(id) => vscode.postMessage({ type: 'openChat', id })}
      />
    </>
  )
}

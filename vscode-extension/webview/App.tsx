import { useEffect, useState } from 'react'
import { ChevronDownIcon } from '@radix-ui/react-icons'
import { Box, Button, DropdownMenu, Flex, IconButton } from '@radix-ui/themes'
import type { ChatsMessage, SidebarMessage } from '../shared/api'
import { ChatList } from './ChatList'

declare function acquireVsCodeApi(): {
  postMessage(message: SidebarMessage): void
}

const vscode = acquireVsCodeApi()

function TerminalIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M3.5 2A1.5 1.5 0 0 0 2 3.5v8A1.5 1.5 0 0 0 3.5 13h8a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 11.5 2h-8ZM3 3.5a.5.5 0 0 1 .5-.5h8a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8Z"
      />
      <path d="M4.65 5.15a.5.5 0 0 1 .7 0l2 2a.5.5 0 0 1 0 .7l-2 2a.5.5 0 1 1-.7-.7L6.29 7.5 4.65 5.85a.5.5 0 0 1 0-.7ZM7.5 9.5h3v1h-3v-1Z" />
    </svg>
  )
}

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
      <Flex role="toolbar" aria-label="Utilities" px="4" pt="3" gap="2">
        <IconButton
          variant="soft"
          aria-label="New terminal"
          title="New terminal"
          onClick={() => vscode.postMessage({ type: 'openTerminal' })}
        >
          <TerminalIcon />
        </IconButton>
      </Flex>
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

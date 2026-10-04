import {
  Button,
  ChoiceMenu,
  Notice,
  SkeletonLine,
  Spinner,
  UIProvider,
  WorktreeName,
} from '../../../../src/shared/ui/components'
import {
  chatProviderOptions,
  launchProviderSchema,
  type SidebarAction,
  type SidebarState,
} from '../../../../src/shared/sidebar.ts'
import './sidebar.css'

export function Sidebar({
  state,
  send,
}: {
  state: SidebarState
  send: (action: SidebarAction) => void
}) {
  const provider = chatProviderOptions.find(
    (provider) => provider.id === state.selectedProvider,
  )!
  return (
    <UIProvider>
      <main className="chat-sidebar" aria-label="ADE terminals and chats">
        <div className="chat-launchers">
          <Button
            tone="secondary"
            onClick={() => send({ type: 'launch', kind: 'terminal' })}
          >
            Terminal
          </Button>
          <div className="chat-provider-button">
            <Button
              onClick={() =>
                send({ type: 'launch', kind: state.selectedProvider })
              }
            >
              {provider.label}
            </Button>
            <ChoiceMenu
              value={state.selectedProvider}
              items={chatProviderOptions}
              onChange={(value) =>
                send({
                  type: 'select-provider',
                  provider: launchProviderSchema.parse(value),
                })
              }
            >
              <Button
                className="chat-provider-dropdown"
                aria-label="Select chat provider"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="m4 6 4 4 4-4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Button>
            </ChoiceMenu>
          </div>
        </div>
        {state.error && <Notice>{state.error}</Notice>}
        <ul className="chat-list" aria-label="Live chats">
          {state.chats.map((chat) => {
            const worktree =
              chat.path.split(/[/\\]/).filter(Boolean).at(-1) ?? chat.path
            return (
              <li key={chat.id}>
                <button
                  className="chat-row"
                  onClick={() => send({ type: 'open', chatId: chat.id })}
                  aria-label={`Open ${chat.title || 'chat'} in ${worktree}`}
                  aria-current={
                    state.activeChatId === chat.id ? 'true' : undefined
                  }
                >
                  <span
                    className="chat-status"
                    role="img"
                    aria-label={
                      chat.activity === 'working' ? 'Working' : 'Idle'
                    }
                    title={chat.activity === 'working' ? 'Working' : 'Idle'}
                  >
                    {chat.activity === 'working' ? (
                      <Spinner />
                    ) : (
                      <span className="chat-idle-dot" />
                    )}
                  </span>
                  <span className="chat-content">
                    <WorktreeName
                      className="chat-worktree"
                      title={chat.path}
                      color={chat.color}
                    >
                      {worktree}
                    </WorktreeName>
                    <span className="chat-title" title={chat.title}>
                      {chat.title || (
                        <SkeletonLine label="Loading chat title" />
                      )}
                    </span>
                    <span className="chat-message" title={chat.message}>
                      {chat.message || (
                        <span
                          className="chat-message-skeleton"
                          role="img"
                          aria-label="Loading chat message"
                        >
                          <SkeletonLine label="" />
                          <SkeletonLine label="" />
                          <SkeletonLine label="" />
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        {state.chats.length === 0 && (
          <p className="chat-empty">No live chats</p>
        )}
      </main>
    </UIProvider>
  )
}

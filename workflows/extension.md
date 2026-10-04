# Workspace extension

- The extension runs with the workspace on the companion machine. It owns terminal placement, terminal identities, the ADE sidebar, and destination terminal focus.
- Codex and Claude commands launch provider terminals and report [live chat activity](chats.md#report-chat-activity).
- Sources: [activation](../extensions/ade-terminals/src/extension.ts), [launcher](../extensions/ade-terminals/src/launcher.ts), [terminal identities](../extensions/ade-terminals/src/terminal-identities.ts), [chat controller](../extensions/ade-terminals/src/chats.ts), [sidebar](../extensions/ade-terminals/src/sidebar.ts).

## Activate and connect

```mermaid
sequenceDiagram
    participant Code as VS Code workspace
    participant Extension
    participant Chats as Companion chat service
    participant Sidebar
    Code->>Extension: Activate ADE extension
    Extension->>Extension: Restore saved terminal identities and<br/>register launch actions
    Extension->>Chats: /extension connection with editor control<br/>credential and activation identity
    Chats->>Chats: Replace an older extension connection for<br/>this editor
    Chats-->>Extension: Current global chat snapshot
    Extension-->>Sidebar: Chats, remembered provider, and active chat<br/>selection
    Note over Extension,Sidebar: Extension is connected and the initial<br/>sidebar state is available
```

- The control credential enters only the extension host and is removed from its inherited environment before extension-spawned processes can receive it. Provider terminals receive activity-reporting access instead.
- A new extension activation replaces older control connections; a reconnect from an obsolete activation cannot reclaim ownership.
- The extension automatically reconnects after connection loss while it remains active.
- Sidebar actions [launch terminals](#launch-a-terminal) or request [chat opening](chats.md#open-a-chat). Choosing a provider both remembers the choice and launches it.
- Extension deactivation stops its observers and connection without killing workspace terminals. Terminal restoration and placement ownership have separate lifetimes.

## Update the sidebar

```mermaid
flowchart TD
    Snapshot([Chat snapshot arrives]) --> Compose[Combine shared chats, provider choice, and local terminal selection]
    Selection([Owned provider group's active tab changes]) --> Compose
    Ready([Sidebar webview becomes ready]) --> Compose
    Compose --> Publish[Send sidebar state to the current webview]
    Publish --> Visible([Rows and current-chat highlight reflect the latest state])
```

- Selection follows the active terminal tab in the group owned by this launcher, even when another editor group has focus. Terminal identity restoration can make that selection match a live conversation later.
- Chat snapshots and local selection changes update the sidebar without waiting for launch or navigation completion.

## Launch a terminal

```mermaid
flowchart TD
    Action([User launches a shell or provider]) --> Queue[Wait for the shared placement and focus queue]
    Queue --> Kind{Terminal kind?}
    Kind -->|Provider| Group[Prepare a locked provider group]
    Group --> Provider[Create and focus terminal, persist its identity in the background]
    Provider --> Command[Run the project’s provider command]
    Command --> ProviderDone([Provider terminal launched])
    Kind -->|Ordinary shell| Shell[Create and focus terminal using normal editor placement]
    Shell --> ShellDone([Ordinary shell ready in an unlocked group])
    click Group "extension.md#prepare-a-provider-group"
    click Provider "extension.md#restore-terminal-identities"
```

- Launches and resolved chat focus share one queue because group changes affect the whole workbench. Process discovery and identity recovery run outside that queue.
- A terminal uses the single workspace folder as its working directory. Provider terminals receive a new terminal ID and immediately start [identity persistence](#restore-terminal-identities).
- The companion supplies the project’s `chatCommands` from `server.yaml` to every worktree editor. Omitted commands use `codex --no-daemon` and `claude`; extension settings do not configure launches.
- The shell runs the configured command on the workspace machine. If placement fails after terminal creation, the new terminal is disposed.

## Prepare a provider group

```mermaid
flowchart TD
    Request([Queued provider launch needs a group]) --> Resolve[Reuse owned group, otherwise claim an empty group or create one to the right]
    Resolve --> Focus[Focus and lock the selected group]
    Focus --> Ready([Return the group for provider terminal placement])
```

- Provider group ownership lasts only for the current extension activation and is released if the group disappears or becomes empty. Saved terminal identities do not grant ownership of restored editor groups.
- Locking keeps ordinary file opens from displacing the provider group. Ordinary shells use VS Code's normal routing around locked groups.

## Finish a provider terminal

```mermaid
flowchart LR
    Exit([Provider command finishes]) --> Shell[Shell exits and VS Code closes its terminal]
    Shell --> Cleanup[Active extension releases terminal identity and selection]
    Cleanup --> Done([Provider terminal is removed from the workbench])
```

- The [provider shell command](../extensions/ade-terminals/src/provider-command.ts) owns exit cleanup even if the desktop or extension disconnects. Ordinary shells remain until they exit or the user closes them.
- Closing a terminal does not directly remove a live chat. The companion runs [process reconciliation](chats.md#schedule-chat-maintenance) in the background to detect provider exits and remove their conversations.

## Restore terminal identities

```mermaid
sequenceDiagram
    participant Trigger as Launch, activation, or terminal restoration
    participant Identities as Terminal identity owner
    participant Processes as Host process list
    participant Storage as Workspace state
    Trigger->>Identities: Register a new ID or recover a restored<br/>terminal
    Identities->>Processes: Resolve terminal process identity
    Processes-->>Identities: Process ID and start time
    alt Explicitly registered terminal
        Identities->>Storage: Save terminal ID with its current process<br/>identity
        Note over Identities: New terminal is addressable immediately
    else Saved identity matches the live process
        Identities->>Identities: Restore the terminal ID
        Identities->>Storage: Retain live identities and remove stale ones
        Note over Identities: Restored terminal becomes addressable by<br/>chat navigation
    else No matching saved identity
        Identities->>Identities: Leave terminal without an ADE identity
    end
    Note over Identities: If process discovery is not ready, retry<br/>after 2 seconds outside the placement queue
```

- Process start time distinguishes a surviving shell from a reused process ID. Recovery never overwrites a newer explicit registration.
- Closing a terminal cancels its recovery and removes its saved identity. Deactivation stops recovery while preserving saved workspace state for the next activation.

## Focus a chat terminal

```mermaid
flowchart TD
    Request([Companion sends chat focus request]) --> Restore[Wait for the requested terminal identity to become available]
    Restore --> Queue[Enter the shared placement and focus queue]
    Queue --> Current{Request still current and terminal still live?}
    Current -->|Yes| Show[Show terminal and wait until it is active]
    Show --> Acknowledge([Acknowledge terminal focus to the companion])
    Current -->|No| Cancel([Return unavailable or superseded result])
    Restore --> Expire([Cancel on supersession, disconnect, or 8-second deadline])
    Show --> Expire
```

- Waiting for restoration does not hold the workbench queue. The focus acknowledgement completes the companion's [chat open](chats.md#open-a-chat).
- A newer request or cancellation prevents an older request from subsequently taking focus.

# Desktop

- Main owns the companion connection, accepted snapshot, credentials, and navigation. The picker renderer owns search, dialogs, and temporary interaction state.
- Sources: [main entry point](../src/main/index.ts), [connection](../src/main/companion-client.ts), [state](../src/main/companion-state.ts), [navigation](../src/main/editor-navigation.ts), [picker](../src/renderer/src/App.tsx).

## Connect to the companion

```mermaid
flowchart TD
    Launch([Desktop launched]) --> Config[Load desktop connection configuration]
    Config --> Shortcut{Register global picker shortcut}
    Shortcut -->|Succeeded| Start[Show picker and start connection]
    Shortcut -->|Failed| Normal[Keep picker as a normal window]
    Normal --> Start
    Retry([User selects Reconnect]) --> Reset[Cancel current navigation and replace connection]
    Lost([Connection lost]) --> ResetState[Clear displayed snapshot and cancel navigation]
    ResetState --> Automatic[Automatically retry connection]
    Start --> Connect[Connect to /companion using main-owned credential]
    Reset --> Connect
    Automatic --> Connect
    Connect --> Hello[Wait for compatible companion handshake]
    Hello --> Fetch[Mark connected and request worktrees:list]
    Fetch --> Accept[Accept current shared state]
    Accept --> Ready([Picker shows available worktrees])
    Hello --> Settings[Request settings synchronization for retained pages]
    Settings --> Background([Settings pass runs in the background])
    click Accept "desktop.md#accept-shared-state"
    click Settings "settings.md#schedule-synchronization"
```

- File configuration supplies the companion URL and optional token; environment configuration overrides it. Invalid configuration prevents desktop startup.
- A connection must complete protocol discovery before other companion events are accepted. The companion [authenticates the connection](companion.md#admit-connections).
- Reconnect resets snapshot ordering. Retained editor pages stay alive while the companion connection is unavailable.

## Accept shared state

```mermaid
flowchart TD
    Incoming([Worktree reply or broadcast arrives]) --> Store[Main accepts only newer state from its current connection]
    Store --> Reconcile[Reconcile retained pages with accepted membership]
    Reconcile --> Publish[Publish state to the picker]
    Publish --> Visible([Picker and retained views reflect the same membership])
```

- Connection and refresh requests read through main; command completion does not return snapshots to the renderer.
- Reconciliation removes pages for absent worktrees. A stopped editor status alone does not dispose its page.
- Shared row state survives desktop reconnection because the companion owns it. [Worktree membership](worktrees.md#refresh-and-apply-membership) remains separate from operation and editor status.

## Toggle the worktree picker

```mermaid
flowchart TD
    Shortcut([User presses Ctrl/Cmd+Shift+Space in any application]) --> Focused{Picker has keyboard focus?}
    Focused -->|Yes| Hidden[Main hides the picker without minimizing it]
    Blur([Picker window loses focus]) --> Registered{Global shortcut registered?}
    Escape([User presses Escape in the search field]) --> Registered
    Registered -->|Yes| Hidden
    Registered -->|No| Visible([Keep picker visible])
    Hidden --> Cleared([Renderer clears the search and resets results])
    Focused -->|No| Focus[Main restores the picker if minimized, then shows and focuses it]
    Focus --> Ready([Worktree picker has keyboard focus])
```

- Main registers the global shortcut before showing the picker or connecting to the companion and releases it on quit. If registration fails, startup continues with a normal window that stays visible on blur and Escape and can be minimized and restored through the desktop.
- Dismissal clears search and resets selection and scrolling, including when the search is already empty.
- Explicit dismissal returns focus to the window used before opening the picker. Hiding after focus moves elsewhere preserves that destination. Windows and Linux/X11 capture a native window identity before showing the picker; macOS uses a nonactivating panel, and Wayland delegates the handoff to its compositor. Closed targets and denied activation requests fall back to the operating system's normal hide behavior.

## Open a worktree

```mermaid
sequenceDiagram
    actor User
    participant Picker
    participant Main as Desktop navigation
    participant Server as Companion
    participant Window as Editor window
    User->>Picker: Activate an available worktree
    Picker->>Main: openEditor through trusted preload bridge
    Main->>Main: Supersede the previous selection request
    Main->>Server: editor:open, wait for editor preparation
    Note over Server: Git queue registers startup, then releases<br/>it during readiness waits
    Server-->>Main: Ready editor session and credential
    Main->>Window: Select editor page, wait for document<br/>readiness
    Window-->>Main: Page ready
    Main-->>Picker: Opening completed
    Note over User,Window: Selected worktree is visible, process and<br/>page have separate lifetimes
```

- The server performs [editor preparation](editors.md#prepare-an-editor); the window performs [page selection](editor-pages.md#select-an-editor-page). Opening completes after both.
- Search filters basename and branch. Pointer or keyboard activation skips disconnected, prunable, missing, and mutating worktrees. Progress updates preserve a still-valid selection; changed search results reset it.
- Create and delete dialogs suspend picker interaction and invoke [worktree mutations](worktrees.md#schedule-a-mutation). Dismissing a dialog does not cancel an accepted server operation.
- An opening failure becomes a companion row error; if main cannot store it there, the picker retains a local error. Opening an editor does not clear an existing error.

## Notify when a chat becomes idle

```mermaid
sequenceDiagram
    participant Chats as Companion registry
    participant Main as Desktop main
    participant OS as Desktop notifications
    actor User
    Chats->>Chats: Accept working to idle for the same chat
    Chats-->>Main: chat:idle with title and message
    Main->>OS: Show notification
    User->>OS: Click notification
    OS->>Main: Open the notified chat
    Main->>Chats: chat:activate, wait for terminal focus
    Note over Chats,Main: Run shared chat navigation
    Chats-->>Main: Terminal focused or navigation failed
    Main-->>User: Chat is visible, or show opening error
```

- Notifications use the chat title and latest message, falling back to the worktree path when no message is available. They also appear while the desktop is focused, subject to operating-system notification settings.
- Only accepted working-to-idle transitions notify. Initial idle reports, repeated idle reports, title updates, session replacement, and process removal do not. Transitions while disconnected are not replayed.
- Each chat retains at most one notification. A later notification replaces it; clicking, disconnecting, or quitting clears it.
- Clicks use [chat navigation](chats.md#navigate-to-a-chat), including terminal acknowledgement and stale-chat errors. Notification navigation requires exactly one connected desktop, as sidebar navigation does.

## Supersede navigation

```mermaid
flowchart TD
    Event([New selection, reconnect, or connection loss]) --> Cancel[Invalidate the current desktop navigation]
    Cancel --> Effects[Suppress its later selection and completion effects]
    Effects --> Finish[For chat navigation, report supersession to the companion]
    Finish --> Continue[Keep shared startup and retained page loading alive]
    Continue --> Done([Current visible view remains until another selection changes it])
```

- Picker and [chat navigation](chats.md#navigate-to-a-chat) share this coordinator. Chat requests remain current until the companion reports terminal completion.
- A page that finishes loading after another page is selected never reselects itself.

## Close a window

```mermaid
flowchart TD
    Close([User closes a desktop window]) --> Which{Which window?}
    Which -->|Editor window| Hide[Hide its active view and release the native window]
    Hide --> Retained([Picker stays open, editor pages stay retained])
    Which -->|Picker or application quit| Stop[Stop settings synchronization and close every editor page]
    Stop --> Disconnect[Disconnect from the companion]
    Disconnect --> Exit([Desktop exits, companion editor processes keep running])
```

- Desktop shutdown does not wait for editor unload approval, saves, backups, or settings synchronization. Recent unsaved browser state can be lost.
- [Companion shutdown](companion.md#stop-the-companion) is a separate lifecycle.

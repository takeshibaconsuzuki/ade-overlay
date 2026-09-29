# Companion

- The companion account owns configured repositories, Git commands, local VS Code resources, and editor processes. The companion keeps running when desktop clients disconnect.
- Sources: [service composition](../src/server/server.ts), [entry point](../src/server/index.ts), [companion transport](../src/server/companion-transport.ts), [configuration](../src/server/config.ts).

## Start the companion

```mermaid
sequenceDiagram
    participant Host as Companion entry point
    participant Store as Worktree store
    participant Chats as Chat service
    participant Listener as Public listener
    participant Runtime as Editor runtime owner
    Host->>Host: Load and validate configuration
    Host->>Store: Discover configured main worktrees, wait for<br/>initial membership
    Store-->>Host: Initial snapshot ready
    Host->>Chats: Open local activity and extension service
    Chats->>Chats: Start process and title maintenance<br/>schedules
    Chats-->>Host: Local service ready
    Host->>Listener: Open companion and editor transport listener
    Listener-->>Host: Accepting connections
    Host->>Runtime: Start shared runtime preparation<br/>in the background
    Note over Host,Listener: Companion is ready before runtime<br/>preparation completes
    Runtime->>Runtime: Prepare runtime for later editor requests
```

- Startup discovery applies [Git membership](worktrees.md#refresh-and-apply-membership) before the public listener opens. Configuration must identify main worktree roots; an absent default configuration produces an empty project list.
- [Runtime preparation](editors.md#prepare-the-shared-runtime) is shared with later editor requests. [Chat maintenance](chats.md#schedule-chat-maintenance) continues for the service lifetime.
- Configuration is loaded at startup. Changing it requires restarting the companion.

## Admit connections

```mermaid
flowchart TD
    Request([Connection or request arrives]) --> Boundary{Requested service?}
    Boundary -->|/companion| Desktop[Reject browser origins, check configured companion token]
    Desktop --> Handshake[Send protocol handshake and accept worktree commands]
    Handshake --> Connected([Desktop connected, shared snapshots are broadcast])
    Boundary -->|/editors/| Editor[Authenticate and route editor traffic]
    Editor --> EditorResult([Editor resource or connection returned])
    Boundary -->|Local chat service| Chat[Authenticate editor-scoped activity or extension credential]
    Chat --> ChatResult([Accept activity reports or extension control connection])
    click Editor "editors.md#serve-editor-traffic"
    click Chat "extension.md#activate-and-connect"
```

- Editor pages can only reserve and submit terminal pastes through their narrow desktop bridge; main proxies target queries to the companion. Main holds the companion credential; editor traffic uses a separate credential per running editor.
- Chat reporting and extension control use distinct credentials on the loopback service. Terminal processes receive reporting access, while the extension host receives navigation control.
- Command admission stops during shutdown. Each transport owns its connections, subscriptions, and timers.

## Stop the companion

```mermaid
sequenceDiagram
    participant Host as Companion lifecycle
    participant Store as Worktree store
    participant Transport as Public and chat transports
    participant Editors as Editor processes
    Host->>Store: Stop admitting worktree requests
    Host->>Transport: Stop listener and close active connections
    Transport->>Transport: Finish pending chat navigation, stop<br/>maintenance
    Host->>Store: Wait for admitted requests and queued<br/>operations
    Note over Store: Includes creation paths still being resolved<br/>when shutdown began
    Store-->>Host: Accepted work drained
    Host->>Editors: Cancel preparation and stop every editor
    Editors-->>Host: Processes stopped, accepted settings writes<br/>settled
    Host-->>Host: Companion shutdown complete
```

- Startup failure uses the same cleanup path.
- Closing transports happens before waiting for accepted work; disconnected clients do not cancel queued mutations.
- [Editor stopping](editors.md#editor-process-lifetime) preserves workspace data directories for later starts.

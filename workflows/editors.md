# Editor servers

- An editor server is the companion's VS Code server for one worktree. The companion owns one process per opened worktree, shared by all clients. The desktop's editor window shows it in a [retained page](editor-pages.md). Stable worktree identities retain workspace data across process restarts; each process start receives a fresh access credential.
- All editors share the companion account's local VS Code extensions directory and settings service. Workspace server data remains separate for each worktree.
- Sources: [editor manager](../src/server/editors/editor-manager.ts), [runtime owner](../src/server/editors/vscode-runtime.ts), [editor transport](../src/server/editors/editor-transport.ts), [profile preparation](../src/server/editors/local-vscode.ts).

## Prepare an editor

```mermaid
sequenceDiagram
    participant Caller as Desktop request
    participant Store as Worktree store
    participant Editors as Editor manager
    Caller->>Store: companionStartEditorServer
    Store->>Store: Refuse a row with a running operation, a stopping<br/>editor, or a worktree missing from cached membership
    Store->>Store: Save the worktree's color
    Store->>Store: Confirm the worktree is still present and idle
    Store->>Editors: Reuse session or start shared editor<br/>preparation
    Store->>Editors: Wait for the shared session to become ready
    Editors-->>Caller: Ready editor identity and access credential
```

- Opening waits only for its own worktree. Creations, deletions, and rescans elsewhere do not delay it, and an already running editor answers immediately.
- The second check lets a deletion or [rescan](worktrees.md#rescan-a-project) that began during the color save win. The editor is registered in the same step as that check.
- A stopping editor refuses opens without retaining a row error. Opening again after it has stopped starts a fresh process.
- A new session starts [editor server preparation](#start-an-editor-server). Multiple opens share a pending start instead of launching duplicate processes; existing sessions reuse the same readiness result.
- Process readiness completes the server request. The desktop must still [load the editor page](editor-pages.md#select-an-editor-page).

## Start an editor server

```mermaid
flowchart TD
    Start([A new editor start is registered]) --> Environment[Publish starting state and prepare shared local resources]
    Environment --> Runtime[Wait for shared runtime preparation]
    Runtime --> Launch[Start VS Code with persistent workspace data]
    Launch --> Health[Wait for authenticated workbench readiness]
    Health --> Ready([Publish running state and resolve the shared session])
    click Runtime "editors.md#prepare-the-shared-runtime"
```

- Environment preparation reads local profile resources and creates the shared settings service. Later [document delivery](settings.md#initialize-the-browser-profile) lets VS Code initialize a browser profile.
- VS Code runs on loopback behind the companion proxy. It automatically trusts the configured workspace, enables persistent terminal sessions, and avoids automatic Python environment commands in provider terminals.

## Prepare the shared runtime

```mermaid
flowchart TD
    Request([Startup prefetch or editor preparation requests runtime]) --> Shared{Preparation already running or ready?}
    Shared -->|Yes| Join[Join the shared result]
    Shared -->|No| Cached{Prepared runtime available on disk?}
    Cached -->|Yes| Validate[Validate the retained runtime]
    Cached -->|No| Download[Use local VS Code to obtain the approved server runtime]
    Download --> Prepare[Prepare and validate a reusable runtime copy]
    Validate --> Ready([Runtime ready for editor starts])
    Prepare --> Ready
    Join --> Ready
```

- [Companion startup](companion.md#start-the-companion) starts this work in the background; [editor preparation](#prepare-an-editor) waits for its result when needed.
- Progress is shared with waiting editor rows. Failed preparation can be retried by a later open; stopping one worktree does not cancel preparation shared by other worktrees.

## Editor server lifetime

```mermaid
stateDiagram-v2
    [*] --> Stopped
    Stopped --> Starting: Open a worktree
    Starting --> Running: VS Code accepts authenticated requests
    Starting --> Stopped: Preparation fails
    Running --> Stopped: Process exits
    Starting --> Stopping: Delete, removed membership, or companion shutdown
    Running --> Stopping: Stop, delete, removed membership, or companion shutdown
    Stopping --> Stopped: Release chat control and stop process
    Running --> Running: Desktop disconnects or closes editor window
```

- Every stop publishes stopping status in the same step that begins it, before waiting for the process. The picker shows the row as busy and unavailable until it is stopped.
- Process exit releases its editor registration and publishes stopped status. [Chat reconciliation](chats.md#reconcile-live-processes) separately decides when chat records disappear.
- Deletion and accepted membership removal cancel pending starts and stop running editors. Companion shutdown cancels shared preparation and stops all editors.
- The picker row menu offers **Stop VS Code server** for any worktree with a running editor, including the main worktree. It is unavailable while the editor starts or the picker is opening it, so an explicit stop never surfaces as an opening failure. `companionStopEditorServer` keeps membership and is refused during startup, during another stop, or while a creation or deletion owns the row. Retained desktop pages stay until the worktree is reopened, which starts a fresh process with a new access credential.
- Workspace data remains on disk. VS Code's reconnection grace governs disconnected extension hosts and terminals; it does not determine the companion-owned process lifetime.

## Serve editor traffic

```mermaid
sequenceDiagram
    participant Page as Retained editor page
    participant Main as Desktop request authentication
    participant Proxy as Companion editor transport
    participant Code as Worktree VS Code server
    Page->>Main: Request an editor resource or WebSocket
    Main->>Proxy: /editors/ traffic with the matching editor<br/>credential
    Proxy->>Proxy: Authenticate editor identity and replace<br/>only the VS Code auth cookie
    alt Main workbench document
        Proxy->>Code: Fetch document
        Code-->>Proxy: Workbench HTML
        Proxy->>Proxy: Attach initial profile, startup layout,<br/>settings bridge, and chat activation baseline
        Proxy-->>Page: Prepared document
    else Other editor resource or WebSocket
        Proxy->>Code: Forward authenticated traffic
        Code-->>Page: Resource or live connection through proxy
    end
```

- Main supplies credentials only for the matching companion origin and editor path. The proxy removes the app authorization header before forwarding to VS Code and preserves other browser cookies, including display language.
- The [initial profile](settings.md#initialize-the-browser-profile) seeds a new browser profile. The activation baseline makes [chat opening](chats.md#open-a-chat) wait for an extension belonging to the new document.
- Each fresh document opens the ADE sidebar through VS Code's startup layout. The secondary sidebar containing Chat starts hidden by default; explicit settings and saved visibility take precedence, so later user changes are remembered.
- Authenticated settings requests are handled by the companion's [settings service](settings.md#synchronize-one-snapshot) rather than forwarded to VS Code.

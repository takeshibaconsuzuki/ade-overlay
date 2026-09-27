# Contributor Commands

- `python scripts/bootstrap.py | iex` (PowerShell) or `eval "$(python scripts/bootstrap.py)"` (POSIX): set up the development environment by installing and activating Node.js and installing dependencies and Electron. Add `--force` to replace the vendored Node installation.
- `npm run dev`: start Electron/Vite.
- `npm run server`: build and start the companion in a separate terminal. Append `-- --config path/to/server.yaml` to select a config.
- `npm run server:dev`: run the companion with file watching; accepts the same config argument.
- `npm run build` / `npm run build:server`: build everything / just the companion into `out/`.
- `npm run build:extension`: package the workspace extension as `out/ade-terminals.vsix`.
- `npm run package`: build desktop installers and a companion archive for the host OS and architecture into `dist/`. Use the Node runtime pinned in `.node-version`. `npm run package:dir` skips desktop installers for local checks.
- `npm run test:package`: smoke-test the extracted companion without system Node, extension setup and desktop package contents after packaging.
- `npm run test:extension`: run isolated VS Code extension-host tests; set `ADE_TEST_VSCODE_EXECUTABLE` to an existing VS Code executable to avoid downloading a test runtime.
- `npm run typecheck`: check app, companion, and tests.
- `npm test`: run socket and temporary Git repository integration tests. Git must be on PATH.
- Set `ADE_TEST_VSCODE_RUNTIME` to a VS Code web server distribution and run `npm run build` followed by `npm test` to also check the real editor window, worktree switching and restoration across desktop restarts.
- `npm run lint` / `npm run lint:fix`: check / fix ESLint issues.
- `npm run format`: format with Prettier.
- `npm run upgrade`: upgrade dependencies to the latest peer-compatible versions, pin them, and install.

## Server Deployment

The companion runs independently of the desktop app. Release archives include Node, locked production dependencies and the matching VSIX. Extract to a stable path on a machine with Git and VS Code, supply the configuration, install the bundled extension and run the launcher under the repository owner's account. Worktree paths refer to that machine's filesystem.

## Packaging

Desktop and companion payloads are staged separately from the root lockfile. The desktop contains only its runtime dependencies; external companion scripts stay on disk for Node and VS Code to execute. The root package version drives all artifacts, including the VSIX. Upgrades are manual and coordinated because restarting the companion stops its editors. Persistent state stays outside installation directories, with a stable desktop application-data identity.

The Package workflow builds and checks native artifacts on Windows, Linux and both Mac architectures. Manual runs can produce unsigned test builds; version tags must match `package.json` and require desktop signing on Windows and signing/notarization on macOS. Set `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD`, `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`, and `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` as Actions secrets. Local builds use electron-builder's `CSC_LINK` and `CSC_KEY_PASSWORD` variables; `ADE_REQUIRE_SIGNING=true` enforces release signing. Workflow artifacts are uploaded for review, not automatically published. Verify VS Code Server usage and redistribution terms before a public release; its binaries are downloaded by the installed CLI and are not included in our packages.

# Architecture

- Keep direct dependencies pinned to exact versions. Use `npm run upgrade` to update existing dependencies.
- Keep contributor information here and end-user instructions in `README.md`. Keep both short and easy to understand.
- Documentation guidelines:
  - Encode high-level design decisions and workflows here. Keep implementation details in the code.
  - Think about what a tech lead who is not very familiar with the codebase would need to know to make informed architectural decisions.
  - Keep only duration information; exclude non-durable information such as version.
  - Avoid enumeration; replace with the broader idea being referenced.
  - Workflow documentation guidelines:
    - Think about the important actions a user can take and workflows initiated by the server.
    - Use a mermaid sequence diagram with details where necessary. Start from the trigger and follow the automation to its natural end.
    - Avoid conditional branches in diagrams. Describe possible responses and their reactions on a single edge or note.
    - Document the endpoints and commands being called on the server.
    - Limit prose to what is not covered by the diagram.
- Delegate aggressively to well-maintained libraries, even when the current requirement is small or isolated. They usually handle edge cases better and give us a stronger base for future requirements.
- This project is still in development. Assume the server and client always run the same build.

## Codebase Layout

The desktop app separates presentation from privileged work. The renderer owns the UI, the main process owns connections and OS access, and preload provides a narrow bridge between them. The companion credential stays in the main process. App-owned UI components wrap the component library so it can be replaced without rewriting features.

The companion server owns configuration, Git operations, and the shared view of worktrees. Git is the source of truth for membership; the server keeps a cache so listing is fast. Pending operations and per-worktree errors are a server-owned overlay, included in snapshots and retained across desktop reconnects. Status precedence is pending operation, retained error, then editor running or stopped. Opening an editor preserves row errors until explicitly cleared. Synthetic creation rows never participate in editor reconciliation. Clearing an error removes a synthetic row only when Git has no corresponding worktree. Changes and refreshes run in order so concurrent clients see consistent results.

Every accepted Git worktree list follows one application path: reconcile editor processes against the complete list, then publish the resulting state. Project scans first merge with other projects' cached worktrees. Editor-status broadcasts do not change membership or trigger reconciliation.

The shared layer defines the contract between the app and server. Library-backed schemas validate incoming data and provide the matching types. Keep both sides of the contract in step when behavior changes.

The companion owns a VS Code web server process per opened worktree. Stable workspace data directories retain editor state; all processes use the companion account's local VS Code extensions directory. Startup is registered in the worktree queue, then download and readiness waits run independently so Git operations remain responsive. Deletion and shutdown cancel pending starts. Processes live until deletion, failure or companion shutdown, independently of desktop connections. The main process owns a single editor window with retained views and persistent browser storage. Editor views have no preload bridge or Node access. The main process supplies editor request credentials without exposing them through the worktree picker's preload bridge. VS Code manages its own editor-page session cookie.

The picker window owns the desktop app's lifetime on every platform: closing it quits the app and closes all editor views. Closing only the editor window immediately hides its retained views while the picker stays open. Desktop shutdown prioritizes responsiveness and does not honor editor unload vetoes or wait for saves, backups or settings synchronization. Losing recent unsaved edits or unfinished backups is an accepted tradeoff. Companion processes keep running, but cannot preserve browser state that was never saved. The server must never hold the client open.

Each retained editor page owns its current navigation state throughout its lifetime. Opening reuses ready pages, waits for loading pages, and replaces failed pages; token rotation also replaces the page. Only the current navigation can complete readiness, and disposal belongs to the specific view being removed. Readiness depends on the main document, independently of subresources.

The active editor view and its extension frames may use the clipboard and microphone; clipboard reads require a user gesture. Other browser permission requests remain denied. VS Code and Chromium retain their frame-level policies, and operating-system microphone permissions still apply. The editor proxy replaces only the authentication cookie, preserving browser preferences such as display language.

## Terminal Launcher Extension

The workspace extension in `extensions/ade-terminals` runs on the companion through its shared local extensions directory. Its sidebar webview reuses the main window's app-owned theme and UI components. A narrow validated message bridge accepts launch, provider selection and chat navigation actions; credentials remain in the extension host. Provider selection persists in extension global state. Provider terminals share a locked group remembered only during the current activation; ordinary terminals use VS Code's placement around locked groups and leave their destination unlocked for files. Empty groups are reused, and a single chat group fills the editor until ordinary content needs a separate group. Launches run sequentially because group focus is global workbench state. VS Code owns terminal titles and persistence. Activation does not adopt existing terminal groups or clean them up, and deactivation does not dispose terminals. Group locking governs default placement; users can still move tabs, rename terminals, and unlock groups.

```mermaid
sequenceDiagram
    participant User
    participant Extension as Workspace extension
    participant VSCode as VS Code workbench
    participant Shell as Companion shell
    User->>Extension: Sidebar launch action for Terminal or selected provider
    Note over Extension: Keep buttons available; queue launches and incoming terminal focus together
    Extension->>VSCode: Reuse an existing or empty group, creating a separate group only when needed
    Extension->>VSCode: createTerminal in editor area with workspace cwd and explicit chat viewColumn
    Note over Extension,VSCode: Lock provider group and unlock ordinary terminal group
    VSCode->>Shell: Start the configured default shell
    Extension->>Shell: sendText with configured foreground provider command and shell-owned exit
    Note over VSCode,Shell: Workspace session retains terminals independently of extension activation
    Shell->>VSCode: Exit when provider command finishes; close its terminal
```

## Live Chats

Provider adapters own hook configuration, payload mapping, process identification and conversation content. The companion merges its owned commands into global provider hooks under a file lock with atomic replacement; unrelated configuration is preserved. Reporters are bounded and fail quietly, identify the provider through local process ancestry, and send identity, activity and bounded message previews. Normal local CLIs remain unchanged.

Conversation titles are independent of terminal names. Codex previews come from prompt-submission and turn-end hooks; hooks without text preserve the last received message. The companion reads Codex resume titles from local metadata without writing it, honoring the provider home and database configuration. This internal metadata interface must be revalidated when Codex changes; unavailable content shows skeletons. Title refresh runs outside activity processing and retries during reconciliation. No historical transcript content is loaded. The extension forwards snapshots to its webview as plain text data and sends the latest state whenever the view becomes ready.

The companion owns an in-memory registry with only idle and working activity. Activity reports upsert chats; a later conversation replaces the entry for its terminal. Snapshots sort newest prompt or turn end first; tool activity and metadata refresh never reorder chats. Chats without an observed turn stay below those with one, with stable ties. Chat selection follows the active tab in the launcher's owned chat group, independently of focus in other groups. The launcher associates newly created chat tabs with terminal objects; the controller resolves them through validated local identities. Files in the owned group and group closure clear selection. Selection is local and never adopts layout groups across activations. All terminated-chat removal belongs to periodic process reconciliation using PID and start identity. Quiet idle chats never expire, and transport disconnection never changes their activity. Provider hook gaps are accepted; no remote provider observation supplements them.

Each editor gets separate activity and extension-control credentials for a dedicated authenticated loopback service. Terminals receive only the activity credential and an opaque terminal ID. The extension persists shell PID/start identity associations to recover restored terminals without adopting their layout groups. A new extension activation replaces stale control connections. Companion restart resets the registry; crash-survivor recovery is outside this lifecycle.

Process validation shares snapshots across queued requests only when the scan began after those requests arrived. Activity bursts share scan costs with terminal registration while registry updates retain their request order.

Control credentials reach the editor bootstrap over private IPC and are injected only when VS Code forks an extension host. The server and terminal environment never contain them. This startup interface must be revalidated against real native terminals and tasks when updating the runtime.

```mermaid
sequenceDiagram
    participant User
    participant Extension as Workspace extension
    participant Provider as Local provider and hook reporter
    participant Server as Companion loopback service
    participant OS as Local processes
    User->>Extension: Launch provider terminal
    Extension->>Server: WebSocket /extension inventory with terminal ID and shell PID
    Server->>OS: Validate shell identity
    Server-->>Extension: Accepted inventory with process start identity
    Extension->>Provider: Start configured command with ADE identification environment
    Provider->>OS: Hook identifies provider PID and start identity through ancestry
    Provider->>Server: POST /activity with session identity, idle or working and available message preview
    Note over Server: Validate terminal ancestry and report ordering, then upsert chat
    Server-->>Extension: Snapshot of chats across worktrees for sidebar rendering
    Note over Server: Read provider title metadata independently and publish updates when available
    loop Periodic reconciliation
        Server->>OS: Read process identities
        Note over Server: Remove chats whose provider or shell process has exited
        Server-->>Extension: Updated snapshot when membership changes
    end
```

Navigation targets the single connected desktop; ambiguous routing is rejected. The desktop selects its retained editor view or loads the worktree. Fresh pages must have a new destination extension activation before focus is dispatched. The companion owns navigation through terminal acknowledgement and notifies its desktop when it finishes. Completion invalidates pending desktop opens without stopping shared editor startup or retained pages. Requests have bounded waits, acknowledgements and supersession cancellation; stale connections cannot complete them.

Each served editor document records the activation it supersedes. Chat navigation keeps that baseline across repeated opens and waits for a different activation with the destination terminal in its inventory. Reloading replaces the baseline; retaining the document preserves it.

```mermaid
sequenceDiagram
    participant User
    participant Source as Sidebar extension
    participant Server as Companion
    participant App as Desktop main
    participant Target as Destination extension
    User->>Source: Click live chat
    Source->>Server: /extension activate with chat ID
    Server-->>App: /companion chat:activate with worktree
    App->>Server: /companion editor:open
    Server-->>App: Editor session
    Note over App: Select worktree through EditorWindow
    App->>Server: /companion chat:view-ready or error
    Target->>Server: /extension inventory after activation or restoration
    Server-->>Target: focus with terminal ID once view and extension are ready
    Target->>Target: Show terminal and await activeTerminal
    Target->>Server: focused acknowledgement or error
    Server-->>App: /companion chat:finished invalidates the matching navigation
    Server-->>Source: Result, including timeout or supersession errors
```

## Connections

The app's main process opens a WebSocket connection directly at `/companion`, independently of loading any editor page, so the server can push changes to every connected app. The main process handles authentication and reconnection. When configured, it supplies `ADE_COMPANION_TOKEN` as a bearer token during the upgrade; the operator sets the same shared secret on the app and server. The server rejects browser connections to `/companion`, while editor pages use separate connections under `/editors/`. Remote deployments require authentication and encrypted transport.

Worktree commands return the current list in a `worktrees` reply. Creation and deletion acknowledge acceptance before queued work runs; completion and failures arrive in snapshots. `worktrees:set-error` reports editor-page failures or clears a row error for every client. Changes and refreshes also broadcast `worktrees:updated` to all connected apps, including the requester. Rejected commands return `error` without disconnecting the app. Message fields and validation rules live in the shared contract.

## Startup

The server loads and validates its configuration, then discovers worktrees for all configured projects. It accepts connections only after the cache is ready. On accepting a connection, the server sends `hello` without waiting for a command. The app checks compatibility before requesting the cached list with `worktrees:list`.

```mermaid
sequenceDiagram
    participant App
    participant Server
    participant Git
    Note over Server: Load configuration
    Server->>Git: Discover configured worktrees
    Git-->>Server: Current worktrees
    Note over Server: Populate cache, then accept connections
    App->>Server: WebSocket upgrade /companion with authentication
    Server-->>App: hello
    Note over App: Check compatibility
    App->>Server: worktrees:list
    Server-->>App: worktrees (cached list)
```

## Steady State

The app and server independently initiate background heartbeats on `/companion`. Each peer automatically answers WebSocket ping control frames with pong. The server closes unresponsive connections; the app retries lost connections and reloads the list after reconnecting.

```mermaid
sequenceDiagram
    participant App
    participant Server as Server (/companion)
    loop Background connection checks
        par App heartbeat
            App->>Server: WebSocket ping control frame
            Server-->>App: WebSocket pong control frame
        and Server heartbeat
            Server->>App: WebSocket ping control frame
            App-->>Server: WebSocket pong control frame
        end
    end
```

## Worktree Updates

When an operation changes the cached Git state or a refresh completes, the server initiates a `worktrees:updated` broadcast on `/companion`. Every connected app receives the current list without polling, including the app that requested the operation. Apps use the newest update and ignore older responses. An app that missed updates while disconnected recovers through `worktrees:list` after reconnecting; both recovered lists and broadcasts close retained views for removed worktrees. External Git changes become visible when a user refreshes.

```mermaid
sequenceDiagram
    participant Server as Server (/companion)
    participant Apps as All connected apps
    Note over Server: Git state changes or refresh completes
    Note over Server: Update the shared cache
    Server-->>Apps: worktrees:updated (current list)
    Note over Apps: Accept the newest list and update the UI
```

## Create Worktree

The server config uses project objects with `mainWorktreePath` and an optional `bootstrapCommand`. Bootstrap runs in the newly created directory under the companion account's default shell, inside the creation operation. The queue and its status belong to the server, independently of desktop connections. Failed checkouts or bootstrap commands can leave real worktrees behind; reconciliation preserves these and the original error.

```mermaid
sequenceDiagram
    participant User
    participant App
    participant Server as Server (/companion)
    participant Git
    participant Shell
    participant Clients as All connected apps
    User->>App: Submit worktree details
    App->>Server: worktrees:create
    Note over Server: Register pending row before queued work starts
    Server-->>Clients: worktrees:updated (creating)
    Server-->>App: worktrees (accepted)
    Note over App: Close dialog
    Server->>Git: git worktree add
    Git-->>Server: Created or failed
    Note over Server,Shell: After successful creation, run configured bootstrapCommand in the worktree
    Server->>Shell: Execute bootstrapCommand, when configured
    Shell-->>Server: Completed or failed
    Server->>Git: Read actual worktrees
    Git-->>Server: Current worktrees
    Note over Server: Reconcile editors against Git membership, then finish operation or retain row error
    Server-->>Clients: worktrees:updated (finished or error)
    Note over Clients: Replace spinner with status or a red X and show error in tooltip
    User->>App: Click red X
    App->>Server: worktrees:set-error without error
    Server-->>Clients: worktrees:updated (error cleared)
    Server-->>App: worktrees
```

## Delete Worktree

Main and locked worktrees are protected. Removal never forces Git or deletes the branch or saved editor state. An editor stopped for a failed deletion can be reopened. Admission failures leave the confirmation dialog available; accepted operations release it immediately.

```mermaid
sequenceDiagram
    participant User
    participant App
    participant Server as Server (/companion)
    participant Git
    participant Clients as All connected apps
    User->>App: Confirm deletion
    App->>Server: worktrees:delete
    Note over Server: Mark row deleting before queued work starts
    Server-->>Clients: worktrees:updated (deleting)
    Server-->>App: worktrees (accepted)
    Note over App: Close dialog
    Note over Server: Stop this worktree's editor process
    Server->>Git: git worktree remove without force
    Git-->>Server: Removed or refused
    Note over Server: Remove row on success or retain row and error on failure
    Server-->>Clients: worktrees:updated (removed or error)
    Note over Clients: Remove row or replace spinner with red X and error tooltip
```

## Editor Updates

The companion requires an installed VS Code CLI on PATH. Runtime preparation uses Microsoft's downloader; direct editor launch exposes the reconnection grace and avoids the wrapper's idle shutdown. The internal layout, release log and launch arguments are validated before accepting a runtime. Prepared copies live outside the CLI's cache pruning; old copies are retained so live processes keep their files. ADE preserves mouse-report encoding in the bundled terminal serializer so interactive apps reconnect correctly. Compatibility revisions use separate runtime copies and must pass round-trip checks against the bundled terminal libraries before use. Preparation runs independently of worktree operations and is cancelled on shutdown.

```mermaid
sequenceDiagram
    participant Server as Companion
    participant CLI as Installed code CLI
    participant Microsoft as Microsoft update service
    participant Editor as Worktree editor
    Note over Server: Companion startup and hourly update check
    Server->>CLI: code serve-web on loopback with isolated temporary server data
    CLI->>Microsoft: Check latest release for the installed channel
    Microsoft-->>CLI: Latest release or update failure
    Note over Server,CLI: Wait for a completed update check before requesting the page
    Server->>CLI: Authenticated GET / to prepare the selected release
    CLI->>Microsoft: Download uncached server component
    Microsoft-->>CLI: Server distribution or download failure
    CLI-->>Server: HTTP ready, download progress or failure
    Note over Server: Validate runtime and retain a versioned copy, or keep the last working version
    Server->>CLI: Stop temporary process tree
    Note over Server: Existing editor processes continue running
    Note over Server: Next editor:open that needs a new process
    Server->>Editor: Launch a new session directly with the selected runtime and configured grace
```

## Open Editor

Editor tokens are cryptographically random and separate from `ADE_COMPANION_TOKEN`; no Microsoft or GitHub login is required. Restarting an editor process rotates its token while retaining workspace data. The worktree picker and snapshots never receive editor tokens, and the companion shared secret is never forwarded to VS Code.

Switching to a retained view reuses its existing connections. User settings synchronize with the companion account's default desktop profile; keybindings initialize new browser profiles. Extension packages and the default registry are shared directly with the local VS Code installation. Saved workspace data stays separate from runtime versions.

Clients need only the companion's address; individual VS Code ports remain private to the server machine. Remote deployments must expose that address through TLS and forward both HTTP and WebSocket upgrades. Persistence comes from retained editor processes and saved state, independently of the proxy.

```mermaid
sequenceDiagram
    participant User
    participant App as App main process
    participant Page as Editor page
    participant Server as Companion and proxy
    participant Editor as VS Code on loopback
    User->>App: Click a worktree via picker IPC
    Note over App,Server: Existing /companion WebSocket uses the configured companion token
    App->>Server: editor:open with worktree
    Note over Server: Validate worktree, generate token for a new process or reuse existing session
    Note over Server: Select the prepared runtime or wait for preparation
    Note over Server: Load local keybindings, enable settings sync and select the local extensions directory
    Server->>Editor: Start with token file, workspace data, shared extensions and --disable-workspace-trust, or reuse
    Editor-->>Server: Ready or startup failure
    Server-->>App: worktrees:updated with status and progress, broadcast to all apps
    Server-->>App: editor with ID, path and accessToken, or error
    Note over App: Retain errors on the worktree row or configure authentication and select editor view
    App->>Page: Load /editors/id/ in the single editor window for a new or replaced view
    Note over Page,Server: Main process adds the editor bearer token to HTTP and WebSocket upgrades
    Page->>Server: GET /editors/id/ and assets
    Note over Server: Check editor token and forward it as the vscode-tkn cookie
    Server->>Editor: Proxy HTTP request to loopback port
    Editor-->>Server: HTML, assets and VS Code session cookie
    Server-->>Page: Forward root HTML with keybindings and the settings sync script
    Note over Page: Loaded JavaScript starts remote connections
    Page->>Server: WebSocket upgrade beneath /editors/id/
    Server->>Editor: Check token and proxy upgrade with VS Code cookie
    Editor-->>Server: WebSocket accepted
    Server-->>Page: WebSocket accepted
    Page->>Server: VS Code requests and terminal input
    Server->>Editor: Relay WebSocket traffic
    Editor-->>Server: Remote results and terminal output
    Server-->>Page: Relay WebSocket traffic
    Note over Page,Editor: Workspace restores from saved state and reconnects to running terminals
```

## Sync User Settings

Settings move, persist and compare as one immutable `SettingsSnapshot`: content and original modification time. Browser snapshots live in the app's persistent storage, shared by companion origin. Main owns one sync loop per companion origin, using a loaded view to access that storage; workspace query changes remain valid and another view can take over when one is unavailable. Views only observe saves and expose storage operations to main, without a preload or IPC bridge. A browser lock protects snapshots and replacements. Whole-file replacement uses wall-clock save times with approximate ordering across machines; equal times favor the companion. Copies retain the winning snapshot to avoid feedback. A new browser starts with the companion copy; subsequent pending saves survive app restarts. A reply applies only while the full browser snapshot still matches the one sent; intervening saves wait for the next cycle. Remote and Workspace overrides remain separate. Each editor server starts with terminal persistence enabled in its Remote settings so desktop reconnects can retain live processes, without changing synchronized User settings. Legacy imported Remote values migrate once, preserving edited values and a backup.

The bridge uses VS Code's IndexedDB store and file-change broadcast, checked by the real-editor integration test. These are internal runtime interfaces and must be revalidated when updating the runtime. Editor authentication protects both the script and the sync endpoint; the endpoint can only access the discovered local settings file.

```mermaid
sequenceDiagram
    participant App as App main process
    participant Page as Editor page
    participant Server as Companion
    participant File as Local VS Code User settings
    Note over Page: Browser save records a content and modification-time snapshot
    loop Every minute while an editor is loaded, and after reconnecting
        App->>Page: Read shared browser settings via executeJavaScript
        Page-->>App: SettingsSnapshot, or not ready
        App->>Server: POST /editors/id/ade-settings-sync with editor authentication
        Server->>File: Read content and modification time
        File-->>Server: Local settings snapshot
        Note over Server: Serialize requests and compare save times
        Server->>File: Replace with newer browser content and retain its save time
        Server-->>App: Winning settings snapshot, or error for retry
        App->>Page: Apply snapshot via executeJavaScript unless edited during the request
        Page->>Page: Broadcast file change so live editors reload configuration
    end
```

## Refresh Worktrees

The user refreshes to pick up changes made outside the app. `worktrees:refresh` rescans Git, while `worktrees:list` reads the cache. After a successful scan, the server replaces its cache and shares the updated list with all connected apps.

```mermaid
sequenceDiagram
    participant App
    participant Server as Server (/companion)
    participant Git
    participant Clients as All connected apps
    App->>Server: worktrees:refresh
    Server->>Git: Rescan configured projects
    Git-->>Server: Current worktrees
    Note over Server: Replace cache
    Server-->>Clients: worktrees:updated
    Server-->>App: worktrees
```

## Reconnect

The user can force a fresh connection. The main process replaces the existing connection and returns to the startup workflow, including reloading the worktree list. If the server is unavailable, automatic retries continue.

```mermaid
sequenceDiagram
    participant User
    participant App
    participant Server
    User->>App: Reconnect
    Note over App: Close the old connection and reject pending requests
    App->>Server: WebSocket upgrade /companion with authentication
    Server-->>App: hello
    Note over App: Check compatibility
    App->>Server: worktrees:list
    Server-->>App: worktrees
```

## Server Shutdown

When the server is stopped, it closes client connections, lets accepted operations finish, and stops its editor processes before exiting. Apps reject pending requests and return to automatic reconnection. Once the server is available again, the startup workflow reloads the list so apps can see the outcome of operations interrupted by the disconnect. Reopening a worktree starts its editor with the saved workspace data.

```mermaid
sequenceDiagram
    participant Server
    participant Git
    participant App
    Note over Server: Stop serving connections
    Server-->>App: Close WebSocket /companion
    Note over App: Reject pending requests and begin reconnecting
    Note over Server,Git: Finish accepted operations before exiting
    Note over Server: Stop editor processes and retain saved workspace data
    App->>Server: Retry WebSocket upgrade /companion
    Note over App: Resume startup when the server becomes available
```

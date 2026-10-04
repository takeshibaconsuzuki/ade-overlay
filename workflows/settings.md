# Settings

- Settings synchronization exchanges the complete VS Code User settings file between persistent browser storage and the companion account's local VS Code profile. It does not merge individual settings.
- Newer save time wins, compared to the millisecond; equal times favor the companion copy. Copies preserve save time, so synchronization itself does not create a newer edit.
- One desktop coordinator serves all retained pages at a companion origin. One companion settings queue serves all worktrees and clients for the local file.
- Sources: [profile initialization](../src/server/editors/local-vscode.ts), [desktop coordinator](../src/main/settings-sync.ts), [browser storage bridge](../src/editor-browser/settings-sync.ts), [companion settings service](../src/server/editors/settings-sync.ts).

## Initialize the browser profile

```mermaid
sequenceDiagram
    participant Prepare as Editor preparation
    participant Local as Local VS Code profile
    participant Proxy as Editor document transport
    participant Browser as Browser profile
    Prepare->>Local: Read initial keybindings and select local<br/>settings file
    Local-->>Prepare: Profile resources
    Prepare->>Prepare: Share profile and settings service with<br/>editor sessions
    Proxy->>Browser: Deliver document with initial profile and<br/>settings bridge
    Browser->>Browser: Seed a new profile, otherwise restore its<br/>saved data
    Note over Browser: Workbench initialization finishes before<br/>settings exchange begins
```

- [Editor preparation](editors.md#prepare-an-editor) selects the local resources; [document serving](editors.md#serve-editor-traffic) attaches them to each page. VS Code applies profile initialization only for a new browser profile.
- New profiles receive local keybindings and an empty User settings file before their first settings exchange.
- Keybindings are seeded once. User settings use ongoing synchronization. Companion-owned Remote settings and workspace settings remain separate.

## Observe a browser save

```mermaid
flowchart LR
    Save([VS Code saves User settings]) --> Observe[Browser bridge records content and save time]
    Observe --> Remember[Share the remembered snapshot across this origin's pages]
    Remember --> Pending([Snapshot awaits the next synchronization pass])
```

- Workbench initialization and synchronization copies are not user saves. Native saves receive a new save time even if their contents are unchanged.
- Before the first observed user save, browser settings have an initial time of zero, allowing the companion's existing file to win initial synchronization.

## Schedule synchronization

```mermaid
flowchart TD
    Ready([First ready editor page is registered]) --> Immediate[Schedule an immediate pass]
    Reconnect([Companion reconnects]) --> Request[Request a pass]
    Timer([Scheduled delay expires]) --> Request
    Immediate --> Request
    Request --> Share[Join an active pass or start one synchronization pass]
    Share --> Outcome{Pass result?}
    Outcome -->|Not initialized yet| Soon[Schedule another pass 1 second after completion]
    Outcome -->|Ready or pass failed| Later[Schedule another pass 60 seconds after completion]
    Soon --> Waiting([Coordinator waits while at least one page remains])
    Later --> Waiting
    click Share "settings.md#synchronize-one-snapshot"
```

- Concurrent triggers share one run. A run uses one available page for shared browser storage and can try another if that page is unavailable.
- Removing the final page cancels the active run and timer. Desktop shutdown stops synchronization without waiting for it.
- A browser save records its timestamp but does not itself trigger network traffic; the main-process coordinator owns the schedule.

## Synchronize one snapshot

```mermaid
sequenceDiagram
    participant Main as Desktop coordinator
    participant Browser as Shared browser settings
    participant Server as Companion settings service
    participant File as Local VS Code settings
    Main->>Browser: Read settings snapshot after workbench<br/>initialization
    Browser-->>Main: Content and save time
    Main->>Server: Authenticated POST ade-settings-sync
    Server->>File: Read local snapshot in the shared settings<br/>queue
    Server->>File: If browser is newer, replace the unchanged<br/>local copy
    Note over Server,File: Otherwise keep local settings, or retry<br/>later if the file changed during this pass
    Server-->>Main: Winning local snapshot
    Main->>Browser: Apply only if browser snapshot still matches<br/>the one sent
    Browser->>Browser: Preserve intervening saves, otherwise copy<br/>winner and notify VS Code
    Browser-->>Main: Pass complete, synchronized or awaiting a<br/>newer edit's next pass
```

- Both sides protect edits made during an exchange. The browser checks content and remembered save time, including a save that changes content and then changes it back.
- File copies are atomic and keep the winning timestamp. The browser bridge handles storage and notifications; main owns network requests and credentials.

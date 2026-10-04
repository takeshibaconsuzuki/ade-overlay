# Worktrees

- Git is the only source of worktree membership. The companion caches it and replaces the cache only by [rescanning a project](#rescan-a-project); listing reads the cache without running Git.
- Each row also has state the companion owns: an operation (creating or deleting) and a retained error. Synthetic rows show a pending or failed creation where Git has no worktree.
- There is no shared queue. Creations, deletions, and editor opens run in parallel. A row's operation blocks only other actions on that same worktree: opening, stopping its editor, deleting, or creating at its path.
- A row keeps its operation until a rescan that started after its Git work has been applied, so a row is never released before membership reflects the result.
- External Git changes appear after a refresh or after the next operation in that project finishes.
- The picker lists running or starting editors first, most recently opened first. Desktop main records the time of every open, whatever started it: the picker, a chat, or a notification. Open worktrees never opened from this desktop, and unopened worktrees, retain companion order within their groups. Search preserves this ordering; changes to the displayed order reset selection and scroll to the first available result.
- Presentation prioritizes an operation or opening progress, then a retained error, then editor status.
- Worktree names use their assigned color while the editor is starting or running and grey when it is stopped. The companion saves a color per worktree identity in its data directory before editor startup; it survives editor stops, reconnects, and companion restarts. The picker and extension chat list use the same color. Reopening restores the saved color. New assignments favor the least-used palette color, counting saved assignments for stopped worktrees too.
- Sources: [worktree store](../src/server/worktrees/worktree-store.ts), [mutation dialogs](../src/renderer/src/components/worktree-actions.tsx).

## What a snapshot contains

```mermaid
flowchart LR
    Git[(Git worktree lists)] -->|Project rescan| Membership[Cached membership]
    Requests[Create, delete, open,<br/>and error requests] --> Rows[Row state:<br/>operation and error]
    Editors[Editor servers] --> Status[Editor status]
    Membership --> Snapshot[Snapshot with<br/>increasing revision]
    Rows --> Snapshot
    Status --> Snapshot
    Snapshot -->|Reply or broadcast| Desktops[Connected desktops]
    click Membership "worktrees.md#rescan-a-project"
```

- Any change to one of the three inputs publishes a new snapshot to every desktop. Editor status changes publish without rescanning Git.
- Desktop main [accepts newer snapshots](desktop.md#accept-shared-state) and reconciles retained pages before updating the picker.

## Create a worktree

```mermaid
sequenceDiagram
    actor User
    participant Dialog as Creation dialog
    participant Store as Companion worktree store
    participant Git as Git and bootstrap command
    participant Clients as All connected desktops
    User->>Dialog: Submit project, Git ref, branch, and path
    Dialog->>Store: companionCreateWorktree
    Store->>Store: Resolve the physical path, reject an existing<br/>worktree or busy row, reserve a creating row
    Store-->>Clients: Publish the creating row
    Store-->>Dialog: Accepted snapshot
    Dialog-->>User: Close dialog, row shows Creating worktree
    Note over Store,Git: Continues in the background, in parallel<br/>with other operations and opens
    Store->>Git: Resolve the Git ref, then add the worktree
    Store->>Git: If added, run the project bootstrap command<br/>and wait
    Git-->>Store: Success, or failure at any step
    Store->>Store: Rescan the project, wait for it to apply
    Store->>Store: Clear the operation, on failure retain the<br/>error on the row
    Store-->>Clients: Publish the finished row
    Clients-->>User: Notify that creation completed or failed
```

- Acceptance is separate from completion. Admission failures leave the dialog open; later failures belong to the shared row and survive the initiating desktop disconnecting. Creation never opens an editor automatically.
- The [rescan](#rescan-a-project) decides the outcome's membership. A failing Git hook or bootstrap can leave a real worktree, whose row stays usable alongside its error; a failure with no worktree remains as a synthetic error row.
- Scans by other requests may see the worktree while its bootstrap runs. The row then shows Git's data but remains creating and unavailable.
- The bootstrap command's output goes to a [bootstrap log](#open-the-bootstrap-log). A failed bootstrap's row error gives only the exit code and points to that log.
- Each desktop [notifies when creation finishes](desktop.md#notify-when-worktree-creation-finishes). Clicking opens the worktree if it remains available.
- Paths are on the companion machine; relative paths start at the selected project.
- Git ref suggestions load local and remote-tracking branches for the selected project and filter as the user types. The shared picker navigation supports mouse selection, arrows, and Enter. Enter selects the active result; with **No results**, it closes the dropdown and preserves the text without submitting. Stale project responses are ignored; loading failures still allow manual entry.
- Local branch names take precedence over same-named tags; explicit `refs/tags/` refs select tags. Remote refs, tags, commits, and expressions require a new branch name. The companion enforces this in the background step, so this flow never intentionally creates a detached worktree.

## Open the bootstrap log

```mermaid
sequenceDiagram
    actor User
    participant Picker as Picker row menu
    participant Main as Desktop main
    participant Store as Companion
    participant Extension as Worktree's extension
    User->>Picker: Open bootstrap log
    Picker->>Main: Open the worktree, then its log
    Main->>Main: Open the worktree and wait for its page
    Main->>Store: companionOpenBootstrapLog
    Store->>Store: Locate the worktree's log, wait for its<br/>extension to connect
    Store->>Extension: extensionOpenFile
    Extension-->>User: Log is shown as a file in the editor
```

- Each creation writes the bootstrap command and its combined standard output and error to one file in Git's metadata directory for that worktree, on the companion machine. It never appears as an untracked file, and Git removes it with the worktree.
- The desktop first [opens the worktree](desktop.md#open-a-worktree) and requests the log only once the worktree's page is ready: a failed open keeps its own row error, and an open superseded during startup requests nothing. A worktree without a log, or an extension that does not connect in time, becomes a row error.
- The action is available only while the row retains a bootstrap error. Clearing that error disables it; the log file remains until the worktree is deleted.

## Delete a worktree

```mermaid
sequenceDiagram
    actor User
    participant Picker as Picker row menu
    participant Store as Companion worktree store
    participant Git
    participant Editors as Editor servers
    participant Clients as All connected desktops
    User->>Picker: Confirm deletion, optionally with its branch
    Picker->>Store: companionDeleteWorktree
    Store->>Store: Reject main, locked, unknown, or busy rows,<br/>reserve a deleting row
    Store-->>Clients: Publish the deleting row
    Store-->>Picker: Accepted snapshot
    Note over Store,Git: Continues in the background, in parallel<br/>with other operations and opens
    Store->>Git: Recheck the worktree, its lock, and its branch
    Store->>Editors: Cancel startup or stop the worktree's editor
    Store->>Git: Remove the worktree, with force only after<br/>confirmation
    Store->>Git: If removed and requested, delete the local<br/>branch
    Store->>Store: Rescan the project, wait for it to apply
    alt Removed
        Store-->>Clients: Publish without the row, or with a synthetic<br/>error if only the branch remains
    else Removal failed
        Store-->>Clients: Publish the kept worktree with its error<br/>and blocking files
        Picker-->>User: Offer a force retry when Git permits it
    end
```

- A confirmed force retry starts this workflow again with force. Cancelling keeps the worktree; its editor remains stopped.
- The row menu offers worktree-only deletion or deletion of both the worktree and its local branch, including unmerged commits. The menu always opens and lists every action, disabling unavailable ones: every action while the row has an operation or the desktop is disconnected, the [bootstrap log](#open-the-bootstrap-log) without a bootstrap error, branch deletion for detached worktrees, and both deletions for main, locked, and never-created worktrees. It also offers [stopping the editor](editors.md#editor-server-lifetime).
- A failed removal opens a popup for the requesting picker with changed, untracked, ignored, and submodule paths. Main and locked worktrees remain protected.
- Admission checks the cache, so a lock or unlock made outside the app is honored after a refresh. Git still refuses a worktree locked since the last scan.

## Rescan a project

```mermaid
flowchart TD
    Request([A refresh or a finished operation requests a project rescan]) --> Queued{Rescan already queued for this project?}
    Queued -->|Yes| Share[Share the queued rescan]
    Queued -->|No| Queue[Queue one rescan behind the running one, if any]
    Share --> Scan
    Queue --> Scan[Once no scan is running, list the project's worktrees in Git]
    Scan --> Apply[In one step: replace the project's cached membership, drop idle rows of vanished worktrees, and select their editors to stop]
    Apply --> Publish[Publish the snapshot]
    Publish --> Stop[Wait for the selected editors to stop]
    Stop --> Done([Every requester continues])
    click Stop "editors.md#editor-server-lifetime"
```

- Each project has one running and at most one queued rescan, so scans never overlap or apply out of order. A requester never joins a scan that was already reading Git, which may predate its change.
- Membership is briefly stale while a queued rescan waits. Rows with an operation stay visible and unavailable throughout, so the gap never exposes a half-finished worktree.
- `companionRefreshWorktrees` requests a rescan of every project, waits for all of them, and always broadcasts a snapshot. A scan failure is reported to the refreshing desktop, or retained on the row of the operation that requested it.
- Other projects' membership is untouched. Synthetic rows are never part of membership and never affect which editors are retained.
- [Companion startup](companion.md#start-the-companion) scans every project once before accepting connections.

## Autofill a creation path

```mermaid
sequenceDiagram
    actor User
    participant Dialog
    participant Companion
    User->>Dialog: Open creation
    Dialog->>Companion: Request all project path templates once
    Companion-->>Dialog: Templates, main paths, and platform path rules
    Note over Dialog: Render initial suggestion from current inputs
    User->>Dialog: Change project or branch
    alt Path autofill is enabled
        Dialog->>Dialog: Render cached template locally with current variables
        Note over Dialog: Keep the current path until rendering completes
        Dialog-->>User: Show result if input is still current
    else Path was manually edited
        Dialog-->>User: Keep the entered path
    end
    User->>Dialog: Clear the path
    Dialog->>Dialog: Leave empty, enable autofill on the next variable change
```

- The effective branch is the trimmed new branch name, falling back to the Git ref. Each project may configure a Liquid path template; the default appends a filename-safe branch to the main worktree path.
- The initial template response fills the path from the current inputs unless the user has edited or cleared it. Branch edits and project changes require no additional requests or debounce; local hashing and path helpers preserve companion platform behavior.
- Suggestions do not change Git membership or reserve a destination. Manual edits (including clearing), project/branch changes, and dismissal suppress obsolete results. Clearing waits for the project or effective branch to change before rendering another suggestion. Template errors allow a manually entered path.

## Clear a retained error

```mermaid
flowchart TD
    Start([User clears a row error]) --> Request[Send companionSetWorktreeError without an error]
    Request --> Clear[Remove error state unless an operation owns the row]
    Clear --> Publish[Publish remaining Git membership and operation state]
    Publish --> Done([Real worktrees remain, cleared synthetic rows disappear])
```

- Clearing an error does not rerun the failed operation. Successful editor opening also leaves retained errors in place until cleared.

# Product workflows

- These pages describe the implemented desktop, companion, and workspace extension behavior. Start with the component that owns the outcome, then follow its linked workflows.
- The desktop presents worktrees and retained editor pages. The companion runs separately and owns Git operations, editor processes, and live chat state. The workspace extension launches and focuses terminals inside VS Code.
- Contributor commands and architectural constraints live in [AGENTS.md](../AGENTS.md); configuration and operating instructions live in the [project README](../README.md).

| Component                           | Workflows                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [Desktop](desktop.md)               | Connect and reconnect, accept shared state, open a worktree, supersede navigation, close windows            |
| [Companion](companion.md)           | Start services, admit connections, stop and drain accepted work                                             |
| [Worktrees](worktrees.md)           | Refresh membership, schedule mutations, create and bootstrap, delete, clear retained errors                 |
| [Editor processes](editors.md)      | Share runtime preparation, start or reuse an editor, reconcile process lifetime, authenticate editor access |
| [Editor pages](editor-pages.md)     | Select retained views, follow document readiness, restore an editor window, apply browser permissions       |
| [Workspace extension](extension.md) | Connect the sidebar, launch terminals, restore terminal identities, focus a chat terminal                   |
| [Live chats](chats.md)              | Report activity, reconcile processes, refresh titles, navigate across worktrees                             |
| [Settings](settings.md)             | Initialize a browser profile, observe saves, schedule and resolve whole-file synchronization                |

## Follow a user action

- [Open a worktree](desktop.md#open-a-worktree) waits first for the companion's [editor process](editors.md#prepare-an-editor), then for its [browser page](editor-pages.md#select-an-editor-page).
- [Create or delete a worktree](worktrees.md#schedule-a-mutation) returns when the companion accepts the operation; later shared snapshots carry its result.
- [Launch a provider](extension.md#launch-a-terminal) creates a workspace terminal. Later provider events trigger [live chat updates](chats.md#report-chat-activity).
- [Select a live chat](chats.md#navigate-to-a-chat) selects the worktree in the desktop, waits for the destination extension, and completes after terminal focus.
- [Change User settings](settings.md#observe-a-browser-save) records a save locally; the next [synchronization pass](settings.md#synchronize-one-snapshot) reconciles the browser and companion copies.

## Resource boundaries

- Closing the picker quits the desktop. Closing only the editor window retains its pages. Neither action stops companion editor processes.
- Each worktree has a stable editor identity and persistent workspace data. A running editor has a fresh access credential; reopening after its restart replaces the old browser page.
- Worktree operation state and live chats belong to the companion process. Browser storage and workspace data persist after those in-memory registries are reset.
- Diagram references identify work delegated to another workflow. The caller shows whether it waits, schedules work in the background, or sends an event.

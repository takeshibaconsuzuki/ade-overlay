# ADE Overlay

## Controls

The launcher is the small controller window used to jump between ADE views.

Use `Cmd/Ctrl` + `Shift` + `Space` to toggle the launcher between active and
dormant. Dormant mode is translucent and lets mouse clicks pass through.

While active:

- `s` or click worktrees button: open the Worktrees window.
- `w`: show the editor for the currently selected worktree.
- `c`: open chat for the currently selected worktree.
- Click chat button: jump to that chat and its worktree.

## Configuration

Configuration is stored under `~/.ade-overlay/config.json`.

Example:

```json
{
  // Array of tracked repositories. Each entry describes one main Git worktree.
  "repositories": [
    {
      "mainWorktreePath": "/Users/me/src/my-app",
      "worktreePathTemplate": "/Users/me/worktrees/{{branch}}",
      "bootstrapCommand": "npm install",
      "preChatCommand": "source .env.local"
    }
  ]
}
```

ADE watches this file while running, so saved changes are reloaded.

### Repository Fields

`mainWorktreePath`

Required. Path to the repository's main Git worktree.

`worktreePathTemplate`

Optional. Mustache template used to prefill the worktree path in the create
worktree form. Parameters:

- `main_worktree_path`: absolute path of the main worktree.
- `main_worktree_id`: ADE's stable id for the main worktree.
- `branch`: the new branch name, or the base branch if no new branch is set.

`bootstrapCommand`

Optional. Command to run from the new worktree after `git worktree add`
finishes. Runs through the user's login shell. A nonzero exit marks creation as
failed.

`preChatCommand`

Optional. Script to run before starting a chat CLI in a worktree. If this
script fails, the chat CLI is not started.

# Setup

Install Git and run `npm install` from the repo root.

# Server

Create `~/.ade-overlay/server.yaml` (`~` is your home directory):

```yaml
projects:
  - ~/code/my-project
  - E:/Devel/another-project
```

Each project must be a main Git worktree root. Paths may be absolute, start with `~`, or be relative to the config file. Duplicate projects are combined.

Run `npm run server`, or choose a config with `npm run server -- --config path/to/server.yaml`. The server scans all projects before accepting connections. A missing default config starts with no projects; an explicitly selected missing file, invalid config, or invalid project stops startup. Restart the server after changing the config.

| Variable              | Used by | Purpose                                                   |
| --------------------- | ------- | --------------------------------------------------------- |
| `ADE_COMPANION_HOST`  | Server  | Listen address; defaults to `127.0.0.1`.                  |
| `ADE_COMPANION_PORT`  | Server  | Port; defaults to `4317`.                                 |
| `ADE_COMPANION_URL`   | App     | Address; defaults to `ws://127.0.0.1:4317/companion`.     |
| `ADE_COMPANION_TOKEN` | Both    | Optional shared secret; use the same value on both sides. |

For a remote server, use the `wss://` address and token supplied by its operator. Worktree paths always refer to the server’s filesystem.

# App

Run `npm run dev`. Worktrees load on connection and after reconnecting.

- **Create worktree**: choose a project, base branch, and path. Enter a new branch name to create a branch, or leave it blank to check out the base branch directly. Git refuses branches already checked out elsewhere. Relative worktree paths start at the selected project.
- **Delete** on a worktree row: remove the working directory and keep its branch. Main and locked worktrees cannot be deleted; Git refuses worktrees with uncommitted or untracked files.
- **Refresh worktrees**: rescan Git to include changes made outside the app.
- **Reconnect**: force a new connection. The app also retries automatically after disconnects.

Create and delete changes appear automatically in every connected app.

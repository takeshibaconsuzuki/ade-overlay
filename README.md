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

Install VS Code separately on the companion machine and put `code` on that account's PATH (`code-insiders` is also supported). The companion uses its `serve-web` command to check for the latest server at startup and hourly, then launches the prepared runtime directly. Updates affect new editor processes; existing sessions keep running. Failed update checks reuse the last validated runtime. Editor data and cached runtimes live in `~/.ade-overlay/editors`; keep this directory to preserve workspace state.

All editors use the companion account's local VS Code extensions directory directly. Installs, updates and removals are shared with desktop VS Code on that machine. Previous ADE-only extensions remain in `~/.ade-overlay/editors/extensions`; that directory is no longer used unless selected with `localExtensionsDir`. Remote Node extensions can run; extensions requiring a desktop UI host remain unavailable. An extension may require sign-in.

Browser User settings synchronize with the companion account's local default VS Code profile every minute while an editor is loaded. The newer save replaces the entire older file, preserving comments; simultaneous edits and clock differences have approximate ordering. The first sync uses the companion's settings. Browser save times survive app restarts, so pending edits reconcile when reopened. Remote and Workspace settings remain explicit overrides. Old imported Remote values are removed once when they still match the import, with a backup beside the settings file; subsequent edits are retained. Keybindings are imported once for a new browser profile.

Closing windows and quitting the app stay immediate. Quitting does not wait for editor saves, backups or settings sync, so recent unsaved edits can be lost. The companion and its running terminals continue independently.

Optional configuration:

```yaml
editor:
  dataDir: ~/.ade-overlay/editors
  # Seconds to retain disconnected terminal and extension-host sessions:
  reconnectionGraceSeconds: 604800
  # Override the discovered local profile locations:
  # localUserDataDir: /path/to/Code
  # localExtensionsDir: /path/to/.vscode/extensions
```

`localUserDataDir` contains `User/settings.json`. The reconnection grace defaults to seven days and accepts 1?2147483 seconds. Running the editor accepts the [VS Code Server license terms](https://aka.ms/vscode-server-license). Remote reverse proxies must forward HTTP and WebSocket traffic for `/editors/` as well as `/companion` over TLS.

The companion writes structured logs to its terminal and `~/.ade-overlay/server.log`. Logs include commands, timings, update checks, selected versions, editor startup and failures. Set `ADE_LOG_LEVEL=debug` for detailed editor output. Each editor also saves stdout and stderr in `~/.ade-overlay/editors/workspaces/<id>/server.log` (under `editor.dataDir` when configured). Session tokens are redacted. Worktree rows show download and startup progress; Refresh remains available while an editor starts.

# App

Run `npm run dev`. Worktrees load on connection and after reconnecting. Closing the worktree picker quits the app, including its editor window; the companion and remote sessions keep running. Closing only the editor window keeps the picker open.

- **Create worktree**: choose a project, base branch, and path. Enter a new branch name to create a branch, or leave it blank to check out the base branch directly. Git refuses branches already checked out elsewhere. Relative worktree paths start at the selected project.
- **Click a worktree**: open its remote VS Code session. Worktrees opened through ADE are automatically trusted. A grey dot means stopped or starting; green means running. All worktrees use one editor window, which switches to the selected worktree. Closing that window leaves the remote sessions running.
- **Delete** on a worktree row: remove the working directory and keep its branch. Main and locked worktrees cannot be deleted; Git refuses worktrees with uncommitted or untracked files.
- **Refresh worktrees**: rescan Git to include changes made outside the app.
- **Reconnect**: force a new connection. The app also retries automatically after disconnects.

Create and delete changes appear automatically in every connected app.

Files, layout and terminal sessions are restored when you reopen a worktree after restarting the desktop app. Keep the companion running to retain terminal processes; disconnected sessions use the configured reconnection grace period. Restarting the companion or server machine stops running processes. Each worktree keeps its own workspace state, and all editors share installed extensions. Already-open editors may need **Developer: Reload Window** to activate an extension installed elsewhere.

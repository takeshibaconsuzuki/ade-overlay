# Install

Install the desktop package for your system: the Windows installer, macOS disk image, or Linux AppImage, Debian or RPM package. On macOS, choose the build for Apple Silicon (`arm64`) or Intel (`x64`).

The companion runs separately on the computer that holds your repositories. Extract its matching archive to a permanent directory. It includes Node.js and the terminal extension; Python and npm are not needed. Install Git and stable VS Code separately and put `git` and `code` on PATH. Provider CLIs and their sign-ins also belong on this computer.

Create the server configuration below, then open a terminal in the extracted `ade-companion` directory. On Windows:

```powershell
.\ade-companion.cmd --setup
.\ade-companion.cmd
```

On Linux/macOS, use `./ade-companion --setup` and `./ade-companion`. Run it under your own account and keep that terminal running. Setup validates configuration, installs the extension into the companion's configured local extensions directory, and installs provider activity hooks. Pass the same `--config` argument to setup and the service when using a custom configuration. Launch ADE from your desktop after the companion starts.

For development commands, see [AGENTS.md](AGENTS.md).

## Connect to another computer

Local connections work without configuration. For a remote companion, create `~/.ade-overlay/client.json` on the desktop computer:

```json
{
  "url": "wss://your-server.example/companion",
  "token": "the-secret-supplied-by-your-server-operator"
}
```

Keep this file readable only by your account (on Linux/macOS, `chmod 600 ~/.ade-overlay/client.json`). Restart ADE after editing it. `ADE_COMPANION_URL` and `ADE_COMPANION_TOKEN` override the saved values. The credential stays in the desktop main process.

## Upgrade or uninstall

Upgrade the desktop, companion and extension together from the same release. Stop the companion with Ctrl+C before replacing its installation directory, then run `--setup` again and restart both applications. This stops running editors and terminals; save work first. Rerun setup after relocating the companion or changing the provider home so hook commands use the current paths.

Uninstalling the desktop or removing the companion directory leaves repositories and saved state intact. State lives in `~/.ade-overlay` and the desktop's application-data directory. To fully remove the integration, uninstall **ADE Terminals** from VS Code and remove only hook handlers marked `ADE chat activity` from the provider's hooks file.

# Server

Create `~/.ade-overlay/server.yaml` (`~` is your home directory):

```yaml
projects:
  - mainWorktreePath: ~/code/my-project
    bootstrapCommand: npm install
  - mainWorktreePath: E:/Devel/another-project
```

Each project object requires `mainWorktreePath`, pointing to a main Git worktree root. Paths may be absolute, start with `~`, or be relative to the config file. Duplicate projects are combined; the last entry supplies the bootstrap command. The optional `bootstrapCommand` runs in each newly created worktree using the companion account and the server's default shell. Creation stays pending until it exits. A nonzero exit marks creation as failed and retains the worktree for inspection.

Run the companion launcher, or choose a config with `ade-companion --config path/to/server.yaml` (use `ade-companion.cmd` on Windows). The server scans all projects before accepting connections. A missing default config starts with no projects; an explicitly selected missing file, invalid config, or invalid project stops startup. Restart the server after changing the config.

| Variable              | Used by | Purpose                                                   |
| --------------------- | ------- | --------------------------------------------------------- |
| `ADE_COMPANION_HOST`  | Server  | Listen address; defaults to `127.0.0.1`.                  |
| `ADE_COMPANION_PORT`  | Server  | Port; defaults to `4317`.                                 |
| `ADE_COMPANION_URL`   | App     | Address; defaults to `ws://127.0.0.1:4317/companion`.     |
| `ADE_COMPANION_TOKEN` | Both    | Optional shared secret; use the same value on both sides. |

For a remote server, use the `wss://` address and token supplied by its operator. Worktree paths always refer to the server’s filesystem.

Install stable VS Code separately on the companion machine and put `code` on that account's PATH. Each ADE release uses one approved VS Code server build, prepared through Microsoft's downloader and cached locally. Runtime updates arrive with ADE releases. Editor data and cached runtimes live in `~/.ade-overlay/editors`; keep this directory to preserve workspace state.

All editors use the companion account's local VS Code extensions directory directly. Installs, updates and removals are shared with desktop VS Code on that machine. Previous ADE-only extensions remain in `~/.ade-overlay/editors/extensions`; that directory is no longer used unless selected with `localExtensionsDir`. Remote Node extensions can run; extensions requiring a desktop UI host remain unavailable. An extension may require sign-in.

Browser User settings synchronize with the companion account's local default VS Code profile every minute while an editor is loaded. The newer save replaces the entire older file, preserving comments; simultaneous edits and clock differences have approximate ordering. The first sync uses the companion's settings. Browser save times survive app restarts, so pending edits reconcile when reopened. Remote and Workspace settings remain explicit overrides. Keybindings are imported once for a new browser profile.

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

ADE discovers ordinary stable VS Code profile and extension directories. For portable or other custom layouts, set `localUserDataDir` and `localExtensionsDir` explicitly. `localUserDataDir` contains `User/settings.json`. The reconnection grace defaults to seven days and accepts 1?2147483 seconds. Running the editor accepts the [VS Code Server license terms](https://aka.ms/vscode-server-license). Remote reverse proxies must forward HTTP and WebSocket traffic for `/editors/` as well as `/companion` over TLS.

The companion writes structured logs to its terminal and `~/.ade-overlay/server.log`. Logs include commands, timings, runtime preparation, editor startup and failures. Set `ADE_LOG_LEVEL=debug` for detailed editor output. Each editor also saves stdout and stderr in `~/.ade-overlay/editors/workspaces/<id>/server.log` (under `editor.dataDir` when configured). Session tokens are redacted. Worktree rows show download and startup progress; Refresh remains available while an editor starts.

# App

## Terminal sidebar

Install the bundled VS Code extension and activity hooks with the companion launcher's `--setup` command. Pass the same `--config` argument used by the server if you configured a different extensions directory.

Reload existing editors with **Developer: Reload Window**, then open **ADE** in the Activity Bar. The sidebar uses the same theme as the main window. **Terminal** opens a normal shell alongside files in an editor group. The second button launches the selected chat provider; choosing **Codex** or **Claude** from its dropdown immediately launches a chat and remembers your choice. Buttons stay available while launches queue. Provider terminals share a locked chat group and close when the configured foreground command finishes, including failures. Ordinary terminals stay open. Starting from an empty editor uses the full width; another group is created only when ordinary content and chat need to coexist. All terminals start in the current worktree; none open in the terminal panel.

Install and sign in to the provider CLIs on the companion machine separately. Commands default to `codex` and `claude`; customize `adeTerminals.codexCommand` and `adeTerminals.claudeCommand` in that machine's User/Remote settings. Keep provider commands in the foreground so their lifetime controls terminal cleanup. Supported shell profiles include PowerShell, Command Prompt, bash, zsh and fish. VS Code controls terminal titles and persistence. Each extension activation starts without adopting existing terminal groups; new chat launches reuse an empty group or create a new one. Deactivation leaves terminals and groups intact. VS Code still allows manually moving tabs and unlocking groups.

ADE terminal launches require exactly one workspace folder and use it as their working directory.

Chats appear immediately below the launch buttons, sorted by newest prompt or turn end. Tool activity does not move rows. The current chat tab in this activation's ADE chat group has a left selection line, even when another group has focus. Selecting a file inside that chat group clears the line. Rows show a spinner for working or a green dot for idle, followed by the worktree name, conversation title and three lines reserved for a wrapped message preview. For Codex, the title comes from local resume metadata; the preview is the latest submitted prompt or final assistant reply received through hooks, shortened for display. Missing titles and messages show skeletons. Existing transcript messages are not loaded. Click a chat to switch the connected desktop to its worktree and terminal. Navigation requires exactly one connected desktop. Chat identities survive editor reloads and desktop reconnects while the companion and terminal processes keep running. Claude terminals still launch normally; activity tracking currently supports Codex only.

Companion setup merges ADE activity commands into the companion account's `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`), preserving other hooks. Start a new Codex terminal and trust the added commands through `/hooks` when prompted. Hooks outside ADE terminals do nothing. Invalid hook configuration makes setup fail without overwriting the file. Normal service startup never modifies hooks; missing hooks only prevent live activity from appearing. Keep the companion installation at a stable path; rerunning setup after moving it updates the commands and may require trusting them again.

Chats show **working** or **idle**, including permission waits, user input and interruption. These are hook observations: after permission approval a chat can remain idle until the next hook, and missed hooks leave the previous activity visible. Process reconciliation removes exited chats within a few seconds; idle chats do not expire. Closing the desktop does not remove chats. Restarting the companion resets the live registry and stops its editors; recovery of processes surviving a companion crash is not supported.

## Worktrees

Launch ADE. Worktrees load on connection and after reconnecting. Closing the worktree picker quits the app, including its editor window; the companion and remote sessions keep running. Closing only the editor window keeps the picker open.

- **Create worktree**: choose a project, base branch, and path. Enter a new branch name to create a branch, or leave it blank to check out the base branch directly. Git refuses branches already checked out elsewhere. Relative worktree paths start at the selected project.
- **Click a worktree**: open its remote VS Code session. Worktrees opened through ADE are automatically trusted. A grey dot means stopped; green means running. A spinner means an operation is pending and takes priority over errors; errors take priority over green or grey status. A red X indicates an error: hover or focus the row for details, and click the X to clear it. Opening an editor preserves the error until it is explicitly cleared. All worktrees use one editor window, which switches to the selected worktree. Closing that window leaves the remote sessions running.
- **Delete** on a worktree row: remove the working directory and keep its branch. Main and locked worktrees cannot be deleted; Git refuses worktrees with uncommitted or untracked files.
- **Refresh worktrees**: rescan Git to include changes made outside the app.
- **Reconnect**: force a new connection. The app also retries automatically after disconnects.

Create and delete dialogs close once the server accepts the request. Creation immediately adds a pending row; deletion shows a spinner on the existing row. Progress and errors appear in every connected app and survive desktop restarts while the companion stays running. Failed creations that never produced a Git worktree keep an error row until its X is cleared. The branch and directory remain available when bootstrap fails. Restarting the companion rescans Git and resets operation/error state.

Files, layout and terminal sessions are restored when you reopen a worktree after restarting the desktop app. ADE enables `terminal.integrated.enablePersistentSessions` in each editor server's Remote settings at startup, leaving synchronized User settings unchanged. Workspace settings can override this value. Keep the companion running to retain terminal processes; disconnected sessions use the configured reconnection grace period. Restarting the companion or server machine stops running processes. Each worktree keeps its own workspace state, and all editors share installed extensions. Already-open editors may need **Developer: Reload Window** to activate an extension installed elsewhere.

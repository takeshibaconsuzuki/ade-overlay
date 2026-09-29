# ADE

ADE manages Git worktrees and opens VS Code editors with Codex or Claude chats. The desktop app connects to a companion running on the computer that holds your repositories.

## Install

Install the desktop app and extract the companion archive from the same release to a permanent directory. On the companion computer, install Git and stable VS Code with `git` and `code` on `PATH`. For chats, install and sign in to the Codex or Claude CLI.

### Configure projects

Create `~/.ade-overlay/server.yaml` on the companion computer:

```yaml
projects:
  - mainWorktreePath: ~/code/my-project
    bootstrapCommand: npm install
```

Each `mainWorktreePath` points to a repository's main worktree. Relative paths resolve from the configuration file. The optional `bootstrapCommand` runs in new worktrees; failures leave the worktree available for inspection. Restart the companion after configuration changes.

### Start ADE

From the extracted `ade-companion` directory, run:

Windows:

```powershell
.\ade-companion.cmd --setup
.\ade-companion.cmd
```

Linux/macOS:

```sh
./ade-companion --setup
./ade-companion
```

Run under your own account, keep the companion running, then launch ADE. Local connections are automatic. For a custom configuration, pass `--config path/to/server.yaml` to both commands.

Running editors accepts the [VS Code Server license terms](https://aka.ms/vscode-server-license).

## Worktrees

Press **Ctrl+Shift+Space** on Windows/Linux or **Cmd+Shift+Space** on macOS to toggle the worktree window. **Esc** in the search bar or clicking elsewhere hides it.

Click a worktree to open its editor. Opened worktrees are automatically trusted.

- **Create worktree:** leave the branch name blank to check out the base branch. Relative paths start at the selected project.
- **Delete:** removes the directory but keeps its branch. Main or locked worktrees, and those with uncommitted or untracked files, cannot be deleted.
- **Refresh worktrees:** picks up external Git changes.

Hover or focus an error row for details; click its red X to clear the error.

Closing the worktree window quits ADE; closing only the editor window does not. Save first: ADE does not wait for saves or backups. Terminals survive desktop restarts while the companion is running; restarting the companion stops its editors and terminals.

## Terminals and chats

Open **ADE** in VS Code's Activity Bar to launch shells or chats in the current worktree. Launches require exactly one workspace folder. Chat terminals close when their command exits.

For Codex and Claude activity tracking, start a new chat after setup and trust the added commands through `/hooks` when prompted. Click a sidebar chat or idle notification to open its terminal; navigation requires exactly one connected ADE desktop. Titles come from local session metadata; previews show the latest prompt or final response received through hooks.

Use a current Claude Code CLI with [exec-form command hooks](https://code.claude.com/docs/en/hooks#exec-form-and-shell-form) that support `args`. Setup preserves existing provider settings and hooks.

Customize commands through `adeTerminals.codexCommand` and `adeTerminals.claudeCommand` in the companion computer's VS Code User/Remote settings. Keep `--no-daemon` in the Codex command and run both commands in the foreground.

## VS Code settings and extensions

ADE shares extensions with the companion account's local VS Code. Some extensions requiring desktop-only features are unavailable. Reload open editors with **Developer: Reload Window** after installing extensions.

User settings synchronize with that account's default VS Code profile every minute while an editor is open. The newer file replaces the older one; avoid editing both at once. Keybindings are imported once.

## Remote connections

On the desktop computer, create `~/.ade-overlay/client.json`, restrict access to your account, and restart ADE:

```json
{
  "url": "wss://your-server.example/companion",
  "token": "your-shared-secret"
}
```

Repository paths refer to the companion computer. Remote hosting requires a TLS reverse proxy forwarding HTTP and WebSocket traffic for `/companion` and `/editors/`.

| Environment variable  | Where to set it | Purpose                                                                                   |
| --------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `ADE_COMPANION_HOST`  | Companion       | Listen address; default `127.0.0.1`.                                                      |
| `ADE_COMPANION_PORT`  | Companion       | Listen port; default `4317`.                                                              |
| `ADE_COMPANION_URL`   | Desktop         | Overrides the saved address; default `ws://127.0.0.1:4317/companion`.                     |
| `ADE_COMPANION_TOKEN` | Both            | Shared secret; use the same value on both computers. Overrides the desktop's saved token. |

## Optional editor configuration

Add to `server.yaml` to customize storage, session retention, or VS Code locations:

```yaml
editor:
  dataDir: ~/.ade-overlay/editors
  reconnectionGraceSeconds: 604800 # Seven days.
  # localUserDataDir: /path/to/Code
  # localExtensionsDir: /path/to/.vscode/extensions
```

`localUserDataDir` must contain `User/settings.json`. Rerun `--setup` after changing the extensions directory.

## macOS setup

If `code` is unavailable, run **Shell Command: Install 'code' command in PATH** from VS Code's Command Palette.

After a chat finishes a response, enable ADE in **System Settings > Notifications**.

## Logs

Check the companion terminal or `~/.ade-overlay/server.log` for errors. Set `ADE_LOG_LEVEL=debug` for detailed output.

## Upgrade or uninstall

Save your work, stop the companion, and install the desktop and companion from the same release. Run `--setup` again, then restart both. Also rerun setup after moving the companion or changing a provider home directory.

Uninstalling leaves repositories and saved state intact. State lives in `~/.ade-overlay` and the desktop's application-data directory. To remove the integration, uninstall **ADE Terminals** from VS Code and remove only hook handlers marked `ADE chat activity` from `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`) and `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`).

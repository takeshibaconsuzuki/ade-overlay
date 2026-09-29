# ADE Terminals

Open **ADE** in the Activity Bar for a sidebar matching the ADE main window. **Terminal** starts a shell; the second button starts the selected chat provider. Choosing **Codex** or **Claude** from its dropdown launches immediately and remembers that provider. Buttons remain available while launches queue. Every launch creates a new terminal in the editor area. Ordinary terminals share groups with files; provider terminals share a separate locked group and close when the configured foreground command finishes. Ordinary shells remain open.

Live chats appear below the buttons, newest prompt or turn end first. Tool activity does not change their order. The current chat tab in this activation's ADE chat group has a left selection line, even when another group has focus. A file selected inside that group clears the line. A spinner means working; a green dot means idle. Rows show the worktree name, conversation title and three lines reserved for the latest received message, with skeletons for missing content. Codex uses its local resume title and the most recent prompt or final assistant reply reported by hooks. Click a row to switch the connected ADE desktop to that worktree and terminal. Tracking currently supports Codex; Claude can be launched but is not listed.

Starting from an empty editor uses the full width. Empty groups are reused, and a second group is created only when ordinary content and chat need to coexist.

Install the VSIX in the companion account's local VS Code, then reload existing ADE editors. Install and sign in to the provider CLIs on that machine separately. Commands default to `codex --no-daemon` and `claude`; customize them through the project’s `chatCommands.codex` and `chatCommands.claude` in the companion’s `server.yaml`. Commands apply to all worktrees in the project after restarting the companion.

Keep `--no-daemon` in customized Codex commands so hooks run with the ADE terminal’s reporting context. A shared Codex daemon cannot report activity for these terminals.

VS Code controls terminal titles and persistence. The extension remembers only the chat group created during its current activation. After reactivation, existing terminals remain unmanaged; the next chat launch reuses an empty group or creates a new one. Deactivation does not close terminals or delete groups. VS Code still permits manually moving tabs and unlocking groups.

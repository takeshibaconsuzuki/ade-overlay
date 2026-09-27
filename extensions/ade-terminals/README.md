# ADE Terminals

Open **ADE** in the Activity Bar to launch a **Terminal**, **Codex**, or **Claude** in the current workspace. Every click creates a new terminal in the editor area. Ordinary terminals share groups with files; provider terminals share a separate locked group.

Starting from an empty editor uses the full width. Empty groups are reused, and a second group is created only when ordinary content and chat need to coexist.

Install the VSIX in the companion account's local VS Code, then reload existing ADE editors. Install and sign in to the provider CLIs on that machine separately. Commands default to `codex` and `claude`; change `adeTerminals.codexCommand` or `adeTerminals.claudeCommand` in that machine's User/Remote settings to customize them.

VS Code controls terminal titles and persistence. The extension remembers only the chat group created during its current activation. After reactivation, existing terminals remain unmanaged; the next chat launch reuses an empty group or creates a new one. Deactivation does not close terminals or delete groups. VS Code still permits manually moving tabs and unlocking groups.

# Contributor Commands

- `python scripts/bootstrap.py | iex` (PowerShell) or `eval "$(python scripts/bootstrap.py)"` (POSIX): set up and activate the development environment. Run this before running any other commands in the repo.
  - Codex does not have persistent terminals, so the fast path needs to be fast enough to run before every agent command.
- `npm run dev`: start Electron/Vite.
- `npm run server`: build and start the companion in a separate terminal. Append `-- --config path/to/server.yaml` to select a config.
- `npm run server:dev`: watch server sources and rebuild the browser settings bridge; accepts the same config argument.
- `npm run setup`: build and install the extension and provider hooks; accepts `-- --config path/to/server.yaml`. Rerun after upgrades, relocation or provider-home changes.
- `npm run build` / `npm run build:server`: build everything / just the companion into `out/`.
- `npm run build:extension`: package the workspace extension as `out/ade-terminals.vsix`.
- `npm run package`: build desktop installers and a companion archive for the host OS and architecture into `dist/`. Use the Node runtime pinned in `.node-version`. `npm run package:dir` skips desktop installers for local checks.
- `npm run test:package`: smoke-test the extracted companion without system Node, extension setup and desktop package contents after packaging.
- `npm run test:extension`: run isolated VS Code extension-host tests; set `ADE_TEST_VSCODE_EXECUTABLE` to an existing VS Code executable to avoid downloading a test runtime.
- `npm run typecheck`: check app, companion, and tests.
- `npm test`: run socket and temporary Git repository integration tests. Git must be on PATH.
- `python -B -m unittest discover -s tests/integration -p test_bootstrap.py`: check bootstrap caching and setup recovery.
- `npm run test:runtime`: prepare the approved VS Code build and require real-editor and extension-host compatibility tests. On Linux, use `xvfb-run -a npm run test:runtime`. The Package workflow runs this on every supported platform.
- Set `ADE_TEST_VSCODE_RUNTIME` to an approved, prepared VS Code web server runtime and run `npm run build` followed by `npm test` to also check the real editor window, worktree switching and restoration across desktop restarts.
- `npm run lint` / `npm run lint:fix`: check / fix ESLint issues.
- `npm run format`: format with Prettier.
- `npm run upgrade`: upgrade dependencies to the latest peer-compatible versions, pin them, and install.

## Server Deployment

The companion runs independently of the desktop app. Release archives include Node, locked production dependencies and the matching VSIX. Extract to a stable path on a machine with Git and VS Code, supply the configuration, run `--setup` and run the launcher under the repository owner's account. Worktree paths refer to that machine's filesystem.

## Packaging

Desktop and companion payloads are staged separately from the root lockfile. The desktop contains only its runtime dependencies; external companion scripts stay on disk for Node and VS Code to execute. The root package version drives all artifacts, including the VSIX. Upgrades are manual and coordinated because restarting the companion stops its editors. Persistent state stays outside installation directories, with a stable desktop application-data identity.

The Package workflow builds and checks native artifacts on Windows, Linux and both Mac architectures. Manual runs can produce unsigned test builds; version tags must match `package.json` and require desktop signing on Windows and signing/notarization on macOS. Set `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD`, `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`, and `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` as Actions secrets. Local builds use electron-builder's `CSC_LINK` and `CSC_KEY_PASSWORD` variables; `ADE_REQUIRE_SIGNING=true` enforces release signing. Workflow artifacts are uploaded for review, not automatically published. Verify VS Code Server usage and redistribution terms before a public release; its binaries are downloaded by the installed CLI and are not included in our packages.

# Architecture

- Keep direct dependencies pinned to exact versions. Use `npm run upgrade` to update existing dependencies.
- Keep contributor information here and end-user instructions in `README.md`. Keep both short and easy to understand.
- Documentation guidelines:
  - Keep high-level design decisions here and product workflows in `workflows/`. Keep implementation details in the code.
  - Start at the [product workflow index](workflows/README.md) for behavior across the desktop, companion, and workspace extension.
  - Think about what a tech lead who is not very familiar with the codebase would need to know to make informed architectural decisions.
  - Keep durable information; exclude release-specific details such as version numbers.
  - Describe broader concepts instead of enumerating implementation details.
  - Follow [workflows/INSTRUCTIONS.md](workflows/INSTRUCTIONS.md) when creating or updating product workflow documentation.
- Delegate aggressively to well-maintained libraries, even when the current requirement is small or isolated. They usually handle edge cases better and give us a stronger base for future requirements.
- This project is still in development. Assume the server and client always run the same build. Preserve protocol discovery without incrementing the protocol version counter. Do not implement migrations.

## Codebase Layout

The server groups editor runtime, processes, transport and settings under `src/server/editors/`; chat registry, navigation, providers and hooks under `src/server/chats/`; and Git membership, operations and identity under `src/server/worktrees/`. Entry points, composition, configuration, logging and companion transport stay at the server root. Tests are grouped by domain, integration, Electron and real-runtime requirements. Reusable harness functions live in `tests/helpers/`, fake services and data in `tests/fixtures/`, and executable assertion scenarios beside their suites.

The desktop app separates presentation from privileged work. Main owns the current companion state: it fetches on connection, accepts newer snapshots from replies and broadcasts, and reconciles retained editors before publishing state to the picker. Connection changes reset snapshot ordering; late replies from earlier connections cannot replace current state. The renderer reads and subscribes to that state and owns presentation and transient interactions. IPC commands acknowledge completion without returning snapshots. Preload provides a narrow bridge, and the companion credential stays in main. App-owned UI components wrap the component library and expose application theme tokens. The reusable picker owns row registration, pointer/keyboard selection, focus, scrolling and tooltip dismissal; features supply filtered items, availability and actions. Modal presence suspends its owning picker through an explicit interaction scope.

The companion server owns configuration, Git operations, and the shared view of worktrees. It caches only Git membership facts and projects them with the operation/error overlay and editor status into displayed rows. The overlay survives desktop reconnects. Status precedence is pending operation, retained error, then editor running or stopped. Opening an editor preserves row errors until explicitly cleared. Synthetic creation rows never participate in editor reconciliation. Clearing an error removes a synthetic row only when Git has no corresponding worktree. Changes and refreshes run in order so concurrent clients see consistent results.

The public server entry point constructs services, selects routes and owns the listener lifecycle. Editor transport owns editor HTTP and WebSocket authentication and proxying; companion transport owns desktop connections, commands, broadcasts and chat routing. Transports release their own connections, subscriptions and timers. Shutdown stops admission and closes transports before draining accepted work, including requests still resolving creation paths, and stopping editor processes; startup failures use the same cleanup.

Every accepted Git worktree list follows one application path: reconcile editor processes against the complete list, then publish the resulting state. Project scans first merge with other projects' cached worktrees. Editor-status broadcasts do not change membership or trigger reconciliation. The store requires a narrow editor lifecycle contract. Cache and editor identities share path normalization; editor IDs remain stable to preserve saved workspace data.

The shared layer defines the contract between the app and server. Library-backed schemas validate incoming data and provide the matching types. Keep both sides of the contract in step when behavior changes. Lightweight desktop IPC definitions stay separate from network schema initialization. Shared Node utilities and browser UI components have explicit module boundaries; the desktop and extension import them directly without depending on each other's implementation areas.

The companion owns a VS Code web server process per opened worktree. Stable workspace data directories retain editor state; all processes use the companion account's local VS Code extensions directory. Startup is registered in the worktree queue, then download and readiness waits run independently so Git operations remain responsive. Deletion and shutdown cancel pending starts. Processes live until deletion, failure or companion shutdown, independently of desktop connections. The main process owns a single editor window with retained views and persistent browser storage. Editor views have no preload bridge or Node access. The main process supplies editor request credentials without exposing them through the worktree picker's preload bridge. VS Code manages its own editor-page session cookie.

The picker window owns the desktop app's lifetime on every platform: closing it quits the app and closes all editor views. Closing only the editor window immediately hides its retained views while the picker stays open. Desktop shutdown prioritizes responsiveness and does not honor editor unload vetoes or wait for saves, backups or settings synchronization. Losing recent unsaved edits or unfinished backups is an accepted tradeoff. Companion processes keep running, but cannot preserve browser state that was never saved. The server must never hold the client open.

One desktop navigation coordinator owns picker and chat requests, supersession and cancellation. Picker completion follows page readiness; chat completion belongs to the companion through terminal acknowledgement. Cancelling a request suppresses its later effects without stopping shared editor startup or disposing retained pages. Picker failures use shared row errors with a local fallback; chat startup errors remain server-owned and page errors are shared without delaying the source reply.

Each retained editor page owns its current document navigation throughout its lifetime; the editor window owns retained views and selection. Opening reuses ready pages, waits for loading pages, and replaces failed pages; token rotation also replaces the page. Only the current document navigation can complete readiness, and disposal belongs to the specific view being removed. Readiness depends on the main document, independently of subresources.

The active editor view and its extension frames may use the clipboard and microphone; clipboard reads require a user gesture. Other browser permission requests remain denied. VS Code and Chromium retain their frame-level policies, and operating-system microphone permissions still apply. The editor proxy replaces only the authentication cookie, preserving browser preferences such as display language.

# Contributor Commands

Run `python scripts/bootstrap.py | iex` (PowerShell) or `eval "$(python scripts/bootstrap.py)"` (POSIX) before every repo command. Agent shells do not persist; keep the bootstrap's cached path fast.

- `npm run dev`: start Electron/Vite.
- `npm run server:dev`: start and watch the companion in a separate terminal.
- `npm run setup`: build and install the extension and provider hooks. Rerun after upgrades, relocation or provider-home changes.
- `npm run build` / `npm run build:server`: build everything / the companion into `out/`.
- `npm run build:extension`: package `out/ade-terminals.vsix`.
- `npm run package` / `npm run package:dir`: produce native release artifacts in `dist/`, with / without desktop installers.
- `npm run test:package`: smoke-test the companion with bundled Node; verify extension setup, desktop contents and macOS signatures.
- `npm run typecheck`, `npm test`, `npm run lint`: check types, tests and lint. Tests require Git on `PATH`.
- `npm run lint:fix` / `npm run format`: fix lint / format with Prettier.
- `python -B -m unittest discover -s tests/integration -p test_bootstrap.py`: test bootstrap caching and recovery.
- `npm run test:extension`: run extension-host tests. Set `ADE_TEST_VSCODE_EXECUTABLE` to reuse an installed VS Code.
- `npm run test:runtime`: prepare the approved VS Code build and test real-editor and extension compatibility. Use `xvfb-run -a` on Linux. To reuse a prepared runtime, set `ADE_TEST_VSCODE_RUNTIME`, then run `npm run build` and `npm test`.
- `npm run upgrade`: upgrade, pin and install peer-compatible dependencies.

`server:dev` and `setup` accept `-- --config path/to/server.yaml`.

## Packaging

Desktop and companion ship separately under one release version. Keep persistent state outside installations and preserve the desktop application-data identity. VS Code Server is downloaded rather than redistributed.

Local macOS packages default to ad-hoc signing; Windows and macOS releases require certificate signing, with notarization on macOS. CI uploads artifacts for review without publishing releases automatically.

# Architecture

- Pin direct dependencies to exact versions; update them with `npm run upgrade`. Prefer well-maintained libraries over custom implementations, including for small features.
- Server and client run the same build. Preserve protocol discovery; do not increment its version or implement migrations.
- Keep contributor guidance and durable design decisions here, user instructions in [README.md](README.md), behavior in [workflows/](workflows/README.md), and implementation details in code. Keep docs concise and omit release-specific details. Follow [workflows/INSTRUCTIONS.md](workflows/INSTRUCTIONS.md) when editing workflows.

## Codebase Layout

Under `src/server/`, domains live in `editors/`, `chats/` and `worktrees/`; composition, configuration, logging and companion transport stay at the root. Tests are grouped by domain, integration, Electron and real runtime, with harnesses in `tests/helpers/`, fakes in `tests/fixtures/` and assertion scenarios beside their suites.

## Ownership and Lifecycle

- **Desktop:** main owns companion state, credentials and navigation. Reject stale snapshots across reconnects and reconcile retained editors before publishing state. The renderer owns presentation and transient interactions; IPC commands acknowledge completion without returning snapshots. Keep preload narrow. The companion owns paste reservations; main supplies the calling document identity.
- **UI:** app components wrap the library and expose theme tokens. The shared picker owns interaction and focus; features supply items and actions. Modals suspend their picker through an explicit interaction scope. Menus list every action and disable unavailable ones instead of omitting them.
- **Companion:** owns configuration, Git membership and shared operation/error state. Serialize mutations and refreshes. Reconcile editors against complete Git membership before publishing; exclude synthetic rows. Editor-status events must not change membership or trigger reconciliation. Keep path normalization consistent and editor identities stable.
- **Contracts:** validate network data with library-backed schemas and matching types; update both sides together. Keep desktop IPC independent of network schema initialization. Import shared Node and browser modules directly without crossing desktop/extension implementation boundaries.
- **Editors:** the companion owns one process per opened worktree, independently of desktop connections. Register startup in the Git queue, then release the queue during download/readiness waits. Deletion and shutdown cancel pending starts. Workspace data is per worktree; local VS Code extensions are shared.
- **Navigation:** one desktop coordinator owns picker/chat cancellation and supersession. Cancellation suppresses later effects without stopping shared startup or disposing retained pages. Picker completion follows page readiness; chat completion follows terminal acknowledgement. Each page owns its current document readiness; the editor window owns retained views and selection.
- **Shutdown:** closing the picker quits the desktop; closing the editor window only hides its pages. Desktop exit never waits for the companion, editor unload approval, saves, backups or settings sync. Companion shutdown stops admission and closes transports before draining accepted work and stopping editors. Startup failures use the same cleanup; transports release their own resources.
- **Security:** editor views have no Node access. Their preload exposes only paste reservation and submission, scoped by main to the active editor document. Main supplies editor credentials without exposing them to the picker. Only active editor views and their extension frames may request clipboard/microphone access; clipboard reads require a gesture. Deny other permissions and retain browser/OS restrictions. The editor proxy replaces only the authentication cookie.

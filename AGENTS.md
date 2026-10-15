# Agent Rules

- Activate the development environment before running any other command.
- NEVER bypass `scripts/bootstrap.py` for development environment setup or activation. Run it from the checkout being used and let it provision that checkout's own environment; do not substitute manual setup or share another checkout's environment through junctions or symlinks.
- During reviews, treat TODOs that explicitly defer behavior as intentional scope decisions. Do not flag the deferred behavior itself; flag defects outside that scope or consequences the TODO does not acknowledge. A TODO alone does not exempt surrounding code from review.
- Do not install dependencies globally. Install them into the project instead, using methods such as vendoring or virtual environments.
- Use `npm run upgrade` instead of manually editing version ranges when updating dependencies.
- Keep prose focused on durable intent and contracts. Preserve general wording that already describes the behavior correctly. Don’t add implementation details or enumerate current components. Change documentation only when the task makes it inaccurate or incomplete.
- When refactoring, remove dead code made obsolete by the change.

# Code Rules

- Follow surrounding code and documentation conventions. Document contracts and lifecycle behavior that names and types do not make clear.
- When dependency injection is needed for testing, define an explicit interface and a separate implementation.
- Do not manually wrap prose in markdown or text files. Use newlines only when they serve a structural or semantic purpose.
- Delegate aggressively to well-maintained libraries, even when the current requirement is small or isolated. They usually handle edge cases better and give us a stronger base for future requirements.
- We are still in development. Do not implement backwards compatibility or migrations.
- Keep direct dependencies pinned to exact versions in `package.json`.
- Keep the fast path of `scripts/bootstrap.py` fast enough to run before every command; the agent does not have a persistent shell session, so it must run it before every command.
- Strongly prefer to use the bidirectional RPC to communicate between the desktop client and the extension. Treat patching vscode as a last resort, used only when no other alternatives exist.

# Development

To install the development environment if needed and activate it:

```powershell
python scripts/bootstrap.py | iex
```

On Posix:

```bash
eval "$(python scripts/bootstrap.py)"
```

- `npm run dev`: start the development app.
- `npm run dev:server`: start the development server.
- `npm run package`: build a desktop installer for the current platform in `out/packages`.
- `npm run lint:fix`: run lint with auto-fixes.
- `npm run format`: format files.

See `package.json` for other commands.

Desktop packages connect to a separately running ADE server, using `ADE_SERVER_URL` when set. Packaging does not publish artifacts.

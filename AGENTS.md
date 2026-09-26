# Repository Guidelines

## Build, Test, and Development Commands

- `python scripts/bootstrap.py | iex` (PowerShell): installs the expected Node.js version if it is missing or stale and activates it in the current shell.
- `eval "$(python scripts/bootstrap.py)"` (Linux/macOS): initializes and activates the same development environment in the current POSIX shell.
- Add `--force` before the pipe or inside the command substitution to replace the existing vendored Node.js directory.
- `npm install`: installs dependencies and downloads the Electron app binary via `postinstall`.
- `npm run dev`: starts the Electron/Vite development app.
- `npm run build`: builds production output into `out/`.
- `npm run typecheck`: runs TypeScript checks for Electron main/preload and React renderer code.
- `npm run lint`: runs ESLint.
- `npm run lint:fix`: runs ESLint with auto-fixes.
- `npm run format`: formats files with Prettier.
- `npm run upgrade`: upgrades dependencies to the latest peer-compatible versions, pins exact versions, and runs `npm install`.

## Dependency Policy

- Keep direct dependencies pinned to exact versions in `package.json`.
- Use `npm run upgrade` instead of manually editing version ranges when updating dependencies.

## Architecture Notes

- `src/main/`: Electron main process. Owns app lifecycle, window creation, and privileged OS/Electron work.
- `src/preload/`: secure bridge loaded before the renderer. Expose only narrow renderer APIs with `contextBridge`.
- `src/renderer/`: React/browser UI. Treat this as unprivileged browser code; do not rely on Node APIs here.

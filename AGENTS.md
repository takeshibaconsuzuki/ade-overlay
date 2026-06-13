# Repository Guidelines

## Build, Test, and Development Commands

- `python3 bootstrap.py`: installs the expected Node.js version for the current platform if it is missing or stale.
- `python3 bootstrap.py --force`: replaces the existing vendored Node.js directory.
- `eval "$(python3 bootstrap.py --print-env)"`: configures the current POSIX shell to use the vendored Node.
- `npm install`: installs dependencies and downloads the Electron app binary via `postinstall`.
- `npm run dev`: starts the Electron/Vite development app.
- `npm run build`: builds production output into `out/`.
- `npm run typecheck`: runs TypeScript checks for Electron main/preload and React renderer code.
- `npm run lint`: runs ESLint.
- `npm run lint:fix`: runs ESLint with auto-fixes.
- `npm run format`: formats files with Prettier.
- `npm run client:generate`: generates the shared TypeScript API client into `src/api/generated/`.
- `npm run upgrade`: upgrades dependencies to the latest peer-compatible versions, pins exact versions, and runs `npm install`.

## Dependency Policy

- Keep direct dependencies pinned to exact versions in `package.json`.
- Use `npm run upgrade` instead of manually editing version ranges when updating dependencies.

## Architecture Notes

- `src/main/`: Electron main process. Owns app lifecycle, window creation, and privileged OS/Electron work.
- `src/preload/`: secure bridge loaded before the renderer. Expose only narrow renderer APIs with `contextBridge`.
- `src/renderer/`: React/browser UI. Treat this as unprivileged browser code; do not rely on Node APIs here.
- `src/api/generated/`: generated TypeScript client shared by main, preload, and renderer code. Do not edit generated files by hand; update server schemas/routes and run `npm run client:generate`.
- `src/server/`: Fastify HTTP server. Root-level files are for code shared by all server services.
- `src/server/config.ts`: source of truth for server host, port, origin, OpenAPI path, and temporary OpenAPI generation path. Do not duplicate these literal values elsewhere.
- `src/server/worktrees/`: worktrees service.

## Server API Guidelines

- Use Fastify 5 with `fastify-type-provider-zod` and Zod v4 schemas for typed routes.
- Define reusable request/response/domain schema constants in the owning service's `schemas.ts`, for example `AddRepositoryRequest = z.object(...)`, and export matching inferred TypeScript types.
- Register service routes from the service's `routes.ts`; keep `src/server/server.ts` focused on Fastify setup, common middleware/plugins, error handling, and service registration.
- Expose OpenAPI through `@fastify/swagger`; generate clients from OpenAPI with `npm run client:generate`.
- Generated client output is intentionally shared at `src/api/generated/`, not under renderer, because main/preload/renderer may all consume it.

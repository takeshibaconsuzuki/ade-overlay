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
- `npm run client:generate`: generates the shared TypeScript API client into `src/api/server/generated/`.
- `npm run upgrade`: upgrades dependencies to the latest peer-compatible versions, pins exact versions, and runs `npm install`.

## Dependency Policy

- Keep direct dependencies pinned to exact versions in `package.json`.
- Use `npm run upgrade` instead of manually editing version ranges when updating dependencies.

## Architecture Notes

- `src/main/`: Electron main process. Owns app lifecycle, window creation, and privileged OS/Electron work.
- `src/preload/`: secure bridge loaded before the renderer. Expose only narrow renderer APIs with `contextBridge`.
- `src/renderer/`: React/browser UI. Treat this as unprivileged browser code; do not rely on Node APIs here. It may import shared contracts **only** from `src/api` (enforced by ESLint `no-restricted-imports`).
- `src/api/`: node-free shared API contracts, importable by all. Must stay free of `node:*` imports and must not depend on runtime source layers (enforced by ESLint).
- `src/api/server/`: shared HTTP server API surface. Contains hand-authored contract modules (e.g. `config.ts`, `events.ts`) alongside the generated client.
- `src/api/server/generated/`: generated TypeScript client. Do not edit generated files by hand; update server schemas/routes and run `npm run client:generate`. Only this subdirectory is generated — hand-authored shared server modules live directly under `src/api/server/`.
- `src/api/server/config.ts`: source of truth for server constants. Do not duplicate these literal values elsewhere.
- `src/api/preload/`: shared Electron preload API surface. Keep preload bridge contracts here so preload implementations and renderer ambient declarations use the same node-free types.
- `src/server/`: Fastify HTTP server. Root-level files are for code shared by all server services.
- `src/server/worktrees/`: worktrees service.

## Logging

- `src/api/server/logger.ts` defines the shared `Logger` interface (node-free) so code depends on the contract, not a concrete logger. Pino, Pino's browser build, and Fastify's `FastifyBaseLogger` are all structurally assignable to it. Type service/util params as `Logger`, not a framework type.
- Use Pino as the implementation everywhere. Node-side code logs through `src/server/logger.ts` (the same instance Fastify uses via `loggerInstance`); the renderer uses Pino's browser build via `src/renderer/src/log.ts`.
- Renderer logs are consolidated server-side: the browser logger's Pino `transmit` hook batches records (≥ `info`) to `POST /logs`, which re-emits them through the server logger tagged `source: 'renderer'`. They also print to the devtools console for local debugging.
- Prefer the request/instance logger (`request.log`, `server.log`) inside routes; give services a context-bound child, e.g. `server.log.child({ service: 'worktrees' })`.
- Log structured data first: `log.info({ worktreeId }, 'worktree created')`, not string concatenation. Use the `err` key for errors.

## Server API Guidelines

- Use Fastify 5 with `fastify-type-provider-zod` and Zod v4 schemas for typed routes.
- Define reusable request/response/domain schema constants in the owning service's `schemas.ts`, for example `AddRepositoryRequest = z.object(...)`, and export matching inferred TypeScript types.
- Register service routes from the service's `routes.ts`; keep `src/server/server.ts` focused on Fastify setup, common middleware/plugins, error handling, and service registration.
- Expose OpenAPI through `@fastify/swagger`; generate clients from OpenAPI with `npm run client:generate`.
- Generated client output is intentionally shared at `src/api/server/generated/`, not under renderer, because main/preload/renderer may all consume it.

## Renderer Guidelines

- Lean **heavily** into radix themes. Use little to no css styling, rely on radix themes for looks.

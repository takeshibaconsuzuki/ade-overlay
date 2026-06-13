# Repository Guidelines

## Commands

- `python3 bootstrap.py`: install or refresh the vendored Node.js runtime.
- `eval "$(python3 bootstrap.py --print-env)"`: put vendored Node first on `PATH`.
- `npm install`
- `npm run dev`: run the Electron/Vite development app.
- `npm run build`: build production output into `out/`.
- `npm run typecheck`
- `npm run lint`: run ESLint.
- `npm run lint:fix`: run ESLint fixes.
- `npm run format`: format with Prettier.
- `npm run client:generate`: regenerate `src/api/server/generated/`.
- `npm run upgrade`: update dependencies with exact pinned versions.

## Architecture

- `src/main/`: Electron main-process code and privileged desktop integration.
- `src/preload/`: narrow bridge between Electron and the renderer.
- `src/renderer/`: unprivileged React/browser code. Do not import Node APIs or runtime layers.
- `src/api/`: node-free shared contracts. Keep server and preload contracts separate.
- `src/api/server/generated/`: generated client output. Do not edit by hand.
- `src/server/`: Fastify runtime code. Add behavior through service routes and schemas.

## Dependency Policy

- Keep direct dependencies pinned exactly in `package.json`.
- Use `npm run upgrade` for dependency updates.

## Server API

- Use Fastify 5 with `fastify-type-provider-zod` and Zod v4.
- Keep schemas in each service `schemas.ts`; register routes from each service `routes.ts`.
- Keep shared server constants in `src/api/server/config.ts`.
- When route schemas or operation IDs change, run `npm run client:generate`.

## Logging

- Node-side code logs through `src/server/logger.ts`.
- Renderer logs use `src/renderer/src/logger.ts` and are shipped to `POST /logs`.
- Type shared logging dependencies as `Logger` from `src/api/server/logger.ts`.
- Prefer structured fields before the message and use `err` for errors.

## Renderer

- Lean **heavily** into radix themes. Use little to no css styling, rely on radix themes for looks.
- Use generated server clients from `src/api/server/generated/`.
- Use preload contracts from `src/api/preload/`; do not import preload, main, or server runtime files.
- Keep ambient desktop API declarations aligned with `src/api/preload/desktop.ts`.

## Electron

- Keep privileged native work in main or preload.
- Keep preload bridge methods small and backed by one main-process handler.
- Preserve context isolation and avoid enabling renderer Node integration.

# Design

## Server

Electron code is the frontend and acts as a lightweight client. The server is authoritative and owns all application state. Application coordination should live behind server APIs. Server ownership ensures there is a single source of truth, and thus prevents inconsistencies and desyncs between clients.

## Server API

`src/api/server/*` is the shared server API surface: route constants, enums, Zod schemas, inferred types, and SSE/WebSocket message schemas live there. `src/server/*/routes.ts` registers Fastify routes by importing those shared schemas. Renderer REST calls use the generated OpenAPI client in `src/api/server/generated/*`; renderer SSE and WebSocket code parses messages directly with the shared Zod schemas.

## Electron Roles

Each role below is a separate app. All roles except the controller get an entry in the macos dock, so users can command+tab between them.

- Controller: starts the server and owns the launcher and worktrees window.
- Editor: displays VS Code web sessions.
- Chat: displays server-hosted chat terminals.

## Worktrees

The worktree registry is the source of truth for tracked repositories and worktrees.

- Treat worktree IDs as opaque handles. Do not derive IDs or editor state from paths outside the registry.
- Clean up editor state before removing the worktree it depends on.
- Stream worktree state from the server as a snapshot plus incremental changes.
- Worktree creation is asynchronous; expose progress and errors through server state instead of renderer-owned job tracking.

## Editor

The editor multiplexes one VS Code web session per worktree.

- The editor role is separate from the controller so it behaves like its own app in desktop window switching.
- Session data persistence per worktree depends on each worktree having a stable, distinct origin. The local server owns editor routing from worktree-specific localhost origins to the matching VS Code session.
- To mimic the local VS Code experience, bootstrap HTML injects portable user data and reuses local extensions before handing control to VS Code.

## Terminals

- Terminals belong in the server so they survive closing and reopening of client windows.
- Treat `terminalId` as the server-owned PTY id. It is ephemeral, exists only while this app owns a running terminal, and is the only id clients should use to attach terminal WebSockets or select terminal tabs.

## Chats

- The ChatProvider interface abstracts away differences between provider implementations.
- Chat CLIs run in server-owned terminals. Chats and terminals are separate independent concepts. The server is responsible for stamping `terminalId` onto emitted chat state.
- Chats become live on first hook. Liveness has no correlation with terminal existence. This ensures "garbage" like new chats with no user prompt and resumes with no additional user prompts stay out of the live chat list.
- External chats are live chats that we did not spawn a terminal for. Since we do not own the terminal for external chats, they are surfaced as disabled rows in the live chat list. An absent `terminalId` means the live chat is external.
- Treat `chatId` as the provider-scoped conversation/session id. It is stable across provider hooks and historical session records, but it is not globally unique without `providerId`; key live chat state as `(providerId, chatId)`.

## Logs

Node-side code logs through the shared server logger. Electron logs are shipped back to the server so one process owns the log stream.

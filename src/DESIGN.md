# Design

## Server-Centered Coordination

The controller role starts the local server and acts as a lightweight client.
Application coordination should live behind server APIs so renderer and
Electron code can request work and display state without owning it.

## Worktrees

The worktree registry is the source of truth for tracked repositories and worktrees.

- Treat worktree IDs as opaque handles. Do not derive IDs or editor state from
  paths outside the registry.
- Clean up editor state before removing the worktree it depends on.

## Editor

The editor multiplexes one VS Code web session per worktree.

- The editor role is separate from the controller so it behaves like its own app
  in desktop window switching.
- Session data persistence per worktree depends on each worktree having a stable, distinct
  origin. The local server owns editor routing from worktree-specific localhost origins to
  the matching VS Code session.
- To mimic the local VS Code experience, bootstrap HTML injects portable user
  data and reuses local extensions before handing control to VS Code.

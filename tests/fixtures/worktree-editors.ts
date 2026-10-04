import { EventEmitter } from 'node:events'
import type { EditorServerLifecycle } from '../../src/server/editors/editor-manager.ts'
import { editorServerId } from '../../src/server/worktrees/worktree-identity.ts'
import type {
  EditorServerSession,
  WorktreeRef,
  Worktree,
} from '../../src/shared/companion.ts'

// Store tests explicitly provide editor ownership without launching processes.
export class WorktreeEditors
  extends EventEmitter<{ status: [] }>
  implements EditorServerLifecycle
{
  readonly retained: WorktreeRef[][] = []
  private sessions = new Map<string, EditorServerSession>()

  status(worktree: WorktreeRef): Worktree['editorServer'] {
    return this.sessions.has(editorServerId(worktree)) ? 'running' : 'stopped'
  }

  detail(): string | undefined {
    return undefined
  }

  async open(worktree: WorktreeRef): Promise<EditorServerSession> {
    const id = editorServerId(worktree)
    const session = this.sessions.get(id) ?? {
      id,
      path: `/editors/${id}/`,
      accessToken: 'a'.repeat(64),
    }
    this.sessions.set(id, session)
    this.emit('status')
    return session
  }

  async stop(worktree: WorktreeRef): Promise<void> {
    if (this.sessions.delete(editorServerId(worktree))) this.emit('status')
  }

  async retain(worktrees: WorktreeRef[]): Promise<void> {
    this.retained.push(structuredClone(worktrees))
    const ids = new Set(worktrees.map(editorServerId))
    for (const id of this.sessions.keys()) {
      if (!ids.has(id)) {
        this.sessions.delete(id)
        this.emit('status')
      }
    }
  }
}

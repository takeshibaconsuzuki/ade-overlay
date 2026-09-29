import { EventEmitter } from 'node:events'
import type { EditorLifecycle } from '../../src/server/editors/editor-manager.ts'
import { editorId } from '../../src/server/worktrees/worktree-identity.ts'
import type {
  EditorSession,
  OpenEditorInput,
  Worktree,
} from '../../src/shared/companion.ts'

// Store tests explicitly provide editor ownership without launching processes.
export class WorktreeEditors
  extends EventEmitter<{ status: [] }>
  implements EditorLifecycle
{
  readonly retained: OpenEditorInput[][] = []
  private sessions = new Map<string, EditorSession>()

  status(worktree: OpenEditorInput): Worktree['editor'] {
    return this.sessions.has(editorId(worktree)) ? 'running' : 'stopped'
  }

  detail(): string | undefined {
    return undefined
  }

  async open(worktree: OpenEditorInput): Promise<EditorSession> {
    const id = editorId(worktree)
    const session = this.sessions.get(id) ?? {
      id,
      path: `/editors/${id}/`,
      accessToken: 'a'.repeat(64),
    }
    this.sessions.set(id, session)
    this.emit('status')
    return session
  }

  async stop(worktree: OpenEditorInput): Promise<void> {
    if (this.sessions.delete(editorId(worktree))) this.emit('status')
  }

  async retain(worktrees: OpenEditorInput[]): Promise<void> {
    this.retained.push(structuredClone(worktrees))
    const ids = new Set(worktrees.map(editorId))
    for (const id of this.sessions.keys()) {
      if (!ids.has(id)) {
        this.sessions.delete(id)
        this.emit('status')
      }
    }
  }
}

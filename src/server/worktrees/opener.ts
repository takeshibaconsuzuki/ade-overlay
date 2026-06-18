import { ADE_APP_ROLE, type AdeAppRole } from '../../api/server/appFocus'
import { type AppFocusService } from '../appFocus/service'
import { type ChatService } from '../chats/service'
import { type EditorService } from '../editor/service'

export class WorktreeOpener {
  constructor(
    private readonly editor: EditorService,
    private readonly chat: ChatService,
    private readonly focus: AppFocusService,
  ) {}

  async openWorktree(
    worktreeId: string,
  ): ReturnType<EditorService['openWorktreeEditor']> {
    const foregroundRole = this.getForegroundRole()
    const response = await this.editor.openWorktreeEditor(worktreeId)
    this.chat.openChat()
    this.foreground(foregroundRole)
    return response
  }

  private getForegroundRole(): AdeAppRole {
    return this.focus.getPreferredRole()
  }

  private foreground(role: AdeAppRole): void {
    if (role === ADE_APP_ROLE.chat) {
      this.chat.focusChat()
      return
    }
    this.editor.showEditor()
  }
}

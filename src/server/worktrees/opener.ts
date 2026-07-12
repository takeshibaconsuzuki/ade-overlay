import { ADE_APP_ROLE, type AdeAppRole } from '../../api/server/appFocus'
import { type OpenWorktreeResponse } from '../../api/server/worktrees'
import { type AppFocusService } from '../appFocus/service'
import { type ChatService } from '../chats/service'
import { type EditorService } from '../editor/service'
import { type WorktreeRegistry } from './registry'

export class WorktreeOpener {
  constructor(
    private readonly editor: EditorService,
    private readonly chat: ChatService,
    private readonly focus: AppFocusService,
    private readonly registry: WorktreeRegistry,
  ) {}

  async openWorktree(
    worktreeId: string,
    { focus = true }: { focus?: boolean } = {},
  ): Promise<OpenWorktreeResponse> {
    const foregroundRole = this.getForegroundRole()
    await this.registry.selectWorktree(worktreeId)
    const response = await this.editor.openWorktree(worktreeId)
    await this.chat.openChat()
    if (focus) {
      this.foreground(foregroundRole)
    }
    return {
      worktreeId: response.worktreeId,
      url: response.url,
      editorAlreadyStarted: response.alreadyStarted,
    }
  }

  private getForegroundRole(): AdeAppRole {
    return this.focus.getPreferredRole()
  }

  private foreground(role: AdeAppRole): void {
    if (role === ADE_APP_ROLE.chat) {
      this.focusChat()
      return
    }
    this.focusEditor()
  }

  focusEditor(): void {
    this.editor.focusEditor()
    this.focus.recordFocused(ADE_APP_ROLE.editor)
  }

  focusChat(target?: { providerId: string; chatId: string }): void {
    this.chat.focusChat(target)
    this.focus.recordFocused(ADE_APP_ROLE.chat)
  }
}

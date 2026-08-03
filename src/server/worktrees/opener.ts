import { ADE_APP_ROLE, type AdeAppRole } from '../../api/server/appFocus'
import { type OpenWorktreeResponse } from '../../api/server/worktrees'
import { type AppFocusService } from '../appFocus/service'
import { type ChatService } from '../chats/service'
import { type EditorService } from '../editor/service'
import { type WorktreeRegistry } from './registry'

type ChatFocusTarget = { providerId: string; chatId: string }

type FocusRequest = {
  id: number
  role: AdeAppRole
  chatTarget?: ChatFocusTarget
}

type OpenWorktreeOptions = {
  focus?: boolean
  foregroundRole?: AdeAppRole
  chatTarget?: ChatFocusTarget
}

export class WorktreeOpener {
  private latestFocusRequestId = 0

  constructor(
    private readonly editor: EditorService,
    private readonly chat: ChatService,
    private readonly focus: AppFocusService,
    private readonly registry: WorktreeRegistry,
  ) {}

  async openWorktree(
    worktreeId: string,
    { focus = true, foregroundRole, chatTarget }: OpenWorktreeOptions = {},
  ): Promise<OpenWorktreeResponse> {
    // Reserve the focus intent before any asynchronous setup. Otherwise an
    // older request that takes longer to open can overwrite a newer request.
    const focusRequest = focus
      ? this.reserveFocusRequest(
          foregroundRole ?? this.getForegroundRole(),
          chatTarget,
        )
      : undefined
    await this.registry.selectWorktree(worktreeId)
    const response = await this.editor.openWorktree(worktreeId)
    await this.chat.openChat()
    if (focusRequest) {
      await this.completeFocusRequest(focusRequest)
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

  private reserveFocusRequest(
    role: AdeAppRole,
    chatTarget?: ChatFocusTarget,
  ): FocusRequest {
    this.latestFocusRequestId += 1
    return { id: this.latestFocusRequestId, role, chatTarget }
  }

  private isCurrentFocusRequest(request: FocusRequest): boolean {
    return request.id === this.latestFocusRequestId
  }

  private async completeFocusRequest(request: FocusRequest): Promise<void> {
    if (!this.isCurrentFocusRequest(request)) {
      return
    }

    if (request.role === ADE_APP_ROLE.chat) {
      this.chat.focusChat(request.chatTarget)
      this.focus.recordFocused(ADE_APP_ROLE.chat)
      return
    }

    const focused = await this.editor.focusEditor(() =>
      this.isCurrentFocusRequest(request),
    )
    if (focused && this.isCurrentFocusRequest(request)) {
      this.focus.recordFocused(ADE_APP_ROLE.editor)
    }
  }

  async focusEditor(): Promise<void> {
    await this.completeFocusRequest(
      this.reserveFocusRequest(ADE_APP_ROLE.editor),
    )
  }

  async focusChat(target?: ChatFocusTarget): Promise<void> {
    await this.completeFocusRequest(
      this.reserveFocusRequest(ADE_APP_ROLE.chat, target),
    )
  }
}

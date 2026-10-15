import { posix, win32 } from 'node:path'
import pRetry from 'p-retry'
import {
  chatTerminalLaunchSchema,
  type Chat,
  type ChatTerminalLaunch,
  type Worktree,
} from '../shared/api'
import type { DesktopChatMethods } from '../shared/editor-rpc'
import { logger } from '../shared/logger'

export interface ChatEditor {
  open(worktree: Worktree): Promise<void>
  openChatTerminal(options: ChatTerminalLaunch): Promise<void>
  focusChatTerminal(path: string, id: string): Promise<boolean>
}

// Paths belong to the server, which may use a different OS from the desktop.
function pathKey(path: string): string {
  return /^(?:[a-z]:[\\/]|\\\\)/i.test(path)
    ? win32.normalize(path).toLowerCase()
    : posix.normalize(path)
}

export class DesktopChatService implements DesktopChatMethods {
  private chats: Record<string, Chat> = {}
  private worktrees: Worktree[] = []
  private pending:
    | {
        id: string
        terminalId: string | undefined
        path: string
        controller: AbortController
      }
    | undefined

  constructor(private readonly editor: ChatEditor) {}

  updateChats(chats: Record<string, Chat>): void {
    this.chats = chats
    const request = this.pending
    if (request) {
      const chat = chats[request.id]
      if (
        !chat ||
        chat.terminalId !== request.terminalId ||
        pathKey(chat.worktreePath) !== request.path
      )
        this.cancelFocus()
    }
  }

  updateWorktrees(worktrees: Worktree[]): void {
    this.worktrees = worktrees
    if (
      this.pending &&
      !worktrees.some(
        (entry) =>
          pathKey(entry.path) === this.pending?.path && !entry.deleting,
      )
    )
      this.cancelFocus()
  }

  disconnect(): void {
    this.cancelFocus()
    this.chats = {}
    this.worktrees = []
  }

  private cancelFocus(): void {
    this.pending?.controller.abort()
    this.pending = undefined
  }

  private worktree(path: string): Worktree {
    const worktree = this.worktrees.find(
      (entry) => pathKey(entry.path) === pathKey(path),
    )
    if (!worktree) throw new Error('Unknown worktree')
    if (worktree.deleting) throw new Error('Worktree is being deleted')
    return worktree
  }

  async openChatTerminal(value: ChatTerminalLaunch): Promise<void> {
    const options = chatTerminalLaunchSchema.parse(value)
    const worktree = this.worktree(options.worktreePath)
    await this.editor.openChatTerminal({
      ...options,
      worktreePath: worktree.path,
    })
  }

  async openChat(id: string): Promise<void> {
    const chat = this.chats[id]
    if (!chat) throw new Error('Chat is no longer available')
    const worktree = this.worktree(chat.worktreePath)
    logger.debug(
      { chatId: id, path: worktree.path, terminalId: chat.terminalId },
      'Opening chat worktree',
    )
    this.cancelFocus()
    const request = {
      id,
      terminalId: chat.terminalId,
      path: pathKey(worktree.path),
      controller: new AbortController(),
    }
    this.pending = request
    try {
      await this.editor.open(worktree)
    } catch (error) {
      if (this.pending === request) this.cancelFocus()
      throw error
    }
    if (this.pending !== request) return
    const terminalId = request.terminalId
    if (!terminalId) {
      this.cancelFocus()
      return
    }
    // Opening acknowledges startup before extension activation or terminal restoration.
    const signal = AbortSignal.any([
      request.controller.signal,
      AbortSignal.timeout(30_000),
    ])
    void pRetry(
      async () => {
        signal.throwIfAborted()
        if (!(await this.editor.focusChatTerminal(worktree.path, terminalId)))
          throw new Error('The chat terminal is not ready')
        logger.debug(
          { chatId: id, path: worktree.path, terminalId },
          'Chat terminal focused',
        )
      },
      { retries: Infinity, minTimeout: 250, maxTimeout: 250, signal },
    )
      .catch((error: unknown) => {
        if (!request.controller.signal.aborted)
          logger.warn(
            { err: error, chatId: id, path: worktree.path, terminalId },
            'Unable to focus chat terminal before expiry',
          )
      })
      .finally(() => {
        if (this.pending === request) this.cancelFocus()
      })
  }
}

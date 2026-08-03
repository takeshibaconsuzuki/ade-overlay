import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { ADE_APP_ROLE } from '../src/api/server/appFocus'
import { type Logger } from '../src/api/server/logger'
import { AppFocusService } from '../src/server/appFocus/service'
import { type ChatService } from '../src/server/chats/service'
import { type EditorService } from '../src/server/editor/service'
import { WorktreeOpener } from '../src/server/worktrees/opener'
import { type WorktreeRegistry } from '../src/server/worktrees/registry'

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve = (): void => undefined
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function createFocusService(): AppFocusService {
  return new AppFocusService({ info: () => undefined } as unknown as Logger)
}

function createOpener(options: {
  registry?: Partial<WorktreeRegistry>
  editor?: Partial<EditorService>
  chat?: Partial<ChatService>
  focus: AppFocusService
}): WorktreeOpener {
  const registry = {
    selectWorktree: async () => undefined,
    ...options.registry,
  } as unknown as WorktreeRegistry
  const editor = {
    openWorktree: async (worktreeId: string) => ({
      worktreeId,
      url: `http://${worktreeId}.localhost/editor`,
      alreadyStarted: true,
    }),
    focusEditor: async (shouldFocus: () => boolean = () => true) =>
      shouldFocus(),
    ...options.editor,
  } as unknown as EditorService
  const chat = {
    openChat: async () => undefined,
    focusChat: () => undefined,
    ...options.chat,
  } as unknown as ChatService

  return new WorktreeOpener(editor, chat, options.focus, registry)
}

test('newer chat focus supersedes editor delayed during worktree setup', async () => {
  const firstSelection = deferred()
  const focus = createFocusService()
  let selectionCount = 0
  let editorFocusAttempts = 0
  const chatTargets: unknown[] = []
  const opener = createOpener({
    focus,
    registry: {
      selectWorktree: async () => {
        selectionCount += 1
        if (selectionCount === 1) {
          await firstSelection.promise
        }
      },
    },
    editor: {
      focusEditor: async () => {
        editorFocusAttempts += 1
        return true
      },
    },
    chat: {
      focusChat: (target) => {
        chatTargets.push(target)
      },
    },
  })

  const editorRequest = opener.openWorktree('editor-worktree', {
    foregroundRole: ADE_APP_ROLE.editor,
  })
  const chatTarget = { providerId: 'codex', chatId: 'newer-chat' }
  await opener.openWorktree('chat-worktree', {
    foregroundRole: ADE_APP_ROLE.chat,
    chatTarget,
  })
  firstSelection.resolve()
  await editorRequest

  assert.equal(editorFocusAttempts, 0)
  assert.deepEqual(chatTargets, [chatTarget])
  assert.equal(focus.getPreferredRole(), ADE_APP_ROLE.chat)
})

test('newer chat focus cancels editor delayed in foreground handoff', async () => {
  const handoffStarted = deferred()
  const finishHandoff = deferred()
  const focus = createFocusService()
  let editorFocusEmissions = 0
  let chatFocusEmissions = 0
  const opener = createOpener({
    focus,
    editor: {
      focusEditor: async (shouldFocus = () => true) => {
        handoffStarted.resolve()
        await finishHandoff.promise
        if (!shouldFocus()) {
          return false
        }
        editorFocusEmissions += 1
        return true
      },
    },
    chat: {
      focusChat: () => {
        chatFocusEmissions += 1
      },
    },
  })

  const editorRequest = opener.openWorktree('shared-worktree', {
    foregroundRole: ADE_APP_ROLE.editor,
  })
  await handoffStarted.promise
  await opener.openWorktree('shared-worktree', {
    foregroundRole: ADE_APP_ROLE.chat,
  })
  finishHandoff.resolve()
  await editorRequest

  assert.equal(editorFocusEmissions, 0)
  assert.equal(chatFocusEmissions, 1)
  assert.equal(focus.getPreferredRole(), ADE_APP_ROLE.chat)
})

import type { CompanionClient } from './companion-client.ts'
import type { CompanionState } from './companion-state.ts'
import type { EditorPage } from './editor-page.ts'
import type { EditorWindow } from './editor-window.ts'
import type { WorktreeRef } from '../shared/companion.ts'

interface Navigation {
  controller: AbortController
  chatId?: string
}

type NavigationWindow = {
  open(
    ...args: Parameters<EditorWindow['open']>
  ): Promise<Pick<EditorPage, 'chatActivation'>>
}

// One user navigation owns desktop effects. Aborting only releases the client
// request; companion startup and retained page lifetimes belong to their owners.
export class EditorNavigation {
  private current?: Navigation
  private readonly client: Pick<
    CompanionClient,
    'companionStartEditorServer' | 'desktopOpenChatResponse'
  >
  private readonly window: NavigationWindow
  private readonly state: Pick<CompanionState, 'startOpen'>

  constructor(
    client: EditorNavigation['client'],
    window: NavigationWindow,
    state: EditorNavigation['state'],
  ) {
    this.client = client
    this.window = window
    this.state = state
  }

  // Resolves to whether the worktree's page became ready. An open superseded
  // during startup never creates its page; one superseded later still loads.
  openWorktree(input: WorktreeRef): Promise<boolean> {
    return this.navigate(input)
  }

  async openChat(id: string, input: WorktreeRef): Promise<void> {
    await this.navigate(input, id)
  }

  // End the selection request without stopping shared editor startup or
  // retained page loading. The currently visible view stays open.
  cancelSelectionRequest(): void {
    const previous = this.invalidate()
    if (previous?.chatId !== undefined)
      this.client.desktopOpenChatResponse(
        previous.chatId,
        'Navigation was superseded.',
      )
  }

  finishOpenChat(id: string): void {
    if (this.current?.chatId === id) this.invalidate()
  }

  private invalidate(): Navigation | undefined {
    const previous = this.current
    this.current = undefined
    previous?.controller.abort()
    return previous
  }

  private async navigate(
    input: WorktreeRef,
    chatId?: string,
  ): Promise<boolean> {
    this.cancelSelectionRequest()
    const navigation: Navigation = { controller: new AbortController(), chatId }
    this.current = navigation
    const finishOpen = this.state.startOpen(input)
    let phase: 'startup' | 'page' | 'activation' = 'startup'
    let failure: string | undefined
    try {
      const editor = await this.client.companionStartEditorServer(
        input,
        navigation.controller.signal,
      )
      if (this.current !== navigation) return false
      phase = 'page'
      // This wait follows the retained page's lifetime, even if the selection
      // request ends. A newer request can select B while A keeps loading.
      const page = await this.window.open(editor, input)
      if (this.current !== navigation || chatId === undefined) return true
      phase = 'activation'
      const activationAfter = await page.chatActivation()
      if (this.current === navigation)
        this.client.desktopOpenChatResponse(chatId, undefined, activationAfter)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const superseded = this.current !== navigation
      // A superseded startup wait only ended; its outcome belongs to the
      // server. A page that fails in the background still fails its row.
      if (superseded && phase !== 'page') return false
      if (!superseded && chatId !== undefined)
        this.client.desktopOpenChatResponse(chatId, message)
      // Only this desktop observed the failure, so it stays this desktop's row
      // error. A chat's startup and activation errors go only to its source.
      if (chatId === undefined || phase === 'page') failure = message
      return false
    } finally {
      finishOpen(failure)
      // Chat navigation remains current through the terminal acknowledgement.
      if (chatId === undefined && this.current === navigation)
        this.current = undefined
    }
  }
}

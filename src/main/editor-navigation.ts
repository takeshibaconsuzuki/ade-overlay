import type { CompanionClient } from './companion-client.ts'
import type { CompanionState } from './companion-state.ts'
import type { EditorPage } from './editor-page.ts'
import type { EditorWindow } from './editor-window.ts'
import type { OpenEditorInput } from '../shared/companion.ts'

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
  private readonly client: Pick<CompanionClient, 'openEditor' | 'chatViewReady'>
  private readonly window: NavigationWindow
  private readonly state: Pick<CompanionState, 'setWorktreeError'>

  constructor(
    client: EditorNavigation['client'],
    window: NavigationWindow,
    state: EditorNavigation['state'],
  ) {
    this.client = client
    this.window = window
    this.state = state
  }

  openWorktree(input: OpenEditorInput): Promise<void> {
    return this.navigate(input)
  }

  openChat(id: string, input: OpenEditorInput): Promise<void> {
    return this.navigate(input, id)
  }

  // End the selection request without stopping shared editor startup or
  // retained page loading. The currently visible view stays open.
  cancelSelectionRequest(): void {
    const previous = this.invalidate()
    if (previous?.chatId !== undefined)
      this.client.chatViewReady(previous.chatId, 'Navigation was superseded.')
  }

  finishChat(id: string): void {
    if (this.current?.chatId === id) this.invalidate()
  }

  private invalidate(): Navigation | undefined {
    const previous = this.current
    this.current = undefined
    previous?.controller.abort()
    return previous
  }

  private async navigate(
    input: OpenEditorInput,
    chatId?: string,
  ): Promise<void> {
    this.cancelSelectionRequest()
    const navigation: Navigation = { controller: new AbortController(), chatId }
    this.current = navigation
    let phase: 'startup' | 'page' | 'activation' = 'startup'
    try {
      const editor = await this.client.openEditor(
        input,
        navigation.controller.signal,
      )
      if (this.current !== navigation) return
      phase = 'page'
      // This wait follows the retained page's lifetime, even if the selection
      // request ends. A newer request can select B while A keeps loading.
      const page = await this.window.open(editor, input)
      if (this.current !== navigation || chatId === undefined) return
      phase = 'activation'
      const activationAfter = await page.chatActivation()
      if (this.current === navigation)
        this.client.chatViewReady(chatId, undefined, activationAfter)
    } catch (error) {
      if (this.current !== navigation) return
      const message = error instanceof Error ? error.message : String(error)
      const report = () =>
        this.state.setWorktreeError({ ...input, error: message.slice(0, 4096) })
      if (chatId !== undefined) {
        // Startup errors belong to the server. Persist page failures without
        // delaying the source extension's failure reply.
        if (phase === 'page') void report().catch(() => {})
        this.client.chatViewReady(chatId, message)
      } else {
        try {
          await report()
        } catch {
          // IPC provides a local row error only if the companion cannot own it
          // and this request has not been superseded while saving the error.
          if (this.current === navigation) throw error
        }
      }
    } finally {
      // Chat navigation remains current through the terminal acknowledgement.
      if (chatId === undefined && this.current === navigation)
        this.current = undefined
    }
  }
}

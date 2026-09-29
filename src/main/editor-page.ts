import type { WebContents } from 'electron'
import { z } from 'zod'

interface Navigation {
  ready: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  response: boolean
  dom: boolean
  timer: ReturnType<typeof setTimeout>
}

// Readiness belongs to the current document, not to the lifetime of a view.
// Keep observing browser-initiated reloads after the first open has completed.
export class EditorPage {
  state: 'loading' | 'ready' | 'failed' | 'disposed' = 'loading'
  private navigation?: Navigation
  private awaitingStart?: Navigation
  private error = new Error('The editor page is unavailable.')

  constructor(
    private readonly contents: WebContents,
    url: string,
    acceptsNavigation: (target: URL | null) => boolean,
  ) {
    contents.on('did-start-navigation', (details) => {
      if (
        !details.isMainFrame ||
        details.isSameDocument ||
        this.state === 'disposed' ||
        // Electron announces the start before will-navigate can cancel an
        // external link. That handoff does not replace this document.
        !acceptsNavigation(URL.parse(details.url))
      )
        return
      if (this.awaitingStart === this.navigation) this.awaitingStart = undefined
      else this.begin()
    })
    contents.on('did-navigate', (_event, _url, status) => {
      if (this.state !== 'loading' || !this.navigation) return
      if (status < 200 || status >= 400) {
        this.fail(
          new Error(
            `The editor page returned HTTP ${status}. Open the worktree again to retry.`,
          ),
        )
        return
      }
      this.navigation.response = true
      this.complete()
    })
    contents.on('dom-ready', () => {
      if (this.state !== 'loading' || !this.navigation) return
      this.navigation.dom = true
      this.complete()
    })
    contents.on(
      'did-fail-load',
      (_event, code, description, _url, isMainFrame) => {
        // ERR_ABORTED can belong to a superseded navigation. A stopped current
        // navigation is handled by did-stop-loading instead.
        if (isMainFrame && code !== -3)
          this.fail(
            new Error(
              `The editor page failed to load (${description}). Open the worktree again to retry.`,
            ),
          )
      },
    )
    contents.on('did-stop-loading', () => {
      if (this.state === 'loading' && !contents.isLoadingMainFrame())
        this.fail(
          new Error(
            'The editor navigation stopped before the page was ready. Open the worktree again to retry.',
          ),
        )
    })
    contents.on('render-process-gone', () => {
      this.fail(
        new Error(
          'The editor renderer exited. Open the worktree again to retry.',
        ),
      )
    })
    contents.once('destroyed', () => this.dispose())

    const navigation = this.begin()
    this.awaitingStart = navigation
    void contents.loadURL(url).catch((error: Error) => {
      // An older loadURL promise may reject after a new document starts loading.
      if (this.navigation === navigation && this.state === 'loading')
        this.fail(error)
    })
  }

  private begin(): Navigation {
    if (this.navigation) {
      clearTimeout(this.navigation.timer)
      this.navigation.reject(new Error('Editor navigation was superseded.'))
    }
    this.state = 'loading'
    let resolve!: () => void
    let reject!: (error: Error) => void
    const ready = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    // Background reloads have no open() caller waiting to handle a rejection.
    void ready.catch(() => {})
    const navigation: Navigation = {
      ready,
      resolve,
      reject,
      response: false,
      dom: false,
      timer: setTimeout(() => {
        if (this.navigation !== navigation || this.state !== 'loading') return
        this.fail(
          new Error(
            'The editor page did not respond within 30 seconds. Open the worktree again to retry.',
          ),
        )
        this.contents.stop()
      }, 30_000),
    }
    this.navigation = navigation
    return navigation
  }

  private complete(): void {
    const navigation = this.navigation
    if (!navigation?.response || !navigation.dom) return
    clearTimeout(navigation.timer)
    this.state = 'ready'
    navigation.resolve()
  }

  private fail(error: Error): void {
    if (this.state === 'disposed') return
    this.error = error
    this.state = 'failed'
    if (this.navigation) {
      clearTimeout(this.navigation.timer)
      this.navigation.reject(error)
    }
  }

  async whenReady(): Promise<void> {
    while (this.state !== 'disposed') {
      const navigation = this.navigation!
      try {
        await navigation.ready
      } catch (error) {
        if (navigation === this.navigation) throw error
      }
      if (navigation !== this.navigation) continue
      if (this.state === 'ready') return
      throw this.error
    }
    throw this.error
  }

  async chatActivation(): Promise<string | null> {
    while (this.state !== 'disposed') {
      await this.whenReady()
      const navigation = this.navigation
      const baseline: unknown = await this.contents.mainFrame.executeJavaScript(
        `document.querySelector('meta[name="ade-chat-activation-after"]')?.getAttribute('content')`,
      )
      if (navigation !== this.navigation) continue
      if (this.state !== 'ready') throw this.error
      // Missing metadata is a failure, never permission to focus an old host.
      return z.union([z.uuid(), z.literal('')]).parse(baseline) || null
    }
    throw this.error
  }

  dispose(): void {
    if (this.state === 'disposed') return
    this.fail(new Error('The editor view was closed.'))
    this.state = 'disposed'
    // Shutdown must not wait for renderer unload checks, saves or backups.
    if (!this.contents.isDestroyed()) this.contents.close()
  }
}

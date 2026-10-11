import type { VscodeServerStatus, Worktree } from '../../shared/api'
import type { EditorState } from './api'
import { logger } from '../../shared/logger'

const log = logger.child({ component: 'editor-manager' })

export interface EditorPage {
  // Resolves when initial navigation completes; VS Code owns the subsequent connection lifecycle.
  load(url: string): Promise<void>
  // Persists the session before disposal. Must reject within a bounded time if the page cannot respond.
  prepareForDisconnect(): Promise<void>
  // Releases the retained page and its resources.
  dispose(): void
}

export interface EditorHost {
  // Creates or restores the native window, updates its title, and brings it to the foreground.
  showAndFocusWindow(title: string): void
  // Creates a hidden page retained until explicitly disposed. Reports renderer crashes to its owner.
  createPage(key: string, onCrash: () => void): EditorPage
  // Selects a page, or the loading/error UI when absent. Does not reveal or raise a hidden window.
  setContent(page: EditorPage | undefined, state: EditorState): void
  // Disposes the window and its retained content.
  close(): void
}

export interface EditorServer {
  // Ensures startup has been requested. Readiness arrives separately through server status updates.
  ensure(path: string): Promise<void>
}

type EditorPageState =
  // Waiting for startup acknowledgment and a running server with a browser route.
  | 'waitingForServer'
  // The server is ready; initial page navigation is in progress.
  | 'loadingPage'
  // Initial navigation completed. VS Code manages its own connection from here.
  | 'loaded'
  // Startup, navigation, or the renderer failed. Opening again explicitly retries.
  | 'failed'

interface Entry {
  worktree: Worktree
  state: EditorPageState
  page?: EditorPage
  browserPath?: string
  disposal?: Promise<void>
  error?: string
  request?: Promise<void>
}

export class EditorWindowManager {
  private readonly entries = new Map<string, Entry>()
  // An absent snapshot means connection state is unknown, not that servers stopped.
  private statuses: Map<string, VscodeServerStatus> | undefined
  private selected: Entry | undefined
  private closed = false
  private closing: Promise<void> | undefined
  private readonly origin: URL

  constructor(
    private readonly host: EditorHost,
    private readonly server: EditorServer,
    serverUrl: string,
  ) {
    // VS Code requires a secure browser context: remote servers must use WSS/HTTPS.
    // Plain WS/HTTP is supported only on loopback origins, which Chromium trusts.
    this.origin = new URL(serverUrl)
    this.origin.protocol = this.origin.protocol === 'wss:' ? 'https:' : 'http:'
  }

  open(worktree: Worktree): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Editor is closed'))
    let entry = this.entries.get(worktree.path)
    if (!entry) {
      entry = { worktree, state: 'waitingForServer' }
      this.entries.set(worktree.path, entry)
    }
    this.selected = entry
    this.host.showAndFocusWindow(`${worktree.basename} — VS Code`)
    this.render()
    if (entry.request) return entry.request
    if (entry.state === 'loaded' || entry.state === 'loadingPage') {
      const status = this.statuses?.get(worktree.path)
      if (
        !this.statuses ||
        (status?.state === 'running' &&
          status.browserPath === entry.browserPath)
      )
        return Promise.resolve()
    }
    return this.start(entry)
  }

  retry(): Promise<void> {
    if (!this.selected || this.selected.state !== 'failed')
      return Promise.resolve()
    return this.open(this.selected.worktree)
  }

  // Applies a server snapshot to pages awaiting readiness; loaded pages remain independent.
  updateStatuses(statuses: VscodeServerStatus[]): void {
    this.statuses = new Map(statuses.map((status) => [status.path, status]))
    for (const entry of this.entries.values()) this.advance(entry)
  }

  // Called whenever ADE's RPC connection is unavailable, including initial connection attempts.
  // Clears cached statuses and fails pages awaiting readiness; loading and loaded pages continue independently.
  onServerDisconnected(): void {
    this.statuses = undefined
    for (const entry of this.entries.values()) {
      if (entry.state === 'waitingForServer')
        this.fail(
          entry,
          'Disconnected from ADE before VS Code was ready. Retry once ADE reconnects.',
        )
    }
  }

  private start(entry: Entry): Promise<void> {
    const disposal = this.disposePage(entry)
    entry.error = undefined
    entry.state = 'waitingForServer'
    this.render()
    const request = disposal.then(() => {
      if (this.closed) throw new Error('Editor is closed')
      return this.server.ensure(entry.worktree.path)
    })
    entry.request = request
    void request.then(
      () => {
        entry.request = undefined
        this.advance(entry)
      },
      (error: unknown) => {
        entry.request = undefined
        this.fail(
          entry,
          error instanceof Error
            ? error.message
            : 'Unable to start VS Code Server',
        )
      },
    )
    return request
  }

  private advance(entry: Entry): void {
    if (this.closed || entry.state !== 'waitingForServer' || entry.request)
      return
    const status = this.statuses?.get(entry.worktree.path)
    if (status?.state === 'stopped') {
      this.fail(
        entry,
        status.error?.message ??
          'VS Code Server stopped before the page loaded',
      )
    } else if (status?.state === 'running' && status.browserPath) {
      const url = URL.parse(status.browserPath, this.origin)
      if (
        !url ||
        url.origin !== this.origin.origin ||
        !/^\/vscode\/[a-f0-9]{64}\//.test(url.pathname)
      ) {
        this.fail(entry, 'Invalid VS Code browser route')
        return
      }
      entry.state = 'loadingPage'
      const page = this.host.createPage(
        `${this.origin.origin}:${entry.worktree.path}`,
        () => {
          if (entry.page !== page) return
          this.fail(
            entry,
            'The VS Code page closed unexpectedly. Retry to reopen it.',
          )
        },
      )
      entry.page = page
      entry.browserPath = status.browserPath
      void page.load(url.href).then(
        () => {
          if (
            this.closed ||
            entry.page !== page ||
            entry.state !== 'loadingPage'
          )
            return
          entry.state = 'loaded'
          this.render()
        },
        () => {
          if (entry.page === page)
            this.fail(
              entry,
              'Unable to load VS Code. Check the connection and retry.',
            )
        },
      )
    }
  }

  private fail(entry: Entry, message: string): void {
    if (this.closed) return
    entry.state = 'failed'
    entry.error = message
    this.render()
  }

  private render(): void {
    if (this.closed || !this.selected) return
    const entry = this.selected
    this.host.setContent(entry.state === 'loaded' ? entry.page : undefined, {
      title: entry.worktree.basename,
      error: entry.error,
    })
  }

  // Stops new work immediately, then persists all retained pages in parallel before disposal.
  close(): Promise<void> {
    this.closed = true
    this.closing ??= this.closePages()
    return this.closing
  }

  private async closePages(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((entry) => this.disposePage(entry)),
    )
    this.entries.clear()
    this.host.close()
  }

  // Replacement and shutdown share disposal so a pending session save is awaited once.
  private disposePage(entry: Entry): Promise<void> {
    if (entry.disposal) return entry.disposal
    const page = entry.page
    if (!page) return Promise.resolve()
    entry.page = undefined
    entry.browserPath = undefined
    entry.disposal = (async () => {
      try {
        await page.prepareForDisconnect()
      } catch (error) {
        log.error(
          { err: error, path: entry.worktree.path },
          'Unable to persist VS Code session before closing',
        )
      } finally {
        page.dispose()
      }
    })()
    return entry.disposal.finally(() => {
      entry.disposal = undefined
    })
  }
}

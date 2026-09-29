import {
  BaseWindow,
  WebContentsView,
  session,
  shell,
  type Session,
  type WebContents,
  type PermissionRequest,
  type MediaAccessPermissionRequest,
} from 'electron'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { installEditorPaste } from './editor-paste.ts'
import { EditorSettingsSync } from './settings-sync.ts'
import { EditorPage } from './editor-page.ts'
import { editorPath } from '../shared/companion.ts'
import type {
  EditorSession,
  OpenEditorInput,
  WorktreeSnapshot,
} from '../shared/companion.ts'

interface EditorView {
  view: WebContentsView
  token: string
  page: EditorPage
  worktree: OpenEditorInput
  forget: () => void
}

// Views remain connected when hidden or when the editor window is closed.
// VS Code keys workspace state by folder. Sharing a persistent browser session
// also shares web extensions, while remote extensions live on the companion.
export class EditorWindow {
  private window?: BaseWindow
  private active?: EditorView
  private readonly views = new Map<string, EditorView>()
  private browser?: {
    browser: Session
    tokens: Map<string, string>
    sync: EditorSettingsSync
  }
  private readonly origin: URL

  constructor(
    companionUrl: string,
    private readonly pasteTarget?: (editorId: string) => Promise<string | null>,
  ) {
    this.origin = new URL(companionUrl)
    this.origin.protocol = this.origin.protocol === 'wss:' ? 'https:' : 'http:'
  }

  // Select the view before waiting for page readiness. Another open can select
  // a different view during that wait; completing this load never reselects it.
  async open(
    editor: EditorSession,
    worktree: OpenEditorInput,
  ): Promise<EditorPage> {
    const path = editorPath(editor.id)
    const url = new URL(path, this.origin)
    const key = editor.id
    const browserSession = this.browserSession()
    browserSession.tokens.set(path, editor.accessToken)
    let entry = this.views.get(key)
    if (
      entry &&
      (entry.token !== editor.accessToken ||
        entry.page.state === 'failed' ||
        entry.page.state === 'disposed')
    ) {
      this.discard(key, entry, false)
      entry = undefined
      // discard removes the previous view's request credentials.
      browserSession.tokens.set(path, editor.accessToken)
    }
    if (!entry) {
      const view = new WebContentsView({
        webPreferences: {
          session: browserSession.browser,
          preload: this.pasteTarget
            ? join(import.meta.dirname, '../preload/editor.cjs')
            : undefined,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      })
      const isEditorUrl = (target: URL | null): boolean =>
        target !== null &&
        target.origin === url.origin &&
        target.pathname.startsWith(path)
      const openBrowser = (target: URL | null): void => {
        if (
          !target ||
          !['http:', 'https:'].includes(target.protocol) ||
          isEditorUrl(target)
        )
          return
        // Main runs on the desktop, even when the companion is remote. Only
        // web URLs may reach the OS; never dispatch arbitrary protocol handlers.
        void shell.openExternal(target.href).catch(() => {
          console.warn('[ADE] Could not open the link in the desktop browser.')
        })
      }
      view.webContents.setWindowOpenHandler(({ url: target }) => {
        openBrowser(URL.parse(target))
        return { action: 'deny' }
      })
      view.webContents.on('will-navigate', (event) => {
        const next = URL.parse(event.url)
        if (isEditorUrl(next)) return
        event.preventDefault()
        openBrowser(next)
      })
      const forgetPaste = this.pasteTarget
        ? installEditorPaste(
            view.webContents,
            () => this.active?.view === view,
            isEditorUrl,
            () => this.pasteTarget!(editor.id),
          )
        : () => {}
      entry = {
        view,
        token: editor.accessToken,
        page: new EditorPage(view.webContents, url.href, isEditorUrl),
        worktree,
        forget: () => {
          forgetPaste()
          browserSession.tokens.delete(path)
        },
      }
      const created = entry
      view.webContents.once('destroyed', () => this.discard(key, created))
      this.views.set(key, entry)
    }
    const window = this.ensureWindow()
    if (this.active && this.active !== entry) {
      window.contentView.removeChildView(this.active.view)
      this.active.view.setVisible(false)
    }
    this.active = entry
    window.contentView.addChildView(entry.view)
    entry.view.setVisible(true)
    this.resize()
    window.setTitle(`${worktree.path} — VS Code`)
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    entry.view.webContents.focus()
    try {
      await entry.page.whenReady()
    } catch (error) {
      if (entry.page.state === 'failed') this.discard(key, entry)
      throw error
    }
    if (this.views.get(key) === entry && entry.page.state === 'ready')
      browserSession.sync.add(entry.view.webContents, url, editor.accessToken)
    return entry.page
  }

  private discard(key: string, entry: EditorView, closeWindow = true): void {
    if (this.views.get(key) !== entry) return
    this.views.delete(key)
    entry.forget()
    if (this.active === entry) {
      this.window?.contentView.removeChildView(entry.view)
      this.active = undefined
      if (closeWindow) this.window?.close()
    }
    entry.page.dispose()
  }

  reconcile(snapshot: WorktreeSnapshot): void {
    for (const [key, entry] of this.views) {
      if (
        snapshot.worktrees.some(
          (worktree) =>
            worktree.project === entry.worktree.project &&
            worktree.path === entry.worktree.path,
        )
      )
        continue
      this.discard(key, entry)
    }
  }

  private browserSession() {
    if (this.browser) return this.browser
    const url = this.origin
    const key = createHash('sha256').update(url.origin).digest('hex')
    const browser = session.fromPartition(`persist:ade-editor-${key}`)
    const tokens = new Map<string, string>()
    const entry = { browser, tokens, sync: new EditorSettingsSync(url.origin) }
    browser.webRequest.onBeforeSendHeaders((details, callback) => {
      const request = new URL(details.url)
      const protocol = request.protocol.replace(/^ws/, 'http')
      const path = /^\/editors\/[a-f0-9]{64}\//.exec(request.pathname)?.[0]
      const token = path ? tokens.get(path) : undefined
      if (protocol === url.protocol && request.host === url.host && token)
        details.requestHeaders.Authorization = `Bearer ${token}`
      callback({ requestHeaders: details.requestHeaders })
    })
    const trustedPage = (
      contents: WebContents | null,
      details: Pick<PermissionRequest, 'isMainFrame'> & {
        requestingUrl?: string
      },
    ): boolean => {
      if (
        !contents ||
        contents.isDestroyed() ||
        this.active?.view.webContents !== contents
      )
        return false
      const page = URL.parse(contents.getURL())
      if (page?.origin !== url.origin || !tokens.has(page.pathname))
        return false
      // Include extension webviews belonging to this workbench. Chromium and
      // VS Code still enforce each frame's sandbox and Permissions Policy.
      return contents.mainFrame.framesInSubtree.some(
        (frame) => frame.url === details.requestingUrl,
      )
    }
    // Read checks fall through to the request handler so each paste needs a
    // current user gesture; no lasting clipboard grant is shared across views.
    browser.setPermissionCheckHandler(
      (contents, permission, _origin, details) =>
        trustedPage(contents, details) &&
        (permission === 'clipboard-sanitized-write' ||
          (permission === 'media' && details.mediaType === 'audio')),
    )
    browser.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        if (!trustedPage(contents, details)) return callback(false)
        if (permission === 'clipboard-sanitized-write') return callback(true)
        if (permission === 'media') {
          const { mediaTypes } = details as MediaAccessPermissionRequest
          return callback(
            !!mediaTypes?.length &&
              mediaTypes.every((type) => type === 'audio'),
          )
        }
        if (permission !== 'clipboard-read') return callback(false)
        void contents
          .executeJavaScript('navigator.userActivation.isActive')
          .then(
            (active) =>
              callback(active === true && trustedPage(contents, details)),
            () => callback(false),
          )
      },
    )
    this.browser = entry
    return entry
  }

  private ensureWindow(): BaseWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    const window = new BaseWindow({
      width: 1280,
      height: 850,
      show: false,
      title: 'VS Code',
    })
    this.window = window
    // Showing a native window can change its content bounds after the initial
    // size calculation (for example when the Windows menu/frame is laid out).
    // Follow the actual parent view so the editor never extends below it.
    window.contentView.on('bounds-changed', () => this.resize())
    window.once('show', () => window.maximize())
    window.on('closed', () => {
      this.active?.view.setVisible(false)
      this.window = undefined
      this.active = undefined
    })
    return window
  }

  private resize(): void {
    if (!this.window || !this.active) return
    const { width, height } = this.window.contentView.getBounds()
    this.active.view.setBounds({ x: 0, y: 0, width, height })
  }

  close(): void {
    this.browser?.sync.close()
    for (const [key, entry] of this.views) {
      entry.view.webContents.session.flushStorageData()
      this.discard(key, entry, false)
    }
  }

  reconnectSettings(): void {
    void this.browser?.sync.sync()
  }
}

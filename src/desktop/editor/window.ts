import { BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { EDITOR_STATE_CHANGED, type EditorState } from './api'
import type { EditorHost, EditorPage } from './manager'
import type { ExtensionIdentifier } from '../../shared/api'
import type { DesktopExtensionMethods } from '../../shared/editor-rpc'
import { ElectronEditorPage } from './vscode/page'
import type { VscodeSettingsServer } from './vscode/vscode-settings-sync'
import { isVscodeSettingsDocument } from '../../shared/vscode-utils'

export class ElectronEditorWindow implements EditorHost {
  private window: BrowserWindow | undefined
  private readonly pages = new Set<ElectronEditorPage>()
  private current: ElectronEditorPage | undefined
  private state: EditorState = { title: 'VS Code', canRetry: false }
  private vscodeSettingsContent: string | null = null

  constructor(
    private readonly vscodeSettingsServer: VscodeSettingsServer,
    private readonly readDisabledExtensions: () => Promise<
      ExtensionIdentifier[]
    >,
    private readonly desktop: DesktopExtensionMethods,
  ) {}

  receiveVscodeSettings(content: string | null): void {
    if (content !== null && !isVscodeSettingsDocument(content)) return
    this.vscodeSettingsContent = content
    for (const page of this.pages) page.vscodeSettingsSync.receive(content)
  }

  // Identifies IPC from the editor's own renderer, excluding embedded VS Code pages.
  isAdeSender(sender: WebContents): boolean {
    return sender === this.window?.webContents
  }

  // Sends the current presentation snapshot to the editor renderer.
  sendShellState(): void {
    this.window?.webContents.send(EDITOR_STATE_CHANGED, this.state)
  }

  showAndFocusWindow(title: string): void {
    if (!this.window) {
      const window = new BrowserWindow({
        title,
        width: 1200,
        height: 800,
        backgroundColor: '#18181b',
        webPreferences: {
          preload: join(import.meta.dirname, '../preload/editor.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      })
      this.window = window
      window.on('close', (event) => {
        event.preventDefault()
        window.hide()
      })
      window.on('resize', () => this.resize())
      const devUrl = process.env.ELECTRON_RENDERER_URL
      const loading = devUrl
        ? window.loadURL(new URL('editor/renderer/index.html', devUrl).href)
        : window.loadFile(
            join(import.meta.dirname, '../renderer/editor/renderer/index.html'),
          )
      void loading.catch(() => {})
    }
    this.window.setTitle(title)
    if (this.window.isMinimized()) this.window.restore()
    this.window.show()
    this.window.focus()
    this.current?.view.webContents.focus()
  }

  createPage(key: string, onFailure: (message: string) => void): EditorPage {
    const page = new ElectronEditorPage(
      key,
      onFailure,
      this.vscodeSettingsServer,
      this.readDisabledExtensions,
      this.desktop,
    )
    page.vscodeSettingsSync.receive(this.vscodeSettingsContent)
    this.pages.add(page)
    this.window!.contentView.addChildView(page.view)
    page.view.webContents.once('destroyed', () => {
      page.vscodeSettingsSync.dispose()
      this.pages.delete(page)
      if (this.window && !this.window.isDestroyed())
        this.window.contentView.removeChildView(page.view)
    })
    this.resize()
    return page
  }

  setContent(page: EditorPage | undefined, state: EditorState): void {
    const next = page as ElectronEditorPage | undefined
    const changed = this.current !== next
    this.current = next
    this.state = state
    for (const candidate of this.pages)
      candidate.view.setVisible(candidate === next)
    this.sendShellState()
    if (changed && this.window?.isFocused()) next?.view.webContents.focus()
  }

  private resize(): void {
    if (!this.window) return
    const [width, height] = this.window.getContentSize()
    for (const page of this.pages)
      page.view.setBounds({ x: 0, y: 0, width, height })
  }

  close(): void {
    for (const page of this.pages) page.dispose()
    this.window?.destroy()
    this.window = undefined
    this.current = undefined
  }
}

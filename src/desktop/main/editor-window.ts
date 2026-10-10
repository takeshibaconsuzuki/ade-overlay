import { BrowserWindow, WebContentsView, type WebContents } from 'electron'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { EDITOR_STATE_CHANGED, type EditorState } from '../api'
import type { EditorHost, EditorPage } from './editor-manager'

class ElectronEditorPage implements EditorPage {
  readonly view: WebContentsView

  constructor(key: string, onCrash: () => void) {
    this.view = new WebContentsView({
      webPreferences: {
        partition: `persist:vscode-${createHash('sha256').update(key).digest('hex')}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        focusOnNavigation: false,
      },
    })
    this.view.setBackgroundColor('#18181b')
    this.view.setVisible(false)
    this.view.webContents.on('render-process-gone', onCrash)
    this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }

  async load(url: string): Promise<void> {
    const origin = new URL(url).origin
    this.view.webContents.on('will-navigate', (event, next) => {
      if (new URL(next).origin !== origin) event.preventDefault()
    })
    let status = 0
    const onNavigate = (_event: Electron.Event, _url: string, code: number) => {
      status = code
    }
    this.view.webContents.on('did-navigate', onNavigate)
    try {
      await this.view.webContents.loadURL(url)
      if (status >= 400) throw new Error('VS Code page request failed')
    } finally {
      if (!this.view.webContents.isDestroyed())
        this.view.webContents.off('did-navigate', onNavigate)
    }
  }

  dispose(): void {
    if (!this.view.webContents.isDestroyed())
      this.view.webContents.close({ waitForBeforeUnload: false })
  }
}

export class ElectronEditorWindow implements EditorHost {
  private window: BrowserWindow | undefined
  private readonly pages = new Set<ElectronEditorPage>()
  private current: ElectronEditorPage | undefined
  private state: EditorState = { title: 'VS Code' }

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
          preload: join(import.meta.dirname, '../preload/index.mjs'),
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
        ? window.loadURL(`${devUrl.replace(/#.*$/, '')}#editor`)
        : window.loadFile(join(import.meta.dirname, '../renderer/index.html'), {
            hash: 'editor',
          })
      void loading.catch(() => {})
    }
    this.window.setTitle(title)
    if (this.window.isMinimized()) this.window.restore()
    this.window.show()
    this.window.focus()
    this.current?.view.webContents.focus()
  }

  createPage(key: string, onCrash: () => void): EditorPage {
    const page = new ElectronEditorPage(key, onCrash)
    this.pages.add(page)
    this.window!.contentView.addChildView(page.view)
    page.view.webContents.once('destroyed', () => {
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

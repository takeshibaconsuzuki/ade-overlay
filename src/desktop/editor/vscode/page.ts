import { WebContentsView } from 'electron'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { EditorPage } from '../manager'
import { persistVscodeSession } from './vscode-session'
import { applyVscodeSettings } from './vscode-settings'
import {
  VscodeSettingsSync,
  type VscodeSettingsPage,
  type VscodeSettingsServer,
} from './vscode-settings-sync'

export class ElectronEditorPage implements EditorPage, VscodeSettingsPage {
  readonly view: WebContentsView
  readonly vscodeSettingsSync: VscodeSettingsSync

  constructor(
    key: string,
    onCrash: () => void,
    vscodeSettingsServer: VscodeSettingsServer,
  ) {
    this.vscodeSettingsSync = new VscodeSettingsSync(this, vscodeSettingsServer)
    this.view = new WebContentsView({
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/vscode.cjs'),
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
    this.view.webContents.on('render-process-gone', () => {
      this.vscodeSettingsSync.stop()
      onCrash()
    })
    this.view.webContents.on(
      'did-start-navigation',
      (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) this.vscodeSettingsSync.stop()
      },
    )
    this.view.webContents.on('did-finish-load', () =>
      this.vscodeSettingsSync.start(),
    )
    this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.view.webContents.ipc.on(
      'ade:settings-changed',
      (event, generation: unknown, content: unknown) => {
        if (
          event.senderFrame !== this.view.webContents.mainFrame ||
          typeof generation !== 'number' ||
          typeof content !== 'string'
        )
          return
        void this.vscodeSettingsSync.changed(generation, content)
      },
    )
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
    this.vscodeSettingsSync.dispose()
    if (!this.view.webContents.isDestroyed())
      this.view.webContents.close({ waitForBeforeUnload: false })
  }

  async applySettings(content: string, generation: number): Promise<void> {
    await this.view.webContents.executeJavaScript(
      `(${applyVscodeSettings.toString()})(${JSON.stringify(content)}, ${generation})`,
    )
  }

  async prepareForDisconnect(): Promise<void> {
    const contents = this.view.webContents
    if (contents.isDestroyed() || contents.isCrashed()) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        contents.executeJavaScript(`(${persistVscodeSession.toString()})()`),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Timed out saving VS Code session')),
            5000,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}

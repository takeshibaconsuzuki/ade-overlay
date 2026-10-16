import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { APP_DISPLAY_NAME } from '../../shared/constants'
import { WORKTREE_PICKER_VISIBILITY_CHANGED } from './api'

// A picker session starts when the picker is shown and ends when it is dismissed or loses
// focus. Its state is tracked here rather than read from Electron: on macOS isVisible, focus
// and blur treat a window whose occlusion state is exactly "visible" as not visible, so they
// intermittently misreport an on-screen window and silently do nothing.
export class WorktreePickerWindow {
  readonly window: BrowserWindow
  private visible = true

  constructor() {
    this.window = new BrowserWindow({
      title: APP_DISPLAY_NAME,
      width: 900,
      height: 600,
      // A non-activating panel takes keyboard focus without activating the app, so hiding it
      // returns focus to wherever it was, in this app or another, without any hand-over of
      // its own. The menu bar follows the app that is active, as for any such panel. Its
      // floating level keeps it above the key window of another app.
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/picker.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    // The picker goes when keyboard focus leaves it; focus has already moved elsewhere. The
    // window's own blur reports loss of main status instead, which a panel keeps while
    // another window is key, and hiding a window that is still key makes AppKit bring it
    // back once the next key window closes. A sheet attached to the picker disables it and
    // keeps the session.
    // Keyboard focus also leaves the picker when AppKit activates the app, as a Dock click or
    // Cmd-Tab does; hiding the window inside that sequence makes AppKit abort the activation
    // and order the window back in, so the window is hidden once the sequence has run.
    this.window.webContents.on('blur', () => {
      if (
        !this.window.isEnabled() ||
        this.window.webContents.isDevToolsFocused()
      )
        return
      this.endSession()
      setImmediate(() => this.hideWindow())
    })
    // Minimizing ends the session like any focus loss; restoring from the Dock starts one.
    this.window.on('restore', () => this.startSession())
    const devServerUrl = process.env.ELECTRON_RENDERER_URL

    if (devServerUrl) {
      this.window.loadURL(
        new URL('picker/renderer/index.html', devServerUrl).href,
      )
    } else {
      this.window.loadFile(
        join(import.meta.dirname, '../renderer/picker/renderer/index.html'),
      )
    }
  }

  get isVisible(): boolean {
    return this.visible
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  // Session changes are reported to the renderer from here rather than from the window's
  // show and hide events: on macOS those follow asynchronous occlusion changes, and a hide
  // followed quickly by a show emits neither. Only transitions are reported.
  show(): void {
    if (this.visible) return
    this.startSession()
    if (this.window.isMinimized()) this.window.restore()
    this.window.show()
  }

  // Dismisses the picker; focus returns to where it was before the picker was shown.
  hide(): void {
    if (!this.endSession()) return
    // Hiding a window does not activate another one on Windows and Linux, so focus is given
    // up first and the system picks the next window.
    if (process.platform !== 'darwin' && this.window.isFocused())
      this.window.blur()
    this.hideWindow()
  }

  private hideWindow(): void {
    if (this.visible || this.window.isDestroyed()) return
    this.window.hide()
  }

  private startSession(): void {
    if (this.visible) return
    this.visible = true
    this.window.webContents.send(WORKTREE_PICKER_VISIBILITY_CHANGED, true)
  }

  private endSession(): boolean {
    if (!this.visible) return false
    this.visible = false
    this.window.webContents.send(WORKTREE_PICKER_VISIBILITY_CHANGED, false)
    return true
  }
}

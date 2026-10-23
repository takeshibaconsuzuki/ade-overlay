import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { APP_DISPLAY_NAME } from '../../shared/constants'
import { WORKTREE_PICKER_VISIBILITY_CHANGED } from './api'

const CLIPBOARD_SHORTCUTS: Record<string, 'cut' | 'copy' | 'paste'> = {
  x: 'cut',
  c: 'copy',
  v: 'paste',
}

// A picker session starts when the picker is shown and ends when it is dismissed or loses
// focus. Its state is tracked here rather than read from Electron: on macOS isVisible, focus
// and blur treat a window whose occlusion state is exactly "visible" as not visible, so they
// intermittently misreport an on-screen window and silently do nothing.
export class WorktreePickerWindow {
  readonly window: BrowserWindow
  private visible = true
  // Set from ordering the window out until Electron reports the hide, which on macOS follows
  // an asynchronous occlusion change. A window ordered back in before that report stays on
  // screen without pointer events reaching its page until the pointer leaves and re-enters
  // it, so a show that arrives in between waits for the report.
  private hidePending = false
  private pendingShow: NodeJS.Timeout | undefined

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
    // Clipboard shortcuts reach a page through the Edit menu's key equivalents. The menu bar
    // belongs to the active app, which the panel never is while it is key, so the panel
    // dispatches them itself. Shortcuts the page handles on its own keydown, such as select
    // all in the terminal, are left to it.
    if (process.platform === 'darwin') {
      this.window.webContents.on('before-input-event', (event, input) => {
        if (
          input.type !== 'keyDown' ||
          !input.meta ||
          input.control ||
          input.alt
        )
          return
        const command = CLIPBOARD_SHORTCUTS[input.key.toLowerCase()]
        if (!command) return
        event.preventDefault()
        this.window.webContents[command]()
      })
    }
    // Minimizing ends the session like any focus loss; restoring from the Dock starts one.
    this.window.on('restore', () => this.startSession())
    this.window.on('show', () => this.refreshPointer())
    this.window.on('hide', () => {
      this.hidePending = false
      this.completeShow()
    })
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
    if (this.hidePending) {
      // The hide is normally reported within a few hundred milliseconds; the window is shown
      // regardless once that has clearly not happened.
      this.pendingShow ??= setTimeout(() => {
        this.hidePending = false
        this.completeShow()
      }, 500)
      return
    }
    this.showWindow()
  }

  private completeShow(): void {
    if (this.pendingShow) {
      clearTimeout(this.pendingShow)
      this.pendingShow = undefined
    }
    // The session may have ended while the show waited.
    if (!this.visible) return
    this.showWindow()
  }

  private showWindow(): void {
    if (this.window.isMinimized()) this.window.restore()
    this.window.show()
  }

  // Once the window is on screen the pointer leaves the page, clearing hover state left from
  // before the window was hidden and making the page request the default cursor: Chromium
  // applies a cursor only when it differs from the one it last applied, and a cursor applied
  // while the window was being ordered in does not survive the ordering, so without this the
  // system cursor would stay stale until the pointer reached an element with a different
  // cursor. The first real movement then requests the cursor of the element beneath it.
  private refreshPointer(): void {
    if (!this.visible) return
    this.window.webContents.sendInputEvent({ type: 'mouseMove', x: -1, y: -1 })
    this.window.webContents.sendInputEvent({ type: 'mouseLeave', x: -1, y: -1 })
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
    this.hidePending = true
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

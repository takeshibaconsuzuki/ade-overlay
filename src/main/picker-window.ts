import type { BrowserWindow } from 'electron'

export interface WindowFocus {
  capture(): (() => void) | undefined
  dispose(): void
}

export class PickerWindow {
  private returnFocus?: () => void
  private readonly window: BrowserWindow
  private readonly focus: WindowFocus
  private readonly canHide: boolean

  constructor(window: BrowserWindow, focus: WindowFocus, canHide = true) {
    this.window = window
    this.focus = focus
    this.canHide = canHide
    window.on('blur', () => this.hide(false))
    window.once('closed', () => {
      this.returnFocus = undefined
      focus.dispose()
    })
  }

  show(): void {
    if (this.window.isDestroyed()) return
    if (this.canHide && !this.window.isFocused())
      this.returnFocus = this.focus.capture()
    if (this.window.isMinimized()) this.window.restore()
    this.window.show()
    this.window.focus()
  }

  hide(restoreFocus = true): void {
    // Without a global shortcut, keep the picker reachable as a normal window.
    if (!this.canHide || this.window.isDestroyed()) return
    const restore =
      restoreFocus && this.window.isFocused() ? this.returnFocus : undefined
    this.returnFocus = undefined
    // Transfer focus while we still own it. In particular, Windows only allows
    // foreground activation from an eligible process. The resulting blur may
    // hide us synchronously, and must not restore focus again.
    restore?.()
    if (!this.window.isDestroyed()) this.window.hide()
  }

  toggle(): void {
    if (this.window.isDestroyed()) return
    if (this.window.isFocused()) this.hide()
    else this.show()
  }
}

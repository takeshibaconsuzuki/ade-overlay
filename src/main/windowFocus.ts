import { app, type BrowserWindow } from 'electron'

const CURRENT_WORKSPACE_VISIBILITY_MS = 50
// setVisibleOnAllWorkspaces transforms the macOS process type, which makes the
// app's Dock tile disappear/reappear. To avoid this, set
// skipTransformProcessType = true.
const VISIBLE_ON_CURRENT_WORKSPACE_OPTIONS = {
  skipTransformProcessType: true,
  visibleOnFullScreen: true,
}
const HIDDEN_ON_CURRENT_WORKSPACE_OPTIONS = {
  skipTransformProcessType: true,
}
const workspaceVisibilityTimers = new WeakMap<BrowserWindow, NodeJS.Timeout>()

export function focusWindowOnCurrentWorkspace(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return
  }
  if (window.isMinimized()) {
    window.restore()
  }

  if (process.platform === 'darwin') {
    // To focus a role window without making macOS switch back to the Space
    // where that window was last assigned, we temporarily make it visible
    // everywhere.
    window.setVisibleOnAllWorkspaces(true, VISIBLE_ON_CURRENT_WORKSPACE_OPTIONS)
  }

  window.show()
  window.focus()
  // `show`/`focus` target the window; `app.focus({ steal: true })` makes the
  // spawned role process itself the active macOS app so keyboard input goes to
  // that role instead of staying with the launcher/controller app.
  app.focus({ steal: true })

  if (process.platform === 'darwin') {
    const existingTimer = workspaceVisibilityTimers.get(window)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Turning that off shortly after leaves the window assigned to the Space
    // the user is currently using.
    const timer = setTimeout(() => {
      workspaceVisibilityTimers.delete(window)
      if (!window.isDestroyed()) {
        window.setVisibleOnAllWorkspaces(
          false,
          HIDDEN_ON_CURRENT_WORKSPACE_OPTIONS,
        )
      }
    }, CURRENT_WORKSPACE_VISIBILITY_MS)
    workspaceVisibilityTimers.set(window, timer)
  }
}

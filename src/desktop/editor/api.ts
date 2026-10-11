// Editor-window renderer → main: requests current editor presentation state after its listener is registered.
export const EDITOR_INITIALIZE = 'editor:initialize'

// Main → editor-window renderer: delivers current editor presentation state after a change or initialization.
export const EDITOR_STATE_CHANGED = 'editor:stateChanged'

// Editor-window renderer → main: retries opening the selected worktree after a failure. Resolves when the startup request is acknowledged; page loading completes asynchronously. Does nothing unless the selected worktree has failed.
export const EDITOR_RETRY = 'editor:retry'

// Presentation state for the editor window's loading and error UI. Loaded pages are displayed separately.
export interface EditorState {
  title: string
  error?: string
}

export interface EditorApi {
  initializeEditorWindow(): void
  retryEditor(): Promise<void>
  setOnEditorStateChangedListener(
    listener: ((state: EditorState) => void) | undefined,
  ): void
}

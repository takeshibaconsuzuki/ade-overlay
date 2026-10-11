import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { EditorState } from '../api'
import '../../shared/style.css'

function EditorShell(): React.JSX.Element {
  const [state, setState] = useState<EditorState>({
    title: 'VS Code',
  })
  useEffect(() => {
    window.editor.setOnEditorStateChangedListener(setState)
    window.editor.initializeEditorWindow()
    return () => window.editor.setOnEditorStateChangedListener(undefined)
  }, [])
  return state.error ? (
    <main className="editor-error">
      <h1>{state.title}</h1>
      <p role="alert">{state.error}</p>
      <button
        type="button"
        onClick={() => void window.editor.retryEditor().catch(() => {})}
      >
        Retry
      </button>
    </main>
  ) : (
    <div
      className="connection-screen"
      role="status"
      aria-label={`Loading ${state.title}`}
    >
      <span className="connection-spinner" aria-hidden="true" />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<EditorShell />)

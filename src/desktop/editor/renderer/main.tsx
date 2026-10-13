import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Container, Flex, Heading } from '@radix-ui/themes'
import type { EditorState } from '../api'
import { AppTheme } from '../../../ui/AppTheme'
import { ErrorMessage, LoadingScreen } from '../../../ui/Feedback'

function EditorShell(): React.JSX.Element {
  const [state, setState] = useState<EditorState>({
    title: 'VS Code',
    canRetry: false,
  })
  useEffect(() => {
    window.editor.setOnEditorStateChangedListener(setState)
    window.editor.initializeEditorWindow()
    return () => window.editor.setOnEditorStateChangedListener(undefined)
  }, [])
  return state.error ? (
    <Container size="3" p={{ initial: '4', sm: '6' }} asChild>
      <main>
        <Flex direction="column" align="start" gap="4">
          <Heading as="h1" size="7">
            {state.title}
          </Heading>
          <ErrorMessage>{state.error}</ErrorMessage>
          {state.canRetry && (
            <Button
              type="button"
              onClick={() => void window.editor.retryEditor().catch(() => {})}
            >
              Retry
            </Button>
          )}
        </Flex>
      </main>
    </Container>
  ) : (
    <LoadingScreen label={`Loading ${state.title}`} />
  )
}

createRoot(document.getElementById('root')!).render(
  <AppTheme>
    <EditorShell />
  </AppTheme>,
)

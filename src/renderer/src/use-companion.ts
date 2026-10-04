import { useEffect, useState } from 'react'
import type { WorktreeRef } from '../../shared/companion'
import type { CompanionState } from '../../shared/ipc'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Desktop main owns all companion and worktree data. This page mirrors what
// main pushes and keeps only an error for a call that never reached main.
export function useCompanion() {
  const [state, setState] = useState<CompanionState | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let receivedState = false
    let active = true
    const acceptState = (next: CompanionState): void => {
      if (!active) return
      setState(next)
      setError('')
    }
    const unsubscribe = window.companion.onState((next) => {
      receivedState = true
      acceptState(next)
    })
    void window.companion
      .getState()
      .then((next) => {
        if (!receivedState) acceptState(next)
      })
      .catch((cause: unknown) => {
        if (active && !receivedState) setError(errorMessage(cause))
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  // Results and row failures arrive through the pushed state.
  const send = (request: Promise<unknown>): void => {
    void request.catch((cause: unknown) => setError(errorMessage(cause)))
  }
  return {
    status: state?.status ?? null,
    snapshot: state?.snapshot ?? null,
    loading: state?.loading ?? false,
    error: error || state?.error,
    refresh: () => send(window.companion.refreshWorktrees()),
    reconnect: () => send(window.companion.reconnect()),
    openEditor: (input: WorktreeRef) =>
      send(window.companion.openEditor(input)),
    openBootstrapLog: (input: WorktreeRef) =>
      send(window.companion.openBootstrapLog(input)),
    stopEditor: (input: WorktreeRef) =>
      send(window.companion.stopEditor(input)),
    clearError: (input: WorktreeRef) =>
      send(
        window.companion.setWorktreeError({
          project: input.project,
          path: input.path,
        }),
      ),
  }
}

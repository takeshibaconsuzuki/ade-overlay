import { useEffect, useRef, useState } from 'react'
import type { OpenEditorInput } from '../../shared/companion'
import type { CompanionState } from '../../shared/ipc'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useCompanion() {
  const [state, setState] = useState<CompanionState | null>(null)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const openRequest = useRef(0)
  const clearRequests = useRef(new Set<symbol>())
  useEffect(() => {
    const pendingOpens = openRequest
    const pendingClears = clearRequests.current
    let receivedState = false
    let active = true
    const acceptState = (next: CompanionState): void => {
      if (!active) return
      setState(next)
      setError('')
      if (next.status.state !== 'connected') {
        pendingClears.clear()
        setRowErrors({})
        pendingOpens.current++
        setOpening(null)
      }
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
      pendingOpens.current++
      pendingClears.clear()
      unsubscribe()
    }
  }, [])

  async function refresh(): Promise<void> {
    try {
      await window.companion.refreshWorktrees()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function reconnect(): Promise<void> {
    try {
      await window.companion.reconnect()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }
  async function openEditor(input: OpenEditorInput): Promise<void> {
    const request = ++openRequest.current
    const key = JSON.stringify([input.project, input.path])
    setOpening(input.path)
    try {
      await window.companion.openEditor(input)
    } catch (cause) {
      if (request === openRequest.current)
        setRowErrors((current) => ({
          ...current,
          [key]: errorMessage(cause),
        }))
    } finally {
      if (request === openRequest.current) setOpening(null)
    }
  }
  async function clearError(input: OpenEditorInput): Promise<void> {
    const request = Symbol()
    clearRequests.current.add(request)
    const key = JSON.stringify([input.project, input.path])
    try {
      await window.companion.setWorktreeError({
        project: input.project,
        path: input.path,
      })
      if (clearRequests.current.has(request))
        setRowErrors((current) => ({ ...current, [key]: '' }))
    } catch (cause) {
      if (clearRequests.current.has(request))
        setRowErrors((current) => ({ ...current, [key]: errorMessage(cause) }))
    } finally {
      clearRequests.current.delete(request)
    }
  }
  return {
    status: state?.status ?? null,
    snapshot: state?.snapshot ?? null,
    loading: state?.loading ?? false,
    error: error || state?.error,
    refresh,
    reconnect,
    opening,
    openEditor,
    rowErrors,
    clearError,
  }
}

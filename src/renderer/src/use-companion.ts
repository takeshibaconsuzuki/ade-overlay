import { useCallback, useEffect, useRef, useState } from 'react'
import type { CompanionStatus, WorktreeSnapshot } from '../../shared/companion'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useCompanion() {
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [snapshot, setSnapshot] = useState<WorktreeSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const epoch = useRef(0)
  const apply = useCallback((next: WorktreeSnapshot, generation: number) => {
    if (generation !== epoch.current) return
    setSnapshot((current) =>
      !current || next.revision >= current.revision ? next : current,
    )
  }, [])

  useEffect(() => {
    const connectionEpoch = epoch
    let receivedStatus = false
    let active = true
    let connected = false
    const acceptStatus = (next: CompanionStatus): void => {
      if (!active) return
      setStatus(next)
      const generation = ++epoch.current
      connected = next.state === 'connected'
      setSnapshot(null)
      setError('')
      setLoading(connected)
      if (connected)
        void window.companion
          .listWorktrees()
          .then((value) => apply(value, generation))
          .catch((cause: unknown) => {
            if (generation === epoch.current) setError(errorMessage(cause))
          })
          .finally(() => {
            if (generation === epoch.current) setLoading(false)
          })
    }
    const offUpdates = window.companion.onWorktreesUpdated((update) => {
      if (active && connected) apply(update.snapshot, epoch.current)
    })
    const offStatus = window.companion.onStatus((next) => {
      receivedStatus = true
      acceptStatus(next)
    })
    void window.companion
      .getStatus()
      .then((next) => {
        if (!receivedStatus) acceptStatus(next)
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause))
      })
    return () => {
      active = false
      connectionEpoch.current++
      offStatus()
      offUpdates()
    }
  }, [apply])

  async function refresh(): Promise<void> {
    const generation = epoch.current
    setLoading(true)
    setError('')
    try {
      apply(await window.companion.refreshWorktrees(), generation)
    } catch (cause) {
      if (generation === epoch.current) setError(errorMessage(cause))
    } finally {
      if (generation === epoch.current) setLoading(false)
    }
  }

  async function reconnect(): Promise<void> {
    try {
      await window.companion.reconnect()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }
  return { status, snapshot, loading, error, refresh, reconnect }
}

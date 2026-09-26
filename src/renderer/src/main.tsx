import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CompanionStatus } from '../../shared/companion'
import './style.css'

function App(): React.JSX.Element {
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [reconnecting, setReconnecting] = useState(false)

  useEffect(() => {
    let active = true
    let receivedUpdate = false
    const unsubscribe = window.companion.onStatus((next) => {
      receivedUpdate = true
      if (active) setStatus(next)
    })
    void window.companion
      .getStatus()
      .then((initial) => {
        if (active && !receivedUpdate) setStatus(initial)
      })
      .catch(console.error)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  async function reconnect(): Promise<void> {
    setReconnecting(true)
    try {
      await window.companion.reconnect()
    } catch (error) {
      console.error('Could not reconnect to companion:', error)
    } finally {
      setReconnecting(false)
    }
  }

  return (
    <main aria-label="Companion connection">
      {status?.state === 'connected' && !reconnecting ? (
        <button
          type="button"
          onClick={() => void reconnect()}
          title="Force reconnect"
        >
          Reconnect
        </button>
      ) : (
        <span
          className="spinner"
          role="status"
          aria-label="Connecting to companion server"
          title={status?.error ?? 'Connecting to companion server'}
        />
      )}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)

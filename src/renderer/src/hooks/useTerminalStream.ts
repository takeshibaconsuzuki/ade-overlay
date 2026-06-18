import { useEffect, useState } from 'react'
import { SERVER_ORIGIN } from '../../../api/server/config'
import {
  TERMINAL_STREAM_PATH,
  TerminalSseEvents,
  type Terminal,
  type TerminalSnapshot as TerminalSnapshotType,
} from '../../../api/server/terminals'
import { logger } from '../logger'
import { parseSsePayload } from '../sse'

export type TerminalDescriptor = Terminal

const EMPTY_SNAPSHOT: TerminalSnapshotType = { terminals: [] }

export function useTerminalStream(): {
  terminals: TerminalDescriptor[]
  connected: boolean
} {
  const [snapshot, setSnapshot] = useState<TerminalSnapshotType>(EMPTY_SNAPSHOT)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const url = `${SERVER_ORIGIN}${TERMINAL_STREAM_PATH}`
    logger.info({ url }, 'opening terminal stream')
    const source = new EventSource(url)

    source.addEventListener('snapshot', (event) => {
      const data = parseSsePayload(
        TerminalSseEvents,
        'snapshot',
        event.data,
        'terminal',
      )
      if (data) {
        setSnapshot(data)
      }
    })

    source.onopen = () => {
      setConnected(true)
    }
    source.onerror = () => {
      setConnected(false)
    }

    return () => {
      logger.info('closing terminal stream')
      source.close()
    }
  }, [])

  return { terminals: snapshot.terminals, connected }
}

import { useEffect, useState } from 'react'
import { SERVER_ORIGIN } from '../../../api/server/config'
import {
  CHAT_EVENT_TYPES,
  CHAT_STREAM_PATH,
  type ChatStatus,
} from '../../../api/server/chats'
import { logger } from '../logger'

export type Chat = {
  chatId: string
  providerId: string
  status: ChatStatus
  title?: string
  description?: string
  worktreeId?: string
  updatedAt: number
}

export type ChatSnapshot = {
  chats: Chat[]
}

const EMPTY_SNAPSHOT: ChatSnapshot = { chats: [] }

/**
 * Subscribe to the server-sent live-chat stream. The initial `snapshot` event
 * carries full state; every change event carries a fresh `snapshot`, so we
 * simply mirror whichever snapshot arrives last.
 */
export function useChatStream(): {
  chats: Chat[]
  connected: boolean
} {
  const [snapshot, setSnapshot] = useState<ChatSnapshot>(EMPTY_SNAPSHOT)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const url = `${SERVER_ORIGIN}${CHAT_STREAM_PATH}`
    logger.info({ url }, 'opening chat stream')
    const source = new EventSource(url)

    source.addEventListener('snapshot', (event) => {
      const data = parseStream<ChatSnapshot>('snapshot', event.data)
      if (data) {
        setSnapshot(data)
      }
    })
    for (const type of CHAT_EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        const data = parseStream<{ snapshot: ChatSnapshot }>(type, event.data)
        if (data) {
          setSnapshot(data.snapshot)
        }
      })
    }

    source.onopen = () => {
      setConnected(true)
    }
    source.onerror = () => {
      setConnected(false)
    }

    return () => {
      logger.info('closing chat stream')
      source.close()
    }
  }, [])

  return { chats: snapshot.chats, connected }
}

function parseStream<T>(type: string, raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    logger.error({ type, err: error }, 'failed to parse chat stream payload')
    return null
  }
}

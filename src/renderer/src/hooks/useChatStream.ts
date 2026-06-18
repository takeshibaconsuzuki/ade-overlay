import { useEffect, useState } from 'react'
import {
  CHAT_EVENT_TYPES,
  CHAT_STREAM_PATH,
  ChatSseEvents,
  type Chat,
  type ChatSnapshot as ChatSnapshotType,
} from '../../../api/server/chats'
import { SERVER_ORIGIN } from '../../../api/server/config'
import { logger } from '../logger'
import { parseSsePayload } from '../sse'

export type { Chat }

const EMPTY_SNAPSHOT: ChatSnapshotType = { chats: [] }

/**
 * Subscribe to the server-sent live-chat stream. The initial `snapshot` event
 * carries full state; every change event carries a fresh `snapshot`, so we
 * simply mirror whichever snapshot arrives last.
 */
export function useChatStream(): {
  chats: Chat[]
  connected: boolean
} {
  const [snapshot, setSnapshot] = useState<ChatSnapshotType>(EMPTY_SNAPSHOT)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const url = `${SERVER_ORIGIN}${CHAT_STREAM_PATH}`
    logger.info({ url }, 'opening chat stream')
    const source = new EventSource(url)

    source.addEventListener('snapshot', (event) => {
      const data = parseSsePayload(
        ChatSseEvents,
        'snapshot',
        event.data,
        'chat',
      )
      if (data) {
        setSnapshot(data)
      }
    })
    for (const type of CHAT_EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        const data = parseSsePayload(ChatSseEvents, type, event.data, 'chat')
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

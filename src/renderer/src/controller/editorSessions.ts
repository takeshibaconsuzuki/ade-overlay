import { useEffect, useState } from 'react'
import { SERVER_ORIGIN } from '../../../api/server/config'
import {
  EDITOR_SESSION_STATUS_EVENT,
  type EditorSessionStatus,
  type EditorSessionStatusValue,
} from '../../../api/server/editor'
import { logger } from '../logger'

export type EditorSessionState = {
  status: EditorSessionStatusValue
  lastSwitchAt?: string
}
export type EditorSessionStatusMap = ReadonlyMap<string, EditorSessionState>

/**
 * Subscribe to per-worktree VS Code session status. The initial `snapshot`
 * event carries every non-`off` session; subsequent `session-status` events
 * patch a single worktree. Worktrees absent from the map are treated as `off`.
 */
export function useEditorSessionStream(): EditorSessionStatusMap {
  const [statuses, setStatuses] = useState<EditorSessionStatusMap>(new Map())

  useEffect(() => {
    const url = `${SERVER_ORIGIN}/editorSessions`
    logger.info({ url }, 'opening editor session stream')
    const source = new EventSource(url)

    source.addEventListener('snapshot', (event) => {
      const data = parseStream<EditorSessionStatus[]>('snapshot', event.data)
      if (data) {
        setStatuses(
          new Map(
            data.map((entry) => [entry.worktreeId, toSessionState(entry)]),
          ),
        )
      }
    })

    source.addEventListener(EDITOR_SESSION_STATUS_EVENT, (event) => {
      const data = parseStream<EditorSessionStatus>(
        EDITOR_SESSION_STATUS_EVENT,
        event.data,
      )
      if (!data) {
        return
      }
      setStatuses((current) => {
        const next = new Map(current)
        if (data.status === 'off') {
          next.delete(data.worktreeId)
        } else {
          next.set(data.worktreeId, toSessionState(data))
        }
        return next
      })
    })

    source.onerror = () => {
      logger.warn('editor session stream disconnected; browser will retry')
    }

    return () => {
      logger.info('closing editor session stream')
      source.close()
    }
  }, [])

  return statuses
}

function toSessionState(entry: EditorSessionStatus): EditorSessionState {
  return { status: entry.status, lastSwitchAt: entry.lastSwitchAt }
}

function parseStream<T>(type: string, raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    logger.error({ type, err: error }, 'failed to parse session stream payload')
    return null
  }
}

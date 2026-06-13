import { useEffect, useState } from 'react'
import type { RemoveRepositoryResponses } from '../../../api/server/generated'
import { SERVER_ORIGIN } from '../../../api/server/config'
import { WORKTREE_EVENT_TYPES } from '../../../api/server/events'
import { logger } from '../logger'

export type WorktreeSnapshot = RemoveRepositoryResponses[200]['snapshot']
export type Worktree = WorktreeSnapshot['worktrees'][number]
export type Repository = WorktreeSnapshot['repositories'][number]

const EMPTY_SNAPSHOT: WorktreeSnapshot = { repositories: [], worktrees: [] }

/**
 * Subscribe to the server-sent worktree stream. The initial `snapshot` event
 * carries the full state; every change event carries a fresh `snapshot`, so we
 * simply mirror whichever snapshot arrives last.
 */
export function useWorktreeStream(): {
  snapshot: WorktreeSnapshot
  connected: boolean
} {
  const [snapshot, setSnapshot] = useState<WorktreeSnapshot>(EMPTY_SNAPSHOT)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const url = `${SERVER_ORIGIN}/worktrees`
    logger.info({ url }, 'opening worktree stream')
    const source = new EventSource(url)

    source.addEventListener('snapshot', (event) => {
      const data = parseStream<WorktreeSnapshot>('snapshot', event.data)
      if (data) {
        logger.info({ worktrees: data.worktrees.length }, 'snapshot received')
        setSnapshot(data)
      }
    })
    for (const type of WORKTREE_EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        const data = parseStream<{ snapshot: WorktreeSnapshot }>(
          type,
          event.data,
        )
        if (data) {
          logger.info(
            { type, worktrees: data.snapshot.worktrees.length },
            'stream event',
          )
          setSnapshot(data.snapshot)
        }
      })
    }

    source.onopen = () => {
      logger.info('worktree stream connected')
      setConnected(true)
    }
    source.onerror = () => {
      logger.warn('worktree stream disconnected; browser will retry')
      setConnected(false)
    }

    return () => {
      logger.info('closing worktree stream')
      source.close()
    }
  }, [])

  return { snapshot, connected }
}

/** Parse a stream payload, logging (and swallowing) malformed data. */
function parseStream<T>(type: string, raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    logger.error({ type, err: error }, 'failed to parse stream payload')
    return null
  }
}

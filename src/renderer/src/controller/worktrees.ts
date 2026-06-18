import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { SERVER_ORIGIN } from '../../../api/server/config'
import { WORKTREE_EVENT_TYPES } from '../../../api/server/events'
import {
  WORKTREES_PATH,
  WorktreeSseEvents,
  type Repository,
  type Worktree,
  type WorktreeSnapshot as WorktreeSnapshotType,
} from '../../../api/server/worktrees'
import { logger } from '../logger'
import { parseSsePayload } from '../sse'

export type WorktreeSnapshot = WorktreeSnapshotType
export type { Repository, Worktree }

const EMPTY_SNAPSHOT: WorktreeSnapshot = { repositories: [], worktrees: [] }

type WorktreeStreamState = {
  snapshot: WorktreeSnapshot
  connected: boolean
}

const WorktreeStreamContext = createContext<WorktreeStreamState | null>(null)

export function WorktreeStreamProvider({
  children,
}: {
  children: ReactNode
}): React.JSX.Element {
  const value = useWorktreeStreamState()
  return createElement(WorktreeStreamContext.Provider, { value }, children)
}

/**
 * Subscribe to the server-sent worktree stream. The initial `snapshot` event
 * carries the full state; every change event carries a fresh `snapshot`, so we
 * simply mirror whichever snapshot arrives last.
 */
export function useWorktreeStream(): WorktreeStreamState {
  const value = useContext(WorktreeStreamContext)
  if (!value) {
    throw new Error(
      'useWorktreeStream must be used within WorktreeStreamProvider',
    )
  }
  return value
}

function useWorktreeStreamState(): WorktreeStreamState {
  const [snapshot, setSnapshot] = useState<WorktreeSnapshot>(EMPTY_SNAPSHOT)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const url = `${SERVER_ORIGIN}${WORKTREES_PATH}`
    logger.info({ url }, 'opening worktree stream')
    const source = new EventSource(url)

    source.addEventListener('snapshot', (event) => {
      const data = parseSsePayload(
        WorktreeSseEvents,
        'snapshot',
        event.data,
        'worktree',
      )
      if (data) {
        logger.info({ worktrees: data.worktrees.length }, 'snapshot received')
        setSnapshot(data)
      }
    })
    for (const type of WORKTREE_EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        const data = parseSsePayload(
          WorktreeSseEvents,
          type,
          event.data,
          'worktree',
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

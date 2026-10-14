import type { BirpcReturn } from 'birpc'
import { createMessageRpc } from './message-rpc'
import WebSocket, { type RawData } from 'ws'
import { HEARTBEAT_INTERVAL_MS } from './constants'

export function createRpcPeer<Remote extends object, Local extends object>(
  socket: WebSocket,
  methods: Local,
): BirpcReturn<Remote, Local> {
  let receive: (data: string) => void = () => {}
  const rpc = createMessageRpc<Remote, Local>(
    {
      post: (data) =>
        new Promise<void>((resolve, reject) => {
          if (socket.readyState !== WebSocket.OPEN) {
            reject(new Error('RPC connection is not open'))
            return
          }
          socket.send(data, (error) => (error ? reject(error) : resolve()))
        }),
      on: (handler) => {
        receive = handler
      },
      off: () => {
        receive = () => {}
      },
      onError: () => socket.terminate(),
    },
    methods,
  )

  const onMessage = (data: RawData) => {
    // EventEmitter does not observe rejected async message handlers.
    void Promise.resolve()
      .then(() => receive(data.toString()))
      .catch(() => socket.terminate())
  }
  let alive = true
  const onPong = () => {
    alive = true
  }
  const onError = () => socket.terminate()
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate()
      return
    }
    if (socket.readyState === WebSocket.OPEN) {
      alive = false
      socket.ping()
    }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref()

  socket.on('message', onMessage)
  socket.on('pong', onPong)
  socket.on('error', onError)
  socket.once('close', () => {
    clearInterval(heartbeat)
    socket.off('message', onMessage)
    socket.off('pong', onPong)
    socket.off('error', onError)
    rpc.$close(new Error('RPC connection disconnected'))
  })

  return rpc
}

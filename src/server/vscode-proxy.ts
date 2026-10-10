import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { createProxyServer } from 'httpxy'

export interface VscodeProxyTargets {
  // Returns the current loopback upstream for a worktree route, or undefined when unavailable.
  getTarget(basePath: string): string | undefined
}

export interface ServerProxy {
  // Forwards an HTTP request and its response to the selected upstream.
  request(request: IncomingMessage, response: ServerResponse): void
  // Forwards a WebSocket upgrade and retains the connection until it closes or the proxy shuts down.
  upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void
  // Releases proxy resources and closes retained connections.
  close(): void
}

// Routes HTTP and WebSocket traffic by stable worktree path. VS Code serves the
// same base path and authenticates the forwarded requests and connections.
export class VscodeProxy implements ServerProxy {
  private readonly proxy = createProxyServer({ ws: true })
  private readonly sockets = new Set<Socket>()
  private readonly pendingUpgrades = new Set<ClientRequest>()
  private closed = false

  constructor(private readonly targets: VscodeProxyTargets) {
    this.proxy.on('open', (socket) => this.track(socket))
    this.proxy.on('proxyReqWs', (request, _incoming, socket) => {
      if (this.closed) {
        request.destroy()
        return
      }
      // Closing the downstream alone does not cancel httpxy's pending handshake.
      this.pendingUpgrades.add(request)
      const cancel = () => request.destroy()
      socket.once('close', cancel)
      request.once('close', () => {
        this.pendingUpgrades.delete(request)
        socket.off('close', cancel)
      })
    })
  }

  private track(socket: Socket): void {
    // An upstream handshake can complete while shutdown is already in progress.
    if (this.closed) {
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
  }

  private resolveTarget(request: IncomingMessage): string | undefined {
    const basePath = /^\/vscode\/[a-f0-9]{64}(?=\/|\?|$)/.exec(
      request.url ?? '',
    )?.[0]
    if (!basePath) return undefined
    return this.targets.getTarget(basePath)
  }

  private prepareRequest(request: IncomingMessage): void {
    // VS Code constructs browser URLs from these headers. Only the public Host
    // supplied to ADE should determine its authority and the configured route.
    delete request.headers['x-original-host']
    delete request.headers['x-forwarded-host']
    delete request.headers['x-forwarded-port']
    delete request.headers['x-forwarded-prefix']
  }

  request(request: IncomingMessage, response: ServerResponse): void {
    const target = this.resolveTarget(request)
    if (!target) {
      response.writeHead(503, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
      })
      response.end('VS Code Server is not ready')
      return
    }
    this.prepareRequest(request)
    // Leave credentials and cookies intact: VS Code authenticates HTTP and its
    // WebSocket protocol. Never inject a token into an unauthenticated request.
    void this.proxy.web(request, response, { target }).catch(() => {
      if (response.headersSent) response.destroy()
      else {
        response.writeHead(502, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
        })
        response.end('Unable to reach VS Code Server')
      }
    })
  }

  upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    if (this.closed) {
      socket.destroy()
      return
    }
    const target = this.resolveTarget(request)
    if (!target) {
      // Rejected upgrades are not retained; close both directions after flushing.
      socket.end(
        'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n',
        () => socket.destroy(),
      )
      return
    }
    this.prepareRequest(request)
    this.track(socket)
    void this.proxy
      .ws(request, socket, { target }, head)
      .catch(() => socket.destroy())
  }

  close(): void {
    this.closed = true
    for (const request of this.pendingUpgrades) request.destroy()
    this.pendingUpgrades.clear()
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.proxy.close()
  }
}

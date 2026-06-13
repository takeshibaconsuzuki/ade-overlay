import { type ChildProcess } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { isChildAlive } from './processes'

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port)
        } else {
          reject(new Error('Failed to allocate a port'))
        }
      })
    })
  })
}

export async function waitForPort(
  port: number,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    if (!isChildAlive(child)) {
      throw new Error('Process exited before the port was ready')
    }
    try {
      await probePort(port)
      return
    } catch (error) {
      lastError = error
      await delay(150)
    }
  }
  throw new Error(`Timed out waiting for port ${port}: ${String(lastError)}`)
}

function probePort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.end()
      resolve()
    })
    socket.once('error', reject)
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

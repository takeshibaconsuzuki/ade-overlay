import { timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'

export function authorized(header: string | undefined, token: string): boolean {
  const actual = Buffer.from(header ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function rejectUpgrade(socket: Duplex, status: string): void {
  // Release rejected peers even when they keep their write side open.
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  )
}

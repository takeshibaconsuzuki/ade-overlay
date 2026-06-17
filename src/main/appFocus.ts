import { request } from 'node:http'
import {
  APP_FOCUS_PATH,
  type AdeAppRole,
  type AppFocusEvent,
} from '../api/server/appFocus'
import { SERVER_ORIGIN } from '../api/server/config'
import { type Logger } from '../api/server/logger'

export function reportAppFocus(
  role: AdeAppRole,
  event: AppFocusEvent,
  log: Logger,
): void {
  const requestUrl = new URL(APP_FOCUS_PATH, SERVER_ORIGIN)
  const body = JSON.stringify({ event, role })
  const focusRequest = request(
    requestUrl,
    {
      method: 'POST',
      headers: {
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/json',
      },
    },
    (response) => {
      response.resume()
      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 400) {
          log.warn(
            { event, role, statusCode: response.statusCode },
            'failed to report app focus',
          )
        }
      })
    },
  )
  focusRequest.on('error', (error) => {
    log.warn({ err: error, event, role }, 'failed to report app focus')
  })
  focusRequest.end(body)
}

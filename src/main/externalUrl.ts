import { shell } from 'electron'
import { type Logger } from '../api/server/logger'

/**
 * Opens a web URL outside Electron after validating the renderer-controlled
 * value. Keep protocol validation in the privileged process so terminal output
 * cannot launch arbitrary URL handlers.
 */
export function openUrlInHostBrowser(url: unknown, log: Logger): void {
  if (typeof url !== 'string') {
    log.warn({ url }, 'blocked non-string external URL')
    return
  }

  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    log.warn({ url }, 'blocked invalid external URL')
    return
  }

  if (protocol !== 'http:' && protocol !== 'https:') {
    log.warn({ url }, 'blocked external URL with unsupported protocol')
    return
  }

  setImmediate(() => {
    void shell.openExternal(url).catch((error: unknown) => {
      log.warn({ err: error, url }, 'failed to open URL in host browser')
    })
  })
}

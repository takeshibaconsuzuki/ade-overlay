import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function getAppDataDir(): string {
  return process.env.ADE_OVERLAY_DATA_DIR
    ? resolve(process.env.ADE_OVERLAY_DATA_DIR)
    : join(homedir(), '.ade-overlay')
}

export function getEditorDataDir(): string {
  return join(getAppDataDir(), 'editor')
}

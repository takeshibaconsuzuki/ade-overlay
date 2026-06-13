import { readFileSync } from 'node:fs'
import { EDITOR_BASE_PATH } from '../../api/server/editor'
import { getEditorBootstrapClientScript } from './bootstrapClient'
import { type UserDataPayload } from './userData'

let bootstrapTemplate: string | null = null

export function renderBootstrapHtml(payload: UserDataPayload): string {
  const json = JSON.stringify({
    ...payload,
    targetUrl: EDITOR_BASE_PATH,
  }).replace(/</g, '\\u003c')

  return getBootstrapTemplate()
    .replace('__ADE_EDITOR_BOOTSTRAP_PAYLOAD__', () => json)
    .replace('__ADE_EDITOR_BOOTSTRAP_CLIENT__', () =>
      getEditorBootstrapClientScript(),
    )
}

function getBootstrapTemplate(): string {
  bootstrapTemplate ??= readFileSync(
    new URL('./bootstrap.html', import.meta.url),
    'utf8',
  )
  return bootstrapTemplate
}

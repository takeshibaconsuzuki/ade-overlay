import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Logger } from '../../api/server/logger'

const EXTENSION_DIR_NAME = 'ade-overlay-helper'
const EXTENSION_PUBLISHER = 'ade-overlay'
const EXTENSION_NAME = 'ade-overlay-helper'
const EXTENSION_VERSION = '0.0.1'
const EXTENSION_ID = `${EXTENSION_PUBLISHER}.${EXTENSION_NAME}`

const PACKAGE_JSON = JSON.stringify(
  {
    name: EXTENSION_NAME,
    displayName: 'ADE Overlay Helper',
    publisher: EXTENSION_PUBLISHER,
    version: EXTENSION_VERSION,
    engines: { vscode: '^1.0.0' },
    main: './extension.js',
    activationEvents: ['onStartupFinished'],
    contributes: {},
  },
  null,
  2,
)

// Plain CommonJS so the VS Code extension host can require it directly. It opens
// a long-lived connection back to the ADE server and opens whatever absolute
// file path the server pushes for this worktree (used for creation logs, which
// live outside the workspace folder).
const EXTENSION_JS = `const vscode = require('vscode')
const http = require('node:http')
const { URL } = require('node:url')

function activate() {
  const origin = process.env.ADE_SERVER_ORIGIN
  const worktreeId = process.env.ADE_WORKTREE_ID
  if (!origin || !worktreeId) {
    return
  }
  connect(origin, worktreeId)
}

function connect(origin, worktreeId) {
  const url = new URL('/editorExtensionCommands', origin)
  url.searchParams.set('worktreeId', worktreeId)
  const request = http.get(url, (response) => {
    response.setEncoding('utf8')
    let buffer = ''
    response.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\\n\\n')
      while (index >= 0) {
        handleEvent(buffer.slice(0, index))
        buffer = buffer.slice(index + 2)
        index = buffer.indexOf('\\n\\n')
      }
    })
    response.on('end', () => reconnect(origin, worktreeId))
  })
  request.on('error', () => reconnect(origin, worktreeId))
}

function reconnect(origin, worktreeId) {
  setTimeout(() => connect(origin, worktreeId), 1000)
}

function handleEvent(raw) {
  const data = raw
    .split('\\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\\n')
  if (!data) {
    return
  }
  try {
    const payload = JSON.parse(data)
    if (payload && typeof payload.filePath === 'string') {
      void vscode.window.showTextDocument(vscode.Uri.file(payload.filePath), {
        preview: false,
      })
    }
  } catch {
    // Ignore malformed events.
  }
}

module.exports = { activate }
`

/**
 * Write the bundled ADE helper extension into a session's extensions directory.
 * Generated at runtime (rather than shipped as a build artifact) so it stays
 * colocated with this file and needs no packaging step.
 *
 * `code serve-web` has no `--extensions-dir`; it owns `<server-data>/extensions`
 * and reconciles it on startup via `extensions.json` (the installed manifest)
 * and `.obsolete` (pending removals). Simply dropping a folder is unreliable —
 * re-writing it over a prior install makes VS Code mark it obsolete and delete
 * it. So we deterministically reproduce the "installed" state: write the files,
 * register the extension in `extensions.json`, and clear it from `.obsolete`.
 */
export async function writeAdeHelperExtension(
  extensionsDir: string,
  log: Logger,
): Promise<void> {
  const target = join(extensionsDir, EXTENSION_DIR_NAME)
  try {
    await mkdir(target, { recursive: true })
    await writeIfChanged(join(target, 'package.json'), PACKAGE_JSON)
    await writeIfChanged(join(target, 'extension.js'), EXTENSION_JS)
    await registerExtension(extensionsDir, target)
    await clearObsolete(extensionsDir)
  } catch (error) {
    log.warn({ err: error, target }, 'failed to write ADE helper extension')
  }
}

/** Avoid rewriting unchanged files, which can trigger a reinstall/obsolete. */
async function writeIfChanged(path: string, content: string): Promise<void> {
  try {
    if ((await readFile(path, 'utf8')) === content) {
      return
    }
  } catch {
    // Missing/unreadable: fall through and write.
  }
  await writeFile(path, content, 'utf8')
}

/** Ensure our extension is the registered install entry for its id. */
async function registerExtension(
  extensionsDir: string,
  target: string,
): Promise<void> {
  const manifestPath = join(extensionsDir, 'extensions.json')
  const entries = (await readJson<unknown[]>(manifestPath)) ?? []
  const withoutHelper = Array.isArray(entries)
    ? entries.filter((entry) => extensionIdOf(entry) !== EXTENSION_ID)
    : []
  withoutHelper.push({
    identifier: { id: EXTENSION_ID },
    version: EXTENSION_VERSION,
    location: { $mid: 1, path: target, scheme: 'file' },
    relativeLocation: EXTENSION_DIR_NAME,
  })
  await writeFile(manifestPath, JSON.stringify(withoutHelper), 'utf8')
}

/** Remove any pending removal of our extension so VS Code keeps it. */
async function clearObsolete(extensionsDir: string): Promise<void> {
  const obsoletePath = join(extensionsDir, '.obsolete')
  const obsolete = await readJson<Record<string, boolean>>(obsoletePath)
  if (!obsolete) {
    return
  }
  let changed = false
  for (const key of Object.keys(obsolete)) {
    if (key.startsWith(`${EXTENSION_ID}-`)) {
      delete obsolete[key]
      changed = true
    }
  }
  if (!changed) {
    return
  }
  if (Object.keys(obsolete).length === 0) {
    await rm(obsoletePath, { force: true })
  } else {
    await writeFile(obsoletePath, JSON.stringify(obsolete), 'utf8')
  }
}

function extensionIdOf(entry: unknown): string | undefined {
  const id = (entry as { identifier?: { id?: unknown } })?.identifier?.id
  return typeof id === 'string' ? id : undefined
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

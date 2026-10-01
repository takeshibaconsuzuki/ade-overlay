import paths from 'path-browserify-win32'
import filenamify from 'filenamify/browser'
import { Liquid } from 'liquidjs'

export const defaultWorktreePathTemplate =
  '{{ mainWorktreePath }}-{{ branchName | filename }}'

function createEngine(pathStyle: 'win32' | 'posix'): Liquid {
  const engine = new Liquid({
    strictVariables: true,
    strictFilters: true,
    templates: {},
    parseLimit: 16 * 1024,
    renderLimit: 50,
    memoryLimit: 64 * 1024,
  })
  engine.registerFilter('hash', async (value: string) => {
    const bytes = new TextEncoder().encode(String(value))
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
  })
  engine.registerFilter('filename', (value: string) =>
    filenamify(String(value), { replacement: '-' }),
  )
  engine.registerFilter('basename', (value: string) =>
    paths[pathStyle].basename(String(value)),
  )
  engine.registerFilter('dirname', (value: string) =>
    paths[pathStyle].dirname(String(value)),
  )
  return engine
}

const engines = { win32: createEngine('win32'), posix: createEngine('posix') }

export async function renderWorktreePath(
  template: string | undefined,
  mainWorktreePath: string,
  branchName: string,
  pathStyle: 'win32' | 'posix',
): Promise<string> {
  if (!branchName) return ''
  try {
    const path: string = await engines[pathStyle].parseAndRender(
      template ?? defaultWorktreePathTemplate,
      { mainWorktreePath, branchName },
    )
    if (!path.trim() || path.length > 4096 || path.includes('\0'))
      throw new Error(
        'Template must produce a nonblank path of at most 4096 characters without null bytes.',
      )
    return path.trim()
  } catch (cause) {
    throw new Error(
      `Invalid worktreePathTemplate: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }
}

import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { platform } from 'node:os'
import { join } from 'node:path'
import Mustache from 'mustache'
import { getAppDataDir } from '../dataDir'

const FORWARDER_ASSET = new URL('./hook-forwarder.cjs', import.meta.url)
const POSIX_WRAPPER_TEMPLATE = new URL('./hook-wrapper.sh', import.meta.url)
const WINDOWS_WRAPPER_TEMPLATE = new URL('./hook-wrapper.cmd', import.meta.url)

/**
 * Shared managed hook command for chat providers. The configured provider hook
 * runs a small platform wrapper. The wrapper invokes this shared Node script
 * with the provider endpoint baked in, and the forwarder stamps runtime process
 * metadata (including cwd) onto the hook payload.
 */
export async function ensureHookForwarderWrapper(
  providerId: string,
  endpointUrl: string,
): Promise<string> {
  const dir = join(getAppDataDir(), 'chats')
  const scriptPath = join(dir, 'hook-forwarder.cjs')
  const wrapperTemplate =
    platform() === 'win32' ? WINDOWS_WRAPPER_TEMPLATE : POSIX_WRAPPER_TEMPLATE
  const wrapperPath = join(
    dir,
    platform() === 'win32'
      ? `ade-overlay-chat-hook-${providerId}.cmd`
      : `ade-overlay-chat-hook-${providerId}.sh`,
  )
  await mkdir(dir, { recursive: true })
  await copyFile(FORWARDER_ASSET, scriptPath)

  const wrapper = Mustache.render(
    await readFile(wrapperTemplate, 'utf8'),
    platform() === 'win32'
      ? {
          NODE: cmdQuote(process.execPath),
          FORWARDER: cmdQuote(scriptPath),
          ENDPOINT: cmdQuote(endpointUrl),
        }
      : {
          NODE: shellQuote(process.execPath),
          FORWARDER: shellQuote(scriptPath),
          ENDPOINT: shellQuote(endpointUrl),
        },
  )
  await writeFile(wrapperPath, wrapper, 'utf8')
  if (platform() !== 'win32') {
    await chmod(wrapperPath, 0o755)
  }

  return wrapperPath
}

export function hookForwardCommand(wrapperPath: string): {
  type: 'command'
  command: string
  timeout: number
} {
  const command =
    platform() === 'win32' ? cmdQuote(wrapperPath) : shellQuote(wrapperPath)

  return {
    type: 'command',
    command,
    timeout: 5,
  }
}

export function hookAncestorPids(
  payload: Record<string, unknown>,
): number[] | undefined {
  const metadata = payload._ade_overlay
  if (!isRecord(metadata) || !Array.isArray(metadata.hook_ancestor_pids)) {
    return undefined
  }

  const pids = metadata.hook_ancestor_pids.filter(
    (pid): pid is number =>
      typeof pid === 'number' && Number.isInteger(pid) && pid > 0,
  )
  return pids.length > 0 ? pids : undefined
}

export function hookCwd(payload: Record<string, unknown>): string | undefined {
  const metadata = payload._ade_overlay
  if (!isRecord(metadata) || typeof metadata.hook_cwd !== 'string') {
    return undefined
  }

  return metadata.hook_cwd
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function cmdQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

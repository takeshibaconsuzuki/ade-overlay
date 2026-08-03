import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { type Logger } from '../api/server/logger'

const execFileAsync = promisify(execFile)

const FOREGROUND_PROCESS_ID_ENV = 'ADE_FOREGROUND_PROCESS_ID'
const ALLOW_SET_FOREGROUND_WINDOW_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;

public static class AdeForegroundWindow
{
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AllowSetForegroundWindow(uint processId);
}
'@

$processId = [uint32][Environment]::GetEnvironmentVariable('${FOREGROUND_PROCESS_ID_ENV}')
if (-not [AdeForegroundWindow]::AllowSetForegroundWindow($processId)) {
    exit 1
}
`

type ForegroundLogger = Pick<Logger, 'debug' | 'warn'>

type WindowsForegroundOptions = {
  platform?: NodeJS.Platform
  run?: (processId: number) => Promise<void>
}

/**
 * Gives a spawned role process permission to activate its window on Windows.
 *
 * Windows normally rejects foreground activation from a background process.
 * This helper runs in the controller's user-interaction chain and transfers
 * that permission to the role process immediately before its focus command.
 */
export async function allowWindowsForegroundActivation(
  processId: number | undefined,
  log: ForegroundLogger,
  options: WindowsForegroundOptions = {},
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== 'win32') {
    return true
  }
  if (
    typeof processId !== 'number' ||
    !Number.isSafeInteger(processId) ||
    processId <= 0
  ) {
    log.warn({ processId }, 'cannot grant foreground activation without a pid')
    return false
  }

  try {
    await (options.run ?? runWindowsForegroundHelper)(processId)
    log.debug({ processId }, 'granted foreground activation')
    return true
  } catch (error) {
    // Keep the existing Electron focus path as a fallback. It can still work
    // when Windows already considers the editor eligible for activation.
    log.warn({ err: error, processId }, 'failed to grant foreground activation')
    return false
  }
}

async function runWindowsForegroundHelper(processId: number): Promise<void> {
  await execFileAsync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      ALLOW_SET_FOREGROUND_WINDOW_SCRIPT,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        [FOREGROUND_PROCESS_ID_ENV]: String(processId),
      },
      timeout: 2_000,
      windowsHide: true,
    },
  )
}

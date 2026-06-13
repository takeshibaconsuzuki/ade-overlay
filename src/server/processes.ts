import { spawn, type ChildProcess } from 'node:child_process'
import { platform } from 'node:os'
import { type Logger } from '../api/server/logger'

export function isChildAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null && !child.killed
}

export async function killChildProcessTree(
  child: ChildProcess,
  log: Logger,
  label: string,
): Promise<void> {
  if (!child.pid || !isChildAlive(child)) {
    return
  }

  const exitPromise = waitForChildExit(child, 5000)
  try {
    if (platform() === 'win32') {
      await runTaskkill(child.pid)
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        process.kill(child.pid, 'SIGTERM')
      }
    }
  } catch (error) {
    log.warn({ err: error, pid: child.pid, label }, 'process kill failed')
  }

  const exited = await exitPromise
  if (!exited && child.pid && isChildAlive(child)) {
    try {
      if (platform() === 'win32') {
        await runTaskkill(child.pid)
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          process.kill(child.pid, 'SIGKILL')
        }
      }
    } catch (error) {
      log.warn({ err: error, pid: child.pid, label }, 'process kill failed')
    }
  }
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (!isChildAlive(child)) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMilliseconds)
    const onExit = (): void => {
      clearTimeout(timeout)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
    })
    child.on('exit', () => resolve())
    child.on('error', () => resolve())
  })
}

import type { ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import treeKill from 'tree-kill'

// Force-stop an owned process tree. Graceful service shutdown must signal its owner
// separately so accepted work can finish before descendants are terminated.
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  let onClose: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    onClose = resolve
    child.once('close', onClose)
  })
  try {
    const error = await new Promise<Error | undefined>((resolve) => {
      treeKill(child.pid!, 'SIGKILL', resolve)
    })
    if (error) {
      // Windows taskkill can report an exiting descendant before Node receives
      // the parent's close event. Only accept that error if closure follows.
      await Promise.race([
        closed,
        delay(1000, undefined, { ref: false }).then(() => {
          throw error
        }),
      ])
    }
    await closed
  } finally {
    child.removeListener('close', onClose)
  }
}

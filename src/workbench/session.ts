import type { WorkbenchServices } from './services'

// Only the internal contracts used by persistence are described here. VS Code owns the objects.
// eslint-disable-next-line @typescript-eslint/no-namespace -- Groups type-only contracts without emitting a runtime namespace.
export declare namespace SessionServices {
  interface LifecycleService {
    withExpectedShutdown(reason: 3): Promise<void>
  }

  interface WorkingCopyBackupService {
    joinBackups(): Promise<void>
  }

  interface WorkingCopyBackupTracker {
    readonly pendingBackupOperations: { readonly size: number }
  }
}

// Flushes browser-local view state and working-copy backups; the server may already be stopped.
export async function persistVscodeSession(
  handle: WorkbenchServices,
): Promise<void> {
  const lifecycle = handle.get(
    'lifecycleService',
  ) as SessionServices.LifecycleService
  const backups = handle.get(
    'workingCopyBackupService',
  ) as SessionServices.WorkingCopyBackupService
  const tracker = handle.get(
    'workbench.contrib.browserWorkingCopyBackupTracker',
  ) as SessionServices.WorkingCopyBackupTracker
  const results = await Promise.allSettled([
    // Treat reopening ADE's page as a reload so VS Code restores the complete saved layout.
    // Capture the view independently so a stuck backup cannot prevent this flush.
    lifecycle.withExpectedShutdown(3), // ShutdownReason.RELOAD
    (async () => {
      // Let VS Code own backup creation and deletion. Its write queue does not include
      // scheduled backups yet; wait for the tracker too. Electron bounds the entire wait.
      do {
        while (tracker.pendingBackupOperations.size)
          await new Promise<void>((resolve) => setTimeout(resolve, 25))
        await backups.joinBackups()
      } while (tracker.pendingBackupOperations.size)
    })(),
  ])
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  )
  if (errors.length)
    throw new AggregateError(errors, 'Unable to persist VS Code session')
}

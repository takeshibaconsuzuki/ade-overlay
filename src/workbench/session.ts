import type { WorkbenchServices } from './services'

// Only the internal contracts used by persistence are described here. VS Code owns the objects.
// eslint-disable-next-line @typescript-eslint/no-namespace -- Groups type-only contracts without emitting a runtime namespace.
export declare namespace SessionServices {
  interface StorageService {
    flush(reason: 1): Promise<void>
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
  const storage = handle.get('storageService') as SessionServices.StorageService
  const backups = handle.get(
    'workingCopyBackupService',
  ) as SessionServices.WorkingCopyBackupService
  const tracker = handle.get(
    'workbench.contrib.browserWorkingCopyBackupTracker',
  ) as SessionServices.WorkingCopyBackupTracker
  const results = await Promise.allSettled([
    // Capture the view independently so a stuck backup cannot prevent this flush.
    storage.flush(1),
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

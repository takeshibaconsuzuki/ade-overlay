import { resolve } from 'node:path'
import type { CompanionClient } from '../../src/main/companion-client.ts'
import type {
  CreateWorktreeInput,
  DeleteWorktreeInput,
  WorktreeSnapshot,
} from '../../src/shared/companion.ts'

// Existing editor integration scenarios need completed Git operations. The
// production commands acknowledge acceptance; completion arrives by broadcast.
export function completeCreate(
  client: CompanionClient,
  input: CreateWorktreeInput,
) {
  return complete(client, input, () => client.companionCreateWorktree(input))
}

export function completeDelete(
  client: CompanionClient,
  input: DeleteWorktreeInput,
) {
  return complete(client, input, () => client.companionDeleteWorktree(input))
}

function complete(
  client: CompanionClient,
  input: DeleteWorktreeInput,
  start: () => Promise<WorktreeSnapshot>,
): Promise<WorktreeSnapshot> {
  return new Promise((resolveResult, reject) => {
    let accepted: WorktreeSnapshot | undefined
    let latest: WorktreeSnapshot | undefined
    const timer = setTimeout(
      () => finish(new Error('Worktree operation did not finish.')),
      15_000,
    )
    function finish(error?: unknown, snapshot?: WorktreeSnapshot) {
      clearTimeout(timer)
      client.off('desktopUpdateWorktrees', update)
      if (error) reject(error)
      else resolveResult(snapshot!)
    }
    function check() {
      if (!accepted || !latest || latest.revision < accepted.revision) return
      const row = latest.worktrees.find(
        (w) =>
          w.project === input.project &&
          w.path === resolve(input.project, input.path),
      )
      if (row?.operation) return
      finish(row?.error ? new Error(row.error) : undefined, latest)
    }
    function update(value: WorktreeSnapshot) {
      latest = value
      check()
    }
    client.on('desktopUpdateWorktrees', update)
    void start().then(
      (snapshot) => {
        accepted = snapshot
        if (!latest || latest.revision < snapshot.revision) latest = snapshot
        check()
      },
      (error: unknown) => finish(error),
    )
  })
}

import { Flex, Spinner, Text } from '@radix-ui/themes'
import type { RunningWorktree } from '../../src/shared/editor-rpc'

export function WorktreeList({
  worktrees,
  onOpenWorktree,
}: {
  worktrees: RunningWorktree[] | undefined
  onOpenWorktree: (path: string) => void
}) {
  if (!worktrees?.length) return null
  return (
    <nav aria-label="Running worktrees">
      <ul className="worktrees">
        {worktrees.map((worktree) => {
          // Matches the picker's status and availability for each row.
          const status = worktree.deleting
            ? 'Deleting worktree'
            : `VS Code Server ${worktree.state}`
          return (
            <li key={worktree.path}>
              <Flex asChild align="center" gap="2" px="4" py="1">
                <button
                  type="button"
                  className="worktree-open"
                  disabled={worktree.deleting || worktree.state === 'stopping'}
                  onClick={() => onOpenWorktree(worktree.path)}
                  title={worktree.path}
                >
                  <span
                    className="worktree-status"
                    role="img"
                    aria-label={status}
                    title={status}
                  >
                    {worktree.deleting || worktree.state !== 'running' ? (
                      <Spinner size="1" aria-hidden="true" />
                    ) : (
                      <span className="worktree-dot" />
                    )}
                  </span>
                  <Text size="2" weight="medium" className="worktree-field">
                    {worktree.basename}
                  </Text>
                  <Text
                    size="2"
                    color="gray"
                    className="worktree-field worktree-branch"
                  >
                    {worktree.branchName ?? 'Detached HEAD'}
                  </Text>
                </button>
              </Flex>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

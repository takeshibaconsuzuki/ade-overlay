import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WorktreeOrder } from '../src/desktop/picker/worktree-order'
import type { VscodeServerStatus, Worktree } from '../src/shared/api'

function worktree(
  name: string,
  state: VscodeServerStatus['state'] = 'stopped',
  path = `/repo/${name}`,
): Worktree {
  return {
    path,
    basename: name,
    branchName: name,
    mainWorktreePath: '/repo',
    deleting: false,
    vscode: { path, state },
  }
}

test('stopped worktrees sort by name and path regardless of open recency', () => {
  const order = new WorktreeOrder()
  const a = worktree('a')
  const b = worktree('b')
  const otherA = worktree('a', 'stopped', '/other/a')
  const input = [b, a, otherA]
  order.recordOpen(a.path)
  order.recordOpen(b.path)
  assert.deepEqual(order.sort(input), [otherA, a, b])
  assert.deepEqual(input, [b, a, otherA])
})

test('all non-stopped states precede stopped worktrees in most recent open order', () => {
  const order = new WorktreeOrder()
  const stopped = worktree('a')
  const starting = worktree('z', 'starting')
  const running = worktree('y', 'running')
  const stopping = worktree('x', 'stopping')
  const unseen = worktree('b', 'running')
  const input = [stopped, starting, running, stopping, unseen]
  order.recordOpen(starting.path)
  order.recordOpen(running.path)
  order.recordOpen(stopping.path)
  assert.deepEqual(order.sort(input), [
    stopping,
    running,
    starting,
    unseen,
    stopped,
  ])
  order.recordOpen(starting.path)
  assert.deepEqual(order.sort(input), [
    starting,
    stopping,
    running,
    unseen,
    stopped,
  ])
  const stoppedZ = worktree('z')
  assert.deepEqual(order.sort([stoppedZ, running, stopped]), [
    running,
    stopped,
    stoppedZ,
  ])
  assert.deepEqual(order.sort([]), [])
  assert.deepEqual(order.sort(input), [
    starting,
    stopping,
    running,
    unseen,
    stopped,
  ])
})

import assert from 'node:assert/strict'
import childProcess, {
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'
import { dirname } from 'node:path'
import { ProcessVscodeServerFactory } from '../src/server/vscode-server'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { WorktreeStore } from '../src/server/worktree-store'
import { listWorktrees } from '../src/server/git-utils'

test(
  'shutdown terminates every running Git subprocess before completing',
  { timeout: 5000 },
  async (t) => {
    const spawn = childProcess.spawn
    const children: ChildProcess[] = []
    // Substitute long-running children for Git to exercise the real simple-git abort path.
    t.mock.method(
      childProcess,
      'spawn',
      (command: string, args: string[], options: SpawnOptions) => {
        assert.equal(command, 'git')
        assert.deepEqual(args, ['worktree', 'list', '--porcelain', '-z'])
        const child = spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          options,
        )
        children.push(child)
        return child
      },
    )
    syncBuiltinESMExports()
    const store = new WorktreeStore(
      [
        { mainWorktreePath: process.cwd() },
        { mainWorktreePath: dirname(process.cwd()) },
      ],
      new ProcessVscodeServerFactory(
        {
          dataDirectory: '',
          prepare: async () => ({ node: '', entrypoint: '' }),
        },
        {
          launch: async () => {
            throw new Error('Unexpected launch')
          },
        },
      ),
    )
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL')
      }
      await store.close()
      t.mock.restoreAll()
      syncBuiltinESMExports()
    })
    const result = assert.rejects(store.queueRefresh(), /store closed/)
    while (children.length < 2)
      await new Promise<void>((resolve) => setImmediate(resolve))
    let terminated = 0
    const exited = children.map(async (child) => {
      await once(child, 'close')
      terminated++
    })
    await store.close()
    assert.equal(terminated, 2)
    await Promise.all([result, ...exited])
    assert.deepEqual(store.snapshot, [])
  },
)

test('discovery rejects an already cancelled scan without spawning Git', async (t) => {
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    throw new Error('Unexpected spawn')
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  await assert.rejects(
    listWorktrees(
      [{ mainWorktreePath: process.cwd() }],
      AbortSignal.abort(new Error('cancelled')),
    ),
    /cancelled/,
  )
  assert.equal(spawn.mock.callCount(), 0)
})

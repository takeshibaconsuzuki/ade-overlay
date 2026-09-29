import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { EditorNavigation } from '../../src/main/editor-navigation.ts'
import type {
  EditorSession,
  OpenEditorInput,
  SetWorktreeErrorInput,
} from '../../src/shared/companion.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const worktree = (path: string) => ({ project: 'project', path })
const session: EditorSession = {
  id: 'a'.repeat(64),
  accessToken: 'b'.repeat(64),
}
const baseline = 'previous-activation'
type Page = { chatActivation(): Promise<string | null> }
type Source = 'picker' | 'chat'

function fixture() {
  const starts: (ReturnType<typeof deferred<EditorSession>> & {
    input: OpenEditorInput
    signal?: AbortSignal
  })[] = []
  const pages: (ReturnType<typeof deferred<Page>> & {
    editor: EditorSession
    input: OpenEditorInput
  })[] = []
  const errors: (ReturnType<typeof deferred<void>> & {
    input: SetWorktreeErrorInput
  })[] = []
  const replies: {
    id: string
    error?: string
    activationAfter?: string | null
  }[] = []
  let activationReads = 0
  const page = {
    chatActivation: async () => {
      activationReads++
      return baseline
    },
  }
  const navigation = new EditorNavigation(
    {
      openEditor: (input, signal) => {
        // Deliberately allow replies after abort to exercise stale completions,
        // including replies already delivered when navigation is cancelled.
        const request = { input, signal, ...deferred<EditorSession>() }
        starts.push(request)
        return request.promise
      },
      chatViewReady: (id, error, activationAfter) => {
        replies.push({ id, error, activationAfter })
      },
    },
    {
      open: (editor, input) => {
        const request = { editor, input, ...deferred<Page>() }
        pages.push(request)
        return request.promise
      },
    },
    {
      setWorktreeError: (input) => {
        const request = { input, ...deferred<void>() }
        errors.push(request)
        return request.promise
      },
    },
  )
  return {
    navigation,
    starts,
    pages,
    errors,
    replies,
    page,
    activationReads: () => activationReads,
    open: (source: Source, path: string) =>
      source === 'picker'
        ? navigation.openWorktree(worktree(path))
        : navigation.openChat(path, worktree(path)),
    ready: async (index: number) => {
      starts[index].resolve(session)
      await setImmediate()
      pages.at(-1)!.resolve(page)
    },
  }
}

test('picker completion waits for its page without reading chat activation', async () => {
  const f = fixture()
  let completed = false
  const opening = f.open('picker', 'a').then(() => {
    completed = true
  })
  f.starts[0].resolve(session)
  await setImmediate()
  assert.equal(completed, false)
  assert.deepEqual(f.pages[0].input, worktree('a'))
  assert.equal(f.pages[0].editor, session)
  f.pages[0].resolve(f.page)
  await opening
  assert.equal(f.activationReads(), 0)
  assert.deepEqual(f.replies, [])
  assert.deepEqual(f.errors, [])
})

for (const older of ['picker', 'chat'] as const) {
  for (const newer of ['picker', 'chat'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      test(`${newer} supersedes ${older} during startup and ignores late ${outcome}`, async () => {
        const f = fixture()
        const first = f.open(older, 'older')
        const second = f.open(newer, 'newer')
        assert.equal(f.starts[0].signal?.aborted, true)
        assert.equal(f.starts[1].signal?.aborted, false)
        await f.ready(1)
        await second
        if (outcome === 'success') f.starts[0].resolve(session)
        else f.starts[0].reject(new Error('Obsolete startup failure'))
        await first
        assert.deepEqual(
          f.pages.map(({ input }) => input.path),
          ['newer'],
        )
        assert.deepEqual(f.errors, [])
        assert.deepEqual(f.replies, [
          ...(older === 'chat'
            ? [
                {
                  id: 'older',
                  error: 'Navigation was superseded.',
                  activationAfter: undefined,
                },
              ]
            : []),
          ...(newer === 'chat'
            ? [{ id: 'newer', error: undefined, activationAfter: baseline }]
            : []),
        ])
      })
    }

    test(`${newer} supersedes ${older} during page loading and suppresses obsolete failure`, async () => {
      const f = fixture()
      const first = f.open(older, 'older')
      f.starts[0].resolve(session)
      await setImmediate()
      const second = f.open(newer, 'newer')
      await f.ready(1)
      await second
      f.pages[0].reject(new Error('Obsolete page failure'))
      await first
      assert.deepEqual(f.errors, [])
      assert.equal(
        f.replies.some(({ error }) => error?.includes('Obsolete')),
        false,
      )
      assert.equal(f.activationReads(), newer === 'chat' ? 1 : 0)
    })
  }
}

for (const phase of ['startup', 'page', 'activation'] as const) {
  for (const outcome of ['success', 'failure'] as const) {
    test(`chat completion during ${phase} suppresses late ${outcome}`, async () => {
      const f = fixture()
      const opening = f.open('chat', 'a')
      const activation = deferred<string | null>()
      if (phase !== 'startup') {
        f.starts[0].resolve(session)
        await setImmediate()
      }
      if (phase === 'activation') {
        f.pages[0].resolve({ chatActivation: () => activation.promise })
        await setImmediate()
      }
      f.navigation.finishChat('a')
      assert.equal(f.starts[0].signal?.aborted, true)
      if (outcome === 'failure') {
        const pending =
          phase === 'startup'
            ? f.starts[0]
            : phase === 'page'
              ? f.pages[0]
              : activation
        pending.reject(new Error('Obsolete failure'))
      } else if (phase === 'startup') f.starts[0].resolve(session)
      else if (phase === 'page') f.pages[0].resolve(f.page)
      else activation.resolve(baseline)
      await opening
      assert.equal(f.pages.length, phase === 'startup' ? 0 : 1)
      assert.deepEqual(f.errors, [])
      assert.deepEqual(f.replies, [])
    })
  }
}

for (const source of ['picker', 'chat'] as const) {
  test(`late completion of an old chat leaves newer ${source} navigation current`, async () => {
    const f = fixture()
    const first = f.open('chat', 'older')
    await f.ready(0)
    await first
    const second = f.open(source, 'newer')
    f.navigation.finishChat('older')
    assert.equal(f.starts[1].signal?.aborted, false)
    await f.ready(1)
    await second
    assert.equal(f.pages[1].input.path, 'newer')
    if (source === 'chat') {
      assert.equal(f.replies.at(-1)?.activationAfter, baseline)
      f.navigation.finishChat('newer')
      assert.equal(f.starts[1].signal?.aborted, true)
    }
  })

  test(`disconnect invalidates ${source} work and a reconnect can open again`, async () => {
    const f = fixture()
    const first = f.open(source, 'old-connection')
    f.starts[0].resolve(session)
    await setImmediate()
    f.navigation.cancelSelectionRequest()
    const second = f.open(source, 'new-connection')
    await f.ready(1)
    await second
    f.pages[0].reject(new Error('Disconnected page'))
    await first
    assert.equal(f.starts[0].signal?.aborted, true)
    assert.deepEqual(f.errors, [])
    assert.equal(
      f.replies.some(({ error }) => error === 'Disconnected page'),
      false,
    )
  })
}

for (const phase of ['startup', 'page'] as const) {
  for (const persistence of ['success', 'failure'] as const) {
    test(`picker reports ${phase} errors and handles persistence ${persistence}`, async () => {
      const f = fixture()
      const error = new Error('Original failure ' + 'x'.repeat(4096))
      const opening = f.open('picker', 'a')
      const completion =
        persistence === 'failure'
          ? assert.rejects(opening, (value) => value === error)
          : opening
      if (phase === 'startup') f.starts[0].reject(error)
      else {
        f.starts[0].resolve(session)
        await setImmediate()
        f.pages[0].reject(error)
      }
      await setImmediate()
      assert.deepEqual(f.errors[0].input, {
        ...worktree('a'),
        error: error.message.slice(0, 4096),
      })
      if (persistence === 'success') f.errors[0].resolve()
      else f.errors[0].reject(new Error('Could not save row error'))
      await completion
      assert.deepEqual(f.replies, [])
    })
  }
}

test('supersession while saving a picker error suppresses a late local fallback', async () => {
  const f = fixture()
  const first = f.open('picker', 'older')
  f.starts[0].reject(new Error('Original startup failure'))
  await setImmediate()
  const second = f.open('chat', 'newer')
  f.errors[0].reject(new Error('Could not save row error'))
  await first
  await f.ready(1)
  await second
  assert.equal(f.replies.at(-1)?.activationAfter, baseline)
})

test('chat reports startup and activation errors only to its source', async () => {
  const f = fixture()
  const startup = f.open('chat', 'startup')
  f.starts[0].reject(new Error('Server startup failed'))
  await startup
  assert.equal(f.replies.at(-1)?.error, 'Server startup failed')
  const activation = f.open('chat', 'activation')
  f.starts[1].resolve(session)
  await setImmediate()
  f.pages[0].resolve({
    chatActivation: async () => {
      throw new Error('Activation unavailable')
    },
  })
  await activation
  assert.equal(f.replies.at(-1)?.error, 'Activation unavailable')
  assert.deepEqual(f.errors, [])
})

test('chat page failure reaches the source without waiting for row persistence', async () => {
  const f = fixture()
  const opening = f.open('chat', 'a')
  f.starts[0].resolve(session)
  await setImmediate()
  f.pages[0].reject(new Error('Page failed'))
  await opening
  assert.deepEqual(f.errors[0].input, {
    ...worktree('a'),
    error: 'Page failed',
  })
  assert.equal(f.replies.at(-1)?.error, 'Page failed')
  f.errors[0].reject(new Error('Could not save row error'))
  await setImmediate()
  assert.equal(f.replies.length, 1)
})

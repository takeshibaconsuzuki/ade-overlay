import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { EditorNavigation } from '../../src/main/editor-navigation.ts'
import type {
  EditorServerSession,
  WorktreeRef,
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
const session: EditorServerSession = {
  id: 'a'.repeat(64),
  accessToken: 'b'.repeat(64),
}
const baseline = 'previous-activation'
type Page = { chatActivation(): Promise<string | null> }
type Source = 'picker' | 'chat'

function fixture() {
  const starts: (ReturnType<typeof deferred<EditorServerSession>> & {
    input: WorktreeRef
    signal?: AbortSignal
  })[] = []
  const pages: (ReturnType<typeof deferred<Page>> & {
    editor: EditorServerSession
    input: WorktreeRef
  })[] = []
  const opens: { input: WorktreeRef; finished: boolean; error?: string }[] = []
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
      companionStartEditorServer: (input, signal) => {
        // Deliberately allow replies after abort to exercise stale completions,
        // including replies already delivered when navigation is cancelled.
        const request = { input, signal, ...deferred<EditorServerSession>() }
        starts.push(request)
        return request.promise
      },
      desktopOpenChatResponse: (id, error, activationAfter) => {
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
      startOpen: (input) => {
        const open: (typeof opens)[number] = { input, finished: false }
        opens.push(open)
        return (error) => {
          open.finished = true
          if (error) open.error = error
        }
      },
    },
  )
  return {
    navigation,
    starts,
    pages,
    opens,
    failures: () =>
      opens.flatMap(({ input, error }) => (error ? [{ ...input, error }] : [])),
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
  assert.deepEqual(f.failures(), [])
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
        assert.deepEqual(f.failures(), [])
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

    test(`${newer} supersedes ${older} during page loading and keeps the older page failure on its row`, async () => {
      const f = fixture()
      const first = f.open(older, 'older')
      f.starts[0].resolve(session)
      await setImmediate()
      const second = f.open(newer, 'newer')
      await f.ready(1)
      await second
      f.pages[0].reject(new Error('Obsolete page failure'))
      await first
      assert.deepEqual(f.failures(), [
        { ...worktree('older'), error: 'Obsolete page failure' },
      ])
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
      f.navigation.finishOpenChat('a')
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
      // Only the page's own failure still reaches its row.
      assert.deepEqual(
        f.failures(),
        phase === 'page' && outcome === 'failure'
          ? [{ ...worktree('a'), error: 'Obsolete failure' }]
          : [],
      )
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
    f.navigation.finishOpenChat('older')
    assert.equal(f.starts[1].signal?.aborted, false)
    await f.ready(1)
    await second
    assert.equal(f.pages[1].input.path, 'newer')
    if (source === 'chat') {
      assert.equal(f.replies.at(-1)?.activationAfter, baseline)
      f.navigation.finishOpenChat('newer')
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
    // The open's owner drops a failure that outlives its connection.
    assert.deepEqual(f.failures(), [
      { ...worktree('old-connection'), error: 'Disconnected page' },
    ])
    assert.equal(
      f.replies.some(({ error }) => error === 'Disconnected page'),
      false,
    )
  })
}

for (const phase of ['startup', 'page'] as const) {
  test(`picker ends its open with a ${phase} failure`, async () => {
    const f = fixture()
    const opening = f.open('picker', 'a')
    if (phase === 'startup') f.starts[0].reject(new Error('Original failure'))
    else {
      f.starts[0].resolve(session)
      await setImmediate()
      f.pages[0].reject(new Error('Original failure'))
    }
    await opening
    assert.deepEqual(f.opens, [
      { input: worktree('a'), finished: true, error: 'Original failure' },
    ])
    assert.deepEqual(f.replies, [])
  })
}

test('opening reports whether the page became ready', async () => {
  const f = fixture()
  const loaded = f.open('picker', 'a')
  await f.ready(0)
  assert.equal(await loaded, true)

  const failedStartup = f.open('picker', 'b')
  f.starts[1].reject(new Error('Startup failed'))
  assert.equal(await failedStartup, false)

  const failedPage = f.open('picker', 'c')
  f.starts[2].resolve(session)
  await setImmediate()
  f.pages[1].reject(new Error('Page failed'))
  assert.equal(await failedPage, false)

  const supersededStartup = f.open('picker', 'd')
  const supersededPage = f.open('picker', 'e')
  f.starts[3].resolve(session)
  assert.equal(await supersededStartup, false)
  f.starts[4].resolve(session)
  await setImmediate()
  const newer = f.open('picker', 'f')
  f.pages[2].resolve(f.page)
  assert.equal(await supersededPage, true)
  await f.ready(5)
  assert.equal(await newer, true)
})

test('a superseded page failure still becomes its row error', async () => {
  const f = fixture()
  const older = f.open('chat', 'older')
  f.starts[0].resolve(session)
  await setImmediate()
  const newer = f.open('picker', 'newer')
  f.pages[0].reject(new Error('Page failed'))
  await older
  assert.deepEqual(f.failures(), [
    { ...worktree('older'), error: 'Page failed' },
  ])
  assert.deepEqual(f.replies, [
    {
      id: 'older',
      error: 'Navigation was superseded.',
      activationAfter: undefined,
    },
  ])
  await f.ready(1)
  await newer
})

test('every open is recorded when it starts and ended when it finishes, whatever its source', async () => {
  const f = fixture()
  const picker = f.open('picker', 'a')
  assert.deepEqual(f.opens, [{ input: worktree('a'), finished: false }])
  const chat = f.open('chat', 'b')
  f.starts[0].resolve(session)
  await picker
  assert.deepEqual(f.opens, [
    { input: worktree('a'), finished: true },
    { input: worktree('b'), finished: false },
  ])
  await f.ready(1)
  await chat
  assert.equal(f.opens[1].finished, true)
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
  assert.deepEqual(f.failures(), [])
})

test('chat page failure reaches both its source and its row', async () => {
  const f = fixture()
  const opening = f.open('chat', 'a')
  f.starts[0].resolve(session)
  await setImmediate()
  f.pages[0].reject(new Error('Page failed'))
  await opening
  assert.deepEqual(f.failures(), [{ ...worktree('a'), error: 'Page failed' }])
  assert.deepEqual(f.replies, [
    { id: 'a', error: 'Page failed', activationAfter: undefined },
  ])
})

import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { promisify } from 'node:util'
import {
  request as playwrightRequest,
  type APIRequestContext,
} from 'playwright'
import { APP_FOCUS_PATH } from '../../src/api/server/appFocus'
import { CHAT_HOOKS_PATH } from '../../src/api/server/chats'
import { OPENAPI_PATH } from '../../src/api/server/config'
import { getAppConfigPath } from '../../src/server/config/store'
import { createServer } from '../../src/server/server'

const execFileAsync = promisify(execFile)

let tempDir: string
let server: ReturnType<typeof createServer>
let api: APIRequestContext
let baseUrl: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ade-overlay-test-'))
  process.env.ADE_OVERLAY_DATA_DIR = join(tempDir, 'data')
  server = createServer()
  await server.listen({ host: '127.0.0.1', port: 0 })
  const address = server.server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)
  baseUrl = `http://127.0.0.1:${address.port}`
  api = await playwrightRequest.newContext({ baseURL: baseUrl })
})

afterEach(async () => {
  await api?.dispose()
  await server?.close()
  delete process.env.ADE_OVERLAY_DATA_DIR
  await rm(tempDir, { recursive: true, force: true })
})

test('serves OpenAPI and validates app focus and log routes', async () => {
  const openApi = await api.get(OPENAPI_PATH)
  assert.equal(openApi.status(), 200)
  const spec = (await openApi.json()) as {
    paths: Record<string, Record<string, { operationId?: string }>>
  }
  assert.equal(spec.paths['/worktrees'].get.operationId, 'listWorktrees')
  assert.equal(spec.paths['/terminals'].post.operationId, 'createTerminal')

  const logs = await api.post('/logs', {
    data: {
      records: [
        {
          source: 'test',
          level: 'info',
          time: Date.now(),
          msg: 'hello from test',
          fields: { target: 'logs' },
        },
      ],
    },
  })
  assert.equal(logs.status(), 200)
  assert.deepEqual(await logs.json(), { received: 1 })

  const focus = await api.post(APP_FOCUS_PATH, {
    data: { role: 'chat', event: 'focused' },
  })
  assert.equal(focus.status(), 200)
  assert.deepEqual(await focus.json(), { ok: true })

  const invalidFocus = await api.post(APP_FOCUS_PATH, {
    data: { role: 'unknown', event: 'focused' },
  })
  assert.equal(invalidFocus.status(), 400)
  assert.equal((await invalidFocus.json()).error, 'REQUEST_VALIDATION_ERROR')
})

test('tracks a real git repository and streams a worktree snapshot', async () => {
  const repoPath = await createGitRepository()

  const added = await api.post('/repositories', {
    data: { repositoryPath: repoPath },
  })
  assert.equal(added.status(), 200)
  const addedBody = (await added.json()) as {
    repository: { mainWorktreePath: string }
    snapshot: { worktrees: Array<{ path: string; branchName?: string }> }
  }
  assert.equal(addedBody.repository.mainWorktreePath, repoPath)
  assert.equal(addedBody.snapshot.worktrees[0].path, repoPath)

  const branches = await api.post('/repositories/branches', {
    data: { mainWorktreePath: repoPath },
  })
  assert.equal(branches.status(), 200)
  assert.deepEqual(await branches.json(), { branches: ['main'] })

  const snapshot = await readFirstSseEvent<{
    repositories: Array<{ mainWorktreePath: string }>
    worktrees: Array<{ path: string; branchName?: string }>
  }>('/worktrees')
  assert.equal(snapshot.event, 'snapshot')
  assert.equal(snapshot.data.repositories[0].mainWorktreePath, repoPath)
  assert.equal(snapshot.data.worktrees[0].branchName, 'main')
})

test('reloads tracked repositories when config.json changes', async () => {
  const repoPath = await createGitRepository()
  const stream = await openSseStream('/worktrees')

  try {
    const initial = await stream.next<{
      repositories: Array<{ mainWorktreePath: string }>
    }>()
    assert.equal(initial.event, 'snapshot')
    assert.deepEqual(initial.data.repositories, [])

    const configPath = getAppConfigPath()
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      `${JSON.stringify({
        repositories: [{ mainWorktreePath: repoPath }],
      })}\n`,
      'utf8',
    )

    const reloaded = await stream.next<{
      repositories: Array<{ mainWorktreePath: string }>
      worktrees: Array<{ path: string; branchName?: string }>
    }>()
    assert.equal(reloaded.event, 'snapshot')
    assert.equal(reloaded.data.repositories[0].mainWorktreePath, repoPath)
    assert.equal(reloaded.data.worktrees[0].path, repoPath)
    assert.equal(reloaded.data.worktrees[0].branchName, 'main')
  } finally {
    stream.close()
  }
})

test('maps provider hooks into live chat snapshots', async () => {
  const hook = await api.post(
    `${CHAT_HOOKS_PATH}/claude?worktreeId=bbbbbbbbbbbb`,
    {
      data: {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'session-1',
        prompt: 'Investigate failing test\nwith details',
      },
    },
  )
  assert.equal(hook.status(), 200)
  assert.deepEqual(await hook.json(), { ok: true })

  const snapshot = await readFirstSseEvent<{
    chats: Array<{
      chatId: string
      providerId: string
      status: string
      description?: string
      worktreeId?: string
      updatedAt: number
    }>
  }>('/chats/live')
  assert.equal(snapshot.event, 'snapshot')
  assert.deepEqual(snapshot.data.chats, [
    {
      chatId: 'session-1',
      providerId: 'claude',
      status: 'busy',
      description: 'Investigate failing test',
      worktreeId: 'bbbbbbbbbbbb',
      updatedAt: snapshot.data.chats[0].updatedAt,
    },
  ])
})

async function createGitRepository(): Promise<string> {
  const repoPath = join(tempDir, 'repo')
  await execFileAsync('git', ['init', '--initial-branch=main', repoPath])
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repoPath,
  })
  await execFileAsync('git', ['config', 'user.name', 'Test User'], {
    cwd: repoPath,
  })
  await writeFile(join(repoPath, 'README.md'), '# Test repo\n', 'utf8')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoPath })
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoPath })
  return realpath(repoPath)
}

async function readFirstSseEvent<T>(
  path: string,
): Promise<{ event: string | null; data: T }> {
  const stream = await openSseStream(path)
  try {
    return await stream.next<T>()
  } finally {
    stream.close()
  }
}

function parseSseEvent<T>(rawEvent: string): { event: string | null; data: T } {
  const event =
    rawEvent
      .split('\n')
      .find((line) => line.startsWith('event:'))
      ?.slice('event:'.length)
      .trim() ?? null
  const data = rawEvent
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n')
  assert.ok(data)
  return { event, data: JSON.parse(data) as T }
}

async function openSseStream(path: string): Promise<{
  next: <T>() => Promise<{ event: string | null; data: T }>
  close: () => void
}> {
  const controller = new AbortController()
  const response = await fetch(`${baseUrl}${path}`, {
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  assert.ok(response.body)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let closed = false

  return {
    next: async <T>() => {
      while (!closed) {
        const eventEnd = buffer.indexOf('\n\n')
        if (eventEnd >= 0) {
          const rawEvent = buffer.slice(0, eventEnd)
          buffer = buffer.slice(eventEnd + 2)
          return parseSseEvent<T>(rawEvent)
        }

        const { done, value } = await readWithTimeout(
          reader,
          5_000,
          `Timed out waiting for ${path} SSE event`,
        )
        if (done) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
      }

      throw new Error(`SSE stream closed before ${path} event arrived`)
    },
    close: () => {
      if (closed) {
        return
      }
      closed = true
      void reader.cancel().catch(() => undefined)
      controller.abort()
      try {
        reader.releaseLock()
      } catch {
        // Closing an aborted fetch can leave the reader mid-error; cleanup is
        // best-effort in tests because the controller already owns teardown.
      }
    },
  }
}

async function readWithTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  timeoutMs: number,
  message: string,
): Promise<ReadableStreamReadResult<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message))
    }, timeoutMs)

    reader.read().then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

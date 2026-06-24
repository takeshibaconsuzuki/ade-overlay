import { strict as assert } from 'node:assert'
import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { promisify } from 'node:util'
import {
  request as playwrightRequest,
  type APIRequestContext,
} from 'playwright'
import { APP_FOCUS_PATH } from '../../src/api/server/appFocus'
import {
  CHAT_COMMAND_STREAM_PATH,
  CHAT_EVENT_TYPE,
  CHAT_HOOKS_PATH,
  CHAT_STATUS,
} from '../../src/api/server/chats'
import { OPENAPI_PATH } from '../../src/api/server/config'
import { shouldCloseWorktreesWindowOnBlur } from '../../src/main/controller/worktreesWindowPolicy'
import {
  ensureHookForwarderWrapper,
  hookForwardCommand,
} from '../../src/server/chats/hookForwarder'
import { ClaudeChatProvider } from '../../src/server/chats/providers/claude'
import { CodexChatProvider } from '../../src/server/chats/providers/codex'
import { ChatRegistry } from '../../src/server/chats/registry'
import { ChatService } from '../../src/server/chats/service'
import { getAppConfigPath } from '../../src/server/config/store'
import { createServer } from '../../src/server/server'
import {
  resolveChatTerminalSpawn,
  TerminalManager,
  type TerminalManagerChange,
} from '../../src/server/terminals/manager'

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
    snapshot: {
      worktrees: Array<{ name: string; path: string; branchName?: string }>
    }
  }
  assert.equal(addedBody.repository.mainWorktreePath, repoPath)
  assert.equal(addedBody.snapshot.worktrees[0].name, 'repo')
  assert.equal(addedBody.snapshot.worktrees[0].path, repoPath)

  const branches = await api.post('/repositories/branches', {
    data: { mainWorktreePath: repoPath },
  })
  assert.equal(branches.status(), 200)
  assert.deepEqual(await branches.json(), { branches: ['main'] })

  const snapshot = await readFirstSseEvent<{
    repositories: Array<{ mainWorktreePath: string }>
    worktrees: Array<{ name: string; path: string; branchName?: string }>
  }>('/worktrees')
  assert.equal(snapshot.event, 'snapshot')
  assert.equal(snapshot.data.repositories[0].mainWorktreePath, repoPath)
  assert.equal(snapshot.data.worktrees[0].name, 'repo')
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
  const hook = await api.post(`${CHAT_HOOKS_PATH}/claude`, {
    data: {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-1',
      prompt: 'Investigate failing test\nwith details',
    },
  })
  assert.equal(hook.status(), 200)
  assert.deepEqual(await hook.json(), { ok: true })

  const snapshot = await readFirstSseEvent<{
    chats: Array<{
      chatId: string
      providerId: string
      status: string
      description?: string
      updatedAt: number
    }>
  }>('/chats/live')
  assert.equal(snapshot.event, 'snapshot')
  // Claude descriptions are read from the transcript, never the prompt payload,
  // so a hook with no `transcript_path` yields a chat with no description.
  assert.deepEqual(snapshot.data.chats, [
    {
      chatId: 'session-1',
      providerId: 'claude',
      status: 'busy',
      updatedAt: snapshot.data.chats[0].updatedAt,
    },
  ])
})

test('maps no-query hooks using the resolved hook cwd worktree', async () => {
  const logger = { info() {}, warn() {}, debug() {}, error() {} } as never
  const registry = new ChatRegistry(logger, [new CodexChatProvider(logger)])
  let forwardedCwd: string | undefined
  registry.setTerminalSessionBinder(
    (_providerId, _worktreeId, _chatId, _hookAncestorPids, hookCwd) => {
      forwardedCwd = hookCwd
      return 'worktree-from-cwd'
    },
  )

  await registry.applyHook('codex', {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session-1',
    prompt: 'hello',
    _ade_overlay: {
      hook_cwd: '/repo/worktrees/feature',
    },
  })

  assert.equal(forwardedCwd, '/repo/worktrees/feature')
  assert.equal(registry.getSnapshot().chats[0].worktreeId, 'worktree-from-cwd')
})

test('does not surface a live chat from session start alone', async () => {
  const hook = await api.post(`${CHAT_HOOKS_PATH}/claude`, {
    data: {
      hook_event_name: 'SessionStart',
      session_id: 'session-start-only',
    },
  })
  assert.equal(hook.status(), 200)
  assert.deepEqual(await hook.json(), { ok: true })

  const snapshot = await readFirstSseEvent<{
    chats: Array<{
      chatId: string
      providerId: string
      status: string
    }>
  }>('/chats/live')
  assert.equal(snapshot.event, 'snapshot')
  assert.deepEqual(snapshot.data.chats, [])
})

test('does not create a dormant chat from session end alone', async () => {
  const start = await api.post(`${CHAT_HOOKS_PATH}/claude`, {
    data: {
      hook_event_name: 'SessionStart',
      session_id: 'session-start-end-only',
    },
  })
  assert.equal(start.status(), 200)
  assert.deepEqual(await start.json(), { ok: true })

  const end = await api.post(`${CHAT_HOOKS_PATH}/claude`, {
    data: {
      hook_event_name: 'SessionEnd',
      session_id: 'session-start-end-only',
    },
  })
  assert.equal(end.status(), 200)
  assert.deepEqual(await end.json(), { ok: true })

  const snapshot = await readFirstSseEvent<{
    chats: Array<{
      chatId: string
      providerId: string
      status: string
    }>
  }>('/chats/live')
  assert.equal(snapshot.event, 'snapshot')
  assert.deepEqual(snapshot.data.chats, [])
})

test('finds a terminal by hook process ancestry', () => {
  const manager = new TerminalManager({
    info() {},
    warn() {},
    debug() {},
    error() {},
  } as never)
  const terminals = (
    manager as unknown as { terminals: Map<string, Record<string, unknown>> }
  ).terminals
  terminals.set('terminal-1', {
    id: 'terminal-1',
    worktreeId: 'worktree-1',
    status: 'running',
    pty: { pid: 101 },
  })
  terminals.set('terminal-2', {
    id: 'terminal-2',
    worktreeId: 'worktree-1',
    status: 'running',
    pty: { pid: 202 },
  })

  assert.deepEqual(manager.terminalForHookProcess([303, 202, 1]), {
    terminalId: 'terminal-2',
    worktreeId: 'worktree-1',
    title: undefined,
    status: 'running',
  })
})

test('wraps chat launch with preChatCommand in the same shell', () => {
  if (process.platform === 'win32') {
    return
  }

  const originalShell = process.env.SHELL
  process.env.SHELL = '/bin/zsh'

  try {
    const target = resolveChatTerminalSpawn(
      'claude',
      ['--resume', "session'1"],
      'source .venv/bin/activate\nexport FOO=bar',
    )

    assert.equal(target.file, '/bin/zsh')
    assert.equal(target.args[0], '-lic')
    assert.equal(
      target.args[1],
      `source .venv/bin/activate
export FOO=bar
__ade_pre_chat_status=$?
if [ "$__ade_pre_chat_status" -ne 0 ]; then
  exit "$__ade_pre_chat_status"
fi
exec 'claude' '--resume' 'session'\\''1'`,
    )
  } finally {
    if (originalShell === undefined) {
      delete process.env.SHELL
    } else {
      process.env.SHELL = originalShell
    }
  }
})

test('launches Windows chat commands through PowerShell profile', () => {
  if (process.platform !== 'win32') {
    return
  }

  const target = resolveChatTerminalSpawn('claude', ['--resume', 'session-1'])

  assert.equal(target.file, 'powershell.exe')
  assert.deepEqual(target.args, [
    '-NoLogo',
    '-Command',
    "& {\n$global:LASTEXITCODE = $null\r\n& 'claude' '--resume' 'session-1'\n$__ade_success = $?\n$__ade_status = $global:LASTEXITCODE\nif ($null -ne $__ade_status) { exit $__ade_status }\nif (-not $__ade_success) { exit 1 }\n}",
  ])
})

test('worktrees window stays open while its native picker owns focus', () => {
  assert.equal(
    shouldCloseWorktreesWindowOnBlur({ hasOpenNativeDialog: true }),
    false,
  )
  assert.equal(
    shouldCloseWorktreesWindowOnBlur({ hasOpenNativeDialog: false }),
    true,
  )
})

test('codex chat launches with sandbox and approval flags', () => {
  const provider = new CodexChatProvider({
    info() {},
    warn() {},
    debug() {},
    error() {},
  } as never)

  assert.deepEqual(provider.newLaunch(), {
    command: 'codex',
    args: ['-s', 'danger-full-access', '-a', 'never'],
  })
  assert.deepEqual(provider.resumeLaunch('session-1'), {
    command: 'codex',
    args: ['-s', 'danger-full-access', '-a', 'never', 'resume', 'session-1'],
    chatId: 'session-1',
  })
})

test('reports terminal identity when a terminal is closed', () => {
  const changes: TerminalManagerChange[] = []
  const manager = new TerminalManager(
    { info() {}, warn() {}, debug() {}, error() {} } as never,
    (event) => {
      changes.push(event)
    },
  )
  const terminals = (
    manager as unknown as { terminals: Map<string, Record<string, unknown>> }
  ).terminals
  terminals.set('terminal-1', {
    id: 'terminal-1',
    worktreeId: 'worktree-1',
    status: 'running',
    exitCode: null,
    pty: { kill() {} },
  })

  manager.close('terminal-1')

  assert.deepEqual(changes, [
    {
      type: 'removed',
      reason: 'closed',
      terminal: {
        terminalId: 'terminal-1',
        worktreeId: 'worktree-1',
        title: undefined,
        status: 'running',
      },
    },
  ])
})

test('chat service owns chat-to-terminal binding', async () => {
  const logger = { info() {}, warn() {}, debug() {}, error() {} } as never
  const registry = new ChatRegistry(logger, [new CodexChatProvider(logger)])
  const terminalEvents = new EventEmitter()
  const terminals = {
    events: terminalEvents,
    terminalForHookProcess() {
      return {
        terminalId: 'terminal-1',
        worktreeId: 'worktree-1',
        title: 'New codex chat',
        status: 'running',
      }
    },
    list() {
      return [
        {
          terminalId: 'terminal-1',
          worktreeId: 'worktree-1',
          title: 'New codex chat',
          status: 'running',
        },
      ]
    },
  }
  const service = new ChatService(
    registry,
    { events: new EventEmitter() } as never,
    terminals as never,
    logger,
  )
  ;(
    service as unknown as {
      terminalBindings: Map<
        string,
        { providerId: string; worktreeId: string; chatId?: string }
      >
    }
  ).terminalBindings.set('terminal-1', {
    providerId: 'codex',
    worktreeId: 'worktree-1',
  })

  assert.equal(
    await (
      service as unknown as {
        bindChatToTerminal: (
          providerId: string,
          worktreeId: string | undefined,
          chatId: string,
          hookAncestorPids?: number[],
        ) => Promise<string | undefined>
        terminalIdForChat: (
          providerId: string,
          chatId: string,
        ) => string | undefined
      }
    ).bindChatToTerminal('codex', undefined, 'session-1', [101]),
    'worktree-1',
  )
  assert.equal(
    (
      service as unknown as {
        terminalIdForChat: (
          providerId: string,
          chatId: string,
        ) => string | undefined
      }
    ).terminalIdForChat('codex', 'session-1'),
    'terminal-1',
  )
  assert.equal(registry.getSnapshot().chats.length, 0)
})

test('chat service resolves a hook cwd to a worktree', async () => {
  const logger = { info() {}, warn() {}, debug() {}, error() {} } as never
  const registry = new ChatRegistry(logger, [new CodexChatProvider(logger)])
  const terminals = {
    events: new EventEmitter(),
    terminalForHookProcess() {
      return undefined
    },
    list() {
      return []
    },
  }
  let requestedPath: string | undefined
  const service = new ChatService(
    registry,
    {
      events: new EventEmitter(),
      findWorktreeByPath(path: string) {
        requestedPath = path
        return { worktreeId: 'worktree-from-cwd' }
      },
    } as never,
    terminals as never,
    logger,
  )

  assert.equal(
    await (
      service as unknown as {
        bindChatToTerminal: (
          providerId: string,
          worktreeId: string | undefined,
          chatId: string,
          hookAncestorPids?: number[],
          hookCwd?: string,
        ) => Promise<string | undefined>
      }
    ).bindChatToTerminal(
      'codex',
      undefined,
      'session-1',
      undefined,
      '/repo/worktrees/feature/subdir',
    ),
    'worktree-from-cwd',
  )
  assert.equal(requestedPath, '/repo/worktrees/feature/subdir')
})

test('marks live chat dormant when its owned terminal ends', async () => {
  const logger = { info() {}, warn() {}, debug() {}, error() {} } as never
  const registry = new ChatRegistry(logger, [new CodexChatProvider(logger)])
  let terminalRunning = true
  const terminalEvents = new EventEmitter()
  const terminals = {
    events: terminalEvents,
    terminalForHookProcess() {
      return {
        terminalId: 'terminal-1',
        worktreeId: 'worktree-1',
        title: 'New codex chat',
        status: 'running',
      }
    },
    list() {
      return terminalRunning
        ? [
            {
              terminalId: 'terminal-1',
              worktreeId: 'worktree-1',
              title: 'New codex chat',
              status: 'running',
            },
          ]
        : []
    },
  }
  const service = new ChatService(
    registry,
    { events: new EventEmitter() } as never,
    terminals as never,
    logger,
  )
  ;(
    service as unknown as {
      terminalBindings: Map<
        string,
        { providerId: string; worktreeId: string; chatId?: string }
      >
    }
  ).terminalBindings.set('terminal-1', {
    providerId: 'codex',
    worktreeId: 'worktree-1',
  })

  await registry.applyHook(
    'codex',
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-1',
      prompt: 'hello',
      _ade_overlay: {
        hook_ancestor_pids: [101],
      },
    },
    {},
  )
  assert.equal(registry.getSnapshot().chats[0].status, CHAT_STATUS.busy)
  assert.equal(registry.getSnapshot().chats[0].terminalId, 'terminal-1')

  terminalRunning = false
  let dormantEvent:
    | {
        type: string
        chat: { status: string; terminalId?: string }
        snapshot: { chats: Array<{ status: string; terminalId?: string }> }
      }
    | undefined
  registry.events.on('chat-event', (event) => {
    dormantEvent = event as typeof dormantEvent
  })

  terminalEvents.emit('terminal-change', {
    type: 'removed',
    reason: 'exited',
    terminal: {
      terminalId: 'terminal-1',
      worktreeId: 'worktree-1',
      title: 'New codex chat',
      status: 'exited',
    },
  })

  assert.equal(dormantEvent?.type, CHAT_EVENT_TYPE.chatUpdated)
  assert.equal(dormantEvent?.chat.status, CHAT_STATUS.dormant)
  assert.equal(dormantEvent?.chat.terminalId, undefined)
  assert.equal(dormantEvent?.snapshot.chats[0].status, CHAT_STATUS.dormant)
  assert.equal(dormantEvent?.snapshot.chats[0].terminalId, undefined)
})

test('configures Codex user hooks and clears managed project hooks', async () => {
  const home = join(tempDir, 'home')
  const worktreePath = join(tempDir, 'repo')
  const userHooksPath = join(home, '.codex', 'hooks.json')
  const projectHooksPath = join(worktreePath, '.codex', 'hooks.json')
  await mkdir(dirname(userHooksPath), { recursive: true })
  await mkdir(dirname(projectHooksPath), { recursive: true })
  await writeFile(
    userHooksPath,
    `${JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'echo user' }] },
        ],
      },
    })}\n`,
    'utf8',
  )
  await writeFile(
    projectHooksPath,
    `${JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  '/tmp/ade-overlay-chat-hook-codex.sh stale-worktree-id',
              },
            ],
          },
          { hooks: [{ type: 'command', command: 'echo project' }] },
        ],
        Stop: [
          {
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:0/chats/hooks/codex?worktreeId=old',
              },
            ],
          },
        ],
      },
    })}\n`,
    'utf8',
  )

  const originalHome = process.env.HOME
  process.env.HOME = home
  try {
    await new CodexChatProvider({
      info() {},
      warn() {},
      debug() {},
      error() {},
    } as never).configureWorktree({
      worktreeId: 'worktree-1',
      path: worktreePath,
    })
  } finally {
    restoreHome(originalHome)
  }

  const userConfig = JSON.parse(
    await readFile(userHooksPath, 'utf8'),
  ) as Record<string, { UserPromptSubmit: Array<{ hooks: unknown[] }> }>
  const promptHooks = userConfig.hooks.UserPromptSubmit
  assert.equal(promptHooks.length, 2)
  assert.deepEqual(promptHooks[0], {
    hooks: [{ type: 'command', command: 'echo user' }],
  })
  const managedCommand = (promptHooks[1].hooks[0] as { command?: string })
    .command
  assert.ok(managedCommand?.includes('ade-overlay-chat-hook-codex'))
  assert.ok(!managedCommand?.includes('worktree-1'))

  const projectConfig = JSON.parse(
    await readFile(projectHooksPath, 'utf8'),
  ) as Record<string, { UserPromptSubmit?: unknown[]; Stop?: unknown[] }>
  assert.deepEqual(projectConfig.hooks.UserPromptSubmit, [
    { hooks: [{ type: 'command', command: 'echo project' }] },
  ])
  assert.equal(projectConfig.hooks.Stop, undefined)
})

test('configures Claude user hooks and clears managed project hooks', async () => {
  const home = join(tempDir, 'home')
  const worktreePath = join(tempDir, 'repo')
  const userSettingsPath = join(home, '.claude', 'settings.json')
  const projectSettingsPath = join(
    worktreePath,
    '.claude',
    'settings.local.json',
  )
  await mkdir(dirname(userSettingsPath), { recursive: true })
  await mkdir(dirname(projectSettingsPath), { recursive: true })
  await writeFile(
    userSettingsPath,
    `${JSON.stringify({
      theme: 'dark',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo user' }] }],
      },
    })}\n`,
    'utf8',
  )
  await writeFile(
    projectSettingsPath,
    `${JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  '/tmp/ade-overlay-chat-hook-claude.sh stale-worktree-id',
              },
            ],
          },
          { hooks: [{ type: 'command', command: 'echo project' }] },
        ],
      },
    })}\n`,
    'utf8',
  )

  const originalHome = process.env.HOME
  process.env.HOME = home
  try {
    await new ClaudeChatProvider({
      info() {},
      warn() {},
      debug() {},
      error() {},
    } as never).configureWorktree({
      worktreeId: 'worktree-1',
      path: worktreePath,
    })
  } finally {
    restoreHome(originalHome)
  }

  const userSettings = JSON.parse(
    await readFile(userSettingsPath, 'utf8'),
  ) as Record<string, unknown>
  assert.equal(userSettings.theme, 'dark')
  const userHooks = userSettings.hooks as {
    Stop: Array<{ hooks: Array<{ command?: string }> }>
  }
  assert.equal(userHooks.Stop.length, 2)
  assert.deepEqual(userHooks.Stop[0], {
    hooks: [{ type: 'command', command: 'echo user' }],
  })
  assert.ok(
    userHooks.Stop[1].hooks[0].command?.includes(
      'ade-overlay-chat-hook-claude',
    ),
  )
  assert.ok(!userHooks.Stop[1].hooks[0].command?.includes('worktree-1'))

  const projectSettings = JSON.parse(
    await readFile(projectSettingsPath, 'utf8'),
  ) as Record<string, { Stop?: unknown[] }>
  assert.deepEqual(projectSettings.hooks.Stop, [
    { hooks: [{ type: 'command', command: 'echo project' }] },
  ])
})

test('hook forward command augments and posts payload using app Node runtime', async () => {
  let received: Record<string, unknown> | undefined
  let receivedUrl: string | undefined
  const hookServer = createHttpServer((request, response) => {
    receivedUrl = request.url
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
      >
      response.writeHead(200).end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    hookServer.once('error', reject)
    hookServer.listen(0, '127.0.0.1', () => {
      hookServer.off('error', reject)
      resolve()
    })
  })

  try {
    const address = hookServer.address()
    assert.equal(typeof address, 'object')
    assert.ok(address)
    const wrapperPath = await ensureHookForwarderWrapper(
      'test',
      `http://127.0.0.1:${address.port}/hook`,
    )
    const { command } = hookForwardCommand(wrapperPath)
    assert.ok(!command.includes(' -e '))
    assert.ok(command.includes(wrapperPath))
    assert.ok(!command.includes(`127.0.0.1:${address.port}`))
    const payload = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-1',
    })
    await runHookCommand(command, payload)

    assert.equal(received?.hook_event_name, 'UserPromptSubmit')
    assert.equal(received?.session_id, 'session-1')
    assert.equal(receivedUrl, '/hook')
    const metadata = received?._ade_overlay as
      | Record<string, unknown>
      | undefined
    assert.equal(typeof metadata?.hook_pid, 'number')
    assert.equal(typeof metadata?.hook_ppid, 'number')
    assert.equal(typeof metadata?.hook_cwd, 'string')
    assert.ok(Array.isArray(metadata?.hook_ancestor_pids))
    assert.ok(metadata.hook_ancestor_pids.length > 0)
  } finally {
    await new Promise<void>((resolve) => hookServer.close(() => resolve()))
  }
})

test('lists Codex sessions with large session metadata records', async () => {
  const home = join(tempDir, 'home')
  const worktreePath = join(tempDir, 'repo')
  const sessionPath = join(
    home,
    '.codex',
    'sessions',
    '2026',
    '06',
    '19',
    'rollout-large-meta.jsonl',
  )
  await mkdir(dirname(sessionPath), { recursive: true })
  await mkdir(worktreePath, { recursive: true })

  const sessionId = 'codex-large-session'
  const meta = {
    timestamp: '2026-06-20T01:20:12.000Z',
    type: 'session_meta',
    payload: {
      id: sessionId,
      timestamp: '2026-06-20T01:20:12.000Z',
      cwd: worktreePath,
      base_instructions: { text: 'x'.repeat(40_000) },
    },
  }
  const message = {
    timestamp: '2026-06-20T01:20:13.000Z',
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: 'hello from codex history',
    },
  }
  const reply = {
    timestamp: '2026-06-20T01:20:14.000Z',
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: 'latest codex assistant reply',
    },
  }
  await writeFile(
    sessionPath,
    `${JSON.stringify(meta)}\n${JSON.stringify(message)}\n${JSON.stringify(reply)}\n`,
    'utf8',
  )

  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    const provider = new CodexChatProvider({
      info() {},
      warn() {},
      debug() {},
      error() {},
    } as never)

    const chats = await provider.listHistory({
      worktreeId: 'x',
      path: worktreePath,
    })
    assert.equal(chats.length, 1)
    assert.equal(chats[0].chatId, sessionId)
    assert.equal(chats[0].title, 'hello from codex history')
    assert.equal(chats[0].description, 'latest codex assistant reply')
    assert.equal(chats[0].updatedAt, (await stat(sessionPath)).mtimeMs)
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE
    } else {
      process.env.USERPROFILE = originalUserProfile
    }
  }
})

test('refreshes Codex description from latest transcript text', async () => {
  const transcriptPath = join(tempDir, 'codex-transcript.jsonl')
  const entries = [
    {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'first user prompt',
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'assistant progress update',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'assistant final answer',
          },
        ],
      },
    },
  ]
  await writeFile(
    transcriptPath,
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  )

  const provider = new CodexChatProvider({
    info() {},
    warn() {},
    debug() {},
    error() {},
  } as never)

  assert.equal(
    await provider.resolveDescription({ transcript_path: transcriptPath }),
    'assistant final answer',
  )
})

test('opens chat command stream before any command is emitted', async () => {
  const controller = new AbortController()
  try {
    const response = await promiseWithTimeout(
      fetch(`${baseUrl}${CHAT_COMMAND_STREAM_PATH}`, {
        signal: controller.signal,
      }),
      1_000,
      `Timed out opening ${CHAT_COMMAND_STREAM_PATH}`,
    )
    assert.equal(response.status, 200)
    assert.match(
      response.headers.get('content-type') ?? '',
      /^text\/event-stream\b/,
    )
  } finally {
    controller.abort()
  }
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

async function runHookCommand(command: string, input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ['pipe', 'ignore', 'inherit'],
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Hook command exited with code ${code ?? 'unknown'}`))
      }
    })
    child.stdin.end(input)
  })
}

function restoreHome(originalHome: string | undefined): void {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
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
  return promiseWithTimeout(reader.read(), timeoutMs, message)
}

function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message))
    }, timeoutMs)

    promise.then(
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

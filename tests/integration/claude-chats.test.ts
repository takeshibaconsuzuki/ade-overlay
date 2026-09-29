import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  appendFile,
} from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  claudeProvider,
  chatProvider,
} from '../../src/server/chats/chat-providers.ts'
import {
  installChatHooks,
  installProviderHooks,
} from '../../src/server/chats/chat-hooks.ts'
import { readClaudeTitles } from '../../src/server/chats/claude-chat-title.ts'
import { ChatStore } from '../../src/server/chats/chat-store.ts'

const hook = (hook_event_name: string, fields: object = {}) =>
  claudeProvider.activity({ session_id: 'session', hook_event_name, ...fields })

test('Claude maps main-session activity, previews and turn order without subagent interference', () => {
  assert.equal(chatProvider('claude'), claudeProvider)
  for (const event of [
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'PreCompact',
    'PostCompact',
    'ElicitationResult',
  ]) {
    assert.equal(hook(event)?.activity, 'working', event)
  }
  for (const event of [
    'SessionStart',
    'PermissionRequest',
    'Stop',
    'StopFailure',
    'Elicitation',
  ]) {
    assert.equal(hook(event)?.activity, 'idle', event)
  }
  for (const tool_name of ['AskUserQuestion', 'ExitPlanMode'])
    assert.equal(hook('PreToolUse', { tool_name })?.activity, 'idle')
  assert.equal(hook('SessionStart', { source: 'compact' }), undefined)
  assert.equal(hook('PostCompact', { trigger: 'manual' })?.activity, 'idle')
  assert.equal(hook('PostCompact', { trigger: 'auto' })?.activity, 'working')
  assert.equal(
    hook('PostToolUseFailure', { is_interrupt: true })?.activity,
    'idle',
  )
  for (const notification_type of [
    'permission_prompt',
    'idle_prompt',
    'elicitation_dialog',
  ])
    assert.equal(hook('Notification', { notification_type })?.activity, 'idle')
  for (const notification_type of [
    'auth_success',
    'agent_completed',
    undefined,
  ])
    assert.equal(hook('Notification', { notification_type }), undefined)
  for (const event of claudeProvider.events)
    assert.equal(hook(event, { agent_id: 'background' }), undefined)
  for (const event of ['SubagentStop', 'SessionEnd', 'unknown'])
    assert.equal(hook(event), undefined)
  assert.equal(claudeProvider.activity({}), undefined)
  assert.equal(
    hook('Stop', { last_assistant_message: null })?.message,
    undefined,
  )
  assert.equal(
    hook('UserPromptSubmit', { prompt: '  Fix café 中文 🧪  ' })?.message,
    'Fix café 中文 🧪',
  )
  assert.equal(
    hook('Stop', { last_assistant_message: 'x'.repeat(5000) })?.message?.length,
    4000,
  )
  assert.equal(
    hook('PostToolUse', { last_assistant_message: 'ignore' })?.message,
    undefined,
  )
  for (const event of claudeProvider.events)
    assert.equal(
      hook(event)?.turnEvent ?? false,
      ['UserPromptSubmit', 'Stop', 'StopFailure'].includes(event),
      event,
    )
})

test('manual compaction returns to idle while automatic compaction continues the turn', async (t) => {
  const process = { pid: 20, startedAt: 'start' }
  const store = new ChatStore(
    async () =>
      new Map([
        [
          process.pid,
          {
            ...process,
            parentPid: 1,
            name: 'claude',
            command: 'claude',
          },
        ],
      ]),
  )
  t.after(() => store.close())
  let observedAt = 0
  let idle = 0
  store.on('idle', () => idle++)
  const report = async (event: string, fields = {}) => {
    const activity = hook(event, fields)
    if (activity)
      await store.activity(
        'editor',
        { project: '/project', path: '/project/branch' },
        {
          provider: 'claude',
          terminalId: 'terminal',
          process,
          observedAt: ++observedAt,
          ...activity,
        },
      )
  }
  await report('SessionStart')
  // SessionStart must preserve the outcome whichever side of PostCompact it arrives.
  for (const startBeforePost of [true, false]) {
    await report('PreCompact', { trigger: 'manual' })
    assert.equal(store.list().chats[0].activity, 'working')
    if (startBeforePost) await report('SessionStart', { source: 'compact' })
    await report('PostCompact', { trigger: 'manual' })
    if (!startBeforePost) await report('SessionStart', { source: 'compact' })
    assert.equal(store.list().chats[0].activity, 'idle')
  }
  assert.equal(idle, 2)
  await report('UserPromptSubmit', { prompt: 'Continue the task' })
  for (const startBeforePost of [true, false]) {
    await report('PreCompact', { trigger: 'auto' })
    if (startBeforePost) await report('SessionStart', { source: 'compact' })
    await report('PostCompact', { trigger: 'auto' })
    if (!startBeforePost) await report('SessionStart', { source: 'compact' })
    assert.equal(store.list().chats[0].activity, 'working')
  }
  assert.equal(idle, 2, 'automatic compaction must not notify turn completion')
  assert.equal(store.list().chats[0].message, 'Continue the task')
  await report('Stop', { last_assistant_message: 'Finished' })
  assert.equal(store.list().chats[0].activity, 'idle')
  assert.equal(idle, 3)
})

test('Claude recognizes native and npm processes and respects its configuration home', () => {
  const entry = { pid: 1, parentPid: 0, startedAt: 'start' }
  for (const [name, command] of [
    ['claude', '/home/me/.local/bin/claude'],
    ['claude.exe', 'C:\\bin\\claude.exe'],
    ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'],
    ['node.exe', 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
  ])
    assert.equal(claudeProvider.isProcess({ ...entry, name, command }), true)
  for (const [name, command] of [
    ['sh', 'claude'],
    ['node', '/tmp/claude.js'],
    ['codex', 'codex'],
  ])
    assert.equal(claudeProvider.isProcess({ ...entry, name, command }), false)
  assert.equal(
    claudeProvider.hookFile({}),
    join(homedir(), '.claude', 'settings.json'),
  )
  assert.equal(
    claudeProvider.hookFile({ CLAUDE_CONFIG_DIR: '/custom' }),
    join('/custom', 'settings.json'),
  )
  assert.equal(
    claudeProvider.metadataRoot({ CLAUDE_CONFIG_DIR: '/custom' }),
    '/custom',
  )
})

test('setup merges both providers, preserves Claude settings, and executes paths with shell characters verbatim', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ade-claude-hooks-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = {
    CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
  }
  await mkdir(env.CLAUDE_CONFIG_DIR)
  const path = claudeProvider.hookFile(env)
  const userHook = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'user-hook' }],
  }
  await writeFile(
    path,
    JSON.stringify({
      permissions: { deny: ['Read(secret)'] },
      hooks: { PreToolUse: [userHook] },
    }),
  )
  await installChatHooks(env)
  const installed = await readFile(path, 'utf8')
  assert.match(
    await readFile(join(env.CODEX_HOME, 'hooks.json'), 'utf8'),
    /ADE chat activity/,
  )
  const config = JSON.parse(installed)
  assert.deepEqual(config.permissions, { deny: ['Read(secret)'] })
  assert.deepEqual(config.hooks.PreToolUse[0], userHook)
  for (const event of claudeProvider.events)
    assert.equal(
      config.hooks[event].filter(
        (group: { hooks: { statusMessage?: string }[] }) =>
          group.hooks.some(
            (handler) => handler.statusMessage === 'ADE chat activity',
          ),
      ).length,
      1,
    )
  await installChatHooks(env)
  assert.equal(await readFile(path, 'utf8'), installed)
  const reporter = join(root, "owner's $reporter `file`.mjs")
  await writeFile(
    reporter,
    'console.log(JSON.stringify(process.argv.slice(2)))',
  )
  await installProviderHooks(claudeProvider, path, reporter)
  const handler = JSON.parse(await readFile(path, 'utf8')).hooks.Stop[0]
    .hooks[0]
  const result = spawnSync(handler.command, handler.args, { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), ['claude'])
  for (const invalid of ['invalid JSON', '{"hooks":{"Stop":{}}}']) {
    await writeFile(path, invalid)
    await assert.rejects(installProviderHooks(claudeProvider, path, reporter))
    assert.equal(await readFile(path, 'utf8'), invalid)
  }
})

test('Claude SDK preserves renamed titles after transcript growth and refreshes durable metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ade-claude-titles-'))
  const project = join(root, 'projects', '-workspace')
  await mkdir(project, { recursive: true })
  const sessionId = randomUUID()
  const path = join(project, `${sessionId}.jsonl`)
  const line = (entry: object) => JSON.stringify(entry) + '\n'
  await writeFile(
    path,
    line({
      type: 'user',
      sessionId,
      isMeta: true,
      message: { content: 'system context' },
    }) +
      line({
        type: 'user',
        sessionId,
        message: { content: [{ type: 'tool_result', content: 'ignore' }] },
      }) +
      line({
        type: 'user',
        sessionId,
        message: { content: [{ type: 'text', text: 'First prompt 🧪' }] },
      }),
  )
  const entries = new Map([
    [
      20,
      {
        pid: 20,
        parentPid: 1,
        startedAt: 'start',
        name: 'claude',
        command: 'claude',
      },
    ],
  ])
  const store = new ChatStore(async () => entries)
  t.after(async () => {
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  let observedAt = 1
  const report = (event: string, fields = {}) =>
    store.activity(
      'editor',
      { project: '/project', path: '/project/branch' },
      {
        provider: 'claude',
        terminalId: 'terminal',
        metadataRoot: root,
        process: { pid: 20, startedAt: 'start' },
        observedAt: observedAt++,
        ...hook(event, fields)!,
        sessionId,
      },
    )
  await report('SessionStart')
  await store.settled()
  assert.equal(store.list().chats[0].title, 'First prompt 🧪')
  await appendFile(
    path,
    line({
      type: 'ai-title',
      aiTitle: 'Generated title',
      sessionId,
    }),
  )
  await store.refreshTitles()
  assert.equal(store.list().chats[0].title, 'Generated title')
  await appendFile(
    path,
    line({ type: 'assistant', message: { content: 'x'.repeat(200_000) } }),
  )
  await appendFile(
    path,
    line({
      type: 'custom-title',
      customTitle: 'Renamed',
      sessionId,
    }) +
      line({
        type: 'ai-title',
        aiTitle: 'Later generated',
        sessionId,
      }),
  )
  const sidecar = join(project, sessionId, 'custom-title.json')
  await mkdir(join(project, sessionId))
  await writeFile(sidecar, JSON.stringify({ customTitle: 'Renamed' }))
  await store.refreshTitles()
  assert.equal(store.list().chats[0].title, 'Renamed')
  await appendFile(
    path,
    line({ type: 'assistant', message: { content: 'x'.repeat(200_000) } }) +
      '{"type":',
  )
  await store.refreshTitles()
  assert.equal(store.list().chats[0].title, 'Renamed')
  assert.equal(
    (await readClaudeTitles(new Map([[root, new Set([sessionId])]])))
      .get(root)
      ?.get(sessionId),
    'Renamed',
    'a fresh reader also finds the rename outside both transcript windows',
  )
  await writeFile(sidecar, JSON.stringify({ customTitle: '最新の名前' }))
  await store.refreshTitles()
  assert.equal(store.list().chats[0].title, '最新の名前')
  await report('UserPromptSubmit', { prompt: 'Latest prompt' })
  let idle = 0
  store.on('idle', () => idle++)
  await report('Stop', { last_assistant_message: 'Finished' })
  assert.equal(idle, 1)
  assert.equal(store.list().chats[0].message, 'Finished')
  await rm(path)
  await store.refreshTitles()
  assert.equal(store.list().chats[0].title, '最新の名前')
  entries.clear()
  await store.reconcile()
  assert.deepEqual(store.list().chats, [])
  await writeFile(
    join(project, `${sessionId}.jsonl`),
    line({ type: 'user', isSidechain: true, message: { content: 'hidden' } }),
  )
  const titles = await readClaudeTitles(
    new Map([
      [root, new Set(['missing', '../escape', sessionId])],
      ['relative', new Set(['session'])],
    ]),
  )
  assert.equal(titles.get(root)?.size, 0)
  assert.equal(titles.has('relative'), false)
})

test('Claude SDK lookups isolate concurrent provider homes and ignore unavailable sessions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ade-claude-homes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessionId = randomUUID()
  const missing = randomUUID()
  const homes = [join(root, 'first'), join(root, 'second')]
  const originalHome = process.env.CLAUDE_CONFIG_DIR
  for (const [index, home] of homes.entries()) {
    const project = join(home, 'projects', '-workspace')
    await mkdir(project, { recursive: true })
    await writeFile(
      join(project, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        sessionId,
        message: { content: `Home ${index}` },
      }) + '\n',
    )
  }
  const results = await Promise.all(
    homes.map((home) =>
      readClaudeTitles(
        new Map([
          [join(root, 'missing-home'), new Set([sessionId])],
          [home, new Set([sessionId, missing, '../escape'])],
        ]),
      ),
    ),
  )
  for (const [index, home] of homes.entries()) {
    assert.deepEqual(
      results[index].get(home),
      new Map([[sessionId, `Home ${index}`]]),
    )
  }
  assert.equal(process.env.CLAUDE_CONFIG_DIR, originalHome)
})

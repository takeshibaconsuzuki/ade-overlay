import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ClaudeChatProvider } from '../src/server/chat-providers/claude/provider'
import { CLAUDE_CHAT_EVENTS } from '../src/server/chat-providers/claude/report'

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ade claude hooks '$ "))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const entrypoint = join(directory, 'report-chat.mjs')
  await writeFile(entrypoint, '')
  return {
    directory,
    entrypoint,
    path: join(directory, 'settings.json'),
    installer: new ClaudeChatProvider(
      [process.execPath, entrypoint],
      directory,
    ),
  }
}

test('user settings keep other configuration and handlers, and installation is idempotent', async (t) => {
  const { entrypoint, path, installer } = await fixture(t)
  const custom = { type: 'command', command: 'node', args: ['audit.js'] }
  const stale = {
    type: 'command',
    command: '/old/ade-server',
    args: ['--report-chat', 'claude', 'claude', '--ade-overlay'],
  }
  await writeFile(
    path,
    JSON.stringify({
      model: 'opus',
      permissions: { allow: ['Bash(git status)'] },
      hooks: {
        Stop: [{ hooks: [custom, stale] }],
        Notification: [{ matcher: 'permission_prompt', hooks: [stale] }],
      },
    }),
  )
  await installer.install()
  const content = await readFile(path, 'utf8')
  const originalStat = await stat(path)
  const document = JSON.parse(content)
  assert.equal(document.model, 'opus')
  assert.deepEqual(document.permissions, { allow: ['Bash(git status)'] })
  assert.deepEqual(document.hooks.Stop[0], { hooks: [custom] })
  assert.deepEqual(Object.keys(document.hooks), [
    'Stop',
    'Notification',
    ...CLAUDE_CHAT_EVENTS.filter(
      (event) => event !== 'Stop' && event !== 'Notification',
    ),
  ])
  for (const event of CLAUDE_CHAT_EVENTS) {
    const groups = document.hooks[event].filter((group: { hooks: unknown[] }) =>
      JSON.stringify(group).includes(entrypoint),
    )
    assert.deepEqual(groups, [
      {
        ...(event === 'Notification' ? { matcher: 'idle_prompt' } : {}),
        hooks: [
          {
            type: 'command',
            command: process.execPath,
            args: [entrypoint, 'claude', 'claude', '--ade-overlay'],
            timeout: 3,
            async: event !== 'SessionEnd',
          },
        ],
      },
    ])
  }
  assert.equal(JSON.stringify(document).includes('/old/ade-server'), false)
  await installer.install()
  assert.equal(await readFile(path, 'utf8'), content)
  assert.equal((await stat(path)).mtimeMs, originalStat.mtimeMs)
})

test('invalid user settings are preserved', async (t) => {
  const { path, installer } = await fixture(t)
  for (const content of [
    '{broken',
    '{"hooks":{"Stop":null}}',
    '{"hooks":{"Stop":[{"hooks":[{"type":"command","args":"x"}]}]}}',
  ]) {
    await writeFile(path, content)
    await assert.rejects(installer.install())
    assert.equal(await readFile(path, 'utf8'), content)
  }
})

test(
  'the installed handler runs without a shell and forwards the payload with its owning PID',
  { timeout: 15_000 },
  async (t) => {
    const { directory, path, entrypoint } = await fixture(t)
    const received: unknown[] = []
    const server = createServer(async (request, response) => {
      assert.equal(request.url, '/chats/report/claude')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(204).end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(
      () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections()
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    )
    const port = (server.address() as { port: number }).port
    await copyFile(resolve('scripts/report-chat.mjs'), entrypoint)
    await new ClaudeChatProvider(
      [process.execPath, entrypoint],
      directory,
    ).install()
    const handler = JSON.parse(await readFile(path, 'utf8')).hooks
      .UserPromptSubmit[0].hooks[0]
    // A renamed Node executable models Claude Code spawning its exec-form hook.
    const ownerPath = join(
      directory,
      process.platform === 'win32' ? 'claude.exe' : 'claude',
    )
    await copyFile(process.execPath, ownerPath)
    const script = `
      const { spawn } = require('node:child_process');
      // Node names its main thread, which replaces the executable name on Linux.
      process.title = 'claude';
      const [command, args] = JSON.parse(process.argv[1]);
      const child = spawn(command, args, { windowsHide: true, stdio: 'inherit' });
      child.on('exit', code => { process.exitCode = code; });
    `
    const env = {
      ...process.env,
      ADE_CHAT_REPORT_URL: `http://127.0.0.1:${port}/chats/report`,
      ADE_TERMINAL_ID: 'bcf08308-3214-4d40-8a47-ea183fa95752',
    }
    const owner = spawn(
      ownerPath,
      ['-e', script, JSON.stringify([handler.command, handler.args])],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    t.after(() => owner.kill())
    let output = ''
    owner.stdout.on('data', (chunk) => (output += chunk))
    owner.stderr.on('data', (chunk) => (output += chunk))
    const payload = {
      session_id: 'from-claude',
      cwd: directory,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Unicode preserved: café \u{1f680}',
    }
    owner.stdin.end(JSON.stringify(payload))
    const [code] = await once(owner, 'exit')
    assert.equal(code, 0, output)
    assert.equal(output, '')
    assert.deepEqual(received, [
      { ...payload, pid: owner.pid, terminalId: env.ADE_TERMINAL_ID },
    ])
  },
)

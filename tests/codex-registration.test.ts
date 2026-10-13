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
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createServer } from 'node:http'
import { executePowerShell } from 'powershell-utils'
import { CodexChatProvider } from '../src/server/chat-providers/codex/provider'
import { CODEX_CHAT_EVENTS } from '../src/server/chat-providers/codex/report'
import { quotePosixArgument } from '../src/shared/shell'

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ade hooks '))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const entrypoint = join(directory, 'hook.cjs')
  await writeFile(entrypoint, '')
  return {
    directory,
    entrypoint,
    installer: new CodexChatProvider(entrypoint, directory),
  }
}

test('global installation preserves other handlers and is idempotent', async (t) => {
  const { directory, installer } = await fixture(t)
  const path = join(directory, 'hooks.json')
  const custom = { type: 'command', command: 'echo custom', async: true }
  const mcp = { type: 'mcp_tool', server: 'test', tool: 'audit' }
  const group = { matcher: 'startup', hooks: [custom, mcp] }
  await writeFile(
    path,
    JSON.stringify({
      description: 'User hooks',
      hooks: { SessionStart: [group], PostToolUse: [{ hooks: [custom] }] },
    }),
  )
  await installer.install()
  const content = await readFile(path, 'utf8')
  const originalStat = await stat(path)
  const document = JSON.parse(content)
  assert.equal(document.description, 'User hooks')
  assert.deepEqual(document.hooks.SessionStart[0], group)
  assert.deepEqual(document.hooks.PostToolUse, [{ hooks: [custom] }])
  for (const event of CODEX_CHAT_EVENTS)
    assert.equal(document.hooks[event].at(-1).hooks[0].timeout, 3)
  assert.deepEqual(
    Object.fromEntries(
      CODEX_CHAT_EVENTS.map((event) => [
        event,
        document.hooks[event].at(-1).hooks[0].async,
      ]),
    ),
    {
      SessionStart: true,
      UserPromptSubmit: true,
      Stop: true,
      Interrupt: true,
      SessionEnd: false,
    },
  )
  await installer.install()
  assert.equal(await readFile(path, 'utf8'), content)
  assert.equal((await stat(path)).mtimeMs, originalStat.mtimeMs)
})

test('concurrent installation does not duplicate handlers and malformed user files are preserved', async (t) => {
  const { directory, installer } = await fixture(t)
  await Promise.all([installer.install(), installer.install()])
  const path = join(directory, 'hooks.json')
  const hooks = JSON.parse(await readFile(path, 'utf8')).hooks
  for (const event of CODEX_CHAT_EVENTS) assert.equal(hooks[event].length, 1)
  for (const content of ['{broken', '{"hooks":{"Stop":null}}']) {
    await writeFile(path, content)
    await assert.rejects(installer.install())
    assert.equal(await readFile(path, 'utf8'), content)
  }
})

const scenarios = [
  { architecture: process.arch, provider: 'codex', executable: 'codex' },
  {
    architecture: process.arch,
    provider: 'example',
    executable: 'example-agent',
  },
]
if (process.platform === 'win32')
  scenarios.push({
    architecture: 'arm64',
    provider: 'codex',
    executable: 'codex',
  })
for (const { architecture, provider, executable } of scenarios) {
  test(
    `the standalone script forwards the raw ${provider} payload with its owning PID (${architecture})`,
    { timeout: 15_000 },
    async (t) => {
      const directory = await mkdtemp(
        join(tmpdir(), "standalone hook '\u2018\u2019\u201a\u201b$literal` "),
      )
      t.after(() => rm(directory, { recursive: true, force: true }))
      const received: unknown[] = []
      const server = createServer(async (request, response) => {
        assert.equal(request.url, `/chats/report/${provider}`)
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
      const entrypoint = join(directory, 'report-chat.mjs')
      // Change only the hardcoded address in this isolated copy so tests can use an ephemeral port.
      const scriptSource = await readFile(
        resolve('scripts/report-chat.mjs'),
        'utf8',
      )
      await writeFile(
        entrypoint,
        scriptSource.replace(
          'http://127.0.0.1:4317',
          `http://127.0.0.1:${port}`,
        ),
      )
      await new CodexChatProvider(entrypoint, directory).install()
      const handler = JSON.parse(
        await readFile(join(directory, 'hooks.json'), 'utf8'),
      ).hooks.UserPromptSubmit[0].hooks[0]
      const installedCommand =
        process.platform === 'win32' ? handler.commandWindows : handler.command
      const command =
        provider === 'codex'
          ? installedCommand
          : (process.platform === 'win32' ? '& ' : '') +
            [process.execPath, entrypoint, provider, executable]
              .map(
                process.platform === 'win32'
                  ? executePowerShell.escapeArgument
                  : quotePosixArgument,
              )
              .join(' ')
      // A renamed Node executable models Codex launching its hook shell, including the real process table.
      const ownerPath = join(
        directory,
        process.platform === 'win32' ? `${executable}.exe` : executable,
      )
      await copyFile(process.execPath, ownerPath)
      const script = `
    const { spawn } = require('node:child_process');
    const command = process.argv[1];
    // Codex executes Windows hooks through PowerShell.
    const child = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['inherit', 'inherit', 'inherit'] })
      : spawn('/bin/sh', ['-c', command], { stdio: 'inherit' });
    child.on('exit', code => { process.exitCode = code; });
  `
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ADE_TERMINAL_ID: 'bcf08308-3214-4d40-8a47-ea183fa95752',
      }
      if (architecture !== process.arch) {
        // Exercise architecture selection on x64 CI; this does not emulate ARM hardware.
        const preload = join(directory, 'architecture.cjs')
        await writeFile(
          preload,
          `Object.defineProperty(process, 'arch', { value: ${JSON.stringify(architecture)} })`,
        )
        env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`
      }
      const started = performance.now()
      const owner = spawn(ownerPath, ['-e', script, command], {
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      t.after(() => owner.kill())
      let stdout = '',
        stderr = ''
      owner.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      owner.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      const payload = {
        session_id: 'from-shell',
        cwd: directory,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Unicode preserved: caf\u00e9 \u{1f680}',
        custom: { nested: [1, true, null] },
        pid: 1,
        terminalId: 'payload-cannot-override-terminal',
      }
      owner.stdin.end(JSON.stringify(payload))
      const [code] = await once(owner, 'exit')
      t.diagnostic(
        `Hook process completed in ${Math.round(performance.now() - started)} ms`,
      )
      assert.equal(code, 0, stderr)
      assert.equal(stdout, '')
      assert.equal(stderr, '')
      assert.deepEqual(received, [
        { ...payload, pid: owner.pid, terminalId: env.ADE_TERMINAL_ID },
      ])
    },
  )
}

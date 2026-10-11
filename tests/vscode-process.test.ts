import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { NodeVscodeLauncher } from '../src/server/vscode-process'
import { vscodeBasePath } from '../src/server/vscode-route'

async function fixture(t: TestContext, code: string) {
  const directory = await mkdtemp(join(tmpdir(), 'ade-vscode-process-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const entrypoint = join(directory, 'server.cjs')
  await writeFile(entrypoint, code)
  const controller = new AbortController()
  const child = await new NodeVscodeLauncher().launch(
    { node: process.execPath, entrypoint },
    directory,
    join(directory, 'data'),
    controller.signal,
    join(directory, 'host extensions'),
  )
  t.after(async () => {
    controller.abort()
    await child.stop()
  })
  return { directory, child, controller }
}

test(
  'readiness probes HTTP and shutdown terminates descendant processes',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(
      t,
      `
    const http = require('node:http');
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    fs.writeFileSync('descendant.pid', String(descendant.pid));
    const args = process.argv.slice(2);
    fs.writeFileSync('arguments.json', JSON.stringify(args));
    const token = fs.readFileSync(args[args.indexOf('--connection-token-file') + 1], 'utf8');
    const server = http.createServer((request, response) => {
      fs.writeFileSync('probed', 'yes');
      response.writeHead(request.url === '/version?tkn=' + token ? 200 : 403);
      response.end('ready');
    });
    server.listen(0, '127.0.0.1', () => console.log('Extension host agent listening on ' + server.address().port));
  `,
    )
    const connection = await f.child.ready
    assert.ok(connection.port > 0)
    assert.match(connection.token, /^[a-f0-9]{64}$/)
    assert.equal(await readFile(join(f.directory, 'probed'), 'utf8'), 'yes')
    const args: string[] = JSON.parse(
      await readFile(join(f.directory, 'arguments.json'), 'utf8'),
    )
    assert.equal(args[args.indexOf('--default-folder') + 1], f.directory)
    assert.equal(
      args[args.indexOf('--server-base-path') + 1],
      vscodeBasePath(f.directory),
    )
    assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1')
    assert.equal(
      args[args.indexOf('--extensions-dir') + 1],
      join(f.directory, 'host extensions'),
    )
    assert.equal(args.includes('--without-connection-token'), false)
    const descendant = Number(
      await readFile(join(f.directory, 'descendant.pid'), 'utf8'),
    )
    await f.child.stop()
    await f.child.exited
    assert.throws(() => process.kill(descendant, 0))
  },
)

test(
  'early exits report stderr and do not become running',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(
      t,
      "console.error('Cannot load server'); process.exit(12)",
    )
    await assert.rejects(f.child.ready, /Cannot load server/)
    assert.equal((await f.child.exited).code, 12)
  },
)

test(
  'shutdown cancels a process that never reports readiness',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, 'setInterval(() => {}, 1000)')
    const rejected = assert.rejects(f.child.ready)
    f.controller.abort(new Error('shutdown'))
    await Promise.all([rejected, f.child.stop()])
  },
)

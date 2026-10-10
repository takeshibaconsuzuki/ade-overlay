import assert from 'node:assert/strict'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { parse, stringify, YAMLParseError } from 'yaml'
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
} from '../src/server/constants'
import { optionsFromFile, serverOptionsSchema } from '../src/server/options'
import { startRpcServer } from '../src/server/server'

async function configFile(t: TestContext, contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ade-server-config-'))
  const path = join(directory, 'server config.yaml')
  await writeFile(path, contents)
  t.after(async () => {
    await unlink(path)
    await rmdir(directory)
  })
  return path
}

test('partial file config receives defaults and survives YAML serialization', async (t) => {
  const path = await configFile(t, '# Bind to loopback\nhost: 127.0.0.1\n')
  const options = await optionsFromFile(path)
  assert.equal(options.host, '127.0.0.1')
  assert.equal(options.port, DEFAULT_SERVER_PORT)
  assert.equal(
    serverOptionsSchema.parse({ port: 9000 }).host,
    DEFAULT_SERVER_HOST,
  )
  const serialized = stringify(options)
  assert.deepEqual(parse(serialized), {
    host: '127.0.0.1',
    port: DEFAULT_SERVER_PORT,
    projects: [],
  })
  assert.deepEqual(serverOptionsSchema.parse(parse(serialized)), options)
})

test('schema rejects invalid values and unknown config keys', () => {
  for (const config of [
    null,
    [],
    'config',
    { host: '' },
    { host: '   ' },
    { host: null },
    { host: 123 },
    { port: -1 },
    { port: 65536 },
    { port: 1.5 },
    { port: '4317' },
    { port: null },
    { hostname: 'localhost' },
    { projects: null },
    { projects: ['repository'] },
    { projects: [{}] },
    { projects: [{ mainWorktreePath: '  ' }] },
    { projects: [{ mainWorktreePath: 'repo', name: 'extra' }] },
  ]) {
    assert.throws(
      () => serverOptionsSchema.parse(config),
      Error,
      JSON.stringify(config),
    )
  }
})

test('file loading reports the path and cause for invalid or missing config', async (t) => {
  const path = await configFile(t, 'host: [\n')
  await assert.rejects(optionsFromFile(path), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.ok(error.message.includes(path))
    assert.ok(error.cause instanceof YAMLParseError)
    return true
  })
  await writeFile(path, 'port: 65536\n')
  await assert.rejects(optionsFromFile(path), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.ok(error.cause instanceof Error)
    assert.match(error.cause.message, /port/)
    return true
  })
  await assert.rejects(
    optionsFromFile(`${path}.missing`),
    /Failed to load server configuration/,
  )
})

test('server binds the endpoint specified by a file config', async (t) => {
  const path = await configFile(t, 'host: 127.0.0.1\nport: 0\n')
  const options = await optionsFromFile(path)
  const server = await startRpcServer({}, options)
  t.after(() => server.close())
  assert.ok(server.port > 0)
})

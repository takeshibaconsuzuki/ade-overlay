import assert from 'node:assert/strict'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test, type TestContext } from 'node:test'
import { parse, stringify, YAMLParseError } from 'yaml'
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
} from '../src/server/constants'
import {
  optionsFromFile,
  resolveServerConfigPath,
  serverOptionsSchema,
  vscodeOptionsSchema,
} from '../src/server/options'
import { startRpcServer } from '../src/server/server'

async function configFile(
  t: TestContext,
  contents: string,
  name = 'server config.yaml',
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ade-server-config-'))
  const path = join(directory, name)
  await writeFile(path, contents)
  t.after(async () => {
    await unlink(path)
    await rmdir(directory)
  })
  return path
}

test('default config in the working directory takes precedence over the home config', async (t) => {
  const path = await configFile(t, 'port: 0\n', 'server.config.yaml')
  t.mock.method(process, 'cwd', () => dirname(path))
  assert.equal(await resolveServerConfigPath(), path)
})

test('missing default config falls back to the home directory', async (t) => {
  const path = await configFile(t, 'port: 0\n')
  t.mock.method(process, 'cwd', () => dirname(path))
  assert.equal(
    await resolveServerConfigPath(),
    join(homedir(), '.ade-overlay', 'server.config.yaml'),
  )
})

test('explicit config paths never fall back, including the default filename', async (t) => {
  const path = await configFile(t, 'port: 0\n')
  t.mock.method(process, 'cwd', () => dirname(path))
  for (const name of ['custom.yaml', 'server.config.yaml']) {
    const selected = await resolveServerConfigPath(name)
    assert.equal(selected, join(dirname(path), name))
    await assert.rejects(optionsFromFile(selected), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal((error.cause as NodeJS.ErrnoException).code, 'ENOENT')
      return true
    })
  }
  assert.equal(await resolveServerConfigPath(path), path)
})

test('invalid default config reports an error without falling back', async (t) => {
  const path = await configFile(t, 'host: [\n', 'server.config.yaml')
  t.mock.method(process, 'cwd', () => dirname(path))
  const selected = await resolveServerConfigPath()
  assert.equal(selected, path)
  await assert.rejects(optionsFromFile(selected), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.ok(error.cause instanceof YAMLParseError)
    return true
  })
})

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
    vscode: vscodeOptionsSchema.parse({}),
  })
  assert.deepEqual(serverOptionsSchema.parse(parse(serialized)), options)
})

test('configured paths resolve relative to the config file and preserve absolute overrides', async (t) => {
  const path = await configFile(
    t,
    stringify({
      projects: [
        { mainWorktreePath: './repo' },
        { mainWorktreePath: '../another-repo' },
      ],
      vscode: {
        extensionsDirectory: './extensions',
        settingsFile: '../profile/settings.json',
        profileDatabase: '../profile/globalStorage/state.vscdb',
      },
    }),
  )
  const expected = {
    projects: [
      { mainWorktreePath: join(dirname(path), 'repo') },
      { mainWorktreePath: join(dirname(path), '../another-repo') },
    ],
    vscode: {
      extensionsDirectory: join(dirname(path), 'extensions'),
      settingsFile: join(dirname(path), '../profile/settings.json'),
      profileDatabase: join(
        dirname(path),
        '../profile/globalStorage/state.vscdb',
      ),
    },
  }
  const defaults = serverOptionsSchema.parse({})
  assert.deepEqual(await optionsFromFile(path), { ...defaults, ...expected })
  assert.deepEqual(await optionsFromFile(relative(process.cwd(), path)), {
    ...defaults,
    ...expected,
  })
  await writeFile(path, stringify(expected))
  assert.deepEqual(await optionsFromFile(path), { ...defaults, ...expected })
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
    { vscode: null },
    { vscode: { extensionsDirectory: ' ' } },
    { vscode: { settingsFile: '' } },
    { vscode: { profileDatabase: ' ' } },
    { vscode: { profile: 'unknown' } },
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

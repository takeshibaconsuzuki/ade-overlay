import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, test, type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import { stringify, YAMLParseError } from 'yaml'
import { z } from 'zod'
import { loadDesktopOptions } from '../src/desktop/options'
import { DEFAULT_SERVER_URL } from '../src/shared/constants'

const originalServerUrl = process.env.ADE_SERVER_URL

beforeEach(() => {
  delete process.env.ADE_SERVER_URL
})

afterEach(() => {
  if (originalServerUrl === undefined) delete process.env.ADE_SERVER_URL
  else process.env.ADE_SERVER_URL = originalServerUrl
})

async function configFile(t: TestContext, contents?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ade-desktop-config-'))
  const path = join(directory, 'desktop.config.yaml')
  if (contents !== undefined) await writeFile(path, contents)
  t.after(async () => {
    if (contents !== undefined) await unlink(path)
    await rmdir(directory)
  })
  return path
}

test('missing desktop config and an empty mapping use the built-in endpoint', async (t) => {
  const missing = await configFile(t)
  assert.deepEqual(await loadDesktopOptions(missing), {
    serverUrl: DEFAULT_SERVER_URL,
  })
  const empty = await configFile(t, '{}\n')
  assert.deepEqual(await loadDesktopOptions(empty), {
    serverUrl: DEFAULT_SERVER_URL,
  })
})

test('desktop config accepts WebSocket endpoints', async (t) => {
  for (const serverUrl of [
    'ws://127.0.0.1:9000/rpc',
    'wss://ade.example.com/rpc',
    'ws://[::1]:4317/rpc',
  ]) {
    const path = await configFile(t, stringify({ serverUrl }))
    assert.deepEqual(await loadDesktopOptions(path), { serverUrl })
  }
})

test('environment overrides the desktop config and applies when the file is missing', async (t) => {
  const path = await configFile(t, 'serverUrl: wss://ade.example.com/rpc\n')
  const missing = await configFile(t)
  const serverUrl = 'ws://127.0.0.1:9000/rpc'
  process.env.ADE_SERVER_URL = serverUrl
  assert.deepEqual(await loadDesktopOptions(path), { serverUrl })
  assert.deepEqual(await loadDesktopOptions(missing), { serverUrl })
})

test('desktop config accepts a start command and preserves it with an endpoint override', async (t) => {
  const startCommand = 'ssh -N -L 4317:localhost:4317 ade-server'
  const path = await configFile(t, stringify({ startCommand }))
  assert.deepEqual(await loadDesktopOptions(path), {
    serverUrl: DEFAULT_SERVER_URL,
    startCommand,
  })
  const serverUrl = 'wss://ade.example.com/rpc'
  process.env.ADE_SERVER_URL = serverUrl
  assert.deepEqual(await loadDesktopOptions(path), { serverUrl, startCommand })
})

test('invalid YAML reports the config path and cause, even with an environment override', async (t) => {
  const path = await configFile(t, 'serverUrl: [\n')
  process.env.ADE_SERVER_URL = DEFAULT_SERVER_URL
  await assert.rejects(loadDesktopOptions(path), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.ok(error.message.includes(path))
    assert.ok(error.cause instanceof YAMLParseError)
    return true
  })
})

test('desktop config rejects unknown keys, invalid shapes and invalid endpoints', async (t) => {
  for (const config of [
    null,
    [],
    'config',
    { serverURL: DEFAULT_SERVER_URL },
    ...[null, 123, '', '   ', [], {}].map((startCommand) => ({ startCommand })),
    ...[
      null,
      123,
      '',
      '   ',
      'localhost:4317/rpc',
      'http://127.0.0.1:4317/rpc',
      'https://ade.example.com/rpc',
      'ws://127.0.0.1:4317/rpc#fragment',
    ].map((serverUrl) => ({ serverUrl })),
  ]) {
    const path = await configFile(t, stringify(config))
    await assert.rejects(loadDesktopOptions(path), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes(path))
      assert.ok(error.cause instanceof z.ZodError)
      return true
    })
  }
})

test('invalid environment overrides identify ADE_SERVER_URL as the source', async (t) => {
  const path = await configFile(t)
  for (const value of ['', 'bad-url', 'https://ade.example.com/rpc']) {
    process.env.ADE_SERVER_URL = value
    await assert.rejects(loadDesktopOptions(path), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'Invalid ADE_SERVER_URL')
      assert.ok(error.cause instanceof z.ZodError)
      return true
    })
  }
})

test('config read errors other than a missing file are reported', async (t) => {
  const path = await configFile(t)
  await assert.rejects(loadDesktopOptions(dirname(path)), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.ok(error.message.includes(dirname(path)))
    assert.ok(error.cause instanceof Error)
    return true
  })
})

test('desktop loads its config from the user home regardless of the working directory', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ade-desktop-home-'))
  const configDirectory = join(home, '.ade-overlay')
  await mkdir(configDirectory)
  const homeConfig = join(configDirectory, 'desktop.config.yaml')
  const serverUrl = 'wss://home.example.com/rpc'
  await writeFile(homeConfig, stringify({ serverUrl }))
  t.after(async () => {
    await unlink(homeConfig)
    await rmdir(configDirectory)
    await rmdir(home)
  })
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,
      '--input-type=module',
      '--eval',
      `import { loadDesktopOptions } from ${JSON.stringify(pathToFileURL(resolve('src/desktop/options.ts')).href)}; console.log(JSON.stringify(await loadDesktopOptions()))`,
    ],
    {
      cwd: tmpdir(),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    },
  )
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { serverUrl })
})

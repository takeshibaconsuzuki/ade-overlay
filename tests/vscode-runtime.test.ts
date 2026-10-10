import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { c as createTar } from 'tar'
import lockfile from 'proper-lockfile'
import { VSCODE_SERVER_COMMIT } from '../src/server/constants'
import {
  DownloadedVscodeRuntime,
  vscodePlatform,
} from '../src/server/vscode-runtime'

// A tiny Windows distribution fixture containing node.exe and out/server-main.js.
const zip = Buffer.from(
  'UEsDBBQAAAAIABFfSl3uQOUFCQAAAAcAAAAPAAAAdnNjb2RlL25vZGUuZXhlS8usKCktSgUAUEsDBBQAAAAIABFfSl3uQOUFCQAAAAcAAAAZAAAAdnNjb2RlL291dC9zZXJ2ZXItbWFpbi5qc0vLrCgpLUoFAFBLAQIUABQAAAAIABFfSl3uQOUFCQAAAAcAAAAPAAAAAAAAAAAAAACAAQAAAAB2c2NvZGUvbm9kZS5leGVQSwECFAAUAAAACAARX0pd7kDlBQkAAAAHAAAAGQAAAAAAAAAAAAAAgAE2AAAAdnNjb2RlL291dC9zZXJ2ZXItbWFpbi5qc1BLBQYAAAAAAgACAIQAAAB2AAAAAAA=',
  'base64',
)

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ade-vscode-runtime-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let archive = zip
  if (process.platform !== 'win32') {
    await mkdir(join(directory, 'vscode', 'out'), { recursive: true })
    await writeFile(join(directory, 'vscode', 'node'), 'fixture', {
      mode: 0o755,
    })
    await writeFile(
      join(directory, 'vscode', 'out', 'server-main.js'),
      'fixture',
    )
    const file = join(directory, 'fixture.tar.gz')
    await createTar({ cwd: directory, file, gzip: true }, ['vscode'])
    archive = await readFile(file)
  }
  const release = {
    version: VSCODE_SERVER_COMMIT,
    sha256hash: createHash('sha256').update(archive).digest('hex'),
    url: `https://example.test/vscode.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`,
  }
  const options = {
    cacheDirectory: join(directory, 'cache'),
    dataDirectory: join(directory, 'data'),
  }
  let requests = 0
  const request: typeof fetch = async (url) => {
    requests++
    if (String(url).includes('/api/versions/')) {
      assert.equal(
        String(url),
        `https://update.code.visualstudio.com/api/versions/commit:${VSCODE_SERVER_COMMIT}/${vscodePlatform()}/stable`,
      )
      return Response.json(release)
    }
    return new Response(new Uint8Array(archive))
  }
  return { directory, options, release, request, requests: () => requests }
}

test('release identifiers match the supported Microsoft platforms', () => {
  assert.equal(vscodePlatform('darwin', 'x64'), 'server-darwin-web')
  assert.equal(vscodePlatform('darwin', 'arm64'), 'server-darwin-arm64-web')
  assert.equal(vscodePlatform('win32', 'x64'), 'server-win32-x64-web')
  assert.equal(vscodePlatform('win32', 'arm64'), 'server-win32-arm64-web')
  assert.equal(vscodePlatform('linux', 'x64'), 'server-linux-x64-web')
  assert.equal(vscodePlatform('linux', 'arm64'), 'server-linux-arm64-web')
})

test('installation is verified and shared, and a new runtime uses the cache offline', async (t) => {
  const f = await fixture(t)
  const first = new DownloadedVscodeRuntime({ fetch: f.request }, f.options)
  const second = new DownloadedVscodeRuntime({ fetch: f.request }, f.options)
  const signal = new AbortController().signal
  const [a, b] = await Promise.all([
    first.prepare(signal),
    second.prepare(signal),
  ])
  assert.deepEqual(a, b)
  assert.equal(f.requests(), 2)
  assert.equal(await readFile(a.node, 'utf8'), 'fixture')
  assert.equal(await readFile(a.entrypoint, 'utf8'), 'fixture')
  const offline = new DownloadedVscodeRuntime(
    {
      fetch: async () => {
        throw new Error('offline')
      },
    },
    f.options,
  )
  assert.deepEqual(await offline.prepare(signal), a)
  assert.deepEqual(
    await readdir(join(f.options.cacheDirectory, vscodePlatform())),
    [VSCODE_SERVER_COMMIT],
  )
})

test('checksum failure leaves no partial installation and a new startup can retry', async (t) => {
  const f = await fixture(t)
  const validHash = f.release.sha256hash
  f.release.sha256hash = '0'.repeat(64)
  const runtime = new DownloadedVscodeRuntime({ fetch: f.request }, f.options)
  const signal = new AbortController().signal
  await assert.rejects(runtime.prepare(signal), /checksum mismatch/)
  assert.deepEqual(
    await readdir(join(f.options.cacheDirectory, vscodePlatform())),
    [],
  )
  f.release.sha256hash = validHash
  const retry = new DownloadedVscodeRuntime({ fetch: f.request }, f.options)
  await access((await retry.prepare(signal)).entrypoint)
})

test(
  'waiting for another installer can be cancelled promptly',
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t)
    const directory = join(f.options.cacheDirectory, vscodePlatform())
    await mkdir(directory, { recursive: true })
    const release = await lockfile.lock(directory)
    t.after(() => release())
    const runtime = new DownloadedVscodeRuntime({ fetch: f.request }, f.options)
    const controller = new AbortController()
    const result = assert.rejects(
      runtime.prepare(controller.signal),
      /shutdown/,
    )
    setTimeout(() => controller.abort(new Error('shutdown')), 50)
    await result
    assert.equal(f.requests(), 0)
  },
)

test(
  'a cancelled download is cleaned up and does not publish an installation',
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t)
    const controller = new AbortController()
    const request: typeof fetch = async (url, options) => {
      if (String(url).includes('/api/versions/'))
        return Response.json(f.release)
      return new Response(
        new ReadableStream({
          start(stream) {
            options?.signal?.addEventListener(
              'abort',
              () => stream.error(options.signal?.reason),
              { once: true },
            )
            setTimeout(() => controller.abort(new Error('shutdown')), 20)
          },
        }),
      )
    }
    const runtime = new DownloadedVscodeRuntime({ fetch: request }, f.options)
    await assert.rejects(runtime.prepare(controller.signal))
    assert.deepEqual(
      await readdir(join(f.options.cacheDirectory, vscodePlatform())),
      [],
    )
  },
)

test('a different cached commit is preserved while the pinned release is installed', async (t) => {
  const f = await fixture(t)
  const previousCommit = 'b'.repeat(40)
  const previous = join(
    f.options.cacheDirectory,
    vscodePlatform(),
    previousCommit,
  )
  await mkdir(previous, { recursive: true })
  await writeFile(join(previous, 'sentinel'), 'previous release')
  const runtime = new DownloadedVscodeRuntime({ fetch: f.request }, f.options)
  const installation = await runtime.prepare(new AbortController().signal)
  assert.equal(
    installation.node,
    join(
      f.options.cacheDirectory,
      vscodePlatform(),
      VSCODE_SERVER_COMMIT,
      process.platform === 'win32' ? 'node.exe' : 'node',
    ),
  )
  assert.equal(f.requests(), 2)
  assert.equal(
    await readFile(join(previous, 'sentinel'), 'utf8'),
    'previous release',
  )
})

test('release metadata must match the pin before downloading an archive', async (t) => {
  const f = await fixture(t)
  f.release.version = 'b'.repeat(40)
  const runtime = new DownloadedVscodeRuntime({ fetch: f.request }, f.options)
  await assert.rejects(
    runtime.prepare(new AbortController().signal),
    /does not match the pinned commit/,
  )
  assert.equal(f.requests(), 1)
  assert.deepEqual(
    await readdir(join(f.options.cacheDirectory, vscodePlatform())),
    [],
  )
})

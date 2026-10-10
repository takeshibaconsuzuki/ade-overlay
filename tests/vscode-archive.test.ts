import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { c as createTar } from 'tar'
import { extractVscodeArchive } from '../src/server/vscode-archive'

// Unix ZIP attributes: executable node and launcher, non-executable JavaScript.
const macZip = Buffer.from(
  'UEsDBBQAAAAIAAAAIVzuQOUFCQAAAAcAAAALAAAAdnNjb2RlL25vZGVLy6woKS1KBQBQSwMEFAAAAAgAAAAhXO5A5QUJAAAABwAAABYAAAB2c2NvZGUvYmluL2NvZGUtc2VydmVyS8usKCktSgUAUEsDBBQAAAAIAAAAIVzuQOUFCQAAAAcAAAAZAAAAdnNjb2RlL291dC9zZXJ2ZXItbWFpbi5qc0vLrCgpLUoFAFBLAQIUAxQAAAAIAAAAIVzuQOUFCQAAAAcAAAALAAAAAAAAAAAAAADtgQAAAAB2c2NvZGUvbm9kZVBLAQIUAxQAAAAIAAAAIVzuQOUFCQAAAAcAAAAWAAAAAAAAAAAAAADtgTIAAAB2c2NvZGUvYmluL2NvZGUtc2VydmVyUEsBAhQDFAAAAAgAAAAhXO5A5QUJAAAABwAAABkAAAAAAAAAAAAAAKSBbwAAAHZzY29kZS9vdXQvc2VydmVyLW1haW4uanNQSwUGAAAAAAMAAwDEAAAArwAAAAAA',
  'base64',
)

for (const arch of ['x64', 'arm64']) {
  test(`extracts the macOS ${arch} ZIP and preserves executable permissions on Unix`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'ade-vscode-zip-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const archive = join(directory, 'archive')
    const destination = join(directory, 'unpacked')
    await writeFile(archive, macZip)
    await extractVscodeArchive(
      archive,
      destination,
      `https://example.test/vscode-server-darwin-${arch}-web.zip`,
      new AbortController().signal,
    )
    for (const [path, mode] of [
      ['node', 0o755],
      ['bin/code-server', 0o755],
      ['out/server-main.js', 0o644],
    ] as const) {
      const file = join(destination, 'vscode', path)
      assert.equal(await readFile(file, 'utf8'), 'fixture')
      if (process.platform !== 'win32')
        assert.equal((await stat(file)).mode & 0o777, mode)
    }
  })
}

test('extracts a Linux tar.gz distribution independently of the host OS', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-vscode-tar-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'vscode'))
  await writeFile(join(directory, 'vscode', 'node'), 'fixture', { mode: 0o755 })
  const archive = join(directory, 'archive')
  await createTar({ cwd: directory, file: archive, gzip: true }, ['vscode'])
  const destination = join(directory, 'unpacked')
  await extractVscodeArchive(
    archive,
    destination,
    'https://example.test/vscode-server-linux-x64-web.tar.gz',
    new AbortController().signal,
  )
  assert.equal(
    await readFile(join(destination, 'vscode', 'node'), 'utf8'),
    'fixture',
  )
  if (process.platform !== 'win32')
    assert.equal(
      (await stat(join(destination, 'vscode', 'node'))).mode & 0o777,
      0o755,
    )
})

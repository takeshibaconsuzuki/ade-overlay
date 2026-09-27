import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { finished } from 'node:stream/promises'
import { ZipArchive, TarArchive } from 'archiver'
import spawn from 'cross-spawn'
import { build, Platform } from 'electron-builder'
import { prepareSigning } from './package-signing.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const { values } = parseArgs({ options: { dir: { type: 'boolean' } } })
const app = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (
  process.env.GITHUB_REF?.startsWith('refs/tags/') &&
  process.env.GITHUB_REF !== `refs/tags/v${app.version}`
)
  throw new Error('The release tag must match the package.json version.')
const nodeVersion = (await readFile(join(root, '.node-version'), 'utf8')).trim()
if (process.version !== `v${nodeVersion}`)
  throw new Error(`Package with Node ${nodeVersion}; run the bootstrap first.`)
if (
  !['win32', 'darwin', 'linux'].includes(process.platform) ||
  !['x64', 'arm64'].includes(process.arch)
)
  throw new Error(
    `Unsupported release platform: ${process.platform}-${process.arch}`,
  )

const signing = prepareSigning()
const staging = join(root, 'out', 'release')
const output = join(root, 'dist')
await mkdir(output, { recursive: true })

// Stage only runtime dependencies. npm prunes the existing lock offline, retaining
// its exact resolutions instead of resolving a new dependency tree for each build.
async function stage(name, manifest) {
  const path = resolve(staging, name)
  if (!path.startsWith(resolve(staging) + sep))
    throw new Error('Invalid staging path')
  await rm(path, { recursive: true, force: true })
  await mkdir(path, { recursive: true })
  await writeFile(
    join(path, 'package.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )
  await copyFile(
    join(root, 'package-lock.json'),
    join(path, 'package-lock.json'),
  )
  for (const args of [
    ['install', '--package-lock-only', '--offline', '--ignore-scripts'],
    ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts'],
  ]) {
    const result = spawn.sync('npm', [...args, '--no-audit', '--no-fund'], {
      cwd: path,
      stdio: 'inherit',
    })
    if (result.error) throw result.error
    if (result.status !== 0)
      throw new Error(`Installing ${name} dependencies failed`)
  }
  return path
}

const desktop = await stage('desktop', {
  name: app.name,
  version: app.version,
  description: app.description,
  author: app.author,
  homepage: app.homepage,
  license: app.license,
  private: true,
  type: 'module',
  main: app.main,
  dependencies: Object.fromEntries(
    ['ws', 'zod'].map((name) => [name, app.dependencies[name]]),
  ),
})
for (const directory of ['main', 'preload', 'renderer'])
  await cp(join(root, 'out', directory), join(desktop, 'out', directory), {
    recursive: true,
  })
await copyFile(
  join(root, 'extensions/ade-terminals/out/THIRD_PARTY_NOTICES.txt'),
  join(desktop, 'out/THIRD_PARTY_NOTICES.txt'),
)

const serverManifest = JSON.parse(
  await readFile(join(root, 'out/server/package.json'), 'utf8'),
)
const companion = await stage('companion', serverManifest)
for (const directory of ['server', 'shared'])
  await cp(join(root, 'out/server', directory), join(companion, directory), {
    recursive: true,
  })
await copyFile(
  join(root, 'out/ade-terminals.vsix'),
  join(companion, 'ade-terminals.vsix'),
)
await copyFile(join(root, 'README.md'), join(companion, 'README.md'))
await copyFile(
  join(root, 'extensions/ade-terminals/out/THIRD_PARTY_NOTICES.txt'),
  join(companion, 'THIRD_PARTY_NOTICES.txt'),
)
await mkdir(join(companion, 'runtime'), { recursive: true })
const executable = process.platform === 'win32' ? 'node.exe' : 'node'
await copyFile(process.execPath, join(companion, 'runtime', executable))
await chmod(join(companion, 'runtime', executable), 0o755)

// Official Node distributions include their third-party notices in LICENSE.
const licensePath = join(
  dirname(process.execPath),
  process.platform === 'win32' ? 'LICENSE' : '../LICENSE',
)
let license
try {
  license = await readFile(licensePath)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  const response = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`,
    { signal: AbortSignal.timeout(30_000) },
  )
  if (!response.ok)
    throw new Error(`Could not download Node license: ${response.status}`, {
      cause: error,
    })
  license = Buffer.from(await response.arrayBuffer())
}
await writeFile(join(companion, 'runtime', 'LICENSE'), license)
const launcher =
  process.platform === 'win32' ? 'ade-companion.cmd' : 'ade-companion'
await writeFile(
  join(companion, launcher),
  process.platform === 'win32'
    ? '@echo off\r\nsetlocal\r\n"%~dp0runtime\\node.exe" "%~dp0server\\index.js" %*\r\nexit /b %errorlevel%\r\n'
    : '#!/bin/sh\nADE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1\nexec "$ADE_DIR/runtime/node" "$ADE_DIR/server/index.js" "$@"\n',
)
await chmod(join(companion, launcher), 0o755)

const name = `ade-companion-${app.version}-${process.platform}-${process.arch}`
const archivePath = join(
  output,
  `${name}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`,
)
const destination = createWriteStream(archivePath)
const archive =
  process.platform === 'win32'
    ? new ZipArchive({ zlib: { level: 9 } })
    : new TarArchive({ gzip: true })
archive.on('warning', (error) => archive.destroy(error))
archive.pipe(destination)
const completed = Promise.all([finished(archive), finished(destination)])
archive.directory(companion, 'ade-companion')
await Promise.all([archive.finalize(), completed])

const desktopArtifacts = await build({
  targets: Platform.current().createTarget(values.dir ? ['dir'] : undefined),
  config: {
    extends: join(root, 'electron-builder.yml'),
    electronVersion: app.devDependencies.electron,
    ...signing,
  },
  publish: 'never',
})
const vsix = join(output, `ade-terminals-${app.version}.vsix`)
await copyFile(join(root, 'out/ade-terminals.vsix'), vsix)
const sums = []
for (const path of [archivePath, vsix, ...desktopArtifacts]) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  sums.push(`${hash.digest('hex')}  ${path.slice(output.length + 1)}`)
}
await writeFile(
  join(output, `SHA256SUMS-${process.platform}-${process.arch}.txt`),
  sums.join('\n') + '\n',
)

import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { exec } from '@yao-pkg/pkg'
import { build } from 'esbuild'
import { create } from 'tar'
import { version } from '../package.json'

const root = resolve(import.meta.dirname, '..')
const platforms: Record<string, string> = {
  win32: 'win',
  darwin: 'macos',
  linux: 'linux',
}
const platform = platforms[process.platform]
if (!platform || !['x64', 'arm64'].includes(process.arch))
  throw new Error(
    `Server packaging is not supported on ${process.platform}/${process.arch}`,
  )

const output = join(root, 'out/packages')
await mkdir(output, { recursive: true })
const staging = await mkdtemp(join(output, '.server-'))
try {
  const name = `ade-server-${version}-${platform}-${process.arch}`
  const directory = join(staging, name)
  await mkdir(directory)
  const bundle = join(staging, 'server.cjs')
  await build({
    entryPoints: [join(root, 'scripts/server-entry.mjs')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    // Prefer ESM over UMD modules whose runtime require calls cannot be bundled.
    mainFields: ['module', 'main'],
    external: ['bufferutil', 'utf-8-validate', '@aws-sdk/client-s3'],
    logLevel: 'info',
  })
  const executable = join(
    directory,
    platform === 'win' ? 'ade-server.exe' : 'ade-server',
  )
  // Use the checkout's exact Node version for both the SEA blob and its runtime.
  await exec([
    bundle,
    '--sea',
    '--target',
    `node${process.versions.node}-${platform}-${process.arch}`,
    '--output',
    executable,
  ])
  await chmod(executable, 0o755)
  await copyFile(
    join(root, 'server.config.example.yaml'),
    join(directory, 'server.config.example.yaml'),
  )
  const archive = join(output, `${name}.tar.gz`)
  await create({ cwd: staging, file: archive, gzip: true }, [name])
  console.log(`Server package: ${archive}`)
} finally {
  await rm(staging, { recursive: true, force: true })
}

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { buildVersion } from './build-version'

const root = resolve(import.meta.dirname, '..')

// Runs the electron-builder CLI so its options still apply. The packaged
// package.json carries the full build version, which Electron reports through
// app.getVersion() and the native About panel.
const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js')
const child = spawn(
  process.execPath,
  [
    cli,
    '--publish',
    'never',
    `--config.extraMetadata.version=${await buildVersion(root)}`,
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
)
child.once('exit', (code) => {
  process.exitCode = code ?? 1
})

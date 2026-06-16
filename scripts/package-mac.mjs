import { spawn } from 'node:child_process'
import { access, chmod, cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const packageJsonPath = resolve(projectRoot, 'package.json')
const packageLockPath = resolve(projectRoot, 'package-lock.json')
const electronAppPath = resolve(
  projectRoot,
  'node_modules/electron/dist/Electron.app',
)
const outPath = resolve(projectRoot, 'out')

const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
const productName = process.env.PRODUCT_NAME ?? 'ADE Overlay'
const appId = process.env.APP_ID ?? 'com.ade-overlay.app'
const codesignIdentity = process.env.CODESIGN_IDENTITY ?? '-'
const distDir = resolve(projectRoot, 'dist/mac')
const appPath = resolve(distDir, `${productName}.app`)
const appContentsPath = resolve(appPath, 'Contents')
const appResourcesPath = resolve(appContentsPath, 'Resources')
const appPayloadPath = resolve(appResourcesPath, 'app')

if (process.platform !== 'darwin') {
  throw new Error('Mac packaging must run on a Mac')
}

await assertExists(
  electronAppPath,
  'Electron runtime is missing; run npm install',
)

await run('npm', ['run', 'build'])

await rm(appPath, { force: true, recursive: true })
await mkdir(distDir, { recursive: true })
await run('ditto', [electronAppPath, appPath])

await mkdir(appPayloadPath, { recursive: true })
await cp(packageJsonPath, resolve(appPayloadPath, 'package.json'))
await cp(packageLockPath, resolve(appPayloadPath, 'package-lock.json'))
await cp(outPath, resolve(appPayloadPath, 'out'), { recursive: true })

await run(
  'npm',
  ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
  {
    cwd: appPayloadPath,
  },
)

await restorePtySpawnHelperPermissions()

const plistPath = resolve(appContentsPath, 'Info.plist')
await run('plutil', [
  '-replace',
  'CFBundleDisplayName',
  '-string',
  productName,
  plistPath,
])
await run('plutil', [
  '-replace',
  'CFBundleName',
  '-string',
  productName,
  plistPath,
])
await run('plutil', [
  '-replace',
  'CFBundleIdentifier',
  '-string',
  appId,
  plistPath,
])
await run('plutil', [
  '-replace',
  'CFBundleShortVersionString',
  '-string',
  packageJson.version,
  plistPath,
])
await run('plutil', [
  '-replace',
  'CFBundleVersion',
  '-string',
  packageJson.version,
  plistPath,
])
await run('plutil', [
  '-replace',
  'LSApplicationCategoryType',
  '-string',
  'public.app-category.developer-tools',
  plistPath,
])

if (process.env.SKIP_CODESIGN !== '1') {
  await run('codesign', [
    '--force',
    '--deep',
    '--sign',
    codesignIdentity,
    appPath,
  ])
}

console.log(`Packaged ${appPath}`)

/**
 * node-pty `exec`s a bundled `spawn-helper` binary to open a PTY on macOS. We
 * install dependencies with `--ignore-scripts`, which skips node-pty's
 * postinstall — the step that restores the helper's executable bit — so the
 * prebuilt helper lands as mode 0644 and every chat PTY spawn fails at runtime
 * with "posix_spawnp failed." Restore the bit on each platform's prebuilt
 * helper. (`.node` addons are dlopen'd, not exec'd, so they don't need it.)
 */
async function restorePtySpawnHelperPermissions() {
  const prebuildsDir = resolve(
    appPayloadPath,
    'node_modules/node-pty/prebuilds',
  )

  let platformDirs
  try {
    platformDirs = await readdir(prebuildsDir)
  } catch {
    throw new Error(
      `node-pty prebuilds not found at ${prebuildsDir}; did the install layout change?`,
    )
  }

  let fixed = 0
  for (const platformDir of platformDirs) {
    const helper = resolve(prebuildsDir, platformDir, 'spawn-helper')
    try {
      await chmod(helper, 0o755)
      fixed += 1
    } catch {
      // No spawn-helper for this platform (e.g. the win32 prebuilds) — skip.
    }
  }

  if (fixed === 0) {
    throw new Error(
      `No node-pty spawn-helper binaries found under ${prebuildsDir} to mark executable`,
    )
  }
  console.log(`Restored executable bit on ${fixed} node-pty spawn-helper(s)`)
}

async function assertExists(path, message) {
  try {
    await access(path)
  } catch {
    throw new Error(message)
  }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }

      reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

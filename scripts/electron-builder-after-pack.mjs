import { spawn } from 'node:child_process'
import {
  access,
  chmod,
  cp,
  readdir,
  rename,
  rm,
  symlink,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const electronAppPath = resolve(
  projectRoot,
  'node_modules/electron/dist/Electron.app',
)

const ELECTRON_EXECUTABLE_NAME = 'Electron'
const ROLE_HELPERS = [
  { role: 'editor', name: 'ADE Editor' },
  { role: 'chat', name: 'ADE Chat' },
]

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  await assertExists(
    electronAppPath,
    'Electron runtime is missing; run npm install',
  )

  const appInfo = context.packager.appInfo
  const appPath = resolve(context.appOutDir, `${appInfo.productFilename}.app`)
  const appContentsPath = resolve(appPath, 'Contents')
  const appFrameworksPath = resolve(appContentsPath, 'Frameworks')
  const appPayloadPath = resolve(appContentsPath, 'Resources', 'app')

  await restorePtySpawnHelperPermissions(appPayloadPath)

  for (const helper of ROLE_HELPERS) {
    await createRoleHelperApp({
      ...helper,
      appFrameworksPath,
      bundleId: `${appInfo.macBundleIdentifier}.${helper.role}`,
      version: appInfo.version,
    })
  }
}

async function createRoleHelperApp({
  role,
  name,
  bundleId,
  version,
  appFrameworksPath,
}) {
  const icnsSource = resolve(projectRoot, `resources/icons/${role}.icns`)
  await assertExists(
    icnsSource,
    `resources/icons/${role}.icns is missing; run \`npm run generate:icons\``,
  )

  const helperApp = resolve(appFrameworksPath, `${name}.app`)
  const helperContents = resolve(helperApp, 'Contents')

  await rm(helperApp, { force: true, recursive: true })
  await run('cp', ['-Rc', electronAppPath, helperApp])

  await rename(
    resolve(helperContents, 'MacOS', ELECTRON_EXECUTABLE_NAME),
    resolve(helperContents, 'MacOS', name),
  )

  const helperPlist = resolve(helperContents, 'Info.plist')
  const plistValues = {
    CFBundleDisplayName: name,
    CFBundleExecutable: name,
    CFBundleIconFile: role,
    CFBundleIdentifier: bundleId,
    CFBundleName: name,
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
  }
  for (const [key, value] of Object.entries(plistValues)) {
    await run('plutil', ['-replace', key, '-string', value, helperPlist])
  }

  await cp(icnsSource, resolve(helperContents, 'Resources', `${role}.icns`))
  await symlink(
    '../../../../Resources/app',
    resolve(helperContents, 'Resources', 'app'),
  )
}

async function restorePtySpawnHelperPermissions(appPayloadPath) {
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
      // Some platform prebuilds do not include a spawn-helper binary.
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

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
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

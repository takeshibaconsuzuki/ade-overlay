import { spawn } from 'node:child_process'
import {
  access,
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
} from 'node:fs/promises'
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
const appFrameworksPath = resolve(appContentsPath, 'Frameworks')
const controllerIcnsPath = resolve(
  projectRoot,
  'resources/icons/controller.icns',
)

/** `CFBundleExecutable` of the pristine Electron.app the helpers are cloned from. */
const ELECTRON_EXECUTABLE_NAME = 'Electron'

/**
 * The roles spawned as their own apps (see src/DESIGN.md). Each gets a helper
 * `.app` bundle nested under Contents/Frameworks with a distinct bundle id,
 * name, and icon, so macOS gives it its own dock tile instead of overtaking the
 * controller's. The server launches these via src/server/roleLauncher.ts.
 */
const HELPER_ROLES = [
  { role: 'editor', name: 'ADE Editor', bundleId: `${appId}.editor` },
  { role: 'chat', name: 'ADE Chat', bundleId: `${appId}.chat` },
]

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

// Replace Electron's default bundle icon (CFBundleIconFile points at
// `electron.icns`) with the controller icon, so the installed app shows the
// launcher's icon in Finder. The editor and chat roles get their own icons
// from the helper bundles built below.
await assertExists(
  controllerIcnsPath,
  'resources/icons/controller.icns is missing; run `npm run generate:icons`',
)
await cp(controllerIcnsPath, resolve(appResourcesPath, 'electron.icns'))

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
  // Deep-sign the controller bundle (its framework, child helpers, and our
  // payload) before the role helpers exist. Each helper shares this payload by
  // symlink, so signing the controller `--deep` afterwards would follow that
  // symlink back into the payload and corrupt the signature.
  await run('codesign', [
    '--force',
    '--deep',
    '--sign',
    codesignIdentity,
    appPath,
  ])
}

for (const helper of HELPER_ROLES) {
  await createRoleHelperApp(helper)
}

if (process.env.SKIP_CODESIGN !== '1') {
  // Sign each helper's own executable and seal its bundle, but NOT `--deep`: the
  // cloned framework and child helpers keep their pristine signatures and stay
  // copy-on-write shared, so each helper adds ~0 to disk. A deep re-sign would
  // rewrite ~180MB of identical framework bytes per helper.
  for (const helper of HELPER_ROLES) {
    await run('codesign', [
      '--force',
      '--sign',
      codesignIdentity,
      resolve(appFrameworksPath, `${helper.name}.app`),
    ])
  }
  // Re-seal the controller so its CodeResources covers the new helper bundles.
  // Intentionally shallow (no `--deep`): the helpers are already signed, and a
  // deep pass would follow their app-payload symlink back into this bundle and
  // break the signature.
  await run('codesign', ['--force', '--sign', codesignIdentity, appPath])
}

console.log(`Packaged ${appPath}`)

/**
 * Builds a helper `.app` for a spawned role, nested under Contents/Frameworks.
 * It carries its own identity (bundle id, name, icon) so macOS treats it as a
 * separate app with its own dock tile (see src/DESIGN.md).
 *
 * The bundle is a copy-on-write clone of the pristine Electron runtime, so it
 * has a *real* Contents/Frameworks: Electron's main process realpath()s its
 * child helper executables and aborts ("unexpected helper executable") when the
 * resolved path differs from the expected one — which a symlinked Frameworks
 * would cause. APFS clones keep the duplicated framework near-zero on disk, and
 * the app payload (our code + node_modules) is shared via a symlink rather than
 * copied.
 */
async function createRoleHelperApp({ role, name, bundleId }) {
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
    CFBundleShortVersionString: packageJson.version,
    CFBundleVersion: packageJson.version,
  }
  for (const [key, value] of Object.entries(plistValues)) {
    await run('plutil', ['-replace', key, '-string', value, helperPlist])
  }

  await cp(icnsSource, resolve(helperContents, 'Resources', `${role}.icns`))

  // Electron loads the app from this Resources/app path; point it at the
  // controller's payload so the helper shares one copy of our code.
  await symlink(
    '../../../../Resources/app',
    resolve(helperContents, 'Resources', 'app'),
  )
}

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

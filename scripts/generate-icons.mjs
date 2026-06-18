import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const iconsDir = resolve(projectRoot, 'resources/icons')

/** Each role's icon source. The names match the `--role` values in main. */
const ROLES = ['controller', 'chat', 'editor']

/**
 * The `.iconset` member files macOS expects, mapping each filename to the pixel
 * size `iconutil` requires for it.
 */
const ICONSET_SIZES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

/** Pixel size of the standalone PNG each role hands to `app.dock.setIcon`. */
const DOCK_ICON_SIZE = 1024

if (process.platform !== 'darwin') {
  throw new Error('Icon generation needs macOS `iconutil`')
}

function renderPng(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } })
    .render()
    .asPng()
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
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

for (const role of ROLES) {
  const svg = await readFile(join(iconsDir, `${role}.svg`), 'utf8')

  // Standalone PNG used at runtime by `app.dock.setIcon` for this role.
  await writeFile(join(iconsDir, `${role}.png`), renderPng(svg, DOCK_ICON_SIZE))

  // Assemble a `.iconset` and let `iconutil` pack it into the `.icns` bundle.
  // `iconutil` only accepts a directory whose name ends in `.iconset`.
  const work = await mkdtemp(join(tmpdir(), `ade-icon-${role}-`))
  const iconset = join(work, 'icon.iconset')
  try {
    await mkdir(iconset, { recursive: true })
    for (const [name, size] of ICONSET_SIZES) {
      await writeFile(join(iconset, name), renderPng(svg, size))
    }
    await run('iconutil', [
      '--convert',
      'icns',
      iconset,
      '--output',
      join(iconsDir, `${role}.icns`),
    ])
  } finally {
    await rm(work, { force: true, recursive: true })
  }

  console.log(`Generated ${role}.icns and ${role}.png`)
}

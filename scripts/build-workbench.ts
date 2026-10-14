import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const result = await build({
  entryPoints: [resolve(root, 'src/workbench/index.ts')],
  bundle: true,
  platform: 'browser',
  target: 'chrome148',
  format: 'esm',
  write: false,
})
await mkdir(resolve(root, 'out/workbench'), { recursive: true })
// Embed the browser asset in the server so deployed servers need no source tree or bundler.
await writeFile(
  resolve(root, 'out/workbench/source.ts'),
  `export default ${JSON.stringify(result.outputFiles[0].text)}\n`,
)

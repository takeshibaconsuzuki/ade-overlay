import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createVSIX } from '@vscode/vsce'
import { build } from 'esbuild'

const extensionRoot = resolve(import.meta.dirname, '../vscode-extension')

await Promise.all([
  build({
    entryPoints: [resolve(extensionRoot, 'src/extension.ts')],
    outfile: resolve(extensionRoot, 'out/extension.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: true,
    logLevel: 'info',
  }),
  build({
    entryPoints: [resolve(extensionRoot, 'webview/index.tsx')],
    outdir: resolve(extensionRoot, 'out/webview'),
    tsconfig: resolve(extensionRoot, 'tsconfig.webview.json'),
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
    sourcemap: true,
    logLevel: 'info',
  }),
])

const outputDirectory = resolve(extensionRoot, '../out')
await mkdir(outputDirectory, { recursive: true })
await createVSIX({
  cwd: extensionRoot,
  packagePath: resolve(outputDirectory, 'ade.vsix'),
  dependencies: false,
  allowMissingRepository: true,
  skipLicense: true,
})

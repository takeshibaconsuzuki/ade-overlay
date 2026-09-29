import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createVSIX } from '@vscode/vsce'
import { build } from 'vite'
import { builtinModules } from 'node:module'
import react from '@vitejs/plugin-react'
import { writeNotices } from './notices.mjs'

await build({
  configFile: false,
  resolve: { conditions: ['node'], mainFields: ['module', 'main'] },
  build: {
    target: 'node22',
    outDir: fileURLToPath(
      new URL('../extensions/ade-terminals/out/', import.meta.url),
    ),
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(
        new URL(
          '../extensions/ade-terminals/src/extension.ts',
          import.meta.url,
        ),
      ),
      formats: ['cjs'],
      fileName: () => 'extension.js',
    },
    rollupOptions: {
      output: { chunkFileNames: '[name]-[hash].js' },
      external: [
        'vscode',
        /^node:/,
        ...builtinModules,
        'bufferutil',
        'utf-8-validate',
      ],
    },
  },
})

await build({
  configFile: false,
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: fileURLToPath(
      new URL('../extensions/ade-terminals/out/', import.meta.url),
    ),
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(
        new URL(
          '../extensions/ade-terminals/src/webview/index.tsx',
          import.meta.url,
        ),
      ),
      formats: ['iife'],
      name: 'AdeSidebar',
      fileName: () => 'sidebar.js',
      cssFileName: 'sidebar',
    },
  },
})

await mkdir(new URL('../out/', import.meta.url), { recursive: true })
await writeNotices(
  new URL(
    '../extensions/ade-terminals/out/THIRD_PARTY_NOTICES.txt',
    import.meta.url,
  ),
)
await createVSIX({
  version: JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ).version,
  updatePackageJson: false,
  gitTagVersion: false,
  cwd: fileURLToPath(new URL('../extensions/ade-terminals/', import.meta.url)),
  packagePath: fileURLToPath(
    new URL('../out/ade-terminals.vsix', import.meta.url),
  ),
  dependencies: false,
  allowMissingRepository: true,
  skipLicense: true,
})

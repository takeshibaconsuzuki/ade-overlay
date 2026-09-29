import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

export function buildSettingsBridge(watch = false) {
  return build({
    configFile: false,
    logLevel: 'warn',
    build: {
      target: 'es2022',
      outDir: fileURLToPath(new URL('../out/server/assets', import.meta.url)),
      emptyOutDir: true,
      watch: watch ? {} : null,
      lib: {
        entry: fileURLToPath(
          new URL('../src/editor-browser/index.ts', import.meta.url),
        ),
        formats: ['iife'],
        name: 'ADESettingsSync',
        fileName: () => 'settings-sync.js',
      },
    },
  })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  await buildSettingsBridge()

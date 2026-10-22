import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { APP_DISPLAY_NAME } from './src/shared/constants'

export default defineConfig({
  main: {
    build: {
      target: 'node24.15',
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/desktop/index.ts'),
          'terminal-host': resolve(
            import.meta.dirname,
            'src/desktop/terminal-host.ts',
          ),
        },
      },
    },
  },
  preload: {
    build: {
      target: 'node24.15',
      externalizeDeps: true,
      rollupOptions: {
        input: {
          picker: resolve(import.meta.dirname, 'src/desktop/picker/preload.ts'),
          editor: resolve(import.meta.dirname, 'src/desktop/editor/preload.ts'),
          vscode: resolve(
            import.meta.dirname,
            'src/desktop/editor/vscode/preload.ts',
          ),
        },
        // Sandboxed workbench preloads require CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/desktop'),
    build: {
      target: 'chrome148',
      rollupOptions: {
        input: {
          picker: resolve(
            import.meta.dirname,
            'src/desktop/picker/renderer/index.html',
          ),
          editor: resolve(
            import.meta.dirname,
            'src/desktop/editor/renderer/index.html',
          ),
        },
      },
    },
    plugins: [
      react(),
      {
        name: 'app-title',
        transformIndexHtml: () => [
          { tag: 'title', children: APP_DISPLAY_NAME, injectTo: 'head' },
        ],
      },
    ],
  },
})

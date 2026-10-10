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
        input: resolve(import.meta.dirname, 'src/desktop/main/index.ts'),
      },
    },
  },
  preload: {
    build: {
      target: 'node24.15',
      externalizeDeps: true,
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/desktop/preload/index.ts'),
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/desktop/renderer'),
    build: {
      target: 'chrome148',
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/desktop/renderer/index.html'),
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

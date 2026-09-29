import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      target: 'node24.15',
      externalizeDeps: true,
    },
  },
  preload: {
    build: {
      target: 'node24.15',
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          editor: resolve('src/preload/editor.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    build: {
      target: 'chrome148',
    },
    plugins: [react()],
  },
})

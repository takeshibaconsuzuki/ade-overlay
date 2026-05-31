import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

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
    },
  },
  renderer: {
    build: {
      target: 'chrome148',
    },
    plugins: [react()],
  },
})

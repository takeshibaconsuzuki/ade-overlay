import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const projectRoot = import.meta.dirname
const bootstrapTemplateSource = resolve(
  projectRoot,
  'src/server/editor/bootstrap.html',
)
const bootstrapTemplateOutput = resolve(projectRoot, 'out/main/bootstrap.html')

export default defineConfig({
  main: {
    plugins: [
      {
        name: 'copy-editor-bootstrap-template',
        closeBundle() {
          mkdirSync(dirname(bootstrapTemplateOutput), { recursive: true })
          copyFileSync(bootstrapTemplateSource, bootstrapTemplateOutput)
        },
      },
    ],
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

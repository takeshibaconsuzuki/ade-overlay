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
const hookScriptFiles = [
  'hook-forwarder.cjs',
  'hook-wrapper.cmd',
  'hook-wrapper.sh',
]
const hookScriptsSourceDir = resolve(projectRoot, 'src/server/chats')
const hookScriptsOutputDir = resolve(projectRoot, 'out/main')

/** Per-role dock icons the main process hands to `app.dock.setIcon`. */
const DOCK_ICON_ROLES = ['controller', 'chat', 'editor']
const iconsSourceDir = resolve(projectRoot, 'resources/icons')
const iconsOutputDir = resolve(projectRoot, 'out/main/icons')

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
      {
        name: 'copy-chat-hook-scripts',
        closeBundle() {
          mkdirSync(hookScriptsOutputDir, { recursive: true })
          for (const file of hookScriptFiles) {
            copyFileSync(
              resolve(hookScriptsSourceDir, file),
              resolve(hookScriptsOutputDir, file),
            )
          }
        },
      },
      {
        name: 'copy-role-dock-icons',
        closeBundle() {
          mkdirSync(iconsOutputDir, { recursive: true })
          for (const role of DOCK_ICON_ROLES) {
            copyFileSync(
              resolve(iconsSourceDir, `${role}.png`),
              resolve(iconsOutputDir, `${role}.png`),
            )
          }
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

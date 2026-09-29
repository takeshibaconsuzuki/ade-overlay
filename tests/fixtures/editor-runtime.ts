import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { EditorRuntimeProvider } from '../../src/server/editors/vscode-runtime.ts'

// Socket/window tests own isolated runtimes and profiles; never invoke the
// developer's installed CLI or install into their real extensions directory.
export class FixtureRuntime
  extends EventEmitter<{ progress: [string] }>
  implements EditorRuntimeProvider
{
  runtimeRoot: string
  private readonly root: string
  constructor(root: string, runtimeRoot: string) {
    super()
    this.root = root
    this.runtimeRoot = runtimeRoot
  }
  async localCode() {
    return {
      command: 'fixture',
      commit: 'a'.repeat(40),
      userDataDir: join(this.root, 'local user'),
      extensionsDir: join(this.root, 'local extensions'),
    }
  }
  async get() {
    return {
      executable: join(
        this.runtimeRoot,
        process.platform === 'win32' ? 'node.exe' : 'node',
      ),
      entrypoint: join(this.runtimeRoot, 'out', 'server-main.js'),
    }
  }
  prepareRuntime(): void {}
  async close(): Promise<void> {}
}

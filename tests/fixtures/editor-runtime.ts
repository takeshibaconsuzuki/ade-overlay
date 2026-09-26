import { join } from 'node:path'
import { EditorRuntimeManager } from '../../src/server/vscode-runtime.ts'

// Socket/window tests own isolated runtimes and profiles; never invoke the
// developer's installed CLI or install into their real extensions directory.
export class FixtureRuntime extends EditorRuntimeManager {
  runtimeRoot: string
  private readonly root: string
  constructor(root: string, runtimeRoot: string) {
    super(root)
    this.root = root
    this.runtimeRoot = runtimeRoot
  }
  override async localCode() {
    return {
      command: 'fixture',
      commit: 'a'.repeat(40),
      channel: 'stable' as const,
      userDataDir: join(this.root, 'local user'),
      extensionsDir: join(this.root, 'local extensions'),
    }
  }
  override async get() {
    return {
      executable: join(
        this.runtimeRoot,
        process.platform === 'win32' ? 'node.exe' : 'node',
      ),
      entrypoint: join(this.runtimeRoot, 'out', 'server-main.js'),
    }
  }
}

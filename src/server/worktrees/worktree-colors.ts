import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import type { OpenEditorInput } from '../../shared/companion.ts'
import {
  worktreeColorSchema,
  type WorktreeColor,
} from '../../shared/worktree-colors.ts'
import { worktreeKey } from './worktree-identity.ts'

const colorsSchema = z.record(z.string(), worktreeColorSchema)

// Assignments are owned by the worktree operation queue and outlive editors.
export class WorktreeColors {
  private colors = new Map<string, WorktreeColor>()
  private file?: string

  static async open(dataDir: string): Promise<WorktreeColors> {
    const store = new WorktreeColors()
    store.file = join(dataDir, 'worktree-colors.json')
    try {
      store.colors = new Map(
        Object.entries(
          colorsSchema.parse(JSON.parse(await readFile(store.file, 'utf8'))),
        ),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return store
  }

  get(worktree: OpenEditorInput): WorktreeColor | undefined {
    return this.colors.get(worktreeKey(worktree))
  }

  async assign(worktree: OpenEditorInput): Promise<void> {
    if (this.get(worktree)) return
    const counts = new Map(
      worktreeColorSchema.options.map((color) => [color, 0]),
    )
    for (const color of this.colors.values())
      counts.set(color, counts.get(color)! + 1)
    const color = [...counts].sort((a, b) => a[1] - b[1])[0][0]
    const next = new Map(this.colors).set(worktreeKey(worktree), color)
    if (this.file) {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFileAtomic(
        this.file,
        JSON.stringify(Object.fromEntries(next)),
        {
          mode: 0o600,
        },
      )
    }
    this.colors = next
  }
}

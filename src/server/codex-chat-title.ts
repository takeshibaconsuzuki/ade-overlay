import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { parse } from 'smol-toml'

// Codex's local state is an internal interface. Read only the requested thread,
// never migrate or write its database, and leave unavailable titles as skeletons.
export async function readCodexTitle(
  root: string,
  sessionId: string,
): Promise<string | undefined> {
  if (!isAbsolute(root)) return
  let databaseRoot = root
  try {
    const config = parse(await readFile(join(root, 'config.toml'), 'utf8'))
    if (typeof config.sqlite_home === 'string') {
      const path = config.sqlite_home.replace(/^~(?=[/\\]|$)/, homedir())
      databaseRoot = resolve(root, path)
    }
  } catch {
    /* Missing or temporarily incomplete config: try the default home. */
  }
  const files = await readdir(databaseRoot)
  const file = files
    .filter((file) => /^state_\d+\.sqlite$/.test(file))
    .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0]
  if (!file) return
  const database = new DatabaseSync(join(databaseRoot, file), {
    readOnly: true,
  })
  try {
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 50;')
    const columns = database.prepare('PRAGMA table_info(threads)').all()
    const hasName = columns.some((column) => column.name === 'name')
    const row = database
      .prepare(
        `SELECT ${hasName ? "COALESCE(NULLIF(name, ''), title)" : 'title'} AS title FROM threads WHERE id = ?`,
      )
      .get(sessionId)
    return typeof row?.title === 'string'
      ? row.title.trim().slice(0, 512) || undefined
      : undefined
  } finally {
    database.close()
  }
}

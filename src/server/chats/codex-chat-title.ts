import { readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { parse } from 'smol-toml'
import type { ChatTitleRequests, ChatTitles } from './chat-providers.ts'

async function findDatabase(root: string): Promise<string | undefined> {
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
  // Unicode case conversion can change a valid Windows pathname.
  return realpath(join(databaseRoot, file))
}

// Codex's local state is an internal interface. Read only requested live threads,
// never migrate or write its database. Connections belong to this refresh pass.
export async function readCodexTitles(
  requests: ChatTitleRequests,
): Promise<ChatTitles> {
  const sources = new Map<string, Map<string, ReadonlySet<string>>>()
  for (const [root, sessions] of requests) {
    if (!sessions.size) continue
    const path = await findDatabase(root).catch(() => undefined)
    if (!path) continue
    const homes = sources.get(path) ?? new Map<string, ReadonlySet<string>>()
    homes.set(root, sessions)
    sources.set(path, homes)
  }
  const titles: ChatTitles = new Map()
  for (const [path, homes] of sources) {
    try {
      const sessions = new Set([...homes.values()].flatMap((ids) => [...ids]))
      const found = readDatabase(path, sessions)
      for (const [root, ids] of homes)
        titles.set(root, new Map([...found].filter(([id]) => ids.has(id))))
    } catch {
      // A missing, busy or changing source does not discard other sources.
    }
  }
  return titles
}

function readDatabase(
  path: string,
  sessions: ReadonlySet<string>,
): Map<string, string> {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 50;')
    const columns = database.prepare('PRAGMA table_info(threads)').all()
    const hasName = columns.some((column) => column.name === 'name')
    const query = database.prepare(
      `SELECT ${hasName ? "COALESCE(NULLIF(name, ''), title)" : 'title'} AS title FROM threads WHERE id = ?`,
    )
    const titles = new Map<string, string>()
    for (const sessionId of sessions) {
      const row = query.get(sessionId)
      const title =
        typeof row?.title === 'string' && row.title.trim().slice(0, 512)
      if (title) titles.set(sessionId, title)
    }
    return titles
  } finally {
    database.close()
  }
}

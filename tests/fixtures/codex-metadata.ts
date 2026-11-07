import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function createCodexMetadata(directory: string): DatabaseSync {
  const database = new DatabaseSync(join(directory, 'state_5.sqlite'))
  database.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL DEFAULT '',
    thread_source TEXT NOT NULL DEFAULT 'user',
    archived INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    name TEXT,
    preview TEXT NOT NULL DEFAULT '',
    first_user_message TEXT NOT NULL DEFAULT '',
    history_mode TEXT NOT NULL DEFAULT 'legacy'
  )`)
  return database
}

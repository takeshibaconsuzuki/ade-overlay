import { DatabaseSync } from 'node:sqlite'
import type { ChatHistoryEntry, ChatHistoryResults } from '../shared/api'
import { logger } from '../shared/logger'
import type { ChatProvider, ChatSession } from './chat-provider'

const log = logger.child({ component: 'chat-history' })

// The index is a cache of provider messages: a database with another version is rebuilt.
// Change the version with the schema or with what a provider reads as a message.
const INDEX_VERSION = 2
const SCHEMA = `
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  provider_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  modified_at INTEGER NOT NULL,
  -- The modification whose messages are stored; NULL until a read of them completes.
  indexed_at INTEGER,
  UNIQUE (provider_id, session_id)
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX messages_session ON messages (session);
-- Trigrams let LIKE patterns of three or more characters use the index.
CREATE VIRTUAL TABLE messages_fts USING fts5 (
  text, content = 'messages', content_rowid = 'id', tokenize = 'trigram'
);
CREATE TRIGGER messages_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER messages_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`
const REFRESH_INTERVAL_MS = 10_000
const MAX_RESULTS = 10
const EXCERPT_LENGTH = 300

const LATEST_SQL = `
SELECT s.provider_id, s.session_id, s.title, s.cwd, s.modified_at, m.text
FROM sessions s
JOIN messages m ON m.id = (SELECT MAX(id) FROM messages WHERE session = s.id)
ORDER BY s.modified_at DESC
LIMIT ?`

function matchingSql(terms: number): string {
  return `
WITH hits AS (
  SELECT m.session, MAX(m.id) AS id
  FROM messages_fts f JOIN messages m ON m.id = f.rowid
  WHERE ${Array.from({ length: terms }, () => 'f.text LIKE ?').join(' AND ')}
  GROUP BY m.session
)
SELECT s.provider_id, s.session_id, s.title, s.cwd, s.modified_at, m.text
FROM hits
JOIN sessions s ON s.id = hits.session
JOIN messages m ON m.id = hits.id
ORDER BY s.modified_at DESC
LIMIT ?`
}

interface ResultRow {
  provider_id: string
  session_id: string
  title: string
  cwd: string
  modified_at: number
  text: string
}

interface ChangedSession {
  // The session's row in the index.
  id: number
  modifiedAt: number
}

// One line around the earliest literal term, or the start of the message.
function excerpt(text: string, terms: string[]): string {
  const line = text.replace(/\s+/g, ' ').trim()
  const folded = line.toLowerCase()
  const match = Math.min(
    ...terms
      .map((term) => folded.indexOf(term.toLowerCase()))
      .filter((index) => index !== -1),
  )
  const start = Number.isFinite(match) ? Math.max(0, match - 40) : 0
  const end = start + EXCERPT_LENGTH
  // Cutting can split a surrogate pair at either edge.
  const part = line
    .slice(start, end)
    .replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, '')
    .trim()
  return `${start > 0 ? '…' : ''}${part}${end < line.length ? '…' : ''}`
}

// A persistent search index of the messages providers read from their sessions. Each
// process opens its own connection; searches see the last committed update without
// waiting for one in progress.
export class ChatHistoryIndex {
  private readonly database: DatabaseSync

  constructor(path: string) {
    this.database = new DatabaseSync(path, { timeout: 5000 })
    this.database.exec('PRAGMA journal_mode = WAL')
    const { user_version: version } = this.database
      .prepare('PRAGMA user_version')
      .get() as { user_version: number }
    if (version !== INDEX_VERSION)
      this.transaction(() =>
        this.database.exec(`
DROP TABLE IF EXISTS messages_fts;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS sessions;
${SCHEMA}
PRAGMA user_version = ${INDEX_VERSION};`),
      )
  }

  search(query: string): ChatHistoryEntry[] {
    const terms = query.split(/\s+/).filter(Boolean)
    const rows = (terms.length
      ? this.database
          .prepare(matchingSql(terms.length))
          .all(...terms.map((term) => `%${term}%`), MAX_RESULTS)
      : this.database
          .prepare(LATEST_SQL)
          .all(MAX_RESULTS)) as unknown as ResultRow[]
    return rows.map((row) => ({
      providerId: row.provider_id,
      sessionId: row.session_id,
      title: row.title,
      cwd: row.cwd,
      modifiedAt: row.modified_at,
      excerpt: excerpt(row.text, terms),
    }))
  }

  // Reads the sessions modified since their last read. A provider whose sessions cannot
  // be listed or read is logged and left for the next update.
  async update(providers: readonly ChatProvider[]): Promise<void> {
    const started = performance.now()
    let indexed = 0
    for (const provider of providers) {
      try {
        const sessions = await provider.listSessions()
        const changed = this.transaction(() =>
          this.record(provider.id, sessions),
        )
        indexed += changed.size
        if (changed.size) await this.index(provider, changed)
      } catch (error) {
        log.warn(
          { err: error, providerId: provider.id },
          'Failed to update chat history',
        )
      }
    }
    if (indexed)
      log.info(
        {
          sessions: indexed,
          durationMs: Math.round(performance.now() - started),
        },
        'Chat history indexed',
      )
  }

  close(): void {
    this.database.close()
  }

  // Stores the listed sessions, removes the provider's other sessions, and returns the
  // sessions whose stored messages are not from their current modification.
  private record(
    providerId: string,
    sessions: ChatSession[],
  ): Map<string, ChangedSession> {
    const upsert = this.database.prepare(`
INSERT INTO sessions (provider_id, session_id, title, cwd, modified_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (provider_id, session_id) DO UPDATE SET
  title = excluded.title,
  cwd = excluded.cwd,
  modified_at = excluded.modified_at
RETURNING id, indexed_at`)
    const listed = new Set<number>()
    const changed = new Map<string, ChangedSession>()
    for (const session of sessions) {
      const row = upsert.get(
        providerId,
        session.sessionId,
        session.title,
        session.cwd,
        session.modifiedAt,
      ) as { id: number; indexed_at: number | null }
      listed.add(row.id)
      if (row.indexed_at !== session.modifiedAt)
        changed.set(session.sessionId, {
          id: row.id,
          modifiedAt: session.modifiedAt,
        })
    }
    const ids = this.database
      .prepare('SELECT id FROM sessions WHERE provider_id = ?')
      .all(providerId) as { id: number }[]
    for (const { id } of ids) {
      if (listed.has(id)) continue
      this.database.prepare('DELETE FROM messages WHERE session = ?').run(id)
      this.database.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    }
    return changed
  }

  // Replaces each changed session's messages once all of them are read, so an
  // interrupted read leaves the session's previous messages for the next update.
  private async index(
    provider: ChatProvider,
    changed: Map<string, ChangedSession>,
  ): Promise<void> {
    let current: string | undefined
    let texts: string[] = []
    const finish = () => {
      if (current === undefined) return
      this.replace(changed.get(current)!, texts)
      changed.delete(current)
      texts = []
    }
    for await (const { sessionId, text } of provider.readMessages([
      ...changed.keys(),
    ])) {
      if (sessionId !== current) {
        finish()
        // A session's messages are consecutive, so a finished one cannot return.
        if (!changed.has(sessionId))
          throw new Error(`Unexpected messages for chat session ${sessionId}`)
        current = sessionId
      }
      if (text.trim()) texts.push(text)
    }
    finish()
    // Sessions without messages.
    for (const session of changed.values()) this.replace(session, [])
  }

  private replace(session: ChangedSession, texts: string[]): void {
    this.transaction(() => {
      this.database
        .prepare('DELETE FROM messages WHERE session = ?')
        .run(session.id)
      const insert = this.database.prepare(
        'INSERT INTO messages (session, text) VALUES (?, ?)',
      )
      for (const text of texts) insert.run(session.id, text)
      this.database
        .prepare('UPDATE sessions SET indexed_at = ? WHERE id = ?')
        .run(session.modifiedAt, session.id)
    })
  }

  private transaction<T>(body: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

// Updates the index away from the server's event loop.
export interface ChatHistoryIndexer {
  // Resolves once an update has finished and rejects when it failed.
  update(): Promise<void>
  // Stops a running update.
  close(): Promise<void>
}

// Searches the index for the server and keeps it current with an indexer, one update at
// a time.
export class ChatHistory {
  private readonly index: ChatHistoryIndex
  private refreshing: Promise<void> | undefined
  private refreshedAt = -Infinity
  private closed = false
  private closing: Promise<void> | undefined
  private onRefreshed: (() => void) | undefined

  constructor(
    path: string,
    private readonly indexer: ChatHistoryIndexer,
  ) {
    this.index = new ChatHistoryIndex(path)
  }

  // Called after every update, whether or not it changed the index.
  setOnRefreshedListener(listener: (() => void) | undefined): void {
    this.onRefreshed = listener
  }

  // Joins the running update or starts one. Failures are logged, never rejected.
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.refreshing ??= this.indexer
      .update()
      .catch((error: unknown) => {
        log.warn({ err: error }, 'Failed to update chat history')
      })
      .finally(() => {
        this.refreshing = undefined
        this.refreshedAt = Date.now()
        if (!this.closed) this.onRefreshed?.()
      })
    return this.refreshing
  }

  search(query: string): ChatHistoryResults {
    if (this.closed) throw new Error('Chat history closed')
    if (Date.now() - this.refreshedAt >= REFRESH_INTERVAL_MS)
      void this.refresh()
    return {
      chats: this.index.search(query),
      indexing: this.refreshing !== undefined,
    }
  }

  // Stops the running update and closes the index once.
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true
      this.onRefreshed = undefined
      await this.indexer.close()
      await this.refreshing
      this.index.close()
    })()
    return this.closing
  }
}

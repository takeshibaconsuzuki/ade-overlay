import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { ChatHistoryIndex } from '../src/server/chat-history'
import { ProcessChatHistoryIndexer } from '../src/server/chat-history-process'
import { createCodexMetadata } from './fixtures/codex-metadata'

// The update process inherits the providers' directories through the environment.
const directory = await mkdtemp(join(tmpdir(), 'ade-chat-history-process-'))
after(() => rm(directory, { recursive: true, force: true }))
process.env.CLAUDE_CONFIG_DIR = join(directory, 'claude')
process.env.CODEX_HOME = join(directory, 'codex')

test('the server command updates the index in its own process', async () => {
  const claudeSession = randomUUID()
  const project = join(directory, 'claude', 'projects', '-work')
  await mkdir(project, { recursive: true })
  await writeFile(
    join(project, `${claudeSession}.jsonl`),
    JSON.stringify({
      type: 'user',
      sessionId: claudeSession,
      uuid: randomUUID(),
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/work',
      promptSource: 'typed',
      message: { role: 'user', content: 'Claude prompt' },
    }) + '\n',
  )
  const rollout = join(directory, 'codex', 'rollout.jsonl')
  await mkdir(join(directory, 'codex'))
  const metadata = createCodexMetadata(join(directory, 'codex'))
  metadata
    .prepare(
      'INSERT INTO threads (id, rollout_path, cwd, title) VALUES (?, ?, ?, ?)',
    )
    .run('codex-session', rollout, '/work', 'Codex chat')
  metadata.close()
  await writeFile(
    rollout,
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'UserMessage',
          content: [{ type: 'text', text: 'Codex prompt' }],
        },
      },
    }) + '\n',
  )
  const path = join(directory, 'history.sqlite')
  const index = new ChatHistoryIndex(path)
  after(() => index.close())
  await new ProcessChatHistoryIndexer([
    process.execPath,
    ...process.execArgv,
    resolve('src/server/index.ts'),
    '--index-chat-history',
    path,
  ]).update()
  assert.deepEqual(
    index
      .search('prompt')
      .map(({ providerId, excerpt }) => [providerId, excerpt])
      .sort(),
    [
      ['claude', 'Claude prompt'],
      ['codex', 'Codex prompt'],
    ],
  )
})

test('updates report failed processes, and closing stops a running one', async () => {
  await assert.rejects(
    new ProcessChatHistoryIndexer([
      process.execPath,
      '-e',
      'process.exitCode = 3',
    ]).update(),
    /exited with 3/,
  )
  const indexer = new ProcessChatHistoryIndexer([
    process.execPath,
    '-e',
    'setTimeout(() => {}, 60_000)',
  ])
  const running = indexer.update()
  await indexer.close()
  await running
  await indexer.update()
})

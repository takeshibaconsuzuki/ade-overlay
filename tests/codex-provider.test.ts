import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CodexChatProvider } from '../src/server/chat-providers/codex/provider'
import { createCodexMetadata } from './fixtures/codex-metadata'

test('Codex transforms startup using stored status and report receipt times', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-codex-grace-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const provider = new CodexChatProvider(['unused'], directory)
  let now = 0
  t.mock.method(Date, 'now', () => now)
  const raw = { session_id: 'session', cwd: directory, pid: 123 }
  const { chat: previous } = await provider.readReport({
    ...raw,
    hook_event_name: 'UserPromptSubmit',
  })
  now = 999
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const startup = { ...raw, hook_event_name: 'SessionStart', source }
    const prepared = await provider.readReport(startup)
    assert.ok(prepared.transformChat)
    startup.hook_event_name = 'Stop'
    now += 1000
    assert.equal(prepared.transformChat(previous), undefined)
    assert.deepEqual(prepared.transformChat(undefined), prepared.chat)
    assert.deepEqual(
      prepared.transformChat({ ...previous, status: 'idle' }),
      prepared.chat,
    )
    now = 999
  }
  now = 1000
  const startup = { ...raw, hook_event_name: 'SessionStart', source: 'startup' }
  const prepared = await provider.readReport(startup)
  assert.deepEqual(prepared.transformChat?.(previous), prepared.chat)
  for (const hook_event_name of [
    'PreToolUse',
    'PostToolUse',
    'PermissionRequest',
    'Stop',
  ]) {
    const event = { ...raw, hook_event_name }
    const prepared = await provider.readReport(event)
    assert.deepEqual(prepared.transformChat?.(previous), prepared.chat)
  }
})

test('Codex metadata matches resume names and previews, including saved renames', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-codex-metadata-'))
  const db = createCodexMetadata(directory)
  t.after(async () => {
    db.close()
    await rm(directory, { recursive: true, force: true })
  })
  const insert = db.prepare(
    'INSERT INTO threads (id, title, name, preview, first_user_message, history_mode) VALUES (?, ?, ?, ?, ?, ?)',
  )
  insert.run(
    'saved',
    'Saved Codex title',
    null,
    'Preview from Codex',
    'Initial request',
    'legacy',
  )
  insert.run(
    'unnamed',
    'Initial request',
    null,
    '',
    'Initial request',
    'legacy',
  )
  insert.run(
    'indexed',
    'Initial request',
    null,
    '',
    'Initial request',
    'legacy',
  )
  insert.run(
    'paginated',
    'Derived title',
    'Canonical name',
    'Canonical preview',
    'Initial request',
    'paginated',
  )
  await writeFile(
    join(directory, 'session_index.jsonl'),
    [
      { id: 'saved', thread_name: 'Stale index name' },
      { id: 'indexed', thread_name: 'Old name' },
      { id: 'indexed', thread_name: 'Renamed session' },
      { id: 'paginated', thread_name: 'Stale index name' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n{unfinished',
  )
  const provider = new CodexChatProvider(['unused'], directory)
  const title = async (session_id: string) => {
    const result = await provider.readReport({
      session_id,
      hook_event_name: 'SessionStart',
      cwd: directory,
      pid: 123,
      terminalId: 'bcf08308-3214-4d40-8a47-ea183fa95752',
    })
    return result.chat.title
  }
  assert.equal(await title('saved'), 'Saved Codex title')
  assert.equal(await title('unnamed'), 'Initial request')
  assert.equal(await title('indexed'), 'Renamed session')
  assert.equal(await title('paginated'), 'Canonical name')
  assert.equal(await title('missing'), '(no message yet)')
  db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(
    'New saved title',
    'saved',
  )
  assert.equal(await title('saved'), 'New saved title')
})

test('Codex provider reads the saved title and derives other metadata from the hook payload', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-codex-provider-'))
  const db = createCodexMetadata(directory)
  t.after(async () => {
    db.close()
    await rm(directory, { recursive: true, force: true })
  })
  db.prepare('INSERT INTO threads (id, title, preview) VALUES (?, ?, ?)').run(
    'session',
    'Saved name',
    'Saved description',
  )
  const provider = new CodexChatProvider(['unused'], directory)
  const report = {
    session_id: 'session',
    hook_event_name: 'SessionStart',
    cwd: directory,
    pid: 123,
    terminalId: 'bcf08308-3214-4d40-8a47-ea183fa95752',
  }
  for (const [event, source, status] of [
    ['SessionStart', 'startup', 'idle'],
    ['SessionStart', 'resume', 'idle'],
    ['SessionStart', 'clear', 'idle'],
    ['UserPromptSubmit', undefined, 'working'],
    ['PreToolUse', undefined, 'working'],
    ['PermissionRequest', undefined, 'idle'],
    ['PostToolUse', undefined, 'working'],
    ['SessionStart', 'compact', 'working'],
    ['Stop', undefined, 'idle'],
    ['Interrupt', undefined, 'idle'],
    ['SessionEnd', undefined, 'idle'],
  ]) {
    const result = await provider.readReport({
      ...report,
      hook_event_name: event,
      source,
      prompt: event === 'UserPromptSubmit' ? 'Current prompt' : undefined,
      last_assistant_message: event === 'Stop' ? 'Latest answer' : undefined,
    })
    assert.equal(result.shouldPurge, event === 'SessionEnd')
    const { chat } = result
    assert.equal(chat.providerId, 'codex')
    assert.equal(chat.sessionId, 'session')
    assert.equal(chat.terminalId, report.terminalId)
    assert.equal(chat.status, status)
    assert.equal(chat.title, 'Saved name')
    assert.equal(
      chat.description,
      event === 'UserPromptSubmit'
        ? 'Current prompt'
        : event === 'Stop'
          ? 'Latest answer'
          : undefined,
    )
  }
  let now = 100
  t.mock.method(Date, 'now', () => now)
  const pending = provider.readReport({ ...report, mtime: 1 })
  now = 200
  const result = await pending
  assert.equal(result.chat.mtime, 100)
  await assert.rejects(provider.readReport({ ...report, pid: -1 }))
  await assert.rejects(
    provider.readReport({ ...report, hook_event_name: 'Unknown' }),
  )
})

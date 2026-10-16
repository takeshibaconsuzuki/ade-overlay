import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { ClaudeChatProvider } from '../src/server/chat-providers/claude/provider'

// The Agent SDK resolves the configuration directory once per process.
const directory = await mkdtemp(join(tmpdir(), 'ade-claude-provider-'))
process.env.CLAUDE_CONFIG_DIR = directory
after(() => rm(directory, { recursive: true, force: true }))
const projects = join(directory, 'projects', '-project')
await mkdir(projects, { recursive: true })

async function writeTranscript(sessionId: string, entries: object[]) {
  await writeFile(
    join(projects, `${sessionId}.jsonl`),
    entries.map((entry) => JSON.stringify({ ...entry, sessionId }) + '\n'),
  )
}

const prompt = (content: string) => ({
  type: 'user',
  message: { role: 'user', content },
  uuid: randomUUID(),
  timestamp: '2026-01-01T00:00:00.000Z',
  isSidechain: false,
})

test('Claude Code titles prefer saved and generated titles over prompts', async () => {
  const provider = new ClaudeChatProvider(['unused'], directory)
  const [renamed, generated, prompted, missing] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ]
  await writeTranscript(renamed, [
    prompt('Initial request'),
    { type: 'ai-title', aiTitle: 'Generated title' },
    { type: 'custom-title', customTitle: 'Saved title' },
  ])
  await writeTranscript(generated, [
    prompt('Initial request'),
    { type: 'ai-title', aiTitle: 'Generated title' },
  ])
  await writeTranscript(prompted, [prompt('Initial request')])
  const title = async (session_id: string) => {
    const result = await provider.readReport({
      session_id,
      hook_event_name: 'SessionStart',
      cwd: directory,
      pid: 123,
    })
    return result.chat.title
  }
  assert.equal(await title(renamed), 'Saved title')
  assert.equal(await title(generated), 'Generated title')
  assert.equal(await title(prompted), 'Initial request')
  assert.equal(await title(missing), '(no message yet)')
  await appendFile(
    join(projects, `${renamed}.jsonl`),
    JSON.stringify({
      type: 'custom-title',
      customTitle: 'Renamed again',
      sessionId: renamed,
    }) + '\n',
  )
  assert.equal(await title(renamed), 'Renamed again')
})

test('Claude Code hook payloads determine status, activity, and description', async (t) => {
  const provider = new ClaudeChatProvider(['unused'], directory)
  const report = {
    session_id: randomUUID(),
    cwd: directory,
    pid: 123,
    terminalId: 'bcf08308-3214-4d40-8a47-ea183fa95752',
  }
  const now = 100
  t.mock.method(Date, 'now', () => now)
  for (const [event, status, activity, description] of [
    ['SessionStart', 'idle', false, undefined],
    ['UserPromptSubmit', 'working', true, 'Current prompt'],
    ['PreToolUse', 'working', false, undefined],
    ['PermissionRequest', 'idle', false, undefined],
    ['PostToolUse', 'working', false, undefined],
    ['PostToolUseFailure', 'working', false, undefined],
    ['Notification', 'idle', false, undefined],
    ['Stop', 'idle', true, 'Latest answer'],
    ['StopFailure', 'idle', true, 'API Error: Rate limit reached'],
    ['SessionEnd', 'idle', false, undefined],
  ] as const) {
    const result = await provider.readReport({
      ...report,
      hook_event_name: event,
      prompt: event === 'UserPromptSubmit' ? description : undefined,
      last_assistant_message: event.startsWith('Stop')
        ? description
        : undefined,
    })
    assert.equal(result.shouldPurge, event === 'SessionEnd')
    const { chat } = result
    assert.equal(chat.providerId, 'claude')
    assert.equal(chat.sessionId, report.session_id)
    assert.equal(chat.terminalId, report.terminalId)
    assert.equal(chat.worktreePath, directory)
    assert.equal(chat.status, status, event)
    assert.equal(chat.lastActivityAt, activity ? now : undefined, event)
    assert.equal(chat.description, description, event)
  }
  await assert.rejects(provider.readReport({ ...report, pid: -1 }))
  await assert.rejects(
    provider.readReport({ ...report, hook_event_name: 'SubagentStop' }),
  )
})

test('Claude Code subagent reports leave the parent chat unchanged', async () => {
  const provider = new ClaudeChatProvider(['unused'], directory)
  const raw = { session_id: randomUUID(), cwd: directory, pid: 123 }
  const { chat: working } = await provider.readReport({
    ...raw,
    hook_event_name: 'UserPromptSubmit',
  })
  for (const event of [
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PostToolUseFailure',
    'StopFailure',
  ]) {
    const report = await provider.readReport({
      ...raw,
      hook_event_name: event,
      agent_id: 'a1b2c3',
      last_assistant_message: 'API Error: Rate limit reached',
    })
    assert.equal(report.transformChat?.(working), undefined, event)
  }
})

test('Claude Code startup yields to a recent turn and compaction keeps the status', async (t) => {
  const provider = new ClaudeChatProvider(['unused'], directory)
  let now = 0
  t.mock.method(Date, 'now', () => now)
  const raw = { session_id: randomUUID(), cwd: directory, pid: 123 }
  const { chat: working } = await provider.readReport({
    ...raw,
    hook_event_name: 'UserPromptSubmit',
  })
  const idle = { ...working, status: 'idle' as const }
  now = 999
  for (const source of ['startup', 'resume', 'clear', 'fork']) {
    const prepared = await provider.readReport({
      ...raw,
      hook_event_name: 'SessionStart',
      source,
    })
    assert.equal(prepared.transformChat?.(working), undefined)
    assert.deepEqual(prepared.transformChat?.(idle), prepared.chat)
    assert.deepEqual(prepared.transformChat?.(undefined), prepared.chat)
  }
  const compact = await provider.readReport({
    ...raw,
    hook_event_name: 'SessionStart',
    source: 'compact',
  })
  assert.equal(compact.transformChat?.(working)?.status, 'working')
  assert.equal(compact.transformChat?.(idle)?.status, 'idle')
  assert.equal(compact.transformChat?.(undefined)?.status, 'idle')
  now = 1000
  const late = await provider.readReport({
    ...raw,
    hook_event_name: 'SessionStart',
    source: 'startup',
  })
  assert.deepEqual(late.transformChat?.(working), late.chat)
  const stop = await provider.readReport({ ...raw, hook_event_name: 'Stop' })
  assert.deepEqual(stop.transformChat?.(working), stop.chat)
})

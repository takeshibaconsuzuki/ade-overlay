import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'node:test'
import {
  VscodeSettingsSync,
  type VscodeSettingsPage,
} from '../src/desktop/editor/vscode/vscode-settings-sync'

class Page implements VscodeSettingsPage {
  content = ''
  generation = 0
  hold: Promise<void> = Promise.resolve()
  async applySettings(content: string, generation: number): Promise<void> {
    this.content = content
    this.generation = generation
    await this.hold
  }
}

function fixture() {
  const writes: string[] = []
  const page = new Page()
  const sync = new VscodeSettingsSync(page, {
    writeSettings: async (content) => {
      writes.push(content)
    },
  })
  sync.start()
  return { sync, page, writes }
}

test('a host snapshot initializes a page; valid edits flow only after applying it', async () => {
  const { sync, page, writes } = fixture()
  await sync.changed(page.generation, '{"tooEarly":true}')
  sync.receive('{"host":1}')
  await tick()
  assert.equal(page.content, '{"host":1}')
  await sync.changed(page.generation, page.content)
  await sync.changed(page.generation, '{')
  assert.deepEqual(writes, [])
  await sync.changed(page.generation, '{"client":2}')
  assert.deepEqual(writes, ['{"client":2}'])
  sync.receive('{"client":2}')
  await tick()
  assert.equal(page.content, '{"client":2}')
})

test('an open page discards disconnected edits and waits for the reconnect snapshot', async () => {
  const { sync, page, writes } = fixture()
  sync.receive('{"host":1}')
  await tick()
  const oldGeneration = page.generation
  sync.receive(null)
  page.content = '{"offline":true}'
  await sync.changed(oldGeneration, page.content)
  sync.receive('{"host":2}')
  await tick()
  assert.equal(page.content, '{"host":2}')
  await sync.changed(oldGeneration, '{"delayed":true}')
  assert.deepEqual(writes, [])
  await sync.changed(page.generation, '{"online":true}')
  assert.deepEqual(writes, ['{"online":true}'])
})

test('late application completions cannot reopen the gate after disconnect or supersede newer snapshots', async () => {
  const { sync, page, writes } = fixture()
  let release!: () => void
  page.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  sync.receive('{"old":1}')
  await tick()
  sync.receive(null)
  release()
  await tick()
  await sync.changed(page.generation, '{"stale":true}')
  assert.deepEqual(writes, [])
  sync.receive('{"intermediate":1}')
  sync.receive('{"latest":1}')
  await tick()
  assert.equal(page.content, '{"latest":1}')
})

test('invalid host settings suspend outgoing writes, and disposed pages cannot send', async () => {
  const { sync, page, writes } = fixture()
  sync.receive('{}')
  await tick()
  sync.receive(null)
  await sync.changed(page.generation, '{"blocked":true}')
  assert.deepEqual(writes, [])
  sync.receive('{}')
  await tick()
  sync.dispose()
  await sync.changed(page.generation, '{"disposed":true}')
  assert.deepEqual(writes, [])
})

test('an edit arriving before application acknowledgment waits, but never crosses a disconnect', async () => {
  const { sync, page, writes } = fixture()
  let release!: () => void
  page.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  sync.receive('{}')
  await tick()
  const edit = sync.changed(page.generation, '{"savedDuringApply":true}')
  await tick()
  assert.deepEqual(writes, [])
  release()
  await edit
  assert.deepEqual(writes, ['{"savedDuringApply":true}'])

  page.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  sync.receive('{"host":2}')
  await tick()
  const staleEdit = sync.changed(page.generation, '{"stale":true}')
  sync.receive(null)
  release()
  await staleEdit
  assert.deepEqual(writes, ['{"savedDuringApply":true}'])
})

test('a reloaded page reapplies the host snapshot without waiting for the old document', async () => {
  const { sync, page, writes } = fixture()
  let release!: () => void
  page.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  sync.receive('{"host":1}')
  await tick()
  const oldGeneration = page.generation
  sync.stop()
  page.hold = Promise.resolve()
  sync.receive('{"host":2}')
  sync.start()
  await tick()
  assert.equal(page.content, '{"host":2}')
  assert.notEqual(page.generation, oldGeneration)
  await sync.changed(oldGeneration, '{"oldDocument":true}')
  assert.deepEqual(writes, [])
  release()
  await tick()
  await sync.changed(page.generation, '{"newDocument":true}')
  assert.deepEqual(writes, ['{"newDocument":true}'])
})

test('each page owns its readiness and disposal independently', async () => {
  const a = fixture()
  const b = fixture()
  let release!: () => void
  a.page.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  for (const { sync } of [a, b]) sync.receive('{"host":1}')
  await tick()
  await b.sync.changed(b.page.generation, '{"b":1}')
  assert.deepEqual(b.writes, ['{"b":1}'])
  a.sync.dispose()
  release()
  await tick()
  a.sync.start()
  a.sync.receive('{"host":2}')
  await a.sync.changed(a.page.generation, '{"a":1}')
  assert.deepEqual(a.writes, [])
  await b.sync.changed(b.page.generation, '{"b":2}')
  assert.deepEqual(b.writes, ['{"b":1}', '{"b":2}'])
})

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadDesktopConfig } from '../../src/main/config.ts'

test('desktop shortcuts load saved settings; environment overrides them', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ade-desktop-config-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'client.json')
  assert.deepEqual(loadDesktopConfig(path, {}), {
    url: undefined,
    token: undefined,
  })
  writeFileSync(
    path,
    '\uFEFF' +
      JSON.stringify({
        url: 'wss://example.com/companion',
        token: 'saved-token',
      }),
  )
  assert.deepEqual(loadDesktopConfig(path, {}), {
    url: 'wss://example.com/companion',
    token: 'saved-token',
  })
  assert.deepEqual(
    loadDesktopConfig(path, {
      ADE_COMPANION_URL: 'ws://localhost:4317/companion',
      ADE_COMPANION_TOKEN: '',
    }),
    { url: 'ws://localhost:4317/companion', token: '' },
  )
  for (const content of [
    '{broken',
    '{"unknown":true}',
    '{"token":42}',
    '{"token":"bad\\nheader"}',
    '{"url":"https://example.com"}',
    '{"url":"ws://user:password@example.com/companion"}',
  ]) {
    writeFileSync(path, content)
    assert.throws(() => loadDesktopConfig(path, {}))
  }
  writeFileSync(path, '{}')
  for (const url of [
    'garbage',
    'https://localhost/companion',
    'ws://localhost/wrong',
    'ws://user:secret@localhost/companion',
  ]) {
    assert.throws(
      () => loadDesktopConfig(path, { ADE_COMPANION_URL: url }),
      /Use a ws/,
    )
    writeFileSync(path, JSON.stringify({ url }))
    assert.throws(() => loadDesktopConfig(path, {}), /Use a ws/)
  }
  assert.equal(
    loadDesktopConfig(path, {
      ADE_COMPANION_URL: 'WS://LOCALHOST:80/companion',
    }).url,
    'ws://localhost/companion',
  )
})

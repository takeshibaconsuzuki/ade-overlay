import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  patchVscodeTerminalSerializer,
  TERMINAL_SERIALIZER_PATCH,
} from '../src/server/vscode-terminal-serializer-patch'
import { terminalSerializerFixture } from './fixtures/vscode-terminal-serializer'

test('serializer patch is idempotent and rejects incompatible or partial bundles', () => {
  const patched = patchVscodeTerminalSerializer(terminalSerializerFixture)
  assert.ok(patched.includes(TERMINAL_SERIALIZER_PATCH))
  assert.equal(patchVscodeTerminalSerializer(patched), patched)
  for (const source of [
    'unknown bundle',
    terminalSerializerFixture.repeat(2),
    patched.repeat(2),
    patched + terminalSerializerFixture,
    patched.replace('mouseStateService.activeEncoding', 'missing'),
  ]) {
    assert.throws(() => patchVscodeTerminalSerializer(source), /does not match/)
  }
})

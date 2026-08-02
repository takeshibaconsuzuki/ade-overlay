import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { findTerminalFileLinks } from '../../src/renderer/src/chat/terminalFileLinks'

test('finds terminal file paths and source locations', () => {
  assert.deepEqual(
    findTerminalFileLinks(
      'Changed /Users/me/repo/src/App.tsx:42:7 and src/main.ts#L9C2.',
    ).map(({ filePath, line, column }) => ({ filePath, line, column })),
    [
      {
        filePath: '/Users/me/repo/src/App.tsx',
        line: 42,
        column: 7,
      },
      { filePath: 'src/main.ts', line: 9, column: 2 },
    ],
  )
})

test('finds standalone, dot-relative, and Windows file paths', () => {
  assert.deepEqual(
    findTerminalFileLinks(
      'See `package.json`, ./README.md:3, ~/notes.md, and C:\\repo\\src\\main.ts:9.',
    ).map(({ filePath, line }) => ({ filePath, line })),
    [
      { filePath: 'package.json', line: undefined },
      { filePath: './README.md', line: 3 },
      { filePath: '~/notes.md', line: undefined },
      { filePath: 'C:\\repo\\src\\main.ts', line: 9 },
    ],
  )
})

test('does not treat web URLs as file links', () => {
  assert.deepEqual(
    findTerminalFileLinks('Visit https://example.com/docs/file.ts'),
    [],
  )
})

test('excludes markdown delimiters from linked paths', () => {
  assert.deepEqual(
    findTerminalFileLinks('[file](/tmp/example.ts:2)').map(
      ({ text, filePath, line }) => ({ text, filePath, line }),
    ),
    [
      {
        text: '/tmp/example.ts:2',
        filePath: '/tmp/example.ts',
        line: 2,
      },
    ],
  )
})

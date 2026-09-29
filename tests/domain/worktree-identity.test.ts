import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  editorId,
  worktreeKey,
} from '../../src/server/worktrees/worktree-identity.ts'

test('editor IDs preserve the hash encoding used by saved workspace directories', () => {
  const windows = process.platform === 'win32'
  const input = windows
    ? { project: 'C:\\Repos\\ADE', path: 'C:\\Worktrees\\Feature' }
    : { project: '/srv/ade/Project', path: '/srv/ade/Feature' }
  assert.equal(
    editorId(input),
    windows
      ? '68b9e6a0179d6786e58cd41093daf5b7711275603908b255a1ac95a291520f40'
      : '99daf4ade5993931bf798eb2fc744bebbfe73209eae4b52ab2c4c97ccc7d80a9',
  )
  const lowercase = {
    project: input.project.toLowerCase(),
    path: input.path.toLowerCase(),
  }
  assert.equal(editorId(input) === editorId(lowercase), windows)
  assert.equal(worktreeKey(input) === worktreeKey(lowercase), windows)
  assert.notEqual(editorId(input), editorId({ ...input, project: input.path }))
  assert.notEqual(
    worktreeKey(input),
    worktreeKey({ ...input, project: input.path }),
  )
})

test('cache keys and editor IDs resolve relative paths without requiring them to exist', () => {
  const relative = {
    project: './identity/project',
    path: './identity/branch/../worktree',
  }
  const absolute = {
    project: resolve('identity/project'),
    path: resolve('identity/worktree'),
  }
  assert.equal(worktreeKey(relative), worktreeKey(absolute))
  assert.equal(editorId(relative), editorId(absolute))
})

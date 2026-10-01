import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join, win32, posix } from 'node:path'
import { test } from 'node:test'
import { renderWorktreePath } from '../../src/shared/worktree-path-template.ts'

test('worktree path templates interpolate paths and compose utility filters', async () => {
  const project = join('repos', 'my project')
  assert.equal(
    await renderWorktreePath(
      undefined,
      project,
      'feature/login',
      process.platform === 'win32' ? 'win32' : 'posix',
    ),
    `${project}-feature-login`,
  )
  assert.equal(await renderWorktreePath(undefined, project, '', 'posix'), '')
  const hash = createHash('sha256')
    .update('feature/login')
    .digest('hex')
    .slice(0, 8)
  assert.equal(
    await renderWorktreePath(
      '{{ mainWorktreePath | dirname }}/{{ mainWorktreePath | basename }}-{{ branchName | filename | truncate: 7, "" }}-{{ branchName | hash | slice: 0, 8 }}',
      project,
      'feature/login',
      process.platform === 'win32' ? 'win32' : 'posix',
    ),
    `repos/my project-feature-${hash}`,
  )
  assert.equal(
    await renderWorktreePath(
      '../{{ branchName | replace: "/", "_" | downcase }}',
      project,
      'Feature/LOGIN',
      'posix',
    ),
    '../feature_login',
  )
  assert.equal(
    await renderWorktreePath(
      '{{ branchName }}',
      project,
      '{{ unknown }}',
      'posix',
    ),
    '{{ unknown }}',
  )
})

test('invalid templates and invalid generated paths produce actionable errors', async () => {
  for (const template of [
    '{{ missing }}',
    '{{ branchName | unknown }}',
    '{{ branchName',
    ' ',
    'a\0b',
    'a'.repeat(4097),
    '{% include "package.json" %}',
    '{% for n in (1..100000) %}{{ n }}{% endfor %}',
  ]) {
    await assert.rejects(
      () => renderWorktreePath(template, '/repo', 'branch', 'posix'),
      /Invalid worktreePathTemplate/,
    )
  }
})

test('local path helpers follow the companion platform, not the desktop platform', async () => {
  for (const [style, paths] of [
    ['win32', win32],
    ['posix', posix],
  ] as const) {
    for (const path of [
      'C:\\repos\\project',
      '\\\\server\\share\\project',
      '/repos/project',
      '/',
      'C:\\',
    ]) {
      assert.equal(
        await renderWorktreePath(
          '{{ mainWorktreePath | dirname }}|{{ mainWorktreePath | basename }}',
          path,
          'main',
          style,
        ),
        `${paths.dirname(path)}|${paths.basename(path)}`,
      )
    }
  }
})

import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { builtinModules } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'vite'

type Saved = Record<
  string,
  { pid: number; startedAt: string; terminalId: string }
>
const vscode = await import(
  new URL('../fixtures/chat-vscode.mjs', import.meta.url).href
)
let TerminalIdentities: typeof import('../../extensions/ade-terminals/src/terminal-identities.ts').TerminalIdentities
let root: string
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ade-terminal-identities-'))
  await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'vscode-fixture',
        resolveId: (id) =>
          id === 'vscode'
            ? {
                id: new URL('../fixtures/chat-vscode.mjs', import.meta.url)
                  .href,
                external: true,
              }
            : undefined,
      },
    ],
    build: {
      target: 'node22',
      outDir: root,
      emptyOutDir: false,
      lib: {
        entry: fileURLToPath(
          new URL(
            '../../extensions/ade-terminals/src/terminal-identities.ts',
            import.meta.url,
          ),
        ),
        formats: ['es'],
        fileName: () => 'terminal-identities.mjs',
      },
      rollupOptions: {
        external: [/^node:/, ...builtinModules, 'systeminformation'],
      },
    },
  })
  ;({ TerminalIdentities } = await import(
    pathToFileURL(join(root, 'terminal-identities.mjs')).href
  ))
})
after(async () => {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function storage(initial: Saved = {}) {
  let saved = initial
  const writes: Saved[] = []
  return {
    state: {
      keys: () => ['adeChatTerminals'],
      get: <T>() => saved as T,
      update: async (_key: string, value: Saved) => {
        saved = value
        writes.push(value)
      },
    },
    writes,
    read: () => saved,
  }
}
function terminal(pid: number | Promise<number>) {
  const value = { processId: Promise.resolve(pid), creationOptions: {} }
  vscode.window.terminals.push(value)
  return value as unknown as import('vscode').Terminal
}
function processes(...entries: [number, string][]) {
  return new Map(
    entries.map(([pid, startedAt]) => [
      pid,
      {
        pid,
        startedAt,
        parentPid: 1,
        name: 'shell',
        command: 'shell',
      },
    ]),
  )
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2500
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for terminal identity')
    await delay(5)
  }
}

test('explicit registration is immediate, ignores creation env and persists independently of PID discovery', async (t) => {
  vscode.window.terminals = []
  const saved = storage()
  let scans = 0
  const identities = new TerminalIdentities(saved.state, async () => {
    scans++
    return processes([101, 'shell-start'])
  })
  t.after(() => identities.dispose())
  const pid = deferred<number>()
  const created = terminal(pid.promise)
  Object.assign(created.creationOptions, {
    env: { ADE_TERMINAL_ID: 'environment-only' },
  })
  vscode.opened.fire(created)
  assert.equal(
    identities.id(created),
    undefined,
    'opening never discovers identity from env',
  )
  assert.equal(identities.find('environment-only'), undefined)
  identities.register(created, 'registered')
  assert.equal(identities.id(created), 'registered')
  assert.equal(identities.find('registered'), created)
  assert.equal(scans, 0)
  assert.deepEqual(saved.writes, [])
  pid.resolve(101)
  await until(() => saved.writes.length === 1)
  assert.equal(scans, 1)
  assert.deepEqual(saved.read(), {
    101: { pid: 101, startedAt: 'shell-start', terminalId: 'registered' },
  })
})

test('restored terminals match persisted PID and start identity without adopting env or layout', async (t) => {
  vscode.window.terminals = []
  const restored = terminal(101)
  const reused = terminal(102)
  const saved = storage({
    101: { pid: 101, startedAt: 'original', terminalId: 'restored' },
    102: { pid: 102, startedAt: 'old', terminalId: 'reused' },
    103: { pid: 103, startedAt: 'gone', terminalId: 'exited' },
  })
  let changes = 0
  const identities = new TerminalIdentities(saved.state, async () =>
    processes([101, 'original'], [102, 'new']),
  )
  identities.onDidChange(() => changes++)
  t.after(() => identities.dispose())
  await until(() => !!identities.id(restored))
  assert.equal(identities.find('restored'), restored)
  assert.equal(identities.id(reused), undefined)
  assert.equal(identities.find('reused'), undefined)
  assert.equal(changes, 1)
  assert.deepEqual(Object.keys(saved.read()), ['101'])
})

test('explicit registration supersedes recovery already started by the open event', async (t) => {
  vscode.window.terminals = []
  const scans: ReturnType<typeof deferred<ReturnType<typeof processes>>>[] = []
  const saved = storage({
    101: { pid: 101, startedAt: 'same-shell', terminalId: 'previous' },
  })
  const identities = new TerminalIdentities(saved.state, () => {
    const scan = deferred<ReturnType<typeof processes>>()
    scans.push(scan)
    return scan.promise
  })
  t.after(() => identities.dispose())
  const created = terminal(101)
  vscode.opened.fire(created)
  await until(() => scans.length === 1)
  identities.register(created, 'explicit')
  await until(() => scans.length === 2)
  scans[1].resolve(processes([101, 'same-shell']))
  await until(() => saved.writes.length === 1)
  scans[0].resolve(processes())
  await delay(20)
  assert.equal(identities.id(created), 'explicit')
  assert.equal(saved.read()[101].terminalId, 'explicit')
  assert.equal(saved.writes.length, 1)
})

test('an older scan cannot prune an identity saved by a newer registration', async (t) => {
  vscode.window.terminals = []
  const scans: ReturnType<typeof deferred<ReturnType<typeof processes>>>[] = []
  const saved = storage({
    102: { pid: 102, startedAt: 'old', terminalId: 'previous' },
  })
  const identities = new TerminalIdentities(saved.state, () => {
    const scan = deferred<ReturnType<typeof processes>>()
    scans.push(scan)
    return scan.promise
  })
  t.after(() => identities.dispose())
  identities.register(terminal(101), 'first')
  await until(() => scans.length === 1)
  identities.register(terminal(102), 'second')
  await until(() => scans.length === 2)
  scans[1].resolve(processes([101, 'first-start'], [102, 'new-start']))
  await until(() => saved.writes.length === 1)
  scans[0].resolve(processes([101, 'first-start']))
  await until(() => saved.writes.length === 2)
  assert.equal(saved.read()[101].terminalId, 'first')
  assert.deepEqual(saved.read()[102], {
    pid: 102,
    startedAt: 'new-start',
    terminalId: 'second',
  })
})

test('closing a terminal clears identity and saved state while late discovery is ignored', async (t) => {
  vscode.window.terminals = []
  const scan = deferred<ReturnType<typeof processes>>()
  const saved = storage({
    101: { pid: 101, startedAt: 'original', terminalId: 'registered' },
  })
  let scanning = false
  const identities = new TerminalIdentities(saved.state, () => {
    scanning = true
    return scan.promise
  })
  t.after(() => identities.dispose())
  const created = terminal(101)
  identities.register(created, 'registered')
  await until(() => scanning)
  vscode.window.terminals = []
  vscode.closed.fire(created)
  assert.equal(identities.id(created), undefined)
  await until(() => saved.writes.length === 1)
  scan.resolve(processes([101, 'original']))
  await delay(20)
  assert.deepEqual(saved.read(), {})
  assert.equal(saved.writes.length, 1)
})

test('disposal cancels discovery and retry without disposing terminals or deleting saved identities', async () => {
  vscode.window.terminals = []
  const scan = deferred<ReturnType<typeof processes>>()
  const saved = storage()
  let scanning = false
  const identities = new TerminalIdentities(saved.state, () => {
    scanning = true
    return scan.promise
  })
  const created = terminal(101)
  identities.register(created, 'registered')
  await until(() => scanning)
  identities.dispose()
  scan.resolve(processes([101, 'original']))
  await delay(20)
  assert.equal(identities.id(created), undefined)
  assert.deepEqual(vscode.window.terminals, [created])
  assert.deepEqual(saved.writes, [])
})

test('temporarily unavailable process identity retries outside registration', async (t) => {
  vscode.window.terminals = []
  const saved = storage()
  let scans = 0
  const identities = new TerminalIdentities(saved.state, async () =>
    ++scans === 1 ? processes() : processes([101, 'available']),
  )
  t.after(() => identities.dispose())
  const created = terminal(101)
  identities.register(created, 'registered')
  assert.equal(identities.id(created), 'registered')
  await until(() => saved.read()[101]?.startedAt === 'available')
  assert.equal(scans, 2)
})

/* eslint-disable @typescript-eslint/no-require-imports -- Probe CommonJS extension initialization in a fresh process. */
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')
const { join } = require('node:path')

const calls = []
let phase = 'initialization'
for (const name of [
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'spawn',
  'spawnSync',
]) {
  const original = childProcess[name]
  childProcess[name] = function (...args) {
    const options = args.find(
      (arg) => arg && typeof arg === 'object' && !Array.isArray(arg),
    )
    const env = options?.env ?? process.env
    calls.push({
      name,
      phase,
      hasControl: Object.keys(env).some(
        (key) => key.toUpperCase() === 'ADE_CHAT_EXTENSION_TOKEN',
      ),
    })
    return Reflect.apply(original, this, args)
  }
}
syncBuiltinESMExports()

// Only a synthetic token enters this isolated process.
process.env.ADE_CHAT_EXTENSION_TOKEN = 'credential-isolation-test'
delete process.env.ADE_CHAT_ENDPOINT
require(join(process.argv[2], 'chats.cjs'))
const { TerminalIdentities } = require(
  join(process.argv[2], 'terminal-identities.cjs'),
)
const vscode = require(join(process.argv[2], 'chat-vscode.cjs'))
let saved = {}
const identities = new TerminalIdentities({
  get: () => saved,
  update: async (_key, value) => {
    saved = value
  },
})

async function run() {
  try {
    assert.equal(process.env.ADE_CHAT_EXTENSION_TOKEN, undefined)
    for (const nextPhase of ['first scan', 'later scan']) {
      phase = nextPhase
      const terminal = { processId: Promise.resolve(process.pid) }
      vscode.window.terminals.push(terminal)
      identities.register(terminal, phase)
      const deadline = Date.now() + 5000
      while (saved[process.pid]?.terminalId !== phase) {
        assert.ok(
          Date.now() < deadline,
          'the real identity scanner must persist the process',
        )
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.ok(
        calls.some((call) => call.phase === phase),
        'each scan must exercise subprocess creation',
      )
    }
    assert.deepEqual(
      calls.filter((call) => call.hasControl),
      [],
      'control credentials reached a scanner subprocess',
    )
  } finally {
    identities.dispose()
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

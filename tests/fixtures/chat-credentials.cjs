/* eslint-disable @typescript-eslint/no-require-imports -- Probe CommonJS extension initialization in a fresh process. */
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')

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
const { ChatController } = require(process.argv[2])
const controller = new ChatController({
  workspaceState: { get: () => ({}), update: async () => {} },
})

async function run() {
  try {
    assert.equal(process.env.ADE_CHAT_EXTENSION_TOKEN, undefined)
    for (const nextPhase of ['first scan', 'later scan']) {
      phase = nextPhase
      const processes = await controller.readProcesses()
      assert.ok(processes.has(process.pid), 'the real scanner must still work')
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
    controller.dispose()
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

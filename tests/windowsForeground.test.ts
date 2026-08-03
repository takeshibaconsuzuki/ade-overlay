import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { allowWindowsForegroundActivation } from '../src/server/windowsForeground'

type LogEntry = {
  fields: unknown
  message: string
}

function createLog() {
  const debug: LogEntry[] = []
  const warn: LogEntry[] = []
  return {
    debug,
    warn,
    log: {
      debug: (fields: unknown, message: string) => {
        debug.push({ fields, message })
      },
      warn: (fields: unknown, message: string) => {
        warn.push({ fields, message })
      },
    },
  }
}

test('skips foreground permission handoff outside Windows', async () => {
  const { log } = createLog()
  let ran = false

  const granted = await allowWindowsForegroundActivation(123, log, {
    platform: 'darwin',
    run: async () => {
      ran = true
    },
  })

  assert.equal(granted, true)
  assert.equal(ran, false)
})

test('grants Windows foreground permission to the requested pid', async () => {
  const { debug, log, warn } = createLog()
  let receivedProcessId: number | undefined

  const granted = await allowWindowsForegroundActivation(456, log, {
    platform: 'win32',
    run: async (processId) => {
      receivedProcessId = processId
    },
  })

  assert.equal(granted, true)
  assert.equal(receivedProcessId, 456)
  assert.equal(debug[0]?.message, 'granted foreground activation')
  assert.deepEqual(warn, [])
})

test('falls back when Windows foreground permission cannot be granted', async () => {
  const { debug, log, warn } = createLog()
  const failure = new Error('denied')

  const granted = await allowWindowsForegroundActivation(789, log, {
    platform: 'win32',
    run: async () => {
      throw failure
    },
  })

  assert.equal(granted, false)
  assert.deepEqual(debug, [])
  assert.equal(warn[0]?.message, 'failed to grant foreground activation')
  assert.deepEqual(warn[0]?.fields, { err: failure, processId: 789 })
})

test('rejects an invalid Windows process id without running the helper', async () => {
  const { log, warn } = createLog()
  let ran = false

  const granted = await allowWindowsForegroundActivation(undefined, log, {
    platform: 'win32',
    run: async () => {
      ran = true
    },
  })

  assert.equal(granted, false)
  assert.equal(ran, false)
  assert.equal(
    warn[0]?.message,
    'cannot grant foreground activation without a pid',
  )
})

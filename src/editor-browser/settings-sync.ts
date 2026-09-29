import { openDB } from 'idb'
import { SettingsSnapshot } from '../shared/settings-snapshot'

const key = 'ade.settings-sync.v2'
const lockName = key
const channel = new BroadcastChannel('vscode.indexedDB.vscode-userdata.changes')
let closed = false
let lastError = ''
const remembered = (): SettingsSnapshot | undefined => {
  const stored = localStorage.getItem(key)
  return stored ? SettingsSnapshot.from(JSON.parse(stored)) : undefined
}
const remember = (value: SettingsSnapshot) =>
  localStorage.setItem(key, JSON.stringify(value))
const decode = (value: string | BufferSource | undefined): string =>
  value === undefined
    ? '{}\n'
    : typeof value === 'string'
      ? value
      : new TextDecoder().decode(value)
const open = async () => {
  // Let VS Code create/upgrade its own database and object stores first.
  if (
    !(await indexedDB.databases()).some(
      (database) => database.name === 'vscode-web-db',
    )
  )
    throw new Error('Waiting for VS Code browser storage.')
  const database = await openDB('vscode-web-db', undefined, {
    // It may have disappeared since enumeration; only VS Code may create it.
    upgrade: (_database, _oldVersion, _newVersion, transaction) => {
      transaction.abort()
      // The open request reports the failure; also consume the transaction's rejection.
      void transaction.done.catch(() => {})
    },
  })
  if (!database.objectStoreNames.contains('vscode-userdata-store')) {
    database.close()
    throw new Error('Unsupported VS Code browser storage.')
  }
  return database
}
const read = async (): Promise<string> => {
  const database = await open()
  try {
    return decode(
      await database.get('vscode-userdata-store', '/User/settings.json'),
    )
  } finally {
    database.close()
  }
}
const snapshot = async (): Promise<SettingsSnapshot> => {
  const content = await read()
  const previous = remembered()
  const current =
    previous?.content === content
      ? previous
      : new SettingsSnapshot(content, previous ? Date.now() : 0)
  remember(current)
  return current
}
const notify = () =>
  channel.postMessage([
    {
      type: 0,
      resource: { scheme: 'vscode-userdata', path: '/User/settings.json' },
      adeSettingsSync: true,
    },
  ])
const apply = async (
  expected: SettingsSnapshot,
  replacement: SettingsSnapshot,
) => {
  const database = await open()
  try {
    // Read and replace in one transaction; an edit arriving during the HTTP
    // request must be picked up on the next cycle instead of being overwritten.
    const transaction = database.transaction(
      'vscode-userdata-store',
      'readwrite',
    )
    const [applied] = await Promise.all([
      (async () => {
        const current = decode(
          await transaction.store.get('/User/settings.json'),
        )
        // Both the native file and its last observed save must still match.
        // This also protects a newer A -> B -> A save during the request.
        if (!remembered()?.equals(expected) || current !== expected.content)
          return false
        if (current !== replacement.content)
          await transaction.store.put(
            new TextEncoder().encode(replacement.content),
            '/User/settings.json',
          )
        return true
      })(),
      transaction.done,
    ])
    if (applied) {
      remember(replacement)
      if (replacement.content !== expected.content) notify()
    }
    return applied
  } finally {
    database.close()
  }
}
const report = (error: unknown) => {
  const message = String(error)
  if (message !== lastError) console.warn('[ADE] Settings sync:', message)
  lastError = message
}
const observe = () => {
  // Profile initialization is not a user save and must not replace local settings.
  if (!performance.getEntriesByName('code/didStartWorkbench').length) return
  const savedAt = Date.now()
  void navigator.locks
    .request(lockName, async () => {
      // Every native save creates a snapshot, including unchanged contents.
      if (!closed) remember(new SettingsSnapshot(await read(), savedAt))
    })
    .catch(report)
}
channel.onmessage = (event) => {
  if (
    event.data.some(
      (change: { resource: { path: string }; adeSettingsSync?: boolean }) =>
        // Our copies still notify VS Code, but must not become new saves.
        !change.adeSettingsSync &&
        change.resource.path === '/User/settings.json',
    )
  )
    observe()
}
// Main calls these functions through executeJavaScript. This page has no
// polling loop, network requests, Node access or renderer-to-main IPC bridge.
const storage = {
  read: () =>
    navigator.locks.request(lockName, () => {
      // Wait for configuration restoration before sending change notifications.
      if (
        closed ||
        !performance.getEntriesByName('code/didStartWorkbench').length
      )
        return undefined
      return snapshot()
    }),
  apply: (expected: SettingsSnapshot, replacement: SettingsSnapshot) =>
    navigator.locks.request(lockName, () => {
      if (closed) return false
      return apply(
        SettingsSnapshot.from(expected),
        SettingsSnapshot.from(replacement),
      )
    }),
}
;(
  globalThis as typeof globalThis & { adeSettingsSync?: typeof storage }
).adeSettingsSync = storage
addEventListener(
  'pagehide',
  () => {
    closed = true
    channel.close()
  },
  { once: true },
)

import { SettingsSnapshot } from '../shared/editor-settings.ts'

export function settingsSyncScript(): string {
  return `(${startSettingsSync.toString()})(${SettingsSnapshot.toString()});`
}

// Serialized into a same-origin script with its shared snapshot class. Apart
// from that argument, this function must not reference imports or module values.
function startSettingsSync(Snapshot: typeof SettingsSnapshot): void {
  const key = 'ade.settings-sync.v2'
  const lockName = key
  const channel = new BroadcastChannel(
    'vscode.indexedDB.vscode-userdata.changes',
  )
  let closed = false
  let lastError = ''
  const remembered = (): SettingsSnapshot | undefined => {
    const stored = localStorage.getItem(key)
    return stored ? Snapshot.from(JSON.parse(stored)) : undefined
  }
  const remember = (value: SettingsSnapshot) =>
    localStorage.setItem(key, JSON.stringify(value))
  const migrate = async (
    content: string,
  ): Promise<SettingsSnapshot | undefined> => {
    const stored = localStorage.getItem('ade.settings-sync.v1')
    if (!stored) return undefined
    const previous = JSON.parse(stored)
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(content),
        ),
      ),
      (value) => value.toString(16).padStart(2, '0'),
    ).join('')
    return new Snapshot(
      content,
      previous.hash === digest ? previous.modifiedAt : Date.now(),
    )
  }
  const open = async (): Promise<IDBDatabase> => {
    // Let VS Code create/upgrade its own database and object stores first.
    if (
      !(await indexedDB.databases()).some(
        (database) => database.name === 'vscode-web-db',
      )
    )
      throw new Error('Waiting for VS Code browser storage.')
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('vscode-web-db')
      request.onsuccess = () => {
        if (
          !request.result.objectStoreNames.contains('vscode-userdata-store')
        ) {
          request.result.close()
          reject(new Error('Unsupported VS Code browser storage.'))
        } else resolve(request.result)
      }
      request.onerror = () => reject(request.error)
    })
  }
  const read = async (): Promise<string> => {
    const database = await open()
    try {
      return await new Promise((resolve, reject) => {
        const request = database
          .transaction('vscode-userdata-store')
          .objectStore('vscode-userdata-store')
          .get('/User/settings.json')
        request.onsuccess = () =>
          resolve(
            request.result === undefined
              ? '{}\n'
              : typeof request.result === 'string'
                ? request.result
                : new TextDecoder().decode(request.result),
          )
        request.onerror = () => reject(request.error)
      })
    } finally {
      database.close()
    }
  }
  const snapshot = async (): Promise<SettingsSnapshot> => {
    const content = await read()
    const previous = remembered() ?? (await migrate(content))
    const current =
      previous?.content === content
        ? previous
        : new Snapshot(content, previous ? Date.now() : 0)
    remember(current)
    localStorage.removeItem('ade.settings-sync.v1')
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
      const applied = await new Promise<boolean>((resolve, reject) => {
        const transaction = database.transaction(
          'vscode-userdata-store',
          'readwrite',
        )
        const store = transaction.objectStore('vscode-userdata-store')
        const request = store.get('/User/settings.json')
        let changed = false
        request.onsuccess = () => {
          const current =
            request.result === undefined
              ? '{}\n'
              : typeof request.result === 'string'
                ? request.result
                : new TextDecoder().decode(request.result)
          // Both the native file and its last observed save must still match.
          // This also protects a newer A -> B -> A save during the request.
          if (!remembered()?.equals(expected) || current !== expected.content)
            return
          changed = true
          if (current !== replacement.content)
            store.put(
              new TextEncoder().encode(replacement.content),
              '/User/settings.json',
            )
        }
        transaction.oncomplete = () => resolve(changed)
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
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
        if (!closed) remember(new Snapshot(await read(), savedAt))
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
        return apply(Snapshot.from(expected), Snapshot.from(replacement))
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
}

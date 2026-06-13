import { type UserDataPayload } from './userData'

export type EditorBootstrapPayload = UserDataPayload & {
  targetUrl: string
}

declare global {
  interface Window {
    __ADE_EDITOR_BOOTSTRAP__: EditorBootstrapPayload
  }
}

export function runEditorBootstrap(payload: EditorBootstrapPayload): void {
  const markerKey = 'ade-overlay-user-data-hash'

  function openDatabase(version?: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('vscode-web-db', version)
      request.onupgradeneeded = () => {
        const db = request.result
        for (const store of [
          'vscode-userdata-store',
          'vscode-logs-store',
          'vscode-filehandles-store',
        ]) {
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store)
          }
        }
      }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
  }

  function decodeBase64(value: string): Uint8Array {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }

  function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
  }

  function txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }

  function isOwnedUserDataKey(key: IDBValidKey): key is string {
    return (
      typeof key === 'string' &&
      (/^\/User\/[^/]+\.json$/.test(key) || key.startsWith('/User/snippets/'))
    )
  }

  async function getStoredKeys(db: IDBDatabase): Promise<IDBValidKey[]> {
    const tx = db.transaction('vscode-userdata-store', 'readonly')
    const request = tx.objectStore('vscode-userdata-store').getAllKeys()
    const keys = await requestResult(request)
    await txDone(tx)
    return keys
  }

  async function writePayload(
    db: IDBDatabase,
    staleKeys: IDBValidKey[],
  ): Promise<void> {
    const tx = db.transaction('vscode-userdata-store', 'readwrite')
    const store = tx.objectStore('vscode-userdata-store')
    for (const key of staleKeys) {
      if (isOwnedUserDataKey(key)) {
        store.delete(key)
      }
    }
    for (const file of payload.files) {
      store.put(decodeBase64(file.contentBase64), file.path)
    }
    await txDone(tx)
  }

  void (async () => {
    if (localStorage.getItem(markerKey) !== payload.hash) {
      let db: IDBDatabase
      try {
        db = await openDatabase(3)
      } catch {
        db = await openDatabase()
      }
      const staleKeys = await getStoredKeys(db)
      await writePayload(db, staleKeys)
      db.close()
      localStorage.setItem(markerKey, payload.hash)
    }
    location.replace(payload.targetUrl)
  })().catch((error: unknown) => {
    console.error(error)
    location.replace(payload.targetUrl)
  })
}

export function getEditorBootstrapClientScript(): string {
  return `const payload = window.__ADE_EDITOR_BOOTSTRAP__;\n(${runEditorBootstrap.toString()})(payload);\n`
}

import type { WebContents } from 'electron'
import {
  settingsSnapshotSchema,
  type SettingsSnapshot,
} from '../shared/editor-settings.ts'

function snapshot(value: unknown): SettingsSnapshot {
  const parsed = settingsSnapshotSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid settings sync snapshot.')
  return parsed.data
}

// A single coordinator belongs to each companion-origin browser session. Views
// only provide access to the shared IndexedDB file and observe browser saves.
export class EditorSettingsSync {
  private readonly views = new Map<WebContents, { url: URL; token: string }>()
  private timer?: ReturnType<typeof setTimeout>
  private pending?: Promise<void>
  private abort?: AbortController
  private preferred?: WebContents
  private closed = false
  private lastError = ''

  constructor(private readonly origin: string) {}

  add(contents: WebContents, url: URL, token: string): void {
    if (this.closed || url.origin !== this.origin) return
    if (!this.views.has(contents))
      contents.once('destroyed', () => this.remove(contents))
    this.views.set(contents, { url, token })
    if (!this.pending && !this.timer) this.schedule(0)
  }

  private remove(contents: WebContents): void {
    this.views.delete(contents)
    if (!this.views.size) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.abort?.abort()
    }
  }

  private schedule(delay: number): void {
    if (this.closed || !this.views.size) return
    this.timer = setTimeout(() => void this.sync(), delay)
    this.timer.unref()
  }

  // Also used after a companion reconnect. Concurrent triggers share one run.
  sync(): Promise<void> {
    if (this.closed || !this.views.size) return Promise.resolve()
    if (this.pending) return this.pending
    clearTimeout(this.timer)
    this.timer = undefined
    const abort = new AbortController()
    this.abort = abort
    let delay = 60_000
    this.pending = this.run(abort.signal)
      .then((ready) => {
        if (!ready) delay = 1000 // Workbench initialization, without HTTP polling.
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        const message = String(error)
        if (message !== this.lastError)
          console.warn('[ADE] Settings sync:', message)
        this.lastError = message
      })
      .finally(() => {
        this.pending = undefined
        this.abort = undefined
        this.schedule(delay)
      })
    return this.pending
  }

  private async run(signal: AbortSignal): Promise<boolean> {
    let failure: unknown
    const views = [...this.views.keys()]
    if (this.preferred && this.views.has(this.preferred)) {
      views.splice(views.indexOf(this.preferred), 1)
      views.unshift(this.preferred)
    }
    for (const contents of views) {
      signal.throwIfAborted()
      const target = this.views.get(contents)
      if (!target || contents.isDestroyed()) continue
      try {
        const current = await this.evaluate(
          contents,
          target.url,
          'globalThis.adeSettingsSync?.read()',
          signal,
        )
        if (current === undefined) continue
        const expected = snapshot(current)
        const response = await contents.session.fetch(
          new URL('ade-settings-sync', target.url).href,
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${target.token}`,
            },
            body: JSON.stringify(expected),
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          },
        )
        if (!response.ok)
          throw new Error(`Companion returned ${response.status}; retrying.`)
        // Avoid logging response bodies or JSON parser excerpts: settings may
        // contain private values. Validate the snapshot before passing it back.
        const result = snapshot(await response.json().catch(() => undefined))
        await this.evaluate(
          contents,
          target.url,
          `globalThis.adeSettingsSync?.apply(${JSON.stringify(expected)}, ${JSON.stringify(result)})`,
          signal,
        )
        this.preferred = contents
        this.lastError = ''
        return true
      } catch (error) {
        failure = error
      }
    }
    if (failure) throw failure
    return false
  }

  private evaluate(
    contents: WebContents,
    url: URL,
    script: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted()
    const current = contents.isDestroyed() ? null : URL.parse(contents.getURL())
    // Workspace selection changes the query, while this editor's identity stays
    // at the same origin and document path. Never pass settings to another page.
    if (current?.origin !== url.origin || current.pathname !== url.pathname)
      return Promise.reject(new Error('Editor view is no longer available.'))
    // A stalled renderer must not block other views or application shutdown.
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error('Editor settings storage timed out.')),
        10_000,
      )
      const aborted = () => finish(new Error('Settings sync stopped.'))
      const finish = (error?: unknown, value?: unknown) => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', aborted)
        if (error) reject(error)
        else resolve(value)
      }
      signal.addEventListener('abort', aborted, { once: true })
      void contents.executeJavaScript(script).then(
        (value) => finish(undefined, value),
        (error: unknown) => finish(error),
      )
    })
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.abort?.abort()
    this.views.clear()
  }
}

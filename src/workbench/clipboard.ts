import type { WorkbenchServices } from './services'

interface BrowserClipboardService {
  readText(type?: string): Promise<string>
  writeText(text: string, type?: string): Promise<void>
}

// The terminal addon names the system clipboard, but the browser service treats
// named types as private stores. Its system clipboard is the unnamed destination.
export function installClipboard(services: WorkbenchServices): {
  dispose(): void
} {
  const clipboard = services.get('clipboardService') as BrowserClipboardService
  const { readText, writeText } = clipboard
  // The lazy service proxy caches bound methods on its target. Assignment changes
  // the backing instance but leaves that cache intact, so replace the own methods.
  const replace = (methods: BrowserClipboardService) => {
    for (const [key, value] of Object.entries(methods))
      Object.defineProperty(clipboard, key, {
        value,
        configurable: true,
        writable: true,
      })
  }
  replace({
    readText: (type) =>
      readText.call(clipboard, type === 'clipboard' ? undefined : type),
    writeText: (text, type) =>
      writeText.call(clipboard, text, type === 'clipboard' ? undefined : type),
  })
  return {
    dispose() {
      replace({ readText, writeText })
    },
  }
}

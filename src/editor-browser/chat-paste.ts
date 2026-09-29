import { readPaste, type PasteInput } from './paste-content'
import type { PasteBridge } from '../shared/paste'

function terminalTarget(target: EventTarget | null): target is Element {
  return target instanceof Element && !!target.closest('.xterm')
}

export function installChatPaste(
  bridge: PasteBridge | undefined = window.adePaste,
): () => void {
  if (!bridge) return () => {}
  let closed = false
  let queue = Promise.resolve()
  const released = new WeakSet<ClipboardEvent>()
  // Reserve now, while focus and the paste gesture are current. Serialize only
  // delivery, so slow image reads cannot let a later paste overtake this one.
  const gate = (
    input: Promise<PasteInput>,
    ordinary: (text: string) => void,
  ) => {
    // Prepare each chat paste independently. Waiting for prior submissions
    // before downloading images would consume this reservation's lifetime.
    const ready = Promise.all([bridge.reservePaste(), input]).then(
      async ([id, captured]) => ({
        id,
        text: captured.text,
        parts: id !== null && !closed ? await readPaste(captured) : undefined,
      }),
    )
    void ready.catch(() => {})
    const operation = queue.then(async () => {
      const { id, text, parts } = await ready
      if (closed) return
      if (id === null) ordinary(text)
      else if (parts) {
        // Submit in source order, consuming each reservation promptly. The
        // companion prepares images concurrently and orders terminal delivery.
        void bridge
          .paste(id, parts)
          .catch((error: unknown) => console.warn('[ADE paste]', error))
      }
    })
    queue = operation.catch((error: unknown) =>
      console.warn('[ADE paste]', error),
    )
    return queue
  }
  const paste = (event: ClipboardEvent) => {
    const target = event.target
    const data = event.clipboardData
    if (released.has(event) || !terminalTarget(target) || !data) return
    event.preventDefault()
    event.stopImmediatePropagation()
    // DataTransfer is readable only during dispatch, before any IPC awaits.
    const input: PasteInput = {
      text: data.getData('text/plain'),
      html: data.getData('text/html'),
      images: Array.from(data.files).filter((file) =>
        file.type.startsWith('image/'),
      ),
    }
    void gate(Promise.resolve(input), (text) => {
      if (!target.isConnected) return
      const transfer = new DataTransfer()
      transfer.setData('text/plain', text)
      const resumed = new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      })
      released.add(resumed)
      target.dispatchEvent(resumed)
    })
  }
  document.addEventListener('paste', paste, true)

  // VS Code's keyboard/context-menu command reads text directly. Capture rich
  // formats during that same gesture, then hold its result behind the same gate.
  const clipboard = navigator.clipboard
  const original = clipboard?.readText
  const capture = async (): Promise<PasteInput> => {
    if (clipboard.read) {
      try {
        const items = await clipboard.read()
        const input: PasteInput = { text: '', html: '', images: [] }
        for (const item of items) {
          for (const type of item.types) {
            if (type === 'text/plain')
              input.text += await (await item.getType(type)).text()
            else if (type === 'text/html')
              input.html += await (await item.getType(type)).text()
            else if (type.startsWith('image/'))
              input.images.push(await item.getType(type))
          }
        }
        return input
      } catch (error) {
        console.warn(
          '[ADE paste] Rich clipboard read failed; capturing plain text.',
          error,
        )
      }
    }
    return { text: await original.call(clipboard), html: '', images: [] }
  }
  const readText = async () => {
    // Accepted limitation: terminal-directed commands (including custom bindings
    // or extension calls) can read the clipboard while focus remains elsewhere.
    // Those pastes bypass interception; this check preserves normal editor paste.
    if (!terminalTarget(document.activeElement)) return original.call(clipboard)
    let text = ''
    await gate(capture(), (value) => {
      text = value
    })
    return text
  }
  if (clipboard) clipboard.readText = readText
  const dispose = () => {
    closed = true
    document.removeEventListener('paste', paste, true)
    if (clipboard?.readText === readText) clipboard.readText = original
    removeEventListener('pagehide', dispose)
  }
  addEventListener('pagehide', dispose, { once: true })
  return dispose
}

import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { pasteItemsSchema } from '../shared/paste-schema.ts'
import type { PastePart } from '../shared/paste.ts'
import { pasteChannels } from '../shared/paste.ts'

// Focus events reach the page in the task that focuses it; poll between tasks.
const pageFocused = `new Promise((resolve) => {
  const deadline = Date.now() + 1000
  const poll = () =>
    document.hasFocus() || Date.now() > deadline
      ? resolve(document.hasFocus())
      : setTimeout(poll, 10)
  poll()
})`

// Main supplies document identity; the companion owns reservations and targets.
export function installEditorPaste(
  contents: WebContents,
  isActive: () => boolean,
  isEditorUrl: (url: URL | null) => boolean,
  focus: () => void,
  reserve: (documentId: string) => Promise<string | null>,
  submit: (
    documentId: string,
    reservationId: string,
    items: PastePart[],
  ) => Promise<unknown>,
): () => void {
  let documentId = randomUUID()
  const assertSender = (event: IpcMainInvokeEvent) => {
    if (
      contents.isDestroyed() ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame ||
      !isActive() ||
      !isEditorUrl(URL.parse(contents.getURL()))
    )
      throw new Error('Untrusted paste caller.')
  }
  contents.ipc.handle(
    pasteChannels.reserve,
    async (event, trustedTransfer: unknown) => {
      assertSender(event)
      const document = documentId
      if (trustedTransfer === 'drop') {
        // A drag from another application leaves this window in the
        // background, where the page cannot focus the dropped terminal. The
        // extension targets VS Code's active terminal, so wait for that focus.
        focus()
        if ((await contents.executeJavaScript(pageFocused)) !== true)
          throw new Error('The editor window could not be focused.')
        assertSender(event)
      } else if (
        trustedTransfer !== 'paste' &&
        (await contents.executeJavaScript(
          'navigator.userActivation.isActive',
        )) !== true
      )
        throw new Error('Paste requires a user gesture.')
      const id = await reserve(document)
      assertSender(event)
      if (documentId !== document)
        throw new Error('The editor document changed.')
      return id
    },
  )
  contents.ipc.handle(
    pasteChannels.paste,
    async (event, id: unknown, input: unknown) => {
      assertSender(event)
      if (typeof id !== 'string' || id.length > 128)
        throw new Error('Invalid paste reservation.')
      await submit(documentId, id, pasteItemsSchema.parse(input))
    },
  )
  const navigate = (
    _event: unknown,
    _url: string,
    inPlace: boolean,
    mainFrame: boolean,
  ) => {
    if (mainFrame && !inPlace) {
      documentId = randomUUID()
    }
  }
  contents.on('did-start-navigation', navigate)
  return () => {
    documentId = randomUUID()
    contents.removeListener('did-start-navigation', navigate)
    if (!contents.isDestroyed()) {
      contents.ipc.removeHandler(pasteChannels.reserve)
      contents.ipc.removeHandler(pasteChannels.paste)
    }
  }
}

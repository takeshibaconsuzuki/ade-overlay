import { setTimeout as delay } from 'node:timers/promises'

// sendInputEvent requires concrete modifiers rather than accelerator aliases.
export const commandOrControl =
  process.platform === 'darwin' ? 'meta' : 'control'

// Evaluates to whether VS Code's quick input has keyboard focus. The widget
// stays in the document while hidden, so its presence does not mean it is open.
export const quickInputFocused =
  "!!document.activeElement?.matches('.quick-input-widget input')"

export async function key(contents, keyCode, modifiers = []) {
  contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

// Presses the key that types `letter` on the current keyboard layout. VS Code
// resolves letter shortcuts through the layout, so a fixed key position is a
// different shortcut on, for example, Dvorak.
const punctuation = {
  Semicolon: ';',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
}
export async function letterKey(contents, letter, modifiers = []) {
  const code = await contents
    .executeJavaScript(
      `navigator.keyboard.getLayoutMap().then(map => [...map].find(([, value]) => value === ${JSON.stringify(letter)})?.[0])`,
    )
    .catch(() => undefined)
  await key(
    contents,
    punctuation[code] ??
      /^Key([A-Z])$/.exec(code ?? '')?.[1] ??
      letter.toUpperCase(),
    modifiers,
  )
}

// Opens VS Code's command palette and waits until it keeps keyboard focus.
// Focusing the page makes VS Code refocus its open editor a moment later,
// which closes a palette opened in between; press F1 again when that happens.
export async function openCommandPalette(contents) {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    await key(contents, 'F1')
    await delay(300)
    if (await contents.executeJavaScript(quickInputFocused)) return
  }
  throw new Error('Timed out: command palette')
}

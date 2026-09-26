// sendInputEvent requires concrete modifiers rather than accelerator aliases.
export const commandOrControl =
  process.platform === 'darwin' ? 'meta' : 'control'

export async function key(contents, keyCode, modifiers = []) {
  contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

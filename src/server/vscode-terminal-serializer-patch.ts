// Internal serializer contract of the pinned xterm distribution; checked on upgrades.
const anchor = '_serializeModes(t){let e="";const r=t.modes;'
export const TERMINAL_SERIALIZER_PATCH = `_serializeModes(t){let e="";
switch(t._core.mouseStateService.activeEncoding){
  case "SGR":e+="\u001b[?1006h";break;
  case "SGR_PIXELS":e+="\u001b[?1016h";break;
}
const r=t.modes;`

// Replay must restore mouse encoding together with tracking, or movement becomes input.
export function patchVscodeTerminalSerializer(source: string): string {
  const patched = source.split(TERMINAL_SERIALIZER_PATCH).length - 1
  if (patched === 1 && !source.includes(anchor)) return source
  if (patched !== 0 || source.split(anchor).length !== 2)
    throw new Error(
      'VS Code terminal serializer does not match the ADE patch; check the pinned distribution',
    )
  return source.replace(anchor, () => TERMINAL_SERIALIZER_PATCH)
}

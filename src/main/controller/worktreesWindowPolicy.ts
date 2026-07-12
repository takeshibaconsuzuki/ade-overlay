export function shouldCloseWorktreesWindowOnBlur({
  hasOpenNativeDialog,
}: {
  hasOpenNativeDialog: boolean
}): boolean {
  return !hasOpenNativeDialog
}

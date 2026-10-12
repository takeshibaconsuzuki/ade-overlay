export function quotePosixArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

// cmd.exe expands percent references even inside quotes; reject them in literal paths.
export function quoteCmdPath(value: string): string {
  if (/["%\r\n]/.test(value))
    throw new Error('Unsupported character in command path')
  return `"${value}"`
}

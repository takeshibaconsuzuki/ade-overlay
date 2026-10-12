export function quotePosixArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

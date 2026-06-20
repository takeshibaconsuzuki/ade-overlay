export type DroppedFile = {
  name: string
  type: string
}

export function droppedFilePathInput<FileType extends DroppedFile>(
  files: Iterable<FileType>,
  getPathForFile: (file: FileType) => string,
): string | null {
  const paths = [...files].map(getPathForFile).filter((path) => path.length > 0)

  return paths.length > 0 ? `${paths.map(quoteDroppedPath).join(' ')} ` : null
}

export function isFileDropItem(item: DataTransferItem): boolean {
  return item.kind === 'file'
}

function quoteDroppedPath(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`
}

import type { WorkbenchServices } from './services'

// Only the internal contracts used by downloads are described here. VS Code owns the objects.
// eslint-disable-next-line @typescript-eslint/no-namespace -- Type-only workbench contracts.
declare namespace DownloadServices {
  interface Resource {
    scheme: string
    path: string
  }
  interface FileService {
    resolve(
      resource: Resource,
      options: { resolveMetadata: true },
    ): Promise<{ name: string; isFile: boolean }>
    readFile(resource: Resource): Promise<{ value: { buffer: Uint8Array } }>
  }
  interface ProgressService {
    withProgress<T>(
      options: { location: 10; delay: number; title: string },
      task: () => Promise<T>,
    ): Promise<T>
  }
}

function isResource(value: unknown): value is DownloadServices.Resource {
  const resource = value as DownloadServices.Resource | null
  return (
    typeof resource === 'object' &&
    resource !== null &&
    typeof resource.scheme === 'string' &&
    typeof resource.path === 'string'
  )
}

// Saves one file the same way VS Code's explorer download does in a browser: the content is read
// into memory and handed to the page as a download, which the desktop turns into a save dialog.
export async function downloadResource(
  handle: WorkbenchServices,
  resource: unknown,
): Promise<void> {
  if (!isResource(resource)) throw new Error('Invalid download resource')
  const files = handle.get('fileService') as DownloadServices.FileService
  const progress = handle.get(
    'progressService',
  ) as DownloadServices.ProgressService
  const stat = await files.resolve(resource, { resolveMetadata: true })
  if (!stat.isFile) throw new Error(`${stat.name} is not a file`)
  const content = await progress.withProgress(
    { location: 10, delay: 800, title: `Downloading ${stat.name}` }, // ProgressLocation.Window
    () => files.readFile(resource),
  )
  const url = URL.createObjectURL(
    new Blob([content.value.buffer as Uint8Array<ArrayBuffer>]),
  )
  const anchor = document.createElement('a')
  anchor.download = stat.name
  anchor.href = url
  document.body.appendChild(anchor)
  anchor.click()
  setTimeout(() => {
    anchor.remove()
    URL.revokeObjectURL(url)
  })
}

import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { x as extractTar } from 'tar'
import { Open } from 'unzipper'

export async function extractVscodeArchive(
  archive: string,
  destination: string,
  releaseUrl: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  await mkdir(destination)
  const filename = new URL(releaseUrl).pathname
  if (filename.endsWith('.zip')) {
    await extractZip(archive, destination, signal)
  } else if (filename.endsWith('.tar.gz')) {
    await pipeline(
      createReadStream(archive),
      extractTar({ cwd: destination, strict: true }),
      { signal },
    )
  } else {
    throw new Error(`Unsupported VS Code Server archive format: ${filename}`)
  }
  signal.throwIfAborted()
}

async function extractZip(
  archive: string,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  const zip = await Open.file(archive)
  const permissions = new Map<string, number>()
  for (const file of zip.files) {
    const mode = file.externalFileAttributes >>> 16
    if ((mode & 0o170000) === 0o120000)
      throw new Error('Unexpected symlink in VS Code Server archive')
    permissions.set(
      resolve(join(destination, file.path.replaceAll('\\', '/'))),
      mode & 0o777 || 0o644,
    )
  }
  const written: string[] = []
  const options = {
    path: destination,
    concurrency: 4,
    getWriter: ({ path }: { path: string }) => {
      // unzipper checks containment before calling the writer.
      written.push(path)
      return createWriteStream(path)
    },
  }
  await zip.extract(options)
  if (process.platform !== 'win32') {
    for (const path of written) {
      signal.throwIfAborted()
      // Restore executable bits after extraction, independently of the umask.
      await chmod(path, permissions.get(path)!)
    }
  }
}

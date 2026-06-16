import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join, relative, sep } from 'node:path'
import { type Logger } from '../../api/server/logger'
import { readJsonFile } from '../json'

export type UserDataFile = {
  path: string
  contentBase64: string
}

export type UserDataPayload = {
  files: UserDataFile[]
  hash: string
}

type InstalledExtension = {
  identifier: { id: string }
  version?: string
  relativeLocation: string
  metadata?: unknown
}

/**
 * Mirror the user's desktop extensions into a worktree's serve-web extensions
 * directory.
 *
 * Symlink the extension folders.
 * Register every linked extension in `extensions.json`.
 * We drive both the symlinks and the manifest from the desktop's own
 * `extensions.json`, which already excludes obsolete/superseded versions, so we
 * never link duplicate versions of the same extension.
 */
export async function symlinkLocalExtensions(
  targetDir: string,
  log: Logger,
): Promise<void> {
  const sourceDir = join(homedir(), '.vscode', 'extensions')
  try {
    const sourceStat = await stat(sourceDir)
    if (!sourceStat.isDirectory()) {
      return
    }
  } catch {
    return
  }

  await mkdir(targetDir, { recursive: true })
  const installed = await readInstalledExtensions(sourceDir)
  const registered = await Promise.all(
    installed.map(async (extension) => {
      const source = join(sourceDir, extension.relativeLocation)
      const target = join(targetDir, extension.relativeLocation)
      if (!(await ensureSymlink(source, target, log))) {
        return null
      }
      return manifestEntry(extension, target)
    }),
  )

  await mergeManifest(
    targetDir,
    registered.filter((entry): entry is ManifestEntry => entry !== null),
  )
}

/**
 * Ensure `target` is a directory symlink pointing at `source`, returning whether
 * it ends up correct. Idempotent.
 */
async function ensureSymlink(
  source: string,
  target: string,
  log: Logger,
): Promise<boolean> {
  let existing
  try {
    existing = await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err: error, target }, 'extension lstat failed')
      return false
    }
  }

  if (existing) {
    if (existing.isSymbolicLink() && (await readlink(target)) === source) {
      return true
    }
    await rm(target, { recursive: true, force: true })
  }

  try {
    await symlink(source, target, 'dir')
    return true
  } catch (error) {
    log.warn({ err: error, source, target }, 'extension symlink failed')
    return false
  }
}

/**
 * The extensions the desktop VS Code considers installed. Prefer its
 * `extensions.json` (already free of obsolete/superseded versions); fall back to
 * scanning the directory and reading each `package.json` when it is missing.
 */
async function readInstalledExtensions(
  sourceDir: string,
): Promise<InstalledExtension[]> {
  const manifest = await readJsonFile<unknown[]>(
    join(sourceDir, 'extensions.json'),
  )
  if (Array.isArray(manifest)) {
    return manifest.filter(isInstalledExtension)
  }

  const entries = await readdir(sourceDir, { withFileTypes: true })
  const scanned = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<InstalledExtension | null> => {
        const pkg = await readJsonFile<{
          name?: unknown
          publisher?: unknown
          version?: unknown
        }>(join(sourceDir, entry.name, 'package.json'))
        if (
          typeof pkg?.name !== 'string' ||
          typeof pkg.publisher !== 'string'
        ) {
          return null
        }
        return {
          identifier: { id: `${pkg.publisher}.${pkg.name}` },
          version: typeof pkg.version === 'string' ? pkg.version : undefined,
          relativeLocation: entry.name,
        }
      }),
  )
  return scanned.filter((entry): entry is InstalledExtension => entry !== null)
}

type ManifestEntry = {
  identifier: { id: string }
  version?: string
  location: { $mid: 1; path: string; scheme: 'file' }
  relativeLocation: string
  metadata?: unknown
}

function manifestEntry(
  extension: InstalledExtension,
  target: string,
): ManifestEntry {
  return {
    identifier: extension.identifier,
    version: extension.version,
    location: { $mid: 1, path: target, scheme: 'file' },
    relativeLocation: extension.relativeLocation,
    metadata: extension.metadata,
  }
}

/**
 * Write `entries` into the worktree manifest, preserving any entries already
 * present for ids we are not registering.
 */
async function mergeManifest(
  targetDir: string,
  entries: ManifestEntry[],
): Promise<void> {
  const manifestPath = join(targetDir, 'extensions.json')
  const existing = await readJsonFile<unknown[]>(manifestPath)
  const registeredIds = new Set(entries.map((entry) => entry.identifier.id))
  const preserved = Array.isArray(existing)
    ? existing.filter((entry) => {
        const id = (entry as { identifier?: { id?: unknown } })?.identifier?.id
        return typeof id === 'string' && !registeredIds.has(id)
      })
    : []
  await writeFile(
    manifestPath,
    JSON.stringify([...preserved, ...entries]),
    'utf8',
  )
}

function isInstalledExtension(entry: unknown): entry is InstalledExtension {
  const candidate = entry as InstalledExtension
  return (
    typeof candidate?.identifier?.id === 'string' &&
    typeof candidate?.relativeLocation === 'string'
  )
}

export async function readUserDataPayload(): Promise<UserDataPayload> {
  const userDir = getCodeUserDir()
  const files: UserDataFile[] = []

  await collectUserDataFiles(userDir, userDir, files)
  files.sort((left, right) => left.path.localeCompare(right.path))

  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.contentBase64)
    hash.update('\0')
  }

  return { files, hash: hash.digest('hex') }
}

function getCodeUserDir(): string {
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Code', 'User')
  }
  if (platform() === 'win32') {
    return join(
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'Code',
      'User',
    )
  }
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'Code',
    'User',
  )
}

async function collectUserDataFiles(
  root: string,
  directory: string,
  files: UserDataFile[],
): Promise<void> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }

  await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = join(directory, entry.name)
      const projectPath = relative(root, absolutePath).split(sep).join('/')

      if (entry.isDirectory()) {
        if (projectPath === 'snippets') {
          await collectUserDataFiles(root, absolutePath, files)
        }
        return
      }

      if (!entry.isFile() || !shouldImportUserFile(projectPath)) {
        return
      }

      const content = await readFile(absolutePath)
      files.push({
        path: `/User/${projectPath}`,
        contentBase64: content.toString('base64'),
      })
    }),
  )
}

function shouldImportUserFile(projectPath: string): boolean {
  return (
    (projectPath.endsWith('.json') && !projectPath.includes('/')) ||
    projectPath.startsWith('snippets/')
  )
}

import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
} from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join, relative, sep } from 'node:path'
import { type Logger } from '../../api/server/logger'

export type UserDataFile = {
  path: string
  contentBase64: string
}

export type UserDataPayload = {
  files: UserDataFile[]
  hash: string
}

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
  const entries = await readdir(sourceDir, { withFileTypes: true })
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const source = join(sourceDir, entry.name)
        const target = join(targetDir, entry.name)
        try {
          await lstat(target)
          return
        } catch {
          // Create the symlink below.
        }
        try {
          await symlink(source, target, 'dir')
        } catch (error) {
          log.warn({ err: error, source, target }, 'extension symlink failed')
        }
      }),
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

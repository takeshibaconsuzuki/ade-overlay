import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import envPaths from 'env-paths'
import lockfile from 'proper-lockfile'
import pRetry from 'p-retry'
import { z } from 'zod'
import { APP_NAME } from '../shared/constants'
import type { HttpClient } from '../shared/http-client'
import { logger } from '../shared/logger'
import { VSCODE_SERVER_COMMIT } from './constants'
import { extractVscodeArchive } from './vscode-archive'
import { prepareVscodeWorkbench } from './vscode-workbench-patch'

const log = logger.child({ component: 'vscode-runtime' })
const paths = envPaths(APP_NAME)
const releaseSchema = z.object({
  version: z.string().regex(/^[a-f0-9]{40}$/),
  sha256hash: z.string().regex(/^[a-f0-9]{64}$/),
  url: z.url().refine((value) => new URL(value).protocol === 'https:'),
})
type Release = z.infer<typeof releaseSchema>

export interface VscodeInstallation {
  node: string
  entrypoint: string
}

export interface VscodeRuntime {
  readonly dataDirectory: string
  prepare(signal: AbortSignal): Promise<VscodeInstallation>
}

export function vscodePlatform(
  platform = process.platform,
  arch = process.arch,
): string {
  if (
    !['win32', 'darwin', 'linux'].includes(platform) ||
    !['x64', 'arm64'].includes(arch)
  ) {
    throw new Error(`VS Code Server is not supported on ${platform}/${arch}`)
  }
  if (platform === 'darwin' && arch === 'x64') return 'server-darwin-web'
  return `server-${platform}-${arch}-web`
}

async function installationAt(directory: string): Promise<VscodeInstallation> {
  const installation = {
    node: join(directory, process.platform === 'win32' ? 'node.exe' : 'node'),
    entrypoint: join(directory, 'out', 'server-main.js'),
  }
  await Promise.all([
    access(installation.node),
    access(installation.entrypoint),
  ])
  return installation
}

export class DownloadedVscodeRuntime implements VscodeRuntime {
  readonly dataDirectory: string
  private readonly cacheDirectory: string
  private pending: Promise<VscodeInstallation> | undefined

  constructor(
    private readonly http: HttpClient,
    options: {
      cacheDirectory?: string
      dataDirectory?: string
    } = {},
  ) {
    this.cacheDirectory = resolve(
      options.cacheDirectory ?? join(paths.cache, 'vscode-server'),
    )
    this.dataDirectory = resolve(
      options.dataDirectory ?? join(paths.data, 'vscode-server'),
    )
  }

  prepare(signal: AbortSignal): Promise<VscodeInstallation> {
    signal.throwIfAborted()
    this.pending ??= this.install(signal)
    return this.pending
  }

  private async install(signal: AbortSignal): Promise<VscodeInstallation> {
    const platform = vscodePlatform()
    const directory = join(this.cacheDirectory, platform)
    await mkdir(directory, { recursive: true })
    return this.withInstallationLock(directory, signal, (lockedSignal) =>
      this.loadOrInstall(directory, platform, lockedSignal),
    )
  }

  private async withInstallationLock(
    directory: string,
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<VscodeInstallation>,
  ): Promise<VscodeInstallation> {
    // Separate ADE processes share the installation without publishing partial downloads.
    const lockController = new AbortController()
    signal = AbortSignal.any([signal, lockController.signal])
    let releaseLock: (() => Promise<void>) | undefined
    try {
      await pRetry(
        async () => {
          releaseLock = await lockfile.lock(directory, {
            onCompromised: (error) => lockController.abort(error),
          })
        },
        {
          retries: 300,
          minTimeout: 500,
          maxTimeout: 1000,
          signal,
          shouldRetry: ({ error }) =>
            'code' in error && error.code === 'ELOCKED',
        },
      )
      signal.throwIfAborted()
      return await action(signal)
    } finally {
      await releaseLock?.()
    }
  }

  private async readCached(
    target: string,
  ): Promise<VscodeInstallation | undefined> {
    try {
      const cached = releaseSchema.parse(
        JSON.parse(await readFile(join(target, 'ade-release.json'), 'utf8')),
      )
      if (cached.version === VSCODE_SERVER_COMMIT)
        return await installationAt(target)
    } catch {
      // An incomplete or invalid cache entry is replaced by a verified download.
    }
    return undefined
  }

  private async loadOrInstall(
    directory: string,
    platform: string,
    signal: AbortSignal,
  ): Promise<VscodeInstallation> {
    const target = join(directory, VSCODE_SERVER_COMMIT)
    const cached = await this.readCached(target)
    signal.throwIfAborted()
    if (cached) {
      await prepareVscodeWorkbench(target)
      return cached
    }
    const downloadSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(300_000),
    ])
    log.info({ platform }, 'Downloading VS Code Server')
    const release = await this.fetchRelease(platform, downloadSignal)
    const staging = await mkdtemp(join(directory, 'download-'))
    try {
      const archive = join(staging, 'archive')
      await this.downloadArchive(release, archive, downloadSignal)
      const extracted = await this.extractArchive(
        archive,
        join(staging, 'unpacked'),
        release.url,
        signal,
      )
      return await this.publishInstallation(extracted, target, release, signal)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  private async fetchRelease(
    platform: string,
    signal: AbortSignal,
  ): Promise<Release> {
    const metadata = await this.http.fetch(
      `https://update.code.visualstudio.com/api/versions/commit:${VSCODE_SERVER_COMMIT}/${platform}/stable`,
      { signal },
    )
    if (!metadata.ok)
      throw new Error(
        `VS Code Server release lookup failed: HTTP ${metadata.status}`,
      )
    const release = releaseSchema.parse(await metadata.json())
    if (release.version !== VSCODE_SERVER_COMMIT)
      throw new Error('VS Code Server release does not match the pinned commit')
    return release
  }

  private async downloadArchive(
    release: Release,
    archive: string,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.http.fetch(release.url, { signal })
    if (!response.ok || !response.body)
      throw new Error(`VS Code Server download failed: HTTP ${response.status}`)
    const hash = createHash('sha256')
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk)
          callback(null, chunk)
        },
      }),
      createWriteStream(archive, { flags: 'wx' }),
      { signal },
    )
    if (hash.digest('hex') !== release.sha256hash)
      throw new Error('VS Code Server download checksum mismatch')
  }

  private async extractArchive(
    archive: string,
    unpacked: string,
    releaseUrl: string,
    signal: AbortSignal,
  ): Promise<string> {
    await extractVscodeArchive(archive, unpacked, releaseUrl, signal)
    // Microsoft archives contain a single distribution directory.
    const entries = await readdir(unpacked, { withFileTypes: true })
    if (entries.length !== 1 || !entries[0].isDirectory())
      throw new Error('Unexpected VS Code Server archive layout')
    const extracted = join(unpacked, entries[0].name)
    await installationAt(extracted)
    return extracted
  }

  private async publishInstallation(
    extracted: string,
    target: string,
    release: Release,
    signal: AbortSignal,
  ): Promise<VscodeInstallation> {
    await prepareVscodeWorkbench(extracted)
    await writeFile(
      join(extracted, 'ade-release.json'),
      JSON.stringify(release),
    )
    signal.throwIfAborted()
    await rm(target, { recursive: true, force: true })
    await rename(extracted, target)
    log.info({ version: release.version }, 'VS Code Server installed')
    return await installationAt(target)
  }
}

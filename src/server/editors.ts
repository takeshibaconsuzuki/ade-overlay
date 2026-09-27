import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import type { Logger } from 'pino'
import { silentLogger } from './logging.ts'
import type {
  EditorSession,
  OpenEditorInput,
  Worktree,
} from '../shared/companion.ts'
import type { ServerConfig } from './config.ts'
import { EditorRuntimeManager } from './vscode-runtime.ts'
import { codeEnvironment, stopProcess } from './code-cli.ts'
import {
  importLocalVSCode,
  prepareEditorSettings,
  type ImportedProfile,
} from './local-vscode.ts'
import { SettingsSync } from './settings-sync.ts'
import type { ChatService } from './chat-service.ts'

interface RunningEditor {
  session: EditorSession
  state: Worktree['editor']
  token: string
  port?: number
  child?: ChildProcess
  ready: Promise<EditorSession>
  abort: AbortController
  detail?: string
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted()
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export function editorId(worktree: OpenEditorInput): string {
  const paths = [worktree.project, worktree.path].map((path) => {
    const absolute = resolve(path)
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  })
  return createHash('sha256').update(paths.join('\0')).digest('hex')
}

export class EditorManager extends EventEmitter<{ status: [] }> {
  private readonly entries = new Map<string, RunningEditor>()
  private readonly dataDir: string
  private readonly runtimes: EditorRuntimeManager
  private readonly config: ServerConfig['editor']
  private profile?: ImportedProfile
  private settings?: SettingsSync
  private environment?: Promise<void>
  private extensions?: string
  private closing = false
  private readonly logger: Logger
  private readonly chats?: ChatService
  private readonly shutdown = new AbortController()

  constructor(
    config: ServerConfig['editor'] = {},
    logger: Logger = silentLogger,
    runtimes?: EditorRuntimeManager,
    chats?: ChatService,
  ) {
    super()
    this.chats = chats
    this.logger = logger
    this.config = config
    this.dataDir = resolve(
      config?.dataDir ?? join(homedir(), '.ade-overlay', 'editors'),
    )
    this.runtimes = runtimes ?? new EditorRuntimeManager(this.dataDir, logger)
    this.runtimes.on('progress', (message) => {
      for (const pending of this.entries.values())
        if (pending.state === 'starting' && !pending.child)
          pending.detail = message
      this.emit('status')
    })
  }

  startUpdates(): void {
    this.runtimes.startUpdates()
  }

  status(worktree: OpenEditorInput): Worktree['editor'] {
    return this.entries.get(editorId(worktree))?.state ?? 'stopped'
  }

  detail(worktree: OpenEditorInput): string | undefined {
    return this.entries.get(editorId(worktree))?.detail
  }

  target(id: string):
    | {
        url: string
        token: string
        profile?: ImportedProfile
        settings: SettingsSync
      }
    | undefined {
    const entry = this.entries.get(id)
    return entry?.state === 'running' && entry.port && this.settings
      ? {
          url: `http://127.0.0.1:${entry.port}`,
          token: entry.token,
          profile: this.profile,
          settings: this.settings,
        }
      : undefined
  }

  open(worktree: OpenEditorInput): Promise<EditorSession> {
    if (this.closing)
      return Promise.reject(new Error('The companion is shutting down.'))
    const id = editorId(worktree)
    const existing = this.entries.get(id)
    if (existing) {
      this.logger.info(
        { editorId: id, state: existing.state },
        'Reusing editor session',
      )
      return existing.ready
    }
    const token = randomBytes(32).toString('hex')
    const session = { id, path: `/editors/${id}/`, accessToken: token }
    const entry: RunningEditor = {
      session,
      token,
      state: 'starting',
      ready: Promise.resolve(session),
      abort: new AbortController(),
      detail: 'Preparing VS Code',
    }
    this.entries.set(id, entry)
    this.emit('status')
    entry.ready = this.start(entry, worktree).catch(async (error: unknown) => {
      this.logger.error({ editorId: id, err: error }, 'Editor startup failed')
      await this.dispose(entry)
      throw error
    })
    return entry.ready
  }

  private async start(
    entry: RunningEditor,
    worktree: OpenEditorInput,
  ): Promise<EditorSession> {
    this.environment ??= (async () => {
      const progress = (message: string) => {
        for (const pending of this.entries.values())
          if (pending.state === 'starting' && !pending.child)
            pending.detail = message
        this.emit('status')
      }
      const code = await this.runtimes.localCode()
      this.extensions = this.config?.localExtensionsDir ?? code.extensionsDir
      await mkdir(this.extensions, { recursive: true })
      this.logger.info(
        { extensionsDir: this.extensions },
        'Sharing the local VS Code extensions directory',
      )
      progress('Preparing local VS Code settings sync')
      const imported = await importLocalVSCode(
        this.config,
        code,
        this.shutdown.signal,
      )
      this.profile = imported.profile
      this.settings = new SettingsSync(
        join(
          this.config?.localUserDataDir ?? code.userDataDir,
          'User',
          'settings.json',
        ),
        this.logger,
      )
    })().catch((error: unknown) => {
      this.environment = undefined
      throw error
    })
    await abortable(this.environment, entry.abort.signal)
    const runtime = await abortable(this.runtimes.get(), entry.abort.signal)
    const logger = this.logger.child({
      editorId: entry.session.id,
      worktree: worktree.path,
    })
    entry.detail = 'Starting VS Code'
    this.emit('status')
    const directory = join(this.dataDir, 'workspaces', entry.session.id)
    const userData = join(directory, 'data')
    await prepareEditorSettings(userData, this.dataDir)
    const tokenFile = join(directory, 'connection-token')
    await writeFile(tokenFile, entry.token, { mode: 0o600 })
    entry.abort.signal.throwIfAborted()
    const logPath = join(directory, 'server.log')
    const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 })
    log.on('error', (error) =>
      logger.error({ err: error }, 'Could not write editor log'),
    )
    logger.info({ logFile: logPath }, 'Launching VS Code')
    const chatEnvironment = this.chats?.environment(entry.session.id, worktree)
    const extensionToken = this.chats?.extensionToken(entry.session.id)
    const child = spawn(
      runtime.executable,
      [
        ...(extensionToken
          ? [
              fileURLToPath(
                new URL(
                  import.meta.url.endsWith('.ts')
                    ? './editor-bootstrap.ts'
                    : './editor-bootstrap.js',
                  import.meta.url,
                ),
              ),
            ]
          : []),
        runtime.entrypoint,
        '--accept-server-license-terms',
        // The user selects worktrees from their configured companion projects.
        // Scope automatic trust to these editor processes, not desktop settings.
        '--disable-workspace-trust',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--server-base-path',
        entry.session.path.slice(0, -1),
        '--connection-token-file',
        tokenFile,
        '--server-data-dir',
        directory,
        '--user-data-dir',
        userData,
        '--extensions-dir',
        this.extensions!,
        '--default-folder',
        worktree.path,
        '--telemetry-level',
        'off',
        // Retain disconnected extension hosts and terminals for a week.
        '--reconnection-grace-time',
        String(this.config?.reconnectionGraceSeconds ?? 7 * 24 * 60 * 60),
      ],
      {
        cwd: worktree.path,
        windowsHide: true,
        env: {
          ...codeEnvironment(),
          ...chatEnvironment,
        },
        stdio: extensionToken
          ? ['ignore', 'pipe', 'pipe', 'ipc']
          : ['ignore', 'pipe', 'pipe'],
      },
    )
    entry.child = child
    let failure: Error | undefined
    let output = ''
    child.on('error', (error) => {
      failure = error
    })
    if (extensionToken)
      child.once('spawn', () =>
        child.send(extensionToken, (error) => {
          if (error) failure ??= error
        }),
      )
    for (const [stream, name] of [
      [child.stdout!, 'stdout'],
      [child.stderr!, 'stderr'],
    ] as const) {
      createInterface({ input: stream }).on('line', (line) => {
        const safe = line
          .replaceAll(entry.token, '[redacted]')
          .replaceAll(extensionToken ?? entry.token, '[redacted]')
        log.write(safe + '\n')
        logger.debug({ stream: name, output: safe }, 'VS Code output')
      })
    }
    child.once('close', () => log.end())
    child.stdout!.on('data', (data: Buffer) => {
      output = (output + data.toString()).slice(-8192)
      const match = /Extension host agent listening on (\d+)/.exec(output)
      if (match) entry.port = Number(match[1])
    })
    child.once('exit', (code, signal) => {
      logger.info({ code, signal }, 'VS Code exited')
      if (this.entries.get(entry.session.id) === entry) {
        this.chats?.releaseEditor(entry.session.id)
        this.entries.delete(entry.session.id)
        this.emit('status')
      }
    })
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      entry.abort.signal.throwIfAborted()
      if (failure) throw failure
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `VS Code exited during startup. See ${join(directory, 'server.log')}.`,
        )
      if (entry.port) {
        const url = `http://127.0.0.1:${entry.port}${entry.session.path}`
        const ready = await fetch(url, {
          headers: { Cookie: `vscode-tkn=${entry.token}` },
          signal: AbortSignal.any([
            AbortSignal.timeout(2000),
            entry.abort.signal,
          ]),
        })
          .then(async (response) => {
            // VS Code only supports GET here. Consume the small workbench
            // document within the request timeout instead of waiting on cancel.
            await response.arrayBuffer()
            return response.ok
          })
          .catch(() => false)
        if (ready) {
          entry.state = 'running'
          entry.detail = undefined
          logger.info(
            { port: entry.port, pid: child.pid },
            'VS Code is accepting connections',
          )
          this.emit('status')
          return entry.session
        }
      }
      await delay(100, undefined, { signal: entry.abort.signal })
    }
    throw new Error(
      `VS Code startup timed out. See ${join(directory, 'server.log')}.`,
    )
  }

  async stop(worktree: OpenEditorInput): Promise<void> {
    await this.stopId(editorId(worktree))
  }

  async retain(worktrees: OpenEditorInput[]): Promise<void> {
    const ids = new Set(worktrees.map(editorId))
    await Promise.all(
      [...this.entries.keys()]
        .filter((id) => !ids.has(id))
        .map((id) => this.stopId(id)),
    )
  }

  private async stopId(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.abort.abort(new Error('Editor startup was cancelled.'))
    await entry.ready.catch(() => {})
    await this.dispose(entry)
  }

  private async dispose(entry: RunningEditor): Promise<void> {
    if (entry.child) await stopProcess(entry.child)
    if (this.entries.get(entry.session.id) === entry) {
      this.chats?.releaseEditor(entry.session.id)
      this.entries.delete(entry.session.id)
      this.emit('status')
    }
  }

  async close(): Promise<void> {
    this.closing = true
    this.shutdown.abort(new Error('Companion is shutting down.'))
    await Promise.all([
      this.runtimes.close(),
      ...[...this.entries.keys()].map((id) => this.stopId(id)),
    ])
    await this.environment?.catch(() => {})
    await this.settings?.settled()
  }
}

import { z } from 'zod'

export type ConnectionState = 'connecting' | 'connected' | 'retrying' | 'closed'

export interface Worktree {
  path: string
  basename: string
  branchName: string | null
}

export const chatSchema = z.strictObject({
  providerId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  worktreePath: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(['idle', 'working']),
  // Unix milliseconds, captured when the server receives the report.
  mtime: z.int().nonnegative(),
  // The owning provider process, never the short-lived hook process.
  pid: z
    .int()
    .positive()
    .max(2 ** 31 - 1),
})

export type Chat = z.infer<typeof chatSchema>

export interface VscodeServerStatus {
  path: string
  state: 'stopped' | 'starting' | 'running'
  error?: { id: string; message: string }
  // Authenticated browser route, available once the server is ready.
  browserPath?: string
}

export interface ServerMethods {
  // Keys are provider ID + ":" + session ID; sessions can share worktrees and processes.
  getChats(): Record<string, Chat>
  getServerInfo(): { name: string }
  refreshWorktrees(): Promise<void>
  ensureVscodeServer(path: string): void
  clearVscodeServerError(path: string, errorId: string): void
  writeSettings(content: string): Promise<void>
}

export const clientInfoSchema = z.strictObject({
  kind: z.enum(['desktop', 'extension']),
  name: z.string().min(1),
  version: z.string().min(1),
})

export type ClientInfo = z.infer<typeof clientInfoSchema>

export interface ClientMethods {
  getClientInfo(): ClientInfo
}

export interface DesktopClientMethods extends ClientMethods {
  getClientInfo(): ClientInfo & { kind: 'desktop' }
  worktreesChanged(worktrees: Worktree[]): void
  vscodeServersChanged(statuses: VscodeServerStatus[]): void
  // A complete host document is sent on every connection and change. null suspends sync.
  settingsChanged(content: string | null): void
}

export interface ExtensionClientMethods extends ClientMethods {
  getClientInfo(): ClientInfo & { kind: 'extension' }
  // Complete live registry, sent after identification on every connection and change.
  // Descriptions are truncated previews; other fields retain their reported values.
  chatsChanged(chats: Record<string, Chat>): void
}

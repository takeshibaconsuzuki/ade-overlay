import { z } from 'zod'

export type ConnectionState = 'connecting' | 'connected' | 'retrying' | 'closed'

export interface WorktreeInfo {
  path: string
  basename: string
  branchName: string | null
}

export const chatSchema = z.strictObject({
  providerId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  // Present for chats launched in an ADE terminal; inherited across session changes.
  terminalId: z.uuid().optional(),
  worktreePath: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(['idle', 'working']),
  // Unix milliseconds, captured when the server receives the report.
  mtime: z.int().nonnegative(),
  // Unix milliseconds of the last observed user prompt or turn end; absent until observed.
  lastActivityAt: z.int().nonnegative().optional(),
  // The owning provider process, never the short-lived hook process.
  pid: z
    .int()
    .positive()
    .max(2 ** 31 - 1),
})

export type Chat = z.infer<typeof chatSchema>

export const chatTerminalLaunchSchema = z.strictObject({
  worktreePath: z.string().min(1),
  terminalId: z.uuid(),
  providerId: z.string().min(1),
  shellPath: z.string().min(1),
  shellArgs: z.array(z.string()),
})

export type ChatTerminalLaunch = z.infer<typeof chatTerminalLaunchSchema>

export interface Worktree extends WorktreeInfo {
  mainWorktreePath: string
  // Remains true through server termination and Git removal. Success removes the
  // worktree from the snapshot; failure clears it and retains a dismissible error.
  deleting: boolean
  // Latest operation failure. Retained across successful operations until explicitly
  // dismissed; a newer failure replaces it. Error IDs protect against stale dismissals.
  error?: { id: string; message: string }
  vscode: VscodeServerStatus
}

export interface VscodeServerStatus {
  path: string
  state: 'stopped' | 'starting' | 'running' | 'stopping'
  // Authenticated browser route, available once the server is ready.
  browserPath?: string
}

export interface ExtensionIdentifier {
  id: string
  uuid?: string
}

export interface ServerMethods {
  // Keys are provider ID + ":" + session ID; sessions can share worktrees and processes.
  getChats(): Record<string, Chat>
  getServerInfo(): { name: string }
  refreshWorktrees(): Promise<void>
  // Lifecycle commands acknowledge acceptance, not completion. Validation errors
  // reject the call; subsequent progress and failures arrive in worktreesChanged.
  // Different worktrees run independently. Repeated requests are idempotent;
  // starting a stopping server or a deleting worktree is rejected.
  ensureVscodeServer(path: string): void
  stopVscodeServer(path: string): void
  // Supplying the expected branch also requests its safe local deletion. If only
  // branch deletion fails, the worktree is removed and its main worktree reports the error.
  deleteWorktree(path: string, branchName?: string): void
  clearWorktreeError(path: string, errorId: string): void
  // Fresh host profile snapshot for each editor startup. Rejects when unavailable.
  getDisabledExtensions(): Promise<ExtensionIdentifier[]>
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
  // A chat changed from working to idle.
  chatTurnFinished(
    id: string,
    title: string,
    worktreeBasename: string,
    description: string,
  ): void
  chatsChanged(chats: Record<string, Chat>): void
  // Complete authoritative snapshot, also sent on connection. May precede command acknowledgment.
  worktreesChanged(worktrees: Worktree[]): void
  // A complete host document is sent on every connection and change. null suspends sync.
  settingsChanged(content: string | null): void
}

export interface ExtensionClientMethods extends ClientMethods {
  getClientInfo(): ClientInfo & { kind: 'extension' }
  // Complete live registry, sent after identification on every connection and change.
  // Descriptions are truncated previews; other fields retain their reported values.
  chatsChanged(chats: Record<string, Chat>): void
}

import { z } from 'zod'

export const COMPANION_PROTOCOL_VERSION = 1
export const DEFAULT_COMPANION_PORT = 4317
export const DEFAULT_COMPANION_URL = `ws://127.0.0.1:${DEFAULT_COMPANION_PORT}/companion`
export const MAX_MESSAGE_BYTES = 16 * 1024
export const MAX_SERVER_MESSAGE_BYTES = 16 * 1024 * 1024

export const companionChannels = {
  status: 'companion:status',
  getStatus: 'companion:get-status',
  reconnect: 'companion:reconnect',
  listWorktrees: 'companion:worktrees:list',
  refreshWorktrees: 'companion:worktrees:refresh',
  createWorktree: 'companion:worktrees:create',
  deleteWorktree: 'companion:worktrees:delete',
  setWorktreeError: 'companion:worktrees:set-error',
  openEditor: 'companion:editor:open',
  worktreesUpdated: 'companion:worktrees:updated',
} as const

export interface CompanionStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
  url: string
  error?: string
}

export interface PingResult {
  roundTripMs: number
}

export interface CompanionAPI {
  getStatus(): Promise<CompanionStatus>
  reconnect(): Promise<CompanionStatus>
  onStatus(callback: (status: CompanionStatus) => void): () => void
  listWorktrees(): Promise<WorktreeSnapshot>
  refreshWorktrees(): Promise<WorktreeSnapshot>
  createWorktree(input: CreateWorktreeInput): Promise<WorktreeSnapshot>
  deleteWorktree(input: DeleteWorktreeInput): Promise<WorktreeSnapshot>
  setWorktreeError(input: SetWorktreeErrorInput): Promise<WorktreeSnapshot>
  openEditor(input: OpenEditorInput): Promise<void>
  onWorktreesUpdated(callback: (update: WorktreeUpdate) => void): () => void
}

const idSchema = z.string().min(1).max(128)
const argumentSchema = z
  .string()
  .max(4096)
  .refine((value) => !value.includes('\0'), 'Must not contain a null byte.')
const textSchema = argumentSchema.regex(/\S/, 'Must not be blank.')

export const createWorktreeInputSchema = z.object({
  project: textSchema,
  baseBranch: textSchema,
  branch: argumentSchema,
  path: textSchema,
})
export const deleteWorktreeInputSchema = z.object({
  project: textSchema,
  path: textSchema,
})
export const openEditorInputSchema = deleteWorktreeInputSchema
export const setWorktreeErrorInputSchema = deleteWorktreeInputSchema.extend({
  error: z.string().max(4096).optional(),
})
export const editorSessionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().regex(/^\/editors\/[a-f0-9]{64}\/$/),
  accessToken: z.string().regex(/^[a-f0-9]{64}$/),
})
const worktreeSchema = z.object({
  project: textSchema,
  path: textSchema,
  branch: textSchema.nullable(),
  head: z.string(),
  main: z.boolean(),
  locked: z.boolean(),
  prunable: z.boolean(),
  editor: z.enum(['stopped', 'starting', 'running']),
  editorDetail: z.string().max(512).optional(),
  operation: z.enum(['creating', 'deleting']).optional(),
  error: z.string().optional(),
  missing: z.boolean().optional(),
})
const worktreeSnapshotSchema = z.object({
  revision: z.int().nonnegative(),
  projects: z.array(textSchema),
  worktrees: z.array(worktreeSchema),
})
const worktreeUpdateSchema = z.object({
  change: z.enum(['created', 'deleted', 'refreshed', 'editor', 'operation']),
  snapshot: worktreeSnapshotSchema,
})

const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('worktrees:set-error'),
    id: idSchema,
    input: setWorktreeErrorInputSchema,
  }),
  z.object({
    type: z.literal('editor:open'),
    id: idSchema,
    input: openEditorInputSchema,
  }),
  z.object({
    type: z.enum(['ping', 'worktrees:list', 'worktrees:refresh']),
    id: idSchema,
  }),
  z.object({
    type: z.literal('worktrees:create'),
    id: idSchema,
    input: createWorktreeInputSchema,
  }),
  z.object({
    type: z.literal('worktrees:delete'),
    id: idSchema,
    input: deleteWorktreeInputSchema,
  }),
])
const responseMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('editor'),
    id: idSchema,
    session: editorSessionSchema,
  }),
  z.object({ type: z.literal('pong'), id: idSchema }),
  z.object({
    type: z.literal('worktrees'),
    id: idSchema,
    snapshot: worktreeSnapshotSchema,
  }),
])
const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocolVersion: z.int() }),
  ...responseMessageSchema.options,
  worktreeUpdateSchema.extend({ type: z.literal('worktrees:updated') }),
  z.object({
    type: z.literal('error'),
    id: idSchema.optional(),
    message: z.string(),
  }),
])
const requestEnvelopeSchema = z.object({ id: idSchema })

export type CreateWorktreeInput = z.infer<typeof createWorktreeInputSchema>
export type DeleteWorktreeInput = z.infer<typeof deleteWorktreeInputSchema>
export type OpenEditorInput = z.infer<typeof openEditorInputSchema>
export type SetWorktreeErrorInput = z.infer<typeof setWorktreeErrorInputSchema>
export type EditorSession = z.infer<typeof editorSessionSchema>
export type Worktree = z.infer<typeof worktreeSchema>
export type WorktreeSnapshot = z.infer<typeof worktreeSnapshotSchema>
export type WorktreeUpdate = z.infer<typeof worktreeUpdateSchema>
export type ClientMessage = z.infer<typeof clientMessageSchema>
export type ResponseMessage = z.infer<typeof responseMessageSchema>
export type ServerMessage = z.infer<typeof serverMessageSchema>

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function parseClientMessage(text: string): ClientMessage | null {
  return clientMessageSchema.safeParse(parseJson(text)).data ?? null
}

export function parseServerMessage(text: string): ServerMessage | null {
  return serverMessageSchema.safeParse(parseJson(text)).data ?? null
}

export function requestId(text: string): string | undefined {
  return requestEnvelopeSchema.safeParse(parseJson(text)).data?.id
}

const companionUrlSchema = z
  .url({ protocol: /^wss?$/ })
  .max(2048)
  .transform((value) => new URL(value))
  .refine(
    (url) =>
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      url.pathname === '/companion',
  )
  .transform((url) => url.href)

export function normalizeCompanionUrl(value: string): string {
  const result = companionUrlSchema.safeParse(value)
  if (!result.success) {
    throw new Error(
      'Use a ws:// or wss:// URL ending in /companion, without credentials or a query.',
      { cause: result.error },
    )
  }
  return result.data
}

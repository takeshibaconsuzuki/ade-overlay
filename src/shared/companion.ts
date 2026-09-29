import { z } from 'zod'
import { eventSpec, requestSpec } from './rpc.ts'
import { chatIdSchema, chatSchema } from './chats.ts'
import { pasteItemsSchema } from './paste-schema.ts'
import { worktreeColorSchema } from './worktree-colors.ts'

export const COMPANION_PROTOCOL_VERSION = 1
export const DEFAULT_COMPANION_PORT = 4317
export const DEFAULT_COMPANION_URL = `ws://127.0.0.1:${DEFAULT_COMPANION_PORT}/companion`
export const MAX_MESSAGE_BYTES = 16 * 1024

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
export const openEditorInputSchema = z.object({
  project: textSchema,
  path: textSchema,
})
export const deleteWorktreeInputSchema = openEditorInputSchema.extend({
  deleteBranch: z.boolean().optional(),
  force: z.boolean().optional(),
})
export const setWorktreeErrorInputSchema = openEditorInputSchema.extend({
  error: z.string().max(4096).optional(),
})
const editorSessionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  accessToken: z.string().regex(/^[a-f0-9]{64}$/),
})
export function editorPath(id: string): string {
  return `/editors/${id}/`
}
const worktreeSchema = z.object({
  project: textSchema,
  path: textSchema,
  branch: textSchema.nullable(),
  main: z.boolean(),
  locked: z.boolean(),
  prunable: z.boolean(),
  editor: z.enum(['stopped', 'starting', 'running']),
  editorDetail: z.string().max(512).optional(),
  color: worktreeColorSchema.optional(),
  operation: z.enum(['creating', 'deleting']).optional(),
  error: z.string().optional(),
  deletionFailure: z
    .object({
      files: z.array(z.string()),
      canForce: z.boolean(),
      deleteBranch: z.boolean(),
    })
    .optional(),
  missing: z.boolean().optional(),
})
const worktreeSnapshotSchema = z.object({
  revision: z.int().nonnegative(),
  projects: z.array(textSchema),
  worktrees: z.array(worktreeSchema),
})

export const companionRequests = {
  paste: requestSpec(
    'editor:paste',
    z.object({
      editorId: editorSessionSchema.shape.id,
      documentId: z.uuid(),
      reservationId: z.uuid(),
      items: pasteItemsSchema,
    }),
    z.null(),
    25_000,
  ),
  reservePaste: requestSpec(
    'editor:reserve-paste',
    z.object({ editorId: editorSessionSchema.shape.id, documentId: z.uuid() }),
    z.uuid().nullable(),
    8_000,
  ),
  activateChat: requestSpec('chat:activate', chatIdSchema, z.null(), 35_000),
  list: requestSpec('worktrees:list', z.null(), worktreeSnapshotSchema, 5_000),
  refresh: requestSpec(
    'worktrees:refresh',
    z.null(),
    worktreeSnapshotSchema,
    120_000,
  ),
  create: requestSpec(
    'worktrees:create',
    createWorktreeInputSchema,
    worktreeSnapshotSchema,
    120_000,
  ),
  delete: requestSpec(
    'worktrees:delete',
    deleteWorktreeInputSchema,
    worktreeSnapshotSchema,
    120_000,
  ),
  setError: requestSpec(
    'worktrees:set-error',
    setWorktreeErrorInputSchema,
    worktreeSnapshotSchema,
    120_000,
  ),
  openEditor: requestSpec(
    'editor:open',
    openEditorInputSchema,
    editorSessionSchema,
    180_000,
  ),
}
export const companionEvents = {
  chatIdle: eventSpec('chat:idle', chatSchema),
  hello: eventSpec('hello', z.object({ protocolVersion: z.int() })),
  worktrees: eventSpec('worktrees:updated', worktreeSnapshotSchema),
  activateChat: eventSpec(
    'chat:activate',
    z.object({ id: idSchema, input: openEditorInputSchema }),
  ),
  finishChat: eventSpec('chat:finished', idSchema),
  viewReady: eventSpec(
    'chat:view-ready',
    z.object({
      id: idSchema,
      error: z.string().max(1024).optional(),
      activationAfter: z.uuid().nullable(),
    }),
  ),
}

export type CreateWorktreeInput = z.infer<typeof createWorktreeInputSchema>
export type DeleteWorktreeInput = z.infer<typeof deleteWorktreeInputSchema>
export type OpenEditorInput = z.infer<typeof openEditorInputSchema>
export type SetWorktreeErrorInput = z.infer<typeof setWorktreeErrorInputSchema>
export type EditorSession = z.infer<typeof editorSessionSchema>
export type Worktree = z.infer<typeof worktreeSchema>
export type WorktreeSnapshot = z.infer<typeof worktreeSnapshotSchema>
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

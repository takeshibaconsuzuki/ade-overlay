import { z } from 'zod'
import { eventSpec, messages, requestSpec } from './rpc.ts'
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
const worktreeBranchSchema = z.object({ name: textSchema, local: z.boolean() })
export type WorktreeBranch = z.infer<typeof worktreeBranchSchema>

export const createWorktreeInputSchema = z.object({
  project: textSchema,
  baseBranch: textSchema,
  branch: argumentSchema,
  path: textSchema,
})
export const worktreeRefSchema = z.object({
  project: textSchema,
  path: textSchema,
})
const worktreePathTemplatesSchema = z.object({
  pathStyle: z.enum(['win32', 'posix']),
  projects: z.array(
    z.object({
      mainWorktreePath: textSchema,
      worktreePathTemplate: z
        .string()
        .min(1)
        .max(16 * 1024)
        .refine((value) => !value.includes('\0'))
        .optional(),
    }),
  ),
})
export const deleteWorktreeInputSchema = worktreeRefSchema.extend({
  deleteBranch: z.boolean().optional(),
  force: z.boolean().optional(),
})
export const setWorktreeErrorInputSchema = worktreeRefSchema.extend({
  error: z.string().max(4096).optional(),
})
const editorServerSessionSchema = z.object({
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
  editorServer: z.enum(['stopped', 'starting', 'running', 'stopping']),
  editorServerDetail: z.string().max(512).optional(),
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
  bootstrapFailed: z.boolean().optional(),
})
const worktreeSnapshotSchema = z.object({
  revision: z.int().nonnegative(),
  projects: z.array(textSchema),
  worktrees: z.array(worktreeSchema),
})

export const companionRequests = messages({
  companionPaste: requestSpec(
    z.object({
      editorServerId: editorServerSessionSchema.shape.id,
      documentId: z.uuid(),
      reservationId: z.uuid(),
      items: pasteItemsSchema,
    }),
    z.null(),
    25_000,
  ),
  companionReservePaste: requestSpec(
    z.object({
      editorServerId: editorServerSessionSchema.shape.id,
      documentId: z.uuid(),
    }),
    z.uuid().nullable(),
    8_000,
  ),
  companionOpenChat: requestSpec(chatIdSchema, z.null(), 35_000),
  companionOpenBootstrapLog: requestSpec(worktreeRefSchema, z.null(), 30_000),
  companionListWorktrees: requestSpec(z.null(), worktreeSnapshotSchema, 5_000),
  companionListBranches: requestSpec(
    z.object({ project: textSchema }),
    z.array(worktreeBranchSchema),
    5_000,
  ),
  companionGetPathTemplates: requestSpec(
    z.null(),
    worktreePathTemplatesSchema,
    5_000,
  ),
  companionRefreshWorktrees: requestSpec(
    z.null(),
    worktreeSnapshotSchema,
    120_000,
  ),
  companionCreateWorktree: requestSpec(
    createWorktreeInputSchema,
    worktreeSnapshotSchema,
    120_000,
  ),
  companionDeleteWorktree: requestSpec(
    deleteWorktreeInputSchema,
    worktreeSnapshotSchema,
    120_000,
  ),
  companionSetWorktreeError: requestSpec(
    setWorktreeErrorInputSchema,
    worktreeSnapshotSchema,
    120_000,
  ),
  companionStartEditorServer: requestSpec(
    worktreeRefSchema,
    editorServerSessionSchema,
    180_000,
  ),
  companionStopEditorServer: requestSpec(
    worktreeRefSchema,
    worktreeSnapshotSchema,
    120_000,
  ),
})
export const companionEvents = messages({
  desktopNotifyChatIdle: eventSpec(chatSchema),
  hello: eventSpec(z.object({ protocolVersion: z.int() })),
  desktopUpdateWorktrees: eventSpec(worktreeSnapshotSchema),
  desktopOpenChat: eventSpec(
    z.object({ id: idSchema, input: worktreeRefSchema }),
  ),
  desktopFinishOpenChat: eventSpec(idSchema),
  desktopOpenChatResponse: eventSpec(
    z.object({
      id: idSchema,
      error: z.string().max(1024).optional(),
      activationAfter: z.uuid().nullable(),
    }),
  ),
})

export type CreateWorktreeInput = z.infer<typeof createWorktreeInputSchema>
export type WorktreePathTemplates = z.infer<typeof worktreePathTemplatesSchema>
export type DeleteWorktreeInput = z.infer<typeof deleteWorktreeInputSchema>
export type WorktreeRef = z.infer<typeof worktreeRefSchema>
export type SetWorktreeErrorInput = z.infer<typeof setWorktreeErrorInputSchema>
export type EditorServerSession = z.infer<typeof editorServerSessionSchema>
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

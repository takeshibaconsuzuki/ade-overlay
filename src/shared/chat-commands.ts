import { z } from 'zod'

const commandSchema = z
  .string()
  .regex(/\S/, 'Chat commands must not be blank.')
  .refine(
    (command) => !command.includes('\0'),
    'Chat commands must not contain a null byte.',
  )

export const chatCommandsSchema = z
  .object({
    codex: commandSchema.optional(),
    claude: commandSchema.optional(),
  })
  .strict()

export type ChatCommands = z.infer<typeof chatCommandsSchema>

export const defaultChatCommands = {
  codex: 'codex --no-daemon',
  claude: 'claude',
} as const

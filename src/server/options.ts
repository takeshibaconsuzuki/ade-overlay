import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { z } from 'zod'
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from './constants'

export const serverOptionsSchema = z.strictObject({
  host: z.string().trim().min(1).default(DEFAULT_SERVER_HOST),
  // Port 0 asks the operating system to allocate an available port.
  port: z.int().min(0).max(65535).default(DEFAULT_SERVER_PORT),
})

export type ServerOptions = z.infer<typeof serverOptionsSchema>

export async function optionsFromFile(path: string): Promise<ServerOptions> {
  try {
    const config: unknown = parse(await readFile(path, 'utf8'))
    return serverOptionsSchema.parse(config)
  } catch (error) {
    throw new Error(`Failed to load server configuration from "${path}"`, {
      cause: error,
    })
  }
}

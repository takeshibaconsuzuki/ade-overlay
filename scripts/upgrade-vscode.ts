import { writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { HttpClient } from '../src/shared/http-client'
import { vscodePlatform } from '../src/server/vscode-runtime'

const releaseSchema = z.object({
  name: z.string().regex(/^\d+\.\d+\.\d+$/),
  version: z.string().regex(/^[a-f0-9]{40}$/),
})

export async function upgradeVscode(
  http: HttpClient,
  pinFile: string | URL,
): Promise<void> {
  const response = await http.fetch(
    `https://update.code.visualstudio.com/api/latest/${vscodePlatform()}/stable`,
    { signal: AbortSignal.timeout(30_000) },
  )
  if (!response.ok)
    throw new Error(
      `VS Code Server release lookup failed: HTTP ${response.status}`,
    )
  const release = releaseSchema.parse(await response.json())
  await writeFile(
    pinFile,
    `${JSON.stringify({ version: release.name, commit: release.version }, null, 2)}\n`,
  )
  console.log(`VS Code Server pinned to ${release.name} (${release.version})`)
}

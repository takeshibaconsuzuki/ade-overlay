import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { HttpClient } from '../src/shared/http-client'

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/)
const releasesSchema = z.array(
  z.object({ version: z.string().regex(/^v\d+\.\d+\.\d+$/) }),
)

// Stay on the pinned major: changing it also requires reviewing build targets.
// Bootstrap installs the pin after npm exits, so Windows can replace node.exe.
export async function upgradeNode(
  http: HttpClient,
  pinFile: string | URL,
): Promise<void> {
  const current = versionSchema.parse((await readFile(pinFile, 'utf8')).trim())
  const major = current.split('.')[0]
  const response = await http.fetch('https://nodejs.org/dist/index.json', {
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok)
    throw new Error(`Node release lookup failed: HTTP ${response.status}`)
  const versions = releasesSchema
    .parse(await response.json())
    .map(({ version }) => version.slice(1))
    .filter((version) => version.split('.')[0] === major)
    .sort(new Intl.Collator('en', { numeric: true }).compare)
  const latest = versions.at(-1)
  if (!latest) throw new Error(`No Node ${major} releases found`)
  if (latest.localeCompare(current, 'en', { numeric: true }) <= 0) {
    console.log(`Node pin is already up to date (${current})`)
    return
  }
  await writeFile(pinFile, `${latest}\n`)
  console.log(
    `Node pinned to ${latest}. Reactivate with scripts/bootstrap.py to install Node and its bundled npm.`,
  )
}

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const releaseFile = fileURLToPath(
  new URL('../src/server/editors/vscode-release.ts', import.meta.url),
)
const requested = process.argv[2] ?? 'latest'
const endpoint =
  requested === 'latest'
    ? 'https://update.code.visualstudio.com/api/update/darwin/stable/latest'
    : `https://update.code.visualstudio.com/api/versions/${encodeURIComponent(requested)}/darwin/stable`

const response = await fetch(endpoint)
if (!response.ok) {
  throw new Error(
    `VS Code release lookup for ${requested} failed: ${response.status} ${response.statusText}`,
  )
}
const { productVersion: version, version: commit } = await response.json()
if (
  !/^\d+\.\d+\.\d+$/.test(version ?? '') ||
  !/^[0-9a-f]{40}$/.test(commit ?? '')
) {
  throw new Error(
    `VS Code release lookup for ${requested} returned an unexpected payload.`,
  )
}

const source = await readFile(releaseFile, 'utf8')
const updated = source
  .replace(/version: '[^']*'/, `version: '${version}'`)
  .replace(/commit: '[^']*'/, `commit: '${commit}'`)
if (
  !updated.includes(`version: '${version}'`) ||
  !updated.includes(`commit: '${commit}'`)
) {
  throw new Error(
    `Could not find the version and commit fields in ${releaseFile}.`,
  )
}

if (updated === source) {
  console.log(`VS Code is already pinned to ${version} (${commit}).`)
} else {
  await writeFile(releaseFile, updated)
  console.log(
    `Pinned VS Code ${version} (${commit}). Run npm run test:runtime and npm run test:extension to check compatibility.`,
  )
}

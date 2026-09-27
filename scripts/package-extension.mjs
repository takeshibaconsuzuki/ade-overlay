import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createVSIX } from '@vscode/vsce'

await mkdir(new URL('../out/', import.meta.url), { recursive: true })
await createVSIX({
  cwd: fileURLToPath(new URL('../extensions/ade-terminals/', import.meta.url)),
  packagePath: fileURLToPath(
    new URL('../out/ade-terminals.vsix', import.meta.url),
  ),
  dependencies: false,
  allowMissingRepository: true,
  skipLicense: true,
})

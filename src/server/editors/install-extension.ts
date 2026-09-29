import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { findLocalCode, codeEnvironment } from './code-cli.ts'
import type { ServerConfig } from '../config.ts'
import { silentLogger } from '../logging.ts'

export async function installBundledExtension(
  config: ServerConfig,
): Promise<void> {
  const vsix = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts')
        ? '../../../out/ade-terminals.vsix'
        : '../../ade-terminals.vsix',
      import.meta.url,
    ),
  )
  await access(vsix).catch(() => {
    throw new Error(
      'The bundled extension is missing. Use a companion release package, or run npm run setup from the source checkout.',
    )
  })
  const code = await findLocalCode(silentLogger)
  await execa(
    code.command,
    [
      '--extensions-dir',
      config.editor?.localExtensionsDir ?? code.extensionsDir,
      '--install-extension',
      vsix,
      '--force',
    ],
    {
      env: codeEnvironment(),
      extendEnv: false,
      stdio: 'inherit',
      windowsHide: true,
      killDescendants: true,
    },
  )
}

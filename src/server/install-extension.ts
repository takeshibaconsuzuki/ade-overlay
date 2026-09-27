import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import spawn from 'cross-spawn'
import { findLocalCode, codeEnvironment } from './code-cli.ts'
import { loadServerConfig } from './config.ts'
import { silentLogger } from './logging.ts'

export async function installBundledExtension(
  configPath?: string,
): Promise<void> {
  const vsix = fileURLToPath(new URL('../ade-terminals.vsix', import.meta.url))
  await access(vsix).catch(() => {
    throw new Error(
      'The bundled extension is missing. Use a companion release package, or install out/ade-terminals.vsix with code --install-extension.',
    )
  })
  const config = await loadServerConfig(configPath)
  const code = await findLocalCode(silentLogger)
  if (!code)
    throw new Error('Install VS Code and put code (or code-insiders) on PATH.')
  const child = spawn(
    code.command,
    [
      '--extensions-dir',
      config.editor?.localExtensionsDir ?? code.extensionsDir,
      '--install-extension',
      vsix,
      '--force',
    ],
    { env: codeEnvironment(), stdio: 'inherit', windowsHide: true },
  )
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (status) =>
      status === 0
        ? resolve()
        : reject(new Error(`Extension installation failed (${status}).`)),
    )
  })
}

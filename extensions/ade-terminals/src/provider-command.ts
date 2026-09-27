import { basename } from 'node:path'

// Run the configured foreground command inside a complete shell construct so
// the trailing exit cannot be consumed as input by the provider. The shell owns
// cleanup even while the extension host or desktop is disconnected.
export function providerShellCommand(command: string, shell: string): string {
  const name = basename(shell)
    .toLowerCase()
    .replace(/\.exe$/, '')
  if (name === 'cmd') return `${command} & exit`
  if (name === 'pwsh' || name === 'powershell')
    return `try {\n${command}\n} finally { exit }`
  if (name === 'fish') return `begin\n${command}\nend; exit`
  if (['bash', 'gitbash', 'sh', 'zsh', 'ksh', 'dash', 'wsl'].includes(name))
    return `{\n${command}\n}; exit`
  throw new Error(
    `Automatic chat terminal cleanup is not supported for shell "${name}". Select PowerShell, Command Prompt, bash, zsh, fish or another supported shell profile.`,
  )
}

import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'

// Receive the credential over the companion's private IPC channel, before
// loading VS Code. It must never enter the server/pty host environment.
const token = await new Promise<string>((resolve, reject) => {
  process.once('message', (message) => {
    if (typeof message !== 'string' || !/^[a-f0-9]{64}$/.test(message))
      reject(new Error('Invalid extension bootstrap credential.'))
    else resolve(message)
  })
  process.once('disconnect', () =>
    reject(new Error('Extension bootstrap disconnected.')),
  )
})
process.disconnect!()

const fork = childProcess.fork
childProcess.fork = ((modulePath, args, options) => {
  // VS Code forks extension hosts separately from its shared pty host. Keep
  // this adapter covered by the real-runtime test when updating VS Code.
  if (
    Array.isArray(args) &&
    args.includes('--type=extensionHost') &&
    options?.env?.VSCODE_ESM_ENTRYPOINT ===
      'vs/workbench/api/node/extensionHostProcess'
  ) {
    options = {
      ...options,
      env: { ...options.env, ADE_CHAT_EXTENSION_TOKEN: token },
    }
  }
  return fork(modulePath, args, options)
}) as typeof childProcess.fork
syncBuiltinESMExports()

// Preserve the runtime's argv and its own entrypoint-relative asset discovery.
process.argv.splice(1, 1)
await import(pathToFileURL(process.argv[1]).href)

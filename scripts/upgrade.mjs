import spawn from 'cross-spawn'

for (const [command, args] of [
  ['ncu', ['--peer', '--removeRange', '-u']],
  ['npm', ['install']],
]) {
  const result = spawn.sync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

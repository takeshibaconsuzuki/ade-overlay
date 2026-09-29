import { access, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const [started, release, completed] = process.argv.slice(2)
await writeFile(started, '')
while (
  !(await access(release).then(
    () => true,
    () => false,
  ))
)
  await delay(20)
await writeFile(completed, process.cwd())

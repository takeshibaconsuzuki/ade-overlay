import { existsSync, writeFileSync } from 'node:fs'

const kind = process.argv[2]
writeFileSync(`ade-${kind}.txt`, kind)
setInterval(() => {
  if (existsSync(`finish-${kind}`)) process.exit(7)
}, 100)

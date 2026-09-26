import { readFile, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const app = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const manifest = {
  name: `${app.name}-companion`,
  version: app.version,
  private: true,
  type: 'module',
  main: 'server/index.js',
  scripts: { start: 'node server/index.js' },
  engines: { node: '>=22.22.3' },
  dependencies: { ws: app.dependencies.ws },
}

await writeFile(
  new URL('out/server/package.json', root),
  JSON.stringify(manifest, null, 2) + '\n',
)

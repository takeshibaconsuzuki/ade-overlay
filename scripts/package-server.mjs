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
  dependencies: {
    'smol-toml': app.dependencies['smol-toml'],
    systeminformation: app.dependencies.systeminformation,
    'proper-lockfile': app.dependencies['proper-lockfile'],
    'cross-spawn': app.dependencies['cross-spawn'],
    which: app.dependencies.which,
    cheerio: app.dependencies.cheerio,
    cookie: app.dependencies.cookie,
    'jsonc-parser': app.dependencies['jsonc-parser'],
    'write-file-atomic': app.dependencies['write-file-atomic'],
    pino: app.dependencies.pino,
    'http-proxy-3': app.dependencies['http-proxy-3'],
    'tree-kill': app.dependencies['tree-kill'],
    ws: app.dependencies.ws,
    yaml: app.dependencies.yaml,
    zod: app.dependencies.zod,
  },
}

await writeFile(
  new URL('out/server/package.json', root),
  JSON.stringify(manifest, null, 2) + '\n',
)

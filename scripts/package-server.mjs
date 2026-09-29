import { readFile, writeFile } from 'node:fs/promises'
import { buildSettingsBridge } from './settings-bridge-build.mjs'

await buildSettingsBridge()

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
    execa: app.dependencies.execa,
    which: app.dependencies.which,
    cheerio: app.dependencies.cheerio,
    cookie: app.dependencies.cookie,
    'jsonc-parser': app.dependencies['jsonc-parser'],
    'write-file-atomic': app.dependencies['write-file-atomic'],
    pino: app.dependencies.pino,
    'http-proxy-3': app.dependencies['http-proxy-3'],
    'decompress-response': app.dependencies['decompress-response'],
    'tree-kill': app.dependencies['tree-kill'],
    'raw-body': app.dependencies['raw-body'],
    'socket.io': app.dependencies['socket.io'],
    'engine.io': app.dependencies['engine.io'],
    yaml: app.dependencies.yaml,
    zod: app.dependencies.zod,
  },
}

await writeFile(
  new URL('out/server/package.json', root),
  JSON.stringify(manifest, null, 2) + '\n',
)

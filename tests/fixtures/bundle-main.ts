import { join } from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

export async function bundleMain(
  root: string,
  name: string,
  area = 'main',
): Promise<string> {
  await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { conditions: ['node'], mainFields: ['module', 'main'] },
    build: {
      target: 'es2022',
      outDir: root,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: fileURLToPath(
          new URL(`../../src/${area}/${name}.ts`, import.meta.url),
        ),
        formats: ['es'],
        fileName: () => `${name}.mjs`,
      },
      rollupOptions: {
        external: ['electron', 'ws', /^node:/, ...builtinModules],
        output: { paths: { ws: import.meta.resolve('ws') } },
      },
    },
  })
  return join(root, `${name}.mjs`)
}

import { readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import workbenchSource from '../../out/workbench/source'
import {
  patchVscodeTerminalSerializer,
  TERMINAL_SERIALIZER_PATCH,
} from './vscode-terminal-serializer-patch'

// Minified identifiers belong to the pinned distribution and are checked on upgrades.
const anchor =
  'let C;return{commands:{executeCommand:(k,..._)=>r.executeCommand(k,..._)}'
const bridge = `let C;
adeWorkbench.attachWorkbench({
  get(id) {
    const serviceId = Rq.serviceIds.get(id);
    if (serviceId) return g.invokeFunction(accessor => accessor.get(serviceId));
    return cke.INSTANCE.getWorkbenchContribution(id);
  },
  executeCommand: (id, ...args) => r.executeCommand(id, ...args),
  registerCommand: (id, handler) => qe.registerCommand(id, (_accessor, ...args) => handler(...args)),
});
return{commands:{executeCommand:(k,..._)=>r.executeCommand(k,..._)}`
const startupAnchor =
  'async open(){let[e]=await Promise.all([this.initServices(),BVo(Ee(this.domElement))]),t=this.createWorkbench(this.domElement,e.serviceCollection,e.logService);'
const startupBridge = `async open(){
adeWorkbench.configureWorkbench(this.configuration);
let[e]=await Promise.all([this.initServices(),BVo(Ee(this.domElement))]);
await adeWorkbench.initializeExtensions(e.serviceCollection.get(fe));
let t=this.createWorkbench(this.domElement,e.serviceCollection,e.logService);`
const marker = '/* ADE workbench RPC */'

// Isolate installations across integration versions; existing running clients keep their assets.
function version(source: string): string {
  return createHash('sha256')
    .update(bridge + startupBridge + TERMINAL_SERIALIZER_PATCH + source)
    .digest('hex')
    .slice(0, 16)
}
export const WORKBENCH_VERSION = version(workbenchSource)

// Accepts either the pinned original or our complete patch; partial/unknown patches fail closed.
export function patchVscodeWorkbench(
  source: string,
  assetVersion = WORKBENCH_VERSION,
): string {
  const moduleImport = `import * as adeWorkbench from './ade-workbench.js?ade=${assetVersion}';\n`
  if (source.endsWith(marker)) {
    if (
      source.startsWith(moduleImport) &&
      source.split(bridge).length === 2 &&
      source.split(startupBridge).length === 2
    )
      return source
    throw new Error('The cached ADE workbench patch is incomplete')
  }
  if (
    source.split(anchor).length !== 2 ||
    source.split(startupAnchor).length !== 2
  )
    throw new Error(
      'VS Code workbench does not match the ADE patch; check the pinned distribution',
    )
  source = source
    .replace(anchor, () => bridge)
    .replace(startupAnchor, () => startupBridge)
  return `${moduleImport}${source}\n${marker}`
}

// Called under the installation lock for both new and cached distributions.
export interface WorkbenchAssets {
  readonly version: string
  prepare(directory: string): Promise<void>
}

export class BundledWorkbenchAssets implements WorkbenchAssets {
  readonly version: string
  constructor(private readonly source = workbenchSource) {
    this.version = version(source)
  }
  prepare(directory: string): Promise<void> {
    return prepareVscodeWorkbench(directory, this.source, this.version)
  }
}

async function prepareVscodeWorkbench(
  directory: string,
  sourceCode: string,
  assetVersion: string,
): Promise<void> {
  const serializerPath = join(
    directory,
    'node_modules/@xterm/addon-serialize/lib/addon-serialize.js',
  )
  const serializer = await readFile(serializerPath, 'utf8')
  const patchedSerializer = patchVscodeTerminalSerializer(serializer)
  if (patchedSerializer !== serializer)
    await replaceFile(serializerPath, patchedSerializer)
  const root = join(directory, 'out/vs/code/browser/workbench')
  const path = join(root, 'workbench.js')
  await replaceFile(join(root, 'ade-workbench.js'), sourceCode)
  const source = await readFile(path, 'utf8')
  const patched = patchVscodeWorkbench(source, assetVersion)
  if (patched !== source) await replaceFile(path, patched)
  // VS Code caches static assets for a year. Version the script URL without changing the
  // workbench origin or workspace identity, so existing browser state remains available.
  const htmlPath = join(root, 'workbench.html')
  const html = await readFile(htmlPath, 'utf8')
  const scriptUrl = '/out/vs/code/browser/workbench/workbench.js'
  const versionedUrl = `${scriptUrl}?ade=${assetVersion}`
  if (html.split(`${versionedUrl}"`).length === 2) return
  if (html.split(`${scriptUrl}"`).length !== 2)
    throw new Error('VS Code workbench HTML does not match the ADE patch')
  await replaceFile(htmlPath, html.replace(`${scriptUrl}"`, `${versionedUrl}"`))
}

async function replaceFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.ade-tmp`
  await writeFile(temporary, content)
  await rename(temporary, path)
}

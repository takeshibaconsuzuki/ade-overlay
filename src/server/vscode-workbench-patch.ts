import { readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

// Keep this patch limited to exposing references. Desktop code owns the behavior built on them.
// Minified identifiers are specific to the pinned distribution and must be checked on upgrades.
const anchor =
  'let C;return{commands:{executeCommand:(k,...D)=>r.executeCommand(k,...D)}'
const bridge = `let C;
class AdeHandle {
  get(id) {
    const serviceId = cK.serviceIds.get(id);
    if (serviceId) return g.invokeFunction(accessor => accessor.get(serviceId));
    return RIe.INSTANCE.getWorkbenchContribution(id);
  }
}
const adeHandle = new AdeHandle();
globalThis.getAdeHandle = () => adeHandle;
return{commands:{executeCommand:(k,...D)=>r.executeCommand(k,...D)}`
const marker = '/* ADE workbench handle */'

// Accepts either the pinned original or our complete patch; partial/unknown patches fail closed.
export function patchVscodeWorkbench(source: string): string {
  if (source.endsWith(marker)) {
    if (source.split(bridge).length === 2) return source
    throw new Error('The cached ADE workbench patch is incomplete')
  }
  if (source.split(anchor).length !== 2)
    throw new Error(
      'VS Code workbench does not match the ADE patch; check the pinned distribution',
    )
  source = source.replace(anchor, () => bridge)
  return `${source}\n${marker}`
}

// Called under the installation lock for both new and cached distributions.
export async function prepareVscodeWorkbench(directory: string): Promise<void> {
  const root = join(directory, 'out/vs/code/browser/workbench')
  const path = join(root, 'workbench.js')
  const source = await readFile(path, 'utf8')
  const patched = patchVscodeWorkbench(source)
  if (patched !== source) await replaceFile(path, patched)
  // VS Code caches static assets for a year. Version the script URL without changing the
  // workbench origin or workspace identity, so existing browser state remains available.
  const htmlPath = join(root, 'workbench.html')
  const html = await readFile(htmlPath, 'utf8')
  const scriptUrl = '/out/vs/code/browser/workbench/workbench.js'
  const version = createHash('sha256').update(bridge).digest('hex').slice(0, 16)
  const versionedUrl = `${scriptUrl}?ade=${version}`
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

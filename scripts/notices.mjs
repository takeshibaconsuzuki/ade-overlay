import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { init, asPlainVertical } from 'license-checker-rseidelsohn'

export async function writeNotices(destination) {
  const packages = await new Promise((resolve, reject) =>
    init(
      {
        start: fileURLToPath(new URL('../', import.meta.url)),
        production: true,
        excludePrivatePackages: true,
      },
      (error, packages) => (error ? reject(error) : resolve(packages)),
    ),
  )
  await writeFile(destination, asPlainVertical(packages))
}

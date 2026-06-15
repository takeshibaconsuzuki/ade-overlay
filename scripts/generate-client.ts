import { spawn } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { OPENAPI_GENERATED_SPEC_PATH } from '../src/api/server/config'
import { createServer } from '../src/server/server'

const server = createServer()

try {
  await server.ready()
  await writeFile(
    OPENAPI_GENERATED_SPEC_PATH,
    JSON.stringify(server.swagger(), null, 2),
  )
  await runOpenApiTs()
} finally {
  await server.close()
  await rm(OPENAPI_GENERATED_SPEC_PATH, { force: true })
}

function runOpenApiTs(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['openapi-ts'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`openapi-ts exited with code ${code ?? 'unknown'}`))
    })
  })
}

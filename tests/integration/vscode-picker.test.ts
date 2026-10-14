import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runDesktopClient, startIntegrationServer } from './harness'

test('picker search, visibility, scrolling and mixed input preserve one selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-picker-integration-'))
  const server = await startIntegrationServer(directory, [])
  try {
    await runDesktopClient('picker', {
      ADE_SERVER_URL: `ws://127.0.0.1:${server.port}/rpc`,
      ADE_PICKER_DATA: directory,
    })
  } finally {
    await server.close()
  }
})

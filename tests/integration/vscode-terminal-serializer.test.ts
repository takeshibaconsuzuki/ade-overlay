import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { DownloadedVscodeRuntime } from '../../src/server/vscode-runtime'
import { FetchHttpClient } from '../../src/shared/http-client'

interface MouseEvent {
  button: number
  action: number
  col: number
  row: number
  x: number
  y: number
  ctrl: boolean
  alt: boolean
  shift: boolean
}

// Internal contracts of the pinned headless terminal used by VS Code's pty host.
interface Terminal {
  modes: { mouseTrackingMode: string }
  _core: {
    mouseStateService: {
      activeEncoding: string
      encodeMouseEvent(event: MouseEvent): string
    }
  }
  loadAddon(addon: Serializer): void
  write(data: string, callback: () => void): void
  dispose(): void
}

interface Serializer {
  serialize(options?: { excludeModes: boolean }): string
}

test('pinned VS Code replay preserves mouse tracking, encoding, and movement reports', async (t) => {
  const installation = await new DownloadedVscodeRuntime(
    new FetchHttpClient(),
  ).prepare(new AbortController().signal)
  const require = createRequire(installation.entrypoint)
  const { Terminal } = require('@xterm/headless') as {
    Terminal: new (options: { allowProposedApi: boolean }) => Terminal
  }
  const { SerializeAddon } = require('@xterm/addon-serialize') as {
    SerializeAddon: new () => Serializer
  }
  const movement: MouseEvent = {
    button: 3,
    action: 32,
    col: 10,
    row: 5,
    x: 100,
    y: 50,
    ctrl: false,
    alt: false,
    shift: false,
  }
  const cases = [
    {
      name: 'default',
      data: '\x1b[?1003h',
      tracking: 'any',
      encoding: 'DEFAULT',
    },
    {
      name: 'SGR',
      data: '\x1b[?1003h\x1b[?1006h',
      tracking: 'any',
      encoding: 'SGR',
    },
    {
      name: 'disabled SGR',
      data: '\x1b[?1003h\x1b[?1006h\x1b[?1006l',
      tracking: 'any',
      encoding: 'DEFAULT',
    },
    {
      name: 'pixel SGR',
      data: '\x1b[?1002h\x1b[?1016h',
      tracking: 'drag',
      encoding: 'SGR_PIXELS',
    },
    {
      name: 'disabled pixel SGR',
      data: '\x1b[?1003h\x1b[?1016h\x1b[?1016l',
      tracking: 'any',
      encoding: 'DEFAULT',
    },
    {
      name: 'encoding without tracking',
      data: '\x1b[?1006h',
      tracking: 'none',
      encoding: 'SGR',
    },
    {
      name: 'reset',
      data: '\x1b[?1003h\x1b[?1006h\x1bc',
      tracking: 'none',
      encoding: 'DEFAULT',
    },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const create = () => {
        const terminal = new Terminal({ allowProposedApi: true })
        t.after(() => terminal.dispose())
        const serializer = new SerializeAddon()
        terminal.loadAddon(serializer)
        return { terminal, serializer }
      }
      let current = create()
      await new Promise<void>((done) =>
        current.terminal.write(scenario.data, done),
      )
      const expectedReport =
        current.terminal._core.mouseStateService.encodeMouseEvent(movement)
      for (let reconnect = 0; reconnect < 2; reconnect++) {
        const snapshot = current.serializer.serialize()
        const restored = create()
        await new Promise<void>((done) =>
          restored.terminal.write(snapshot, done),
        )
        assert.equal(
          restored.terminal.modes.mouseTrackingMode,
          scenario.tracking,
        )
        assert.equal(
          restored.terminal._core.mouseStateService.activeEncoding,
          scenario.encoding,
        )
        assert.equal(
          restored.terminal._core.mouseStateService.encodeMouseEvent(movement),
          expectedReport,
        )
        current = restored
      }
      const excluded = create()
      await new Promise<void>((done) =>
        excluded.terminal.write(
          current.serializer.serialize({ excludeModes: true }),
          done,
        ),
      )
      assert.equal(excluded.terminal.modes.mouseTrackingMode, 'none')
      assert.equal(
        excluded.terminal._core.mouseStateService.activeEncoding,
        'DEFAULT',
      )
    })
  }
})

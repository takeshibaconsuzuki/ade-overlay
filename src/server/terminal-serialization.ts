import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { codeEnvironment } from './code-cli.ts'

export const terminalSerializationRevision = 'mouse-v1'

// Only Node's package entry changes. The browser's xterm assets stay untouched.
// xterm's serializer restores mouse tracking but omits its encoding. Read the
// headless terminal's current state, including resets, rather than replaying input.
const shim = `const original = require('./addon-serialize.js');
Object.assign(exports, original);
exports.SerializeAddon = class extends original.SerializeAddon {
  serialize(options) {
    const output = super.serialize(options);
    if (options?.excludeModes) return output;
    const encoding = this._terminal?._core?.mouseStateService?.activeEncoding;
    switch (encoding) {
      case 'SGR': return output + '\\x1b[?1006h';
      case 'SGR_PIXELS': return output + '\\x1b[?1016h';
      case 'DEFAULT': return output + '\\x1b[?1006l\\x1b[?1016l';
      default: throw new Error('Unsupported VS Code terminal mouse state');
    }
  }
};
`

export async function prepareTerminalSerialization(
  root: string,
): Promise<void> {
  const directory = join(root, 'node_modules', '@xterm', 'addon-serialize')
  const path = join(directory, 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  if (manifest.main !== 'lib/addon-serialize.js')
    throw new Error('Unsupported VS Code terminal serializer entry point.')
  await writeFile(join(directory, 'lib', 'ade-serialize.cjs'), shim)
  manifest.main = 'lib/ade-serialize.cjs'
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
}

// Check the real bundled headless terminal and Node import path before accepting
// a runtime update. This intentionally fails if an upstream internal API changes.
export async function validateTerminalSerialization(
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  await promisify(execFile)(
    join(root, process.platform === 'win32' ? 'node.exe' : 'node'),
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(process.argv[1]);
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = await import(pathToFileURL(require.resolve('@xterm/addon-serialize')).href);
const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
const addon = new SerializeAddon();
terminal.loadAddon(addon);
const write = (target, data) => new Promise(resolve => target.write(data, resolve));
try {
  for (const [sequence, encoding] of [
    ['\\x1b[?1003;1006h', 'SGR'],
    ['\\x1b[?1016h', 'SGR_PIXELS'],
    ['\\x1b[?1016l', 'DEFAULT'],
    ['\\x1b[?1006h\\x1b[?1006l', 'DEFAULT'],
    ['\\x1b[?1006h\\x1bc', 'DEFAULT'],
  ]) {
    await write(terminal, sequence);
    const restored = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
    try {
      await write(restored, addon.serialize());
      assert.equal(restored._core.mouseStateService.activeEncoding, encoding);
      assert.equal(restored.modes.mouseTrackingMode, terminal.modes.mouseTrackingMode);
    } finally { restored.dispose(); }
  }
  await write(terminal, '\\x1b[?1003;1006h');
  assert.ok(!addon.serialize({ excludeModes: true }).includes('\\x1b[?1006h'));
} finally { terminal.dispose(); }
`,
      join(root, 'package.json'),
    ],
    { env: codeEnvironment(), windowsHide: true, timeout: 10_000, signal },
  )
}

/**
 * Make xterm's scrollback buffer allocate lazily instead of eagerly.
 *
 * xterm's internal CircularList does `this._array = new Array(scrollback + rows)`,
 * which eagerly allocates the full pointer array the moment a terminal opens
 * (~7.5 MB per terminal at a 1M-line scrollback) regardless of how much output
 * is ever produced. There is no public option to change this.
 *
 * Replacing those `new Array(n)` allocations with `[]` makes the array grow on
 * demand: it only reaches full size if the scrollback genuinely fills, so a
 * quiet terminal costs almost nothing. The ring-buffer semantics are unchanged
 * — the cyclic index math only ever reads slots it has already written, so a
 * grown array is observationally identical to a pre-sized holey one.
 *
 * xterm ships prebuilt minified bundles (the renderer loads lib/xterm.mjs, the
 * CJS consumers lib/xterm.js); the TS source isn't compiled by us, so we patch
 * the bundles directly. Runs from `postinstall` and is idempotent — re-running
 * on already-patched files is a no-op. If a future xterm changes these tokens
 * the assertions fail loudly so the patch is never silently dropped.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Per bundle: the eager allocations to replace. `from` must occur exactly once
// (un-patched) or zero times (already patched, plus its `to` present).
const targets = [
  {
    file: 'node_modules/@xterm/xterm/lib/xterm.js',
    edits: [
      ['this._array=new Array(this._maxLength)', 'this._array=[]'],
      ['===e)return;const t=new Array(e)', '===e)return;const t=[]'],
    ],
  },
  {
    file: 'node_modules/@xterm/xterm/lib/xterm.mjs',
    edits: [
      ['this._array=new Array(this._maxLength)', 'this._array=[]'],
      ['===e)return;let i=new Array(e)', '===e)return;let i=[]'],
    ],
  },
]

let changed = false
for (const { file, edits } of targets) {
  const path = join(root, file)
  let source = readFileSync(path, 'utf8')
  for (const [from, to] of edits) {
    const found = source.split(from).length - 1
    if (found === 1) {
      source = source.replace(from, to)
      changed = true
    } else if (found === 0 && source.includes(to)) {
      // Already patched.
    } else {
      throw new Error(
        `patch-xterm-scrollback: expected exactly one '${from}' in ${file} ` +
          `(found ${found}). xterm's bundle changed; update this patch.`,
      )
    }
  }
  writeFileSync(path, source)
}

console.log(
  changed
    ? 'patch-xterm-scrollback: lazy scrollback allocation applied to xterm bundles'
    : 'patch-xterm-scrollback: xterm bundles already patched',
)

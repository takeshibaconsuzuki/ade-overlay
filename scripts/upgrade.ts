import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import ncu from 'npm-check-updates'
import { FetchHttpClient } from '../src/shared/http-client'
import { upgradeNode } from './upgrade-node'
import { upgradeVscode } from './upgrade-vscode'

const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run this script through npm run upgrade')

await ncu({ peer: true, removeRange: true, upgrade: true, silent: false })
const install = spawnSync(process.execPath, [npmCli, 'install'], {
  stdio: 'inherit',
  windowsHide: true,
})
if (install.error) throw install.error
if (install.status !== 0)
  throw new Error(`npm install failed (${install.signal ?? install.status})`)
await upgradeVscode(new FetchHttpClient(), resolve('vscode-server.json'))
await upgradeNode(new FetchHttpClient(), resolve('.node-version'))

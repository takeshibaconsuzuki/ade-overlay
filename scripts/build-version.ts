import { simpleGit } from 'simple-git'
import { version } from '../package.json'

// package.json tracks the numeric release version; builds append the commit as
// semver build metadata so every artifact identifies the source it came from.
export async function buildVersion(root: string): Promise<string> {
  const commit = (await simpleGit(root).revparse(['--short', 'HEAD'])).trim()
  return `${version}+${commit}`
}

import { load } from 'cheerio'
import type { ImportedProfile } from './local-vscode.ts'

// Use VS Code's profile initialization API: it seeds a new browser profile
// once, then leaves subsequent user edits and browser persistence to VS Code.
export function withImportedProfile(
  html: string,
  profile: ImportedProfile | undefined,
  syncPath?: string,
): string {
  const page = load(html)
  const element = page('#vscode-workbench-web-configuration')
  const settings = element.attr('data-settings')
  if (!settings)
    throw new Error('VS Code did not provide its workbench configuration.')
  const config = JSON.parse(settings)
  if (profile) config.profile = profile
  element.attr('data-settings', JSON.stringify(config))
  if (syncPath) {
    const script = page('<script></script>')
      .attr('src', syncPath)
      .attr('defer', '')
    const nonce = page('script[nonce]').first().attr('nonce')
    if (nonce) script.attr('nonce', nonce)
    page('head').append(script)
  }
  return page.html()
}

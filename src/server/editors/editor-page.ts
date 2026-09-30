import { load } from 'cheerio'
import type { ImportedProfile } from './local-vscode.ts'

// Profile initialization seeds a new browser profile once; the startup layout
// applies to every document without resetting saved editors or user settings.
export function withImportedProfile(
  html: string,
  profile: ImportedProfile,
  syncPath: string,
  activationAfter: string | null,
): string {
  const page = load(html)
  const element = page('#vscode-workbench-web-configuration')
  const settings = element.attr('data-settings')
  if (!settings)
    throw new Error('VS Code did not provide its workbench configuration.')
  const config = JSON.parse(settings)
  config.profile = profile
  config.defaultLayout = {
    views: [{ id: 'adeTerminals.sidebar' }],
    force: true,
  }
  // Accepted limitation: a fresh browser profile starts with empty User settings,
  // so this can hide Chat despite an explicit local visibility preference.
  // Settings sync follows layout initialization; the preference takes effect
  // on a later load when saved visibility does not override it.
  config.configurationDefaults = {
    ...config.configurationDefaults,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
  }
  element.attr('data-settings', JSON.stringify(config))
  // A document keeps the activation it superseded, even when another chat
  // click arrives after its extension connected but before terminals have restored.
  page('head').append(
    page('<meta name="ade-chat-activation-after">').attr(
      'content',
      activationAfter ?? '',
    ),
  )
  const script = page('<script></script>')
    .attr('src', syncPath)
    .attr('defer', '')
  const nonce = page('script[nonce]').first().attr('nonce')
  if (nonce) script.attr('nonce', nonce)
  page('head').append(script)
  return page.html()
}

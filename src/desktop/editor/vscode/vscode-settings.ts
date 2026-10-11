import type { AdeWorkbenchGlobal } from '../../../shared/vscode-ade-handle'

// Only the internal contracts used by settings are described here. VS Code owns the objects.
// eslint-disable-next-line @typescript-eslint/no-namespace -- Groups type-only contracts without emitting a runtime namespace.
declare namespace SettingsServices {
  interface UserDataProfilesService {
    defaultProfile: { settingsResource: unknown }
  }
  interface TextFileService {
    read(resource: unknown): Promise<{ value: string }>
    write(resource: unknown, value: string): Promise<unknown>
    revert(resource: unknown, options: { force: boolean }): Promise<void>
  }
  interface FileService {
    exists(resource: unknown): Promise<boolean>
    onDidFilesChange(
      listener: (event: { contains(resource: unknown): boolean }) => void,
    ): unknown
  }
  interface ConfigurationService {
    reloadConfiguration(): Promise<void>
  }
}

// Serialized into the workbench: keep runtime code self-contained. Only the default profile's
// saved user document is synchronized. VS Code continues to own its files and configuration.
export async function applyVscodeSettings(
  content: string,
  generation: number,
): Promise<void> {
  const scope = globalThis as unknown as AdeWorkbenchGlobal
  const deadline = Date.now() + 20_000
  while (!scope.getAdeHandle?.().vscodeSettings) {
    if (Date.now() >= deadline)
      throw new Error('VS Code settings services did not become ready')
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  const handle = scope.getAdeHandle()
  const settings = handle.vscodeSettings!
  if (!settings.apply) {
    const profiles = handle.get(
      'IUserDataProfilesService',
    ) as SettingsServices.UserDataProfilesService
    const resource = profiles.defaultProfile.settingsResource
    const files = handle.get('fileService') as SettingsServices.FileService
    const textFiles = handle.get(
      'textFileService',
    ) as SettingsServices.TextFileService
    const configuration = handle.get(
      'configurationService',
    ) as SettingsServices.ConfigurationService
    let currentGeneration = 0
    let applying = false
    let lastContent: string | undefined
    const read = async () =>
      (await files.exists(resource))
        ? (await textFiles.read(resource)).value
        : '{}\n'
    const notify = () => {
      if (applying) return
      const observedGeneration = currentGeneration
      void read()
        .then((next) => {
          if (
            applying ||
            observedGeneration !== currentGeneration ||
            next === lastContent
          )
            return
          lastContent = next
          settings.changed(observedGeneration, next)
        })
        .catch((error: unknown) =>
          console.error('Unable to read ADE user settings', error),
        )
    }
    files.onDidFilesChange((event) => {
      if (event.contains(resource)) notify()
    })
    settings.apply = async (next, epoch) => {
      currentGeneration = epoch
      applying = true
      lastContent = next
      try {
        if ((await read()) !== next) await textFiles.write(resource, next)
        // Includes an open settings editor with unsaved edits: the host document wins.
        await textFiles.revert(resource, { force: true })
        await configuration.reloadConfiguration()
      } finally {
        applying = false
      }
      // A saved edit may race the host application. Observe the final document after
      // suppressing our own writes so an edit made during configuration reload is not lost.
      notify()
    }
  }
  await settings.apply(content, generation)
}

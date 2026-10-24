import { basename } from 'node:path'
import * as vscode from 'vscode'
import { DOWNLOAD_RESOURCE_COMMAND } from '../../src/shared/editor-rpc'

// Declared in package.json; menus pass the editor's resource as the first argument.
const DOWNLOAD_EDITOR_COMMAND = 'ade.downloadEditor'

function activeTabResource(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
  if (
    input instanceof vscode.TabInputText ||
    input instanceof vscode.TabInputCustom ||
    input instanceof vscode.TabInputNotebook
  )
    return input.uri
  // A diff's modified side is the editable file the tab is about.
  if (
    input instanceof vscode.TabInputTextDiff ||
    input instanceof vscode.TabInputNotebookDiff
  )
    return input.modified
  return undefined
}

// Saves an open editor's file to the local machine; the workbench performs the download.
export function registerDownload(): vscode.Disposable {
  return vscode.commands.registerCommand(
    DOWNLOAD_EDITOR_COMMAND,
    async (resource?: unknown) => {
      const uri =
        resource instanceof vscode.Uri ? resource : activeTabResource()
      if (!uri) {
        void vscode.window.showInformationMessage('No file to download')
        return
      }
      try {
        await vscode.commands.executeCommand(DOWNLOAD_RESOURCE_COMMAND, uri)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        void vscode.window.showErrorMessage(
          `Unable to download ${basename(uri.path)}: ${message}`,
        )
      }
    },
  )
}

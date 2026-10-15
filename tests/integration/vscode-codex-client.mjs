import {
  app,
  BrowserWindow,
  webContents,
  clipboard,
  ClipboardItem,
  nativeImage,
} from 'electron'
import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

app.setPath('userData', join(process.env.ADE_CODEX_DATA, 'electron-data'))
await import('./index.js')

async function wait(condition, label) {
  console.log('WAIT', label)
  const deadline = Date.now() + 30_000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await delay(50)
  }
}

void app.whenReady().then(async () => {
  try {
    await wait(() => BrowserWindow.getAllWindows().length === 1, 'picker')
    const picker = BrowserWindow.getAllWindows()[0]
    await wait(
      async () =>
        !picker.webContents.isLoading() &&
        (await picker.webContents.executeJavaScript(
          '!!document.querySelector(".worktree-open")',
        )),
      'worktrees',
    )
    await picker.webContents.executeJavaScript(
      'document.querySelector(".worktree-open").click()',
    )
    let page
    await wait(() => {
      page = webContents
        .getAllWebContents()
        .find((entry) => /^http:.*\/vscode\//.test(entry.getURL()))
      return page
    }, 'editor page')
    if (process.env.ADE_CODEX_PHASE.startsWith('paste')) {
      page.on('console-message', (event) => {
        if (
          event.level === 'error' &&
          event.message.startsWith('Unable to paste')
        )
          console.error('WORKBENCH', event.message)
      })
    }
    await wait(
      async () =>
        !page.isLoading() &&
        (await page.executeJavaScript('globalThis.adeTest?.workbenchReady')),
      'workbench',
    )
    await page.executeJavaScript(
      'adeTest.get("workspaceTrustManagementService").setWorkspaceTrust(true)',
    )
    const command = (id, ...args) => {
      if (id === 'workbench.action.terminal.paste') {
        BrowserWindow.getAllWindows()
          .find((window) => window !== picker)
          .focus()
        page.focus()
      }
      return Promise.race([
        page.executeJavaScript(
          `adeTest.get('commandService').executeCommand(${[id, ...args].map((value) => JSON.stringify(value)).join(',')})`,
          true,
        ),
        delay(12000).then(() => {
          throw new Error(`Command timed out: ${id}`)
        }),
      ])
    }
    await wait(
      async () => page.executeJavaScript('adeTest.workbenchReady'),
      'chat controller initialized at startup',
    )
    await wait(
      () =>
        page.executeJavaScript(
          "adeTest.get('configurationService').inspect('terminal.integrated.enablePersistentSessions').userLocalValue === false",
        ),
      'host setting disables terminal persistence',
    )
    await wait(
      () =>
        page.executeJavaScript(
          "adeTest.get('configurationService').inspect('terminal.integrated.enablePersistentSessions').userRemoteValue === true",
        ),
      'remote settings loaded',
    )
    assert.deepEqual(
      await page.executeJavaScript(`(() => {
        const setting = adeTest.get('configurationService').inspect('terminal.integrated.enablePersistentSessions');
        return { remote: setting.userRemoteValue, memory: setting.memoryValue };
      })()`),
      { remote: true, memory: undefined },
      'persistence comes from remote settings without a runtime override',
    )
    assert.equal(
      await page.executeJavaScript(
        "adeTest.get('configurationService').getValue('terminal.integrated.enablePersistentSessions')",
      ),
      true,
      'ADE keeps terminal persistence enabled without changing the host setting',
    )
    await command('workbench.view.extension.ade')
    let sidebar
    await wait(async () => {
      for (const frame of page.mainFrame.framesInSubtree) {
        try {
          if (
            await frame.executeJavaScript(
              '[...document.querySelectorAll("button")].some(b => b.textContent === "Codex")',
            )
          ) {
            sidebar = frame
            return true
          }
        } catch (error) {
          // Startup can replace a webview frame while it is being inspected.
          if (!String(error).includes('Render frame was disposed')) throw error
        }
      }
      return false
    }, 'Codex button')
    const clickCodex = () =>
      sidebar.executeJavaScript(
        '[...document.querySelectorAll("button")].find(b => b.textContent === "Codex").click()',
      )
    const repo = process.env.ADE_CODEX_REPO
    const sessions = async () =>
      (await readdir(repo)).filter((name) => name.endsWith('.json'))
    const markerPath = join(process.env.ADE_CODEX_DATA, 'restored-chat.json')
    if (process.env.ADE_CODEX_PHASE.startsWith('paste')) {
      const originalClipboard = await Promise.all(
        (await clipboard.read())
          .filter((item) => item.types.length > 0)
          .map(
            async (item) =>
              new ClipboardItem(
                Object.fromEntries(
                  await Promise.all(
                    item.types.map(async (type) => [
                      type,
                      await item.getType(type),
                    ]),
                  ),
                ),
              ),
          ),
      )
      try {
        const restored = process.env.ADE_CODEX_PHASE === 'paste-restored'
        if (!restored) await clickCodex()
        await wait(
          () =>
            page.executeJavaScript(
              "adeTest.get('terminalService').instances.some(t => t.target === 2 && !!t.processId)",
            ),
          'chat terminal ready for paste',
        )
        await page.executeJavaScript(
          "adeTest.get('terminalEditorService').focusInstance(adeTest.get('terminalService').instances.find(t => t.target === 2))",
        )
        await wait(
          () =>
            page.executeJavaScript(
              "adeTest.get('terminalService').activeInstance?.target === 2 && adeTest.get('terminalService').activeInstance?.xterm.raw.modes.bracketedPasteMode",
            ),
          'chat terminal selected for paste',
        )
        await delay(1000)
        await page.executeJavaScript(
          "adeTest.get('configurationService').updateValue('terminal.integrated.enableMultiLinePasteWarning', 'always', 8)",
        )
        const id = restored
          ? JSON.parse(await readFile(markerPath, 'utf8')).id
          : (await sessions())[0].replace('.json', '')
        const inputPath = join(repo, id + '.input.jsonl')
        const input = async () => {
          try {
            return (await readFile(inputPath, 'utf8'))
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
              .join('')
          } catch (error) {
            if (error.code === 'ENOENT') return ''
            throw error
          }
        }
        const previous = await input()
        await page.executeJavaScript(`(() => {
          const manager = adeTest.get('terminalService').activeInstance._processManager;
          const write = manager.write;
          adeTest.pasteWrites = [];
          manager.write = function(data) {
            if (data.startsWith('\\x1b[200~')) adeTest.pasteWrites.push({ data, at: performance.now() });
            return write.call(this, data);
          };
        })()`)
        const firstImage = Buffer.from(
          'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
          'base64',
        )
        const secondImage = nativeImage
          .createFromBitmap(Buffer.from([0, 255, 0, 255]), {
            width: 1,
            height: 1,
          })
          .toPNG()
        const html = `<h1>before<img src="data:image/gif;base64,${firstImage.toString('base64')}">middle<img src="data:image/png;base64,${secondImage.toString('base64')}">after</h1>`
        await clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob(['NATIVE_UNRELATED'], {
              type: 'text/plain',
            }),
          }),
        ])
        await command('workbench.action.terminal.paste')
        await wait(
          async () => (await input()).slice(previous.length).includes('AFTER'),
          'ordered remote paste reaches the PTY',
        )
        const pasted = (await input()).slice(previous.length)
        const writes = await page.executeJavaScript(
          'adeTest.pasteWrites.slice(0, 5)',
        )
        assert.equal(writes.length, 5)
        for (let index = 1; index < writes.length; index++) {
          if (
            writes[index - 1].data.includes('.png"') ||
            writes[index].data.includes('.png"')
          )
            assert.ok(
              writes[index].at - writes[index - 1].at >= 150,
              'image isolation is measured before remote delivery can batch input',
            )
        }
        const paths = [...pasted.matchAll(/"([^"\r\n]+\.png)"/g)].map(
          (match) => match[1],
        )
        assert.equal(paths.length, 2)
        const firstPng = nativeImage.createFromBuffer(await readFile(paths[0]))
        assert.deepEqual(firstPng.getSize(), { width: 1, height: 1 })
        assert.deepEqual(firstPng.toBitmap(), Buffer.from([0, 0, 0, 0]))
        assert.deepEqual(
          nativeImage.createFromBuffer(await readFile(paths[1])).toBitmap(),
          nativeImage.createFromBuffer(secondImage).toBitmap(),
        )
        assert.equal(
          pasted,
          ['BEFORE', `"${paths[0]}"`, 'MIDDLE', `"${paths[1]}"`, 'AFTER']
            .map((text) => `\x1b[200~${text}\x1b[201~`)
            .join(''),
          'paste preserves separate image-path events and source order without submission',
        )
        const pasteParts = async () =>
          (await readFile(join(repo, id + '.pastes.jsonl'), 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        await wait(
          async () => (await pasteParts()).at(-1)?.text === 'AFTER',
          'composer processes the ordered paste events',
        )
        assert.deepEqual((await pasteParts()).slice(-5), [
          { type: 'text', text: 'BEFORE' },
          { type: 'image', path: paths[0] },
          { type: 'text', text: 'MIDDLE' },
          { type: 'image', path: paths[1] },
          { type: 'text', text: 'AFTER' },
        ])

        const beforeNativePaste = await input()
        page.paste()
        await wait(
          async () =>
            (await input()).slice(beforeNativePaste.length).includes('AFTER'),
          'native menu paste reaches the chat PTY',
        )
        assert.equal(
          (await input()).slice(beforeNativePaste.length),
          pasted,
          'native paste is intercepted exactly once',
        )

        const beforeTyping = await input()
        await page.executeJavaScript(
          "void adeTest.get('commandService').executeCommand('workbench.action.terminal.paste')",
        )
        await wait(
          async () =>
            (await input()).slice(beforeTyping.length).includes('BEFORE'),
          'paced paste starts before keyboard input',
        )
        page.sendInputEvent({ type: 'char', keyCode: 'k' })
        await delay(25)
        const deletion = await page.executeJavaScript(
          "adeTest.get('terminalService').activeInstance.shellType === 'cmd' ? '\\b' : '\\x17'",
        )
        page.sendInputEvent({
          type: 'keyDown',
          keyCode: 'Backspace',
          modifiers: ['control'],
        })
        page.sendInputEvent({
          type: 'keyUp',
          keyCode: 'Backspace',
          modifiers: ['control'],
        })
        await delay(25)
        await command('workbench.action.terminal.sendSequence', {
          text: '[sequence]',
        })
        await page.executeJavaScript(
          "void adeTest.get('terminalService').activeInstance.sendText('[sendText]', false); adeTest.get('terminalService').activeInstance.xterm.raw._core.coreService.triggerBinaryEvent('[binary]')",
        )
        page.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        page.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
        await wait(
          async () =>
            (await input()).slice(beforeTyping.length).endsWith('[binary]\r'),
          'typing, shortcuts, sendText, binary input and Enter follow the complete paste',
        )
        assert.equal(
          (await input()).slice(beforeTyping.length),
          pasted + 'k' + deletion + '[sequence][sendText][binary]\r',
          'all user input paths retain their order behind a multipart paste',
        )

        const beforeProtocol = await input()
        await page.executeJavaScript(
          "void adeTest.get('commandService').executeCommand('workbench.action.terminal.paste')",
        )
        await wait(
          async () =>
            (await input()).slice(beforeProtocol.length).includes('BEFORE'),
          'paced paste starts before a terminal protocol query',
        )
        const report = await page.executeJavaScript(
          "new Promise(resolve => { const raw = adeTest.get('terminalService').activeInstance.xterm.raw; raw.write('\\x1b[6n', () => { const buffer = raw.buffer.active; resolve('\\x1b[' + (buffer.cursorY + 1) + ';' + (buffer.cursorX + 1) + 'R'); }); })",
        )
        await wait(
          async () =>
            (await input()).slice(beforeProtocol.length).includes(report),
          'protocol reply bypasses the user-input queue',
        )
        assert.ok(
          !(await input()).slice(beforeProtocol.length).includes('AFTER'),
        )
        await wait(
          async () =>
            (await input()).slice(beforeProtocol.length).includes('AFTER'),
          'paste completes after the protocol reply',
        )
        assert.equal(
          (await input()).slice(beforeProtocol.length).replace(report, ''),
          pasted,
        )

        const beforePlainText = await input()
        await clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob(['PLAIN_TEXT\nSECOND_LINE']),
          }),
        ])
        await command('workbench.action.terminal.paste')
        await wait(
          async () =>
            (await input())
              .slice(beforePlainText.length)
              .includes('SECOND_LINE'),
          'plain text normalizer pastes multiline content without a shell warning',
        )
        assert.equal(
          (await input()).slice(beforePlainText.length),
          '\x1b[200~PLAIN_TEXT\rSECOND_LINE\x1b[201~',
          'multiline plain text stays inside a bracketed paste without submission',
        )

        if (!restored) {
          await page.executeJavaScript(`(async () => {
            const service = adeTest.get('terminalService');
            const terminal = await service.createTerminal({
              config: { executable: ${JSON.stringify(process.env.ADE_PASTE_NODE)}, args: [${JSON.stringify(process.env.ADE_PASTE_CLI)}], cwd: ${JSON.stringify(repo)}, env: { ADE_TERMINAL_ID: 'unrelated' }, waitOnExit: false },
              location: 1,
            });
            service.setActiveInstance(terminal);
            await adeTest.get('terminalGroupService').showPanel(true);
            await terminal.xtermReadyPromise;
            await terminal.focusWhenReady(true);
          })()`)
          await wait(
            () =>
              page.executeJavaScript(
                "adeTest.get('terminalService').activeInstance?.target === 1 && adeTest.get('terminalService').activeInstance?.xterm.raw.modes.bracketedPasteMode",
              ),
            'ordinary terminal ready',
          )
          await clipboard.write([
            new ClipboardItem({
              'text/html': new Blob([html]),
              'text/plain': new Blob(['NATIVE_UNRELATED']),
            }),
          ])
          await command('workbench.action.terminal.paste')
          await wait(async () => {
            try {
              return (
                await readFile(join(repo, 'unrelated.input.jsonl'), 'utf8')
              ).includes('NATIVE_UNRELATED')
            } catch (error) {
              if (error.code === 'ENOENT') return false
              throw error
            }
          }, 'ordinary terminal receives native text')
          assert.ok(
            !(
              await readFile(join(repo, 'unrelated.input.jsonl'), 'utf8')
            ).includes('.png'),
          )
          await page.executeJavaScript(`(async () => {
            const service = adeTest.get('terminalService');
            const terminal = service.instances.find(t => t.shellLaunchConfig.env?.ADE_TERMINAL_ID === 'unrelated');
            const chat = service.instances.find(t => t.target === 2);
            const editors = adeTest.get('editorService');
            const groupId = editors.findEditors(chat.resource)[0].groupId;
            adeTest.get('terminalGroupService').getGroupForInstance(terminal)?.removeInstance(terminal);
            await editors.openEditor({
              resource: adeTest.get('terminalEditorService').resolveResource(terminal),
              options: { pinned: true },
            }, groupId);
            await adeTest.get('terminalEditorService').focusInstance(terminal);
          })()`)
          const beforeMovedShellPaste = await readFile(
            join(repo, 'unrelated.input.jsonl'),
            'utf8',
          )
          await command('workbench.action.terminal.paste')
          await wait(
            async () =>
              (await readFile(join(repo, 'unrelated.input.jsonl'), 'utf8'))
                .slice(beforeMovedShellPaste.length)
                .includes('NATIVE_UNRELATED'),
            'ordinary terminal retains native paste inside the owned group',
          )
          assert.ok(
            !(await readFile(join(repo, 'unrelated.input.jsonl'), 'utf8'))
              .slice(beforeMovedShellPaste.length)
              .includes('.png'),
          )
          await page.executeJavaScript(
            "adeTest.get('terminalService').instances.find(t => t.shellLaunchConfig.env?.ADE_TERMINAL_ID === 'unrelated').dispose()",
          )
          await page.executeJavaScript(
            "adeTest.get('terminalEditorService').focusInstance(adeTest.get('terminalService').instances.find(t => t.target === 2))",
          )
          await writeFile(markerPath, JSON.stringify({ id, paths }))
        } else {
          const saved = JSON.parse(await readFile(markerPath, 'utf8'))
          await command('workbench.action.terminal.sendSequence', { text: 'q' })
          await wait(
            () =>
              page.executeJavaScript(
                "adeTest.get('terminalService').instances.length === 0",
              ),
            'chat closes',
          )
          await wait(async () => {
            try {
              await readFile(saved.paths[0])
              return false
            } catch (error) {
              if (error.code === 'ENOENT') return true
              throw error
            }
          }, 'chat paste images removed on close')
        }
        console.log('PASS HTML chat paste', process.env.ADE_CODEX_PHASE)
      } finally {
        await clipboard.write(originalClipboard)
      }
      app.quit()
      return
    }
    if (process.env.ADE_CODEX_PHASE === 'sole-group') {
      await wait(
        () =>
          page.executeJavaScript(
            "adeTest.get('editorService').editors.length > 0",
          ),
        'startup editor loaded',
      )
      await command('workbench.action.closeAllEditors')
      await wait(
        () =>
          page.executeJavaScript(
            "adeTest.get('terminalService').instances.length === 0 && adeTest.get('editorGroupsService').groups.length === 1",
          ),
        'empty sole editor group',
      )
      const originalGroup = await page.executeJavaScript(
        "adeTest.get('editorGroupsService').activeGroup.id",
      )
      for (const count of [1, 2]) {
        await clickCodex()
        await wait(
          () =>
            page.executeJavaScript(`(() => {
            const group = adeTest.get('editorGroupsService').getGroup(${originalGroup});
            return group.count === ${count} && group.isLocked && adeTest.get('terminalService').instances.length === ${count};
          })()`),
          `${count} chats in the sole locked group`,
        )
      }
      await page.executeJavaScript(
        "adeTest.get('terminalService').instances[0].sendText('q', false)",
      )
      await wait(
        () =>
          page.executeJavaScript(
            `adeTest.get('editorGroupsService').getGroup(${originalGroup}).count === 1`,
          ),
        'one remaining chat',
      )
      assert.equal(
        await page.executeJavaScript(`(() => {
        const group = adeTest.get('editorGroupsService').getGroup(${originalGroup});
        return group.isLocked && adeTest.get('storageService').getNumber('ade.chatTerminalGroup', 1) === group.id;
      })()`),
        true,
        'the group stays owned while another chat is open',
      )
      await command('workbench.action.closeActiveEditor')
      await wait(
        () =>
          page.executeJavaScript(`(() => {
          const groups = adeTest.get('editorGroupsService');
          const group = groups.getGroup(${originalGroup});
          return groups.groups.length === 1 && group.count === 0 && !group.isLocked
            && adeTest.get('storageService').getNumber('ade.chatTerminalGroup', 1) === undefined;
        })()`),
        'sole group unlocked and ownership cleared after the last chat closes',
      )
      await command('vscode.open', {
        scheme: 'vscode-remote',
        authority: new URL(page.getURL()).host,
        path:
          (process.platform === 'win32' ? '/' : '') +
          join(repo, 'notes.txt').replaceAll('\\', '/'),
      })
      await wait(
        () =>
          page.executeJavaScript(
            '[...document.querySelectorAll(".tab")].some(e => e.textContent === "notes.txt")',
          ),
        'notes.txt opened',
      )
      assert.deepEqual(
        await page.executeJavaScript(
          "adeTest.get('editorGroupsService').groups.map(g => ({ id: g.id, count: g.count, locked: g.isLocked }))",
        ),
        [{ id: originalGroup, count: 1, locked: false }],
        'a normal file opens in the released group without splitting',
      )
      await clickCodex()
      await wait(
        () =>
          page.executeJavaScript(`(() => {
          const groups = adeTest.get('editorGroupsService');
          const id = adeTest.get('storageService').getNumber('ade.chatTerminalGroup', 1);
          return groups.groups.length === 2 && id !== ${originalGroup} && groups.getGroup(id)?.count === 1;
        })()`),
        'a later chat gets its own group beside the normal file',
      )
      console.log(
        'PASS sole chat group releases ownership and space after its last terminal closes',
      )
      app.quit()
      return
    }
    if (process.env.ADE_CODEX_PHASE === 'close-restored') {
      await wait(
        async () =>
          page.executeJavaScript(
            "adeTest.get('terminalService').instances.length === 1",
          ),
        'terminal restored before any new launch',
      )
      await page.executeJavaScript(
        "adeTest.get('terminalService').instances[0].sendText('q', false)",
      )
      await wait(
        async () =>
          page.executeJavaScript(
            "adeTest.get('storageService').getNumber('ade.chatTerminalGroup', 1) === undefined",
          ),
        'restored group cleared before any new launch',
      )
      assert.equal(
        await page.executeJavaScript(
          "adeTest.get('terminalService').instances.length",
        ),
        0,
      )
      await clickCodex()
      await wait(
        async () => (await sessions()).length === 7,
        'launch after startup group removal',
      )
      await wait(
        async () =>
          page.executeJavaScript(
            'document.querySelectorAll(".editor-group-container.locked").length === 1',
          ),
        'replacement locked group',
      )
      console.log(
        'PASS startup tracks restored group removal before any new launch',
      )
      app.quit()
      return
    }
    if (process.env.ADE_CODEX_PHASE === 'restore') {
      const saved = JSON.parse(await readFile(markerPath, 'utf8'))
      const restoredTerminals = () =>
        page.executeJavaScript(`adeTest.get('terminalService').instances.map(t => ({
        resource: t.resource.toString(),
        group: adeTest.get('editorService').findEditors(t.resource)[0]?.groupId,
        restored: !!t.shellLaunchConfig.attachPersistentProcess
      }))`)
      await wait(
        async () =>
          (await restoredTerminals()).some(
            (t) => t.restored && t.group === saved.group,
          ),
        'chat terminal restored',
      )
      const restored = (await restoredTerminals()).find((t) => t.restored)
      await clickCodex()
      await wait(
        async () => (await sessions()).length === 5,
        'new CLI after restart',
      )
      await wait(
        async () =>
          (await restoredTerminals()).length === 2 &&
          (await restoredTerminals()).every((t) => t.group === saved.group),
        'shared group after restart',
      )
      assert.equal(
        await page.executeJavaScript(
          'document.querySelectorAll(".editor-group-container.locked").length',
        ),
        1,
      )
      await wait(
        async () =>
          sidebar.executeJavaScript(
            '!!document.querySelector(".chat-open:enabled")',
          ),
        'restored chat row',
      )
      await sidebar.executeJavaScript(
        'document.querySelector(".chat-open:enabled").click()',
      )
      await wait(
        async () =>
          page.executeJavaScript(
            `adeTest.get('terminalService').activeInstance?.resource.toString() === ${JSON.stringify(restored.resource)}`,
          ),
        'restored terminal focused',
      )
      await command('workbench.action.terminal.sendSequence', { text: 'q' })
      await wait(
        async () =>
          !(await restoredTerminals()).some(
            (t) => t.resource === restored.resource,
          ),
        'restored terminal closes on exit',
      )
      await page.executeJavaScript(
        "adeTest.get('terminalService').instances.forEach(t => t.sendText('q', false))",
      )
      await wait(
        async () => (await restoredTerminals()).length === 0,
        'all restored chats closed',
      )
      await clickCodex()
      await wait(
        async () => (await sessions()).length === 6,
        'launch after restored group closed',
      )
      await wait(
        async () =>
          (await restoredTerminals()).length === 1 &&
          (await restoredTerminals())[0].group !== undefined,
        'replacement group after restart',
      )
      console.log(
        'PASS desktop restart reuses chat group, focuses restored terminal, and closes on exit',
      )
      app.quit()
      return
    }
    assert.equal(
      await page.executeJavaScript(
        'document.querySelectorAll(".editor-group-container.locked").length',
      ),
      0,
      'startup does not create a chat group',
    )
    await page.executeJavaScript(
      `void (async () => { globalThis.failedChatTestTerminal = await adeTest.get('terminalService').createTerminal({ config: { executable: 'ade-nonexistent-test-shell', waitOnExit: false }, location: 1 }); })()`,
    )
    await wait(
      async () =>
        page.executeJavaScript(
          'globalThis.failedChatTestTerminal?.isDisposed === true',
        ),
      'invalid shell terminal closed',
    )
    await page.executeJavaScript('delete globalThis.failedChatTestTerminal')
    await command('workbench.action.closeAllEditors')
    await clickCodex()
    await wait(async () => (await sessions()).length === 1, 'first CLI')
    const first = JSON.parse(
      await readFile(join(repo, (await sessions())[0]), 'utf8'),
    )
    assert.equal(first.cwd.toLowerCase(), repo.toLowerCase())
    await wait(
      async () =>
        page.executeJavaScript(
          'document.querySelectorAll(".editor-group-container.locked").length === 1',
        ),
      'first locked group',
    )
    assert.equal(
      await page.executeJavaScript(
        "adeTest.get('editorGroupsService').groups.length",
      ),
      1,
      'an empty workbench uses the whole editor area for chats',
    )
    await clickCodex()
    await wait(async () => (await sessions()).length === 2, 'second CLI')
    await wait(
      async () =>
        page.executeJavaScript(
          'document.querySelectorAll(".editor-group-container.locked").length === 1',
        ),
      'shared locked group',
    )
    const terminals = () =>
      page.executeJavaScript(`adeTest.get('terminalService').instances
      .filter(t => t.shellLaunchConfig.env?.ADE_TERMINAL_ID)
      .map(t => ({id: t.shellLaunchConfig.env.ADE_TERMINAL_ID, name: t.shellLaunchConfig.name,
        group: adeTest.get('editorService').findEditors(t.resource)[0]?.groupId}))`)
    let opened = await terminals()
    assert.equal(opened.length, 2)
    assert.equal(opened[0].group, opened[1].group)
    assert.ok(
      opened.every((t) => t.name === undefined),
      'terminal titles use the workbench default',
    )
    // Keep a separate editor group to exercise focus changes and later split creation.
    await page.executeJavaScript(`{
      const groups = adeTest.get('editorGroupsService');
      const editorGroup = groups.addGroup(groups.activeGroup, 2);
      void groups.activateGroup(editorGroup);
    }`)
    await command('workbench.action.files.newUntitledFile')
    await command('workbench.action.focusLastEditorGroup')

    // Hold terminal creation so a focus change during startup is deterministic.
    await page.executeJavaScript(`{
      const get = adeTest.get;
      const service = get('terminalService');
      adeTest.get = id => id !== 'terminalService' ? get(id) : {
        get instances() { return service.instances },
        setActiveInstance: terminal => service.setActiveInstance(terminal),
        createTerminal: async options => {
          adeTest.get = get;
          if (!globalThis.chatLaunchReleased) await new Promise(resolve => { globalThis.releaseChatLaunch = resolve });
          return service.createTerminal(options);
        },
      };
      void 0;
    }`)
    await clickCodex()
    await wait(
      async () => page.executeJavaScript('!!globalThis.releaseChatLaunch'),
      'launch paused',
    )
    await command('workbench.action.focusFirstEditorGroup')
    const focusedGroup = await page.executeJavaScript(
      "adeTest.get('editorGroupsService').activeGroup.id",
    )
    await page.executeJavaScript(
      'globalThis.chatLaunchReleased = true; releaseChatLaunch(); delete globalThis.releaseChatLaunch',
    )
    await wait(async () => (await sessions()).length === 3, 'third CLI')
    await wait(
      async () =>
        (await terminals()).filter((t) => t.group === opened[0].group)
          .length === 3,
      'all chats share the group',
    )
    assert.equal(
      await page.executeJavaScript(
        "adeTest.get('editorGroupsService').activeGroup.id",
      ),
      focusedGroup,
      'launch preserves intervening focus changes',
    )
    assert.equal(
      await page.executeJavaScript(
        "adeTest.get('editorGroupsService').activeGroup.isLocked",
      ),
      false,
      'unrelated editor group is not locked',
    )

    const reportChat = async (chat) => {
      const response = await fetch(
        process.env.ADE_SERVER_URL.replace('ws:', 'http:').replace(
          '/rpc',
          '/chats/report/test',
        ),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerId: 'test',
            sessionId: 'first',
            worktreePath: repo,
            status: 'idle',
            mtime: Date.now(),
            ...chat,
          }),
        },
      )
      assert.equal(response.status, 204)
    }
    const firstChat = {
      terminalId: first.id,
      title: 'First chat',
      pid: first.pid,
    }
    await reportChat({ ...firstChat, worktreePath: join(repo, 'other') })
    await wait(
      async () =>
        sidebar.executeJavaScript(
          '!!document.querySelector(".chat-open:enabled")',
        ),
      'chat row',
    )
    const selectedChatTitle = () =>
      sidebar.executeJavaScript(
        'document.querySelector(".chat-open[aria-current=true] .chat-title")?.textContent ?? null',
      )
    assert.equal(
      await selectedChatTitle(),
      null,
      'other worktrees have no indicator',
    )
    await reportChat(firstChat)
    await wait(
      async () => (await selectedChatTitle()) === 'First chat',
      'live chat has an indicator before its terminal is focused',
    )
    await sidebar.executeJavaScript(
      'document.querySelector(".chat-open:enabled").click()',
    )
    await wait(
      async () =>
        page.executeJavaScript(
          `adeTest.get('terminalService').activeInstance?.shellLaunchConfig.env?.ADE_TERMINAL_ID === ${JSON.stringify(first.id)}`,
        ),
      'matching terminal focus',
    )
    const second = JSON.parse(
      await readFile(join(repo, opened[1].id + '.json'), 'utf8'),
    )
    await reportChat({
      sessionId: 'second',
      terminalId: second.id,
      title: 'Second chat',
      pid: second.pid,
    })
    await wait(
      () =>
        sidebar.executeJavaScript(
          'document.querySelectorAll(".chat-open:enabled").length === 2',
        ),
      'second chat row',
    )
    assert.equal(
      await selectedChatTitle(),
      'First chat',
      'new reports preserve chat focus',
    )
    await page.executeJavaScript(
      `adeTest.get('terminalEditorService').focusInstance(adeTest.get('terminalService').instances.find(t => t.shellLaunchConfig.env?.ADE_TERMINAL_ID === ${JSON.stringify(second.id)}))`,
    )
    await wait(
      async () => (await selectedChatTitle()) === 'Second chat',
      'indicator follows chat focus',
    )
    await command('workbench.action.terminal.new')
    await wait(
      () =>
        page.executeJavaScript(
          "adeTest.get('terminalService').activeInstance?.target === 1",
        ),
      'ordinary terminal is active',
    )
    await reportChat({ ...firstChat, title: 'First chat updated' })
    await wait(
      () =>
        sidebar.executeJavaScript(
          '[...document.querySelectorAll(".chat-title")].some(t => t.textContent === "First chat updated")',
        ),
      'chat update reaches sidebar after ordinary terminal focus',
    )
    assert.equal(
      await selectedChatTitle(),
      'Second chat',
      'ordinary terminal focus retains the chat indicator',
    )
    await page.executeJavaScript(
      "adeTest.get('terminalService').activeInstance.dispose()",
    )
    await sidebar.executeJavaScript(
      'document.querySelector(".chat-open:enabled").click()',
    )
    await wait(
      () =>
        page.executeJavaScript(
          `adeTest.get('terminalService').activeInstance?.shellLaunchConfig.env?.ADE_TERMINAL_ID === ${JSON.stringify(first.id)}`,
        ),
      'chat terminal focused again',
    )
    await command('workbench.action.terminal.sendSequence', { text: 'q' })
    await wait(
      async () =>
        page.executeJavaScript(
          `!adeTest.get('terminalService').instances.some(t => t.shellLaunchConfig.env?.ADE_TERMINAL_ID === ${JSON.stringify(first.id)})`,
        ),
      'terminal closes after CLI exit',
    )
    assert.equal((await terminals()).length, 2)
    await page.executeJavaScript(`adeTest.get('terminalService').instances
      .filter(t => t.shellLaunchConfig.env?.ADE_TERMINAL_ID).forEach(t => t.sendText('x', false))`)
    await wait(
      async () => (await terminals()).length === 0,
      'terminals close after nonzero CLI exit',
    )
    await clickCodex()
    await wait(
      async () => (await sessions()).length === 4,
      'launch after closing all chats',
    )
    await wait(
      async () =>
        (await terminals()).length === 1 &&
        (await terminals())[0].group !== undefined,
      'chat group recreated',
    )
    assert.equal(
      await page.executeJavaScript(
        "adeTest.get('editorGroupsService').groups.length",
      ),
      2,
      'an occupied editor keeps its space when the chat group is created',
    )
    const saved = await page.executeJavaScript(`(() => {
      const t = adeTest.get('terminalService').instances[0];
      return { id: t.shellLaunchConfig.env.ADE_TERMINAL_ID, resource: t.resource.toString(), group: adeTest.get('editorService').findEditors(t.resource)[0].groupId };
    })()`)
    const session = JSON.parse(
      await readFile(join(repo, saved.id + '.json'), 'utf8'),
    )
    assert.equal(
      await page.executeJavaScript(
        "adeTest.get('terminalService').instances.every(t => t.shouldPersist)",
      ),
      true,
      'chat terminals remain persistent after settings reloads',
    )
    // Keep the restart fixture's unrelated group empty, as in a newly opened workbench.
    await command('workbench.action.focusFirstEditorGroup')
    await page.executeJavaScript(`(async () => {
      const groups = adeTest.get('editorGroupsService');
      await groups.activeGroup.closeAllEditors({ preserveFocus: true });
      if (groups.groups.length === 1) groups.addGroup(groups.activeGroup, 2);
    })()`)
    await reportChat({
      terminalId: saved.id,
      title: 'Restored chat',
      pid: session.pid,
    })
    await command('workbench.action.focusFirstEditorGroup')
    assert.notEqual(
      await page.executeJavaScript(
        "adeTest.get('editorGroupsService').activeGroup.id",
      ),
      saved.group,
    )
    await writeFile(markerPath, JSON.stringify(saved))
    console.log(
      'PASS locked Codex terminals, matching chat focus, and close on exit',
    )
    app.quit()
  } catch (error) {
    console.error(error)
    for (const page of webContents
      .getAllWebContents()
      .filter((entry) => /^http:.*\/vscode\//.test(entry.getURL()))) {
      console.log(
        'PAGE TEXT',
        await page.executeJavaScript('document.body.innerText'),
      )
    }
    app.exit(1)
  }
})

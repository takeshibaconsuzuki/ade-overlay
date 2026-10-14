import { app, BrowserWindow, webContents } from 'electron'
import { createBirpc } from 'birpc'
import WebSocket from 'ws'
import { once } from 'node:events'
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
    if (process.env.ADE_CODEX_PHASE === 'restore') {
      const socket = new WebSocket(process.env.ADE_SERVER_URL)
      const rpc = createBirpc(
        {
          getClientInfo: () => ({
            kind: 'extension',
            name: 'test-requester',
            version: '1',
          }),
          chatsChanged: () => {},
        },
        {
          post: (data) => socket.send(data),
          on: (handler) =>
            socket.on('message', (data) => handler(data.toString())),
          serialize: JSON.stringify,
          deserialize: JSON.parse,
          timeout: 10_000,
        },
      )
      await once(socket, 'open')
      await rpc.openChat('test:first')
      rpc.$close()
      socket.close()
    } else {
      await picker.webContents.executeJavaScript(
        'document.querySelector(".worktree-open").click()',
      )
    }
    let page
    await wait(() => {
      page = webContents
        .getAllWebContents()
        .find((entry) => /^http:.*\/vscode\//.test(entry.getURL()))
      return page
    }, 'editor page')
    await wait(
      async () =>
        !page.isLoading() &&
        (await page.executeJavaScript('globalThis.adeHandle?.workbenchReady')),
      'workbench',
    )
    await page.executeJavaScript(
      'adeHandle.get("workspaceTrustManagementService").setWorkspaceTrust(true)',
    )
    const command = (id, ...args) =>
      page.executeJavaScript(
        `adeHandle.get('commandService').executeCommand(${[id, ...args].map((value) => JSON.stringify(value)).join(',')})`,
      )
    await wait(
      async () => page.executeJavaScript('!!adeHandle.chatTerminals'),
      'chat controller initialized at startup',
    )
    await wait(
      () =>
        page.executeJavaScript(
          "adeHandle.get('configurationService').inspect('terminal.integrated.enablePersistentSessions').userLocalValue === false",
        ),
      'host setting disables terminal persistence',
    )
    assert.deepEqual(
      await page.executeJavaScript(`(() => {
        const setting = adeHandle.get('configurationService').inspect('terminal.integrated.enablePersistentSessions');
        return { remote: setting.userRemoteValue, memory: setting.memoryValue };
      })()`),
      { remote: true, memory: undefined },
      'persistence comes from remote settings without a runtime override',
    )
    assert.equal(
      await page.executeJavaScript(
        "adeHandle.get('configurationService').getValue('terminal.integrated.enablePersistentSessions')",
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
    if (process.env.ADE_CODEX_PHASE === 'sole-group') {
      await wait(
        () =>
          page.executeJavaScript(
            "adeHandle.get('editorService').editors.length > 0",
          ),
        'startup editor loaded',
      )
      await command('workbench.action.closeAllEditors')
      await wait(
        () =>
          page.executeJavaScript(
            "adeHandle.get('terminalService').instances.length === 0 && adeHandle.get('editorGroupsService').groups.length === 1",
          ),
        'empty sole editor group',
      )
      const originalGroup = await page.executeJavaScript(
        "adeHandle.get('editorGroupsService').activeGroup.id",
      )
      for (const count of [1, 2]) {
        await clickCodex()
        await wait(
          () =>
            page.executeJavaScript(`(() => {
            const group = adeHandle.get('editorGroupsService').getGroup(${originalGroup});
            return group.count === ${count} && group.isLocked && adeHandle.get('terminalService').instances.length === ${count};
          })()`),
          `${count} chats in the sole locked group`,
        )
      }
      await page.executeJavaScript(
        "adeHandle.get('terminalService').instances[0].sendText('q', false)",
      )
      await wait(
        () =>
          page.executeJavaScript(
            `adeHandle.get('editorGroupsService').getGroup(${originalGroup}).count === 1`,
          ),
        'one remaining chat',
      )
      assert.equal(
        await page.executeJavaScript(`(() => {
        const group = adeHandle.get('editorGroupsService').getGroup(${originalGroup});
        return group.isLocked && adeHandle.get('storageService').getNumber('ade.chatTerminalGroup', 1) === group.id;
      })()`),
        true,
        'the group stays owned while another chat is open',
      )
      await command('workbench.action.closeActiveEditor')
      await wait(
        () =>
          page.executeJavaScript(`(() => {
          const groups = adeHandle.get('editorGroupsService');
          const group = groups.getGroup(${originalGroup});
          return groups.groups.length === 1 && group.count === 0 && !group.isLocked
            && adeHandle.get('storageService').getNumber('ade.chatTerminalGroup', 1) === undefined;
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
          "adeHandle.get('editorGroupsService').groups.map(g => ({ id: g.id, count: g.count, locked: g.isLocked }))",
        ),
        [{ id: originalGroup, count: 1, locked: false }],
        'a normal file opens in the released group without splitting',
      )
      await clickCodex()
      await wait(
        () =>
          page.executeJavaScript(`(() => {
          const groups = adeHandle.get('editorGroupsService');
          const id = adeHandle.get('storageService').getNumber('ade.chatTerminalGroup', 1);
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
            "adeHandle.get('terminalService').instances.length === 1",
          ),
        'terminal restored before any new launch',
      )
      await page.executeJavaScript(
        "adeHandle.get('terminalService').instances[0].sendText('q', false)",
      )
      await wait(
        async () =>
          page.executeJavaScript(
            "adeHandle.get('storageService').getNumber('ade.chatTerminalGroup', 1) === undefined",
          ),
        'restored group cleared before any new launch',
      )
      assert.equal(
        await page.executeJavaScript(
          "adeHandle.get('terminalService').instances.length",
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
        page.executeJavaScript(`adeHandle.get('terminalService').instances.map(t => ({
        resource: t.resource.toString(),
        group: adeHandle.get('editorService').findEditors(t.resource)[0]?.groupId,
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
      await wait(
        async () =>
          page.executeJavaScript(
            `adeHandle.get('editorGroupsService').activeGroup.id === ${saved.group}`,
          ),
        'chat click during startup focuses restored group',
      )
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
            `adeHandle.get('terminalService').activeInstance?.resource.toString() === ${JSON.stringify(restored.resource)}`,
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
        "adeHandle.get('terminalService').instances.forEach(t => t.sendText('q', false))",
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
      `void (async () => { globalThis.failedChatTestTerminal = await adeHandle.get('terminalService').createTerminal({ config: { executable: 'ade-nonexistent-test-shell', waitOnExit: false }, location: 1 }); })()`,
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
        "adeHandle.get('editorGroupsService').groups.length",
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
      page.executeJavaScript(`adeHandle.get('terminalService').instances
      .filter(t => t.shellLaunchConfig.env?.ADE_TERMINAL_ID)
      .map(t => ({id: t.shellLaunchConfig.env.ADE_TERMINAL_ID, name: t.shellLaunchConfig.name,
        group: adeHandle.get('editorService').findEditors(t.resource)[0]?.groupId}))`)
    let opened = await terminals()
    assert.equal(opened.length, 2)
    assert.equal(opened[0].group, opened[1].group)
    assert.ok(
      opened.every((t) => t.name === undefined),
      'terminal titles use the workbench default',
    )
    // Keep a separate editor group to exercise focus changes and later split creation.
    await page.executeJavaScript(`{
      const groups = adeHandle.get('editorGroupsService');
      const editorGroup = groups.addGroup(groups.activeGroup, 2);
      void groups.activateGroup(editorGroup);
    }`)
    await command('workbench.action.files.newUntitledFile')
    await command('workbench.action.focusLastEditorGroup')

    // Hold terminal creation so a focus change during startup is deterministic.
    await page.executeJavaScript(`{
      const get = adeHandle.get;
      const service = get('terminalService');
      adeHandle.get = id => id !== 'terminalService' ? get(id) : {
        get instances() { return service.instances },
        setActiveInstance: terminal => service.setActiveInstance(terminal),
        createTerminal: async options => {
          adeHandle.get = get;
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
      "adeHandle.get('editorGroupsService').activeGroup.id",
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
        "adeHandle.get('editorGroupsService').activeGroup.id",
      ),
      focusedGroup,
      'launch preserves intervening focus changes',
    )
    assert.equal(
      await page.executeJavaScript(
        "adeHandle.get('editorGroupsService').activeGroup.isLocked",
      ),
      false,
      'unrelated editor group is not locked',
    )

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
          terminalId: first.id,
          worktreePath: repo,
          title: 'First chat',
          status: 'idle',
          mtime: Date.now(),
          pid: first.pid,
        }),
      },
    )
    assert.equal(response.status, 204)
    await wait(
      async () =>
        sidebar.executeJavaScript(
          '!!document.querySelector(".chat-open:enabled")',
        ),
      'chat row',
    )
    await sidebar.executeJavaScript(
      'document.querySelector(".chat-open:enabled").click()',
    )
    await wait(
      async () =>
        page.executeJavaScript(
          `adeHandle.get('terminalService').activeInstance?.shellLaunchConfig.env?.ADE_TERMINAL_ID === ${JSON.stringify(first.id)}`,
        ),
      'matching terminal focus',
    )
    await command('workbench.action.terminal.sendSequence', { text: 'q' })
    await wait(
      async () =>
        page.executeJavaScript(
          `!adeHandle.get('terminalService').instances.some(t => t.shellLaunchConfig.env?.ADE_TERMINAL_ID === ${JSON.stringify(first.id)})`,
        ),
      'terminal closes after CLI exit',
    )
    assert.equal((await terminals()).length, 2)
    await page.executeJavaScript(`adeHandle.get('terminalService').instances
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
        "adeHandle.get('editorGroupsService').groups.length",
      ),
      2,
      'an occupied editor keeps its space when the chat group is created',
    )
    const saved = await page.executeJavaScript(`(() => {
      const t = adeHandle.get('terminalService').instances[0];
      return { id: t.shellLaunchConfig.env.ADE_TERMINAL_ID, resource: t.resource.toString(), group: adeHandle.get('editorService').findEditors(t.resource)[0].groupId };
    })()`)
    const session = JSON.parse(
      await readFile(join(repo, saved.id + '.json'), 'utf8'),
    )
    assert.equal(
      await page.executeJavaScript(
        "adeHandle.get('terminalService').instances.every(t => t.shouldPersist)",
      ),
      true,
      'chat terminals remain persistent after settings reloads',
    )
    // Keep the restart fixture's unrelated group empty, as in a newly opened workbench.
    await command('workbench.action.focusFirstEditorGroup')
    await page.executeJavaScript(`(async () => {
      const groups = adeHandle.get('editorGroupsService');
      await groups.activeGroup.closeAllEditors({ preserveFocus: true });
      if (groups.groups.length === 1) groups.addGroup(groups.activeGroup, 2);
    })()`)
    const report = await fetch(
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
          terminalId: saved.id,
          worktreePath: repo,
          title: 'Restored chat',
          status: 'idle',
          mtime: Date.now(),
          pid: session.pid,
        }),
      },
    )
    assert.equal(report.status, 204)
    await command('workbench.action.focusFirstEditorGroup')
    assert.notEqual(
      await page.executeJavaScript(
        "adeHandle.get('editorGroupsService').activeGroup.id",
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

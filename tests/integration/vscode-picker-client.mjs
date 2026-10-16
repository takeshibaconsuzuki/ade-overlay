import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Other desktop windows must not suspend renderer animations during this test.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.setPath('userData', join(process.env.ADE_PICKER_DATA, 'electron-data'))
let togglePicker
globalShortcut.register = (_shortcut, listener) => {
  togglePicker = listener
  return true
}
await import('./index.js')

const wait = async (condition, label) => {
  const deadline = Date.now() + 20000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await delay(25)
  }
}

void app.whenReady().then(async () => {
  try {
    await wait(() => BrowserWindow.getAllWindows().length === 1, 'picker')
    const picker = BrowserWindow.getAllWindows()[0]
    // Unrelated desktop focus changes must not clear an in-progress test.
    // Exercise the production blur handler explicitly below.
    const blurListeners = picker.webContents.listeners('blur')
    picker.webContents.removeAllListeners('blur')
    picker.setFocusable(false)
    const run = (script) => picker.webContents.executeJavaScript(script)
    // Show and hide through the shortcut handler so the renderer is told about visibility.
    // The picker's session state is tracked here, as Electron's visibility is unreliable.
    let pickerShown = true
    const toggleTrackedPicker = () => {
      togglePicker()
      pickerShown = !pickerShown
    }
    const showPicker = () => {
      if (!pickerShown) toggleTrackedPicker()
    }
    const hidePicker = () => {
      if (pickerShown) toggleTrackedPicker()
    }
    await wait(
      async () =>
        !picker.webContents.isLoading() &&
        (await run('document.body.innerText.includes("No worktrees found.")')),
      'connected picker',
    )
    // Keep the user's real pointer independent of the injected test events.
    await run(`document.addEventListener('pointermove', event => {
      if (event.isTrusted) event.stopImmediatePropagation();
    }, true)`)
    const opened = []
    ipcMain.removeHandler('worktree:open')
    ipcMain.handle('worktree:open', (_event, path) => opened.push(path))
    const worktrees = Array.from({ length: 30 }, (_, index) => ({
      path: `/projects/repository/worktree-${index}`,
      basename: `Worktree ${index}`,
      branchName: `feature/branch-${index}`,
      mainWorktreePath: '/projects/repository/worktree-0',
      deleting: false,
      vscode: {
        path: `/projects/repository/worktree-${index}`,
        state: 'stopped',
      },
    }))
    const publish = (rows) => picker.webContents.send('worktrees:changed', rows)
    picker.webContents.debugger.attach('1.3')
    await picker.webContents.debugger.sendCommand('Accessibility.enable')
    const accessibleSelection = async (index) => {
      const { nodes } = await picker.webContents.debugger.sendCommand(
        'Accessibility.getFullAXTree',
      )
      const input = nodes.find((node) => node.role?.value === 'combobox')
      const activeId = input?.properties.find(
        (property) => property.name === 'activedescendant',
      )?.value.relatedNodes?.[0]?.backendDOMNodeId
      const active = nodes.find(
        (node) => activeId && node.backendDOMNodeId === activeId,
      )
      assert.equal(
        active?.role.value,
        'row',
        'Chromium exposes the active result',
      )
      assert.equal(
        active.name.value,
        `${worktrees[index].basename}, ${worktrees[index].branchName}`,
      )
      assert.equal(
        active.properties.find((property) => property.name === 'selected')
          ?.value.value,
        true,
      )
      assert.ok(
        nodes.some(
          (node) =>
            !node.ignored &&
            node.role?.value === 'button' &&
            node.name?.value === `Actions for ${worktrees[index].basename}`,
        ),
        'row actions remain exposed to assistive technology',
      )
    }
    const selected = async (index) => {
      await wait(
        async () =>
          await run(`(() => {
            const rows = document.querySelectorAll('[data-highlighted="true"]');
            return rows.length === 1 && rows[0].dataset.path === ${JSON.stringify(worktrees[index].path)};
          })()`),
        `exactly one selection: ${index}`,
      ).catch(async (error) => {
        console.error(
          await run(
            `({ selected: [...document.querySelectorAll('[data-highlighted="true"]')].map(row => row.dataset.path), focus: document.activeElement.outerHTML, visible: document.visibilityState })`,
          ),
        )
        throw error
      })
      assert.equal(
        await run(`(() => {
          const input = document.querySelector('input');
          const grid = document.getElementById(input.getAttribute('aria-controls'));
          const active = document.getElementById(input.getAttribute('aria-activedescendant'));
          return input.getAttribute('role') === 'combobox' &&
            input.getAttribute('aria-expanded') === 'true' &&
            input.getAttribute('aria-haspopup') === 'grid' &&
            grid?.getAttribute('role') === 'grid' && grid.contains(active) &&
            active?.getAttribute('role') === 'row' &&
            active.dataset.path === ${JSON.stringify(worktrees[index].path)} &&
            active.getAttribute('aria-selected') === 'true' &&
            grid.querySelectorAll('[aria-selected="true"]').length === 1;
        })()`),
        true,
        'accessible active result follows the highlighted row',
      )
    }
    const key = async (key) => {
      await run(
        `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`,
      )
    }
    const search = async (value) => {
      await run(`(() => {
        const input = document.querySelector('input');
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
    }
    const pointer = async (index, x = 100, y = 100) => {
      await run(
        `document.querySelectorAll('.worktree-row')[${index}].dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${x}, clientY: ${y} }))`,
      )
    }
    showPicker()
    publish(worktrees)
    await selected(0)
    assert.equal(
      await run('document.activeElement === document.querySelector("input")'),
      true,
    )
    assert.equal(
      await run('document.querySelector("header").innerText.trim()'),
      'Refresh',
    )
    await key('ArrowDown')
    await selected(1)
    await accessibleSelection(1)
    assert.equal(
      await run('document.activeElement === document.querySelector("input")'),
      true,
      'arrow navigation preserves typing focus',
    )
    await pointer(4)
    await selected(4)
    await key('ArrowDown')
    await selected(5)
    // Layout-generated pointer events at the same coordinates cannot undo a key press.
    await pointer(4)
    await selected(5)
    await pointer(4, 101)
    await selected(4)
    await key('Enter')
    await wait(() => opened.length === 1, 'Enter opens selection')
    assert.equal(opened[0], worktrees[4].path)
    await run('document.querySelectorAll(".worktree-open")[2].focus()')
    await run(
      'document.activeElement.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))',
    )
    await selected(2)
    await pointer(6, 102)
    await selected(6)
    await key('Enter')
    await wait(
      () => opened.length === 2,
      'Enter follows mouse selection after keyboard focus',
    )
    assert.equal(opened[1], worktrees[6].path)

    await search('  BRANCH-21  ')
    await selected(21)
    await accessibleSelection(21)
    assert.equal(
      await run('document.querySelectorAll(".worktree-row").length'),
      1,
    )
    await search('WORKTREE 9')
    await selected(9)
    // Only the basename and branch are searched, never the path.
    await search('repository/worktree-12')
    await wait(
      () => run('document.querySelectorAll(".worktree-row").length === 0'),
      'empty search',
    )
    assert.equal(
      await run(
        'document.querySelector("input").hasAttribute("aria-activedescendant")',
      ),
      false,
      'empty results have no active descendant',
    )
    assert.equal(
      await run(
        'document.querySelector("input").getAttribute("aria-expanded")',
      ),
      'false',
    )
    await key('ArrowDown')
    await key('Enter')
    assert.equal(opened.length, 2)
    await search('')
    await selected(0)
    await key('ArrowUp')
    await selected(29)
    assert.equal(
      await run(`(() => {
        const toolbar = document.querySelector('header').getBoundingClientRect();
        const selected = document.querySelector('[data-highlighted="true"]').getBoundingClientRect();
        return document.querySelector('.picker-results [data-radix-scroll-area-viewport]').scrollTop > 0 &&
          window.scrollY === 0 && toolbar.top >= 0 &&
          selected.top >= toolbar.bottom && selected.bottom <= innerHeight &&
          document.documentElement.scrollHeight <= innerHeight;
      })()`),
      true,
      'only the list scrolls and keyboard selection stays visible',
    )
    await key('ArrowDown')
    await selected(0)

    await pointer(7, 103)
    await selected(7)
    publish([...worktrees].reverse())
    await selected(7)
    publish(worktrees.filter((worktree) => worktree !== worktrees[7]))
    await selected(0)
    publish([])
    await wait(
      () =>
        run(
          'document.querySelectorAll("[data-highlighted=true]").length === 0',
        ),
      'empty update',
    )
    publish(worktrees)
    await selected(0)

    await search('branch-21')
    await selected(21)
    for (const listener of blurListeners) listener.call(picker.webContents)
    pickerShown = false
    await wait(
      () => run('document.querySelector("input").value === ""'),
      'search clears while hidden',
    )
    await selected(0)
    await run('document.querySelector("input").blur()')
    showPicker()
    await wait(
      () => run('document.activeElement === document.querySelector("input")'),
      'search focuses on show',
    )
    // Visibility changes must also survive an immediate toggle.
    await search('branch-3')
    await selected(3)
    hidePicker()
    showPicker()
    await wait(
      () =>
        run(
          'document.querySelector("input").value === "" && document.activeElement === document.querySelector("input")',
        ),
      'rapid toggle',
    )
    await selected(0)

    publish([{ ...worktrees[0], deleting: true }])
    await wait(
      () => run('document.querySelectorAll(".worktree-row").length === 1'),
      'disabled row',
    )
    await selected(0)
    await key('Enter')
    assert.equal(
      opened.length,
      2,
      'Enter preserves unavailable-worktree behavior',
    )
    publish(worktrees)
    await wait(
      () => run('document.querySelectorAll(".worktree-row").length === 30'),
      'restore rows',
    )
    picker.setFocusable(true)
    picker.focus()
    await wait(() => picker.isFocused(), 'picker has native focus')
    await run('document.querySelector(".worktree-actions button").focus()')
    await key('Enter')
    await wait(
      () =>
        run(
          'document.querySelector("[role=menu]")?.contains(document.activeElement)',
        ),
      'actions menu',
    )
    await key('ArrowDown')
    await selected(0)
    await key('Escape')
    await wait(
      () => run('!document.querySelector("[role=menu]")'),
      'close menu',
    )
    const clickActions = async () => {
      const { x, y } = await run(`(() => {
        const button = document.querySelector('.worktree-actions button');
        button.scrollIntoView({ block: 'nearest' });
        const rect = button.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await picker.webContents.debugger.sendCommand(
          'Input.dispatchMouseEvent',
          {
            type,
            x,
            y,
            button: 'left',
            clickCount: 1,
          },
        )
      }
      await wait(
        () =>
          run(
            'document.querySelector("[role=menu][data-state=open]")?.contains(document.activeElement)',
          ),
        'mouse opens actions menu',
      )
    }
    // Native show/hide must reset the session even if browser visibility events lag.
    await run(`window.deferPickerVisibility = event => event.stopImmediatePropagation();
      document.addEventListener('visibilitychange', window.deferPickerVisibility, true)`)
    for (const hiddenDuration of [0, 25, 200]) {
      await clickActions()
      toggleTrackedPicker()
      if (hiddenDuration) {
        await wait(() => run('document.hidden'), 'menu hidden with picker')
        await delay(hiddenDuration)
      }
      toggleTrackedPicker()
      await wait(
        () =>
          run(
            '!document.querySelector("[role=menu]") && document.activeElement === document.querySelector("input")',
          ),
        `hiding dismisses menu and restores search focus (${hiddenDuration}ms)`,
      )
      await delay(300)
      assert.equal(
        await run('document.activeElement === document.querySelector("input")'),
        true,
        'search keeps focus after native window activation and menu cleanup',
      )
    }
    await run(`document.removeEventListener('visibilitychange', window.deferPickerVisibility, true);
      delete window.deferPickerVisibility`)
    await run('document.querySelector(".worktree-actions button").focus()')
    await key('Enter')
    await wait(
      () =>
        run(
          'document.querySelector("[role=menu]")?.contains(document.activeElement)',
        ),
      'menu opens again after hide',
    )
    await key('Escape')
    await wait(
      () =>
        run(
          '!document.querySelector("[role=menu]") && document.activeElement === document.querySelector(".worktree-actions button")',
        ),
      'normal dismissal restores trigger focus after a previous hide',
    )
    const assertRestoredRowsKeepSearchFocus = async (label) => {
      await wait(
        () => run('document.querySelectorAll(".worktree-row").length === 30'),
        `${label}: rows return`,
      )
      await delay(200)
      assert.equal(
        await run('!!document.querySelector("[role=menu]")'),
        false,
        `${label}: restoring rows does not reopen a menu`,
      )
      assert.equal(
        await run('document.activeElement === document.querySelector("input")'),
        true,
        `${label}: restoring rows preserves search focus`,
      )
    }
    await clickActions()
    publish(worktrees.slice(0, -1))
    await wait(
      () => run('document.querySelectorAll(".worktree-row").length === 29'),
      'unrelated row removed',
    )
    assert.equal(
      await run('!!document.querySelector("[role=menu][data-state=open]")'),
      true,
      'an available row keeps its menu open during worktree updates',
    )
    publish(worktrees.slice(1))
    await wait(
      () => run('!document.querySelector("[role=menu]")'),
      'removing the menu row unmounts its menu',
    )
    await search('')
    publish(worktrees)
    await assertRestoredRowsKeepSearchFocus('removed worktree')

    await clickActions()
    picker.webContents.send('connection:stateChanged', 'connecting')
    await wait(
      () => run('document.querySelectorAll(".worktree-row").length === 0'),
      'disconnect unmounts rows even before the empty worktree update',
    )
    await search('')
    picker.webContents.send('connection:stateChanged', 'connected')
    await assertRestoredRowsKeepSearchFocus('reconnection')

    await clickActions()
    publish([])
    await wait(
      () => run('document.querySelectorAll(".worktree-row").length === 0'),
      'empty worktree update unmounts rows',
    )
    await search('')
    publish(worktrees)
    await assertRestoredRowsKeepSearchFocus('empty worktree update')

    await clickActions()
    await search('branch-21')
    await selected(21)
    await wait(
      () => run('!document.querySelector("[role=menu]")'),
      'filtering out the menu row unmounts its menu',
    )
    await search('')
    await assertRestoredRowsKeepSearchFocus('filtered worktree')

    for (const index of [0, 17]) {
      await search('')
      await selected(0)
      if (index) {
        await pointer(index, 104)
        await selected(index)
      }
      await run(
        'document.querySelector(".picker-results [data-radix-scroll-area-viewport]").scrollTop = 1000',
      )
      assert.equal(
        await run(
          'document.querySelector(".picker-results [data-radix-scroll-area-viewport]").scrollTop > 0',
        ),
        true,
        'list is manually scrolled before hiding',
      )
      hidePicker()
      await wait(() => run('document.hidden'), 'picker hidden')
      showPicker()
      await wait(
        () =>
          run(
            '!document.hidden && document.querySelector("input").value === "" && document.activeElement === document.querySelector("input")',
          ),
        'reopened picker starts with empty focused search',
      )
      await selected(0)
      assert.equal(
        await run(
          'document.querySelector(".picker-results [data-radix-scroll-area-viewport]").scrollTop',
        ),
        0,
        `reopening resets scroll after selecting row ${index}`,
      )
    }
    await key('Enter')
    await wait(
      () => opened.length === 3,
      'Enter opens the first row after reopening',
    )
    assert.equal(opened[2], worktrees[0].path)
    await run('document.querySelector("input").focus()')
    await writeFile(
      join('out', 'picker-search.png'),
      (await picker.webContents.capturePage()).toPNG(),
    )
    console.log(
      'PASS picker filtering, visibility, mixed navigation, selection and scrolling',
    )
    picker.webContents.debugger.detach()
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})

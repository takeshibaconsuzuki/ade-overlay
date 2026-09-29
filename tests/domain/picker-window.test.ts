import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { BrowserWindow } from 'electron'
import { PickerWindow } from '../../src/main/picker-window.ts'

class Window extends EventEmitter {
  focused = false
  visible = false
  destroyed = false
  isDestroyed() {
    return this.destroyed
  }
  isFocused() {
    return this.focused
  }
  isMinimized() {
    return false
  }
  restore() {}
  show() {
    this.visible = true
  }
  focus() {
    this.focused = true
  }
  hide() {
    this.visible = false
    if (this.focused) {
      this.focused = false
      this.emit('blur')
    }
  }
}

test('each picker visit restores its captured target once despite synchronous blur', () => {
  const window = new Window()
  let active = 'first'
  const restored: string[] = []
  const picker = new PickerWindow(window as unknown as BrowserWindow, {
    capture() {
      const target = active
      return () => {
        restored.push(target)
        active = target
        window.focused = false
        window.emit('blur')
      }
    },
    dispose() {},
  })
  picker.show()
  // Re-showing an already focused picker must not overwrite its return target.
  active = 'picker'
  picker.show()
  picker.hide()
  assert.deepEqual(restored, ['first'])
  assert.equal(window.visible, false)
  active = 'second'
  picker.toggle()
  active = 'picker'
  picker.toggle()
  assert.deepEqual(restored, ['first', 'second'])
})

test('focus loss preserves the newly selected window and discards the old target', () => {
  const window = new Window()
  let restored = 0
  const picker = new PickerWindow(window as unknown as BrowserWindow, {
    capture: () => () => {
      restored++
    },
    dispose() {},
  })
  picker.show()
  window.focused = false
  window.emit('blur')
  picker.hide()
  assert.equal(restored, 0)
  assert.equal(window.visible, false)
})

test('native handoff and closed picker do not retain a focus target', () => {
  const window = new Window()
  let disposed = 0
  const picker = new PickerWindow(window as unknown as BrowserWindow, {
    capture: () => undefined,
    dispose: () => {
      disposed++
    },
  })
  picker.show()
  picker.hide()
  assert.equal(window.visible, false)
  window.destroyed = true
  window.emit('closed')
  picker.show()
  picker.hide()
  picker.toggle()
  assert.equal(disposed, 1)
  assert.equal(window.visible, false)
})

test('without a shortcut the picker stays visible on blur and dismissal', () => {
  const window = new Window()
  let captured = 0
  let disposed = 0
  const picker = new PickerWindow(
    window as unknown as BrowserWindow,
    {
      capture() {
        captured++
        return undefined
      },
      dispose() {
        disposed++
      },
    },
    false,
  )
  picker.show()
  window.focused = false
  window.emit('blur')
  assert.equal(window.visible, true)
  picker.hide()
  assert.equal(window.visible, true)
  assert.equal(window.focused, false)
  picker.show()
  picker.hide()
  assert.equal(window.visible, true)
  assert.equal(window.focused, true)
  assert.equal(captured, 0)
  window.destroyed = true
  window.emit('closed')
  assert.equal(disposed, 1)
})

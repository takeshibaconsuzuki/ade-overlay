import { app, type BrowserWindow } from 'electron'
import koffi from 'koffi'
import type { WindowFocus } from './picker-window.ts'

const nativeHandoff: WindowFocus = {
  capture: () => undefined,
  dispose: () => {},
}

function windowHandle(window: BrowserWindow): bigint {
  const handle = window.getNativeWindowHandle()
  return handle.length === 8
    ? handle.readBigUInt64LE()
    : BigInt(handle.readUInt32LE())
}

export function createWindowFocus(window: BrowserWindow): WindowFocus {
  try {
    if (process.platform === 'win32') return windowsFocus(windowHandle(window))
    if (
      process.platform === 'linux' &&
      (!process.env.WAYLAND_DISPLAY ||
        app.commandLine.getSwitchValue('ozone-platform') === 'x11')
    )
      return x11Focus(Number(windowHandle(window)))
  } catch (error) {
    console.warn('[ADE] Could not initialize previous-window focus:', error)
  }
  // macOS panels hand focus back natively. Wayland compositors also own the
  // handoff; clients cannot query or activate arbitrary other clients' windows.
  return nativeHandoff
}

function windowsFocus(picker: bigint): WindowFocus {
  const user32 = koffi.load('user32.dll')
  const foreground = user32.func('void * __stdcall GetForegroundWindow()')
  const activate = user32.func(
    'int __stdcall SetForegroundWindow(void *window)',
  )
  const visible = user32.func('int __stdcall IsWindowVisible(void *window)')
  const minimized = user32.func('int __stdcall IsIconic(void *window)')
  const owner = user32.func(
    'uint32_t __stdcall GetWindowThreadProcessId(void *window, _Out_ uint32_t *process)',
  )
  return {
    capture() {
      const target: bigint | null = foreground()
      if (!target || target === picker) return
      const processId = [0]
      const thread: number = owner(target, processId)
      if (!thread) return
      return () => {
        const currentProcess = [0]
        // HWND values can be recycled after a window closes. Also avoid
        // stealing focus if the user has already selected another window.
        if (
          foreground() === picker &&
          visible(target) &&
          !minimized(target) &&
          owner(target, currentProcess) === thread &&
          currentProcess[0] === processId[0]
        )
          activate(target)
      }
    },
    dispose: () => user32.unload(),
  }
}

function x11Focus(picker: number): WindowFocus {
  const x11 = koffi.load('libX11.so.6')
  const open = x11.func('void *XOpenDisplay(const char *name)')
  const close = x11.func('int XCloseDisplay(void *display)')
  const rootWindow = x11.func('unsigned long XDefaultRootWindow(void *display)')
  const intern = x11.func(
    'unsigned long XInternAtom(void *display, const char *name, int onlyIfExists)',
  )
  const property = x11.func(
    'int XGetWindowProperty(void *display, unsigned long window, unsigned long property, long offset, long length, int remove, unsigned long requestedType, _Out_ unsigned long *actualType, _Out_ int *format, _Out_ unsigned long *count, _Out_ unsigned long *remaining, _Out_ void **data)',
  )
  const free = x11.func('int XFree(void *data)')
  const send = x11.func(
    'int XSendEvent(void *display, unsigned long window, int propagate, long mask, const void *event)',
  )
  const flush = x11.func('int XFlush(void *display)')
  const display: bigint | null = open(null)
  if (!display) {
    x11.unload()
    return nativeHandoff
  }
  const root = Number(rootWindow(display))
  const active = Number(intern(display, '_NET_ACTIVE_WINDOW', 0))
  const clients = Number(intern(display, '_NET_CLIENT_LIST', 0))
  const clientMessage = koffi.struct({
    type: 'int',
    serial: 'unsigned long',
    send_event: 'int',
    display: 'void *',
    window: 'unsigned long',
    message_type: 'unsigned long',
    format: 'int',
    data: koffi.array('long', 5),
  })
  function windows(atom: number): number[] {
    const type = [0],
      format = [0],
      count = [0],
      remaining = [0]
    const data: (bigint | null)[] = [null]
    try {
      const status = property(
        display,
        root,
        atom,
        0,
        65536,
        0,
        33,
        type,
        format,
        count,
        remaining,
        data,
      )
      if (status || Number(type[0]) !== 33 || format[0] !== 32 || !data[0])
        return []
      // XIDs are 32-bit, but Xlib stores them in native longs. Koffi may decode
      // those as a BigUint64Array on LP64 platforms.
      return Array.from(
        koffi.decode(data[0], 'unsigned long', Number(count[0])) as ArrayLike<
          number | bigint
        >,
        Number,
      )
    } finally {
      if (data[0]) free(data[0])
    }
  }
  return {
    capture() {
      const target = windows(active)[0]
      if (!target || target === picker) return
      return () => {
        if (windows(active)[0] !== picker || !windows(clients).includes(target))
          return
        // EWMH asks the window manager to activate the client, preserving its
        // own focus policy. XEvent is a union padded to 24 native longs.
        const event = Buffer.alloc(24 * koffi.sizeof('long'))
        koffi.encode(event, clientMessage, {
          type: 33,
          serial: 0,
          send_event: 1,
          display,
          window: target,
          message_type: active,
          format: 32,
          data: [2, 0, picker, 0, 0],
        })
        send(display, root, 0, (1 << 20) | (1 << 19), event)
        flush(display)
      }
    },
    dispose() {
      close(display)
      x11.unload()
    },
  }
}

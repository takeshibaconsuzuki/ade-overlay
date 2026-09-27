import { EventEmitter as NodeEvents } from 'node:events'

export class EventEmitter {
  events = new NodeEvents()
  event = (listener) => {
    this.events.on('change', listener)
    return { dispose: () => this.events.off('change', listener) }
  }
  fire(value) {
    this.events.emit('change', value)
  }
  dispose() {
    this.events.removeAllListeners()
  }
}
export class TabInputTerminal {}
export const opened = new EventEmitter()
export const closed = new EventEmitter()
export const changed = new EventEmitter()
export const window = {
  terminals: [],
  activeTerminal: undefined,
  tabGroups: { onDidChangeTabs: changed.event },
  onDidOpenTerminal: opened.event,
  onDidCloseTerminal: closed.event,
}

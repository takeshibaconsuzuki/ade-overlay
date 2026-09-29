import { EventEmitter } from 'node:events'

export const state = {}
export let watcher
export let child
export const launcherProcess = new EventEmitter()
export default launcherProcess

export function reset(platform = 'linux') {
  Object.assign(launcherProcess, {
    platform,
    execPath: 'fixture-node',
    argv: ['node', 'server-dev.mjs', '--config', 'fixture.yaml'],
    exitCode: undefined,
  })
  Object.assign(state, {
    creating: Promise.withResolvers(),
    created: Promise.withResolvers(),
    spawned: Promise.withResolvers(),
    stopping: Promise.withResolvers(),
    launches: [],
    closes: 0,
    treeStops: 0,
    closeError: undefined,
  })
  watcher = new EventEmitter()
  watcher.close = async () => {
    state.closes++
    if (state.closeError) throw state.closeError
  }
  child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = (signal) => {
    state.stopping.resolve(signal)
    return true
  }
  child.finish = (status) => {
    child.exitCode = status
    child.emit('exit', status)
  }
}

export async function buildSettingsBridge() {
  state.created.resolve()
  await state.creating.promise
  return watcher
}

export function spawn(...args) {
  state.launches.push(args)
  state.spawned.resolve()
  return child
}

export async function stopProcess() {
  if (child.exitCode !== null) return
  state.treeStops++
  state.stopping.resolve('tree')
}

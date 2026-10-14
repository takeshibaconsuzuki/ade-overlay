import {
  initializeExtensions as initialize,
  attachWorkbench as attach,
} from '../../src/workbench/index'
import type {
  ProfileStorage,
  WorkbenchServices,
} from '../../src/workbench/services'

// Only integration installations load this bundle. Production exposes no service locator.
const probe = { workbenchReady: false } as WorkbenchServices & {
  workbenchReady: boolean
}
;(globalThis as unknown as { adeTest: typeof probe }).adeTest = probe
export function initializeExtensions(storage: ProfileStorage): Promise<void> {
  return initialize(storage)
}
export async function attachWorkbench(
  services: WorkbenchServices,
): Promise<void> {
  Object.assign(probe, services)
  await attach(probe)
  probe.workbenchReady = true
}

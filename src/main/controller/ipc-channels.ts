/**
 * IPC channel names for the controller role, shared between the main process
 * (which registers handlers) and the preload bridge (which invokes them). Kept
 * free of `electron` imports so both build targets can import it without pulling
 * main-only modules. Channels are namespaced by role to stay collision-free on
 * the shared (global) IPC bus.
 */
export const CONTROLLER_IPC_CHANNELS = {
  selectRepository: 'controller:select-repository',
  openWorktrees: 'controller:open-worktrees',
} as const

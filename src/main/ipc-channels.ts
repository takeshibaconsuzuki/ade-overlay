/**
 * IPC channel names for generic main-process actions shared across Electron
 * roles. Kept free of `electron` imports so preload can import it safely.
 */
export const MAIN_IPC_CHANNELS = {
  chooseFiles: 'main:choose-files',
  closeWindow: 'main:close-window',
} as const

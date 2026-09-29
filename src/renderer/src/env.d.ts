import type { CompanionAPI } from '../../shared/ipc'

declare global {
  interface Window {
    companion: CompanionAPI
  }
}

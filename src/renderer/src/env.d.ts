import type { CompanionAPI } from '../../shared/companion'

declare global {
  interface Window {
    companion: CompanionAPI
  }
}

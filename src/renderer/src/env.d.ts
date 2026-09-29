import type { CompanionAPI, PickerWindowAPI } from '../../shared/ipc'

declare global {
  interface Window {
    companion: CompanionAPI
    pickerWindow: PickerWindowAPI
  }
}

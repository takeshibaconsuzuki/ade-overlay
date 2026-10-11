import type { PickerApi } from '../api'

declare global {
  interface Window {
    picker: PickerApi
  }
}

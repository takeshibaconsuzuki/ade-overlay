import { type DesktopApi } from '../../../api/preload/desktop'

export {}

declare global {
  interface Window {
    /**
     * Controller role's privileged API, exposed by the preload bridge (see
     * `src/preload`). The contract lives in `src/api/preload/desktop.ts` so
     * preload and renderer code share one node-free type.
     */
    desktop: DesktopApi
  }
}

import { version } from '../../package.json'
import vscodeServer from '../../vscode-server.json'

export const DEFAULT_SERVER_HOST = '0.0.0.0'
export const DEFAULT_SERVER_PORT = 4317
export const DEFAULT_SERVER_CONFIG_PATH = 'server.config.yaml'
export const MAX_CHAT_DESCRIPTION_LENGTH = 64_000

// Packaged executables embed the full build version; see scripts/build-version.ts.
declare const __BUILD_VERSION__: string | undefined
export const APP_VERSION: string =
  typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : version

// Updated by npm run upgrade; startup downloads this exact release.
export const VSCODE_SERVER_COMMIT = vscodeServer.commit

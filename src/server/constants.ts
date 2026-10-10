import vscodeServer from '../../vscode-server.json'

export const DEFAULT_SERVER_HOST = '0.0.0.0'
export const DEFAULT_SERVER_PORT = 4317
export const DEFAULT_SERVER_CONFIG_PATH = 'server.config.yaml'

// Updated by npm run upgrade; startup downloads this exact release.
export const VSCODE_SERVER_COMMIT = vscodeServer.commit

import { name, productName } from '../../package.json'

export const APP_NAME = name
export const APP_DISPLAY_NAME = productName

export const RPC_PATH = '/rpc'
export const DEFAULT_SERVER_URL = `ws://127.0.0.1:4317${RPC_PATH}`

export const CONNECT_TIMEOUT_MS = 10_000
export const RETRY_MIN_DELAY_MS = 1000
export const RETRY_MAX_DELAY_MS = 30_000

export const MAX_RPC_PAYLOAD_BYTES = 1024 * 1024
export const RPC_TIMEOUT_MS = 10_000
export const HEARTBEAT_INTERVAL_MS = 15_000

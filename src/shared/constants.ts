import { name, productName } from '../../package.json'

export const APP_NAME = name
export const APP_DISPLAY_NAME = productName

export const RPC_PATH = '/rpc'

export const MAX_RPC_PAYLOAD_BYTES = 1024 * 1024
export const RPC_TIMEOUT_MS = 10_000
export const HEARTBEAT_INTERVAL_MS = 15_000

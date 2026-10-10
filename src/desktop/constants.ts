import { RPC_PATH } from '../shared/constants'

export const DEFAULT_SERVER_URL = `ws://127.0.0.1:4317${RPC_PATH}`

export const CONNECT_TIMEOUT_MS = 10_000
export const RETRY_MIN_DELAY_MS = 1000
export const RETRY_MAX_DELAY_MS = 30_000

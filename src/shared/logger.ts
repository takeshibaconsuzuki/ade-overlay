import pino from 'pino'
import { APP_NAME } from './constants'

const isDevelopment =
  process.env.NODE_ENV === 'development' ||
  process.env.npm_lifecycle_event === 'dev' ||
  process.env.npm_lifecycle_event === 'dev:server'

export const logger = pino({
  name: APP_NAME,
  level: process.env.LOG_LEVEL ?? (isDevelopment ? 'debug' : 'info'),
})

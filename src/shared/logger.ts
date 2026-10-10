import pino from 'pino'
import { APP_NAME } from './constants'

export const logger = pino({
  name: APP_NAME,
  level: process.env.LOG_LEVEL ?? 'info',
})

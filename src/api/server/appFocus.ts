export const APP_FOCUS_PATH = '/app-focus'

export const ADE_APP_ROLE = {
  chat: 'chat',
  editor: 'editor',
} as const

export type AdeAppRole = (typeof ADE_APP_ROLE)[keyof typeof ADE_APP_ROLE]

export const APP_FOCUS_EVENT = {
  closed: 'closed',
  focused: 'focused',
} as const

export type AppFocusEvent =
  (typeof APP_FOCUS_EVENT)[keyof typeof APP_FOCUS_EVENT]

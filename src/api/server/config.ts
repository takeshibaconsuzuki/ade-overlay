export const SERVER_HOST = '127.0.0.1'
export const SERVER_PORT = 3000
export const SERVER_ORIGIN = `http://${SERVER_HOST}:${SERVER_PORT}`
export const OPENAPI_PATH = '/openapi.json'
export const OPENAPI_URL = `${SERVER_ORIGIN}${OPENAPI_PATH}`
export const OPENAPI_GENERATED_SPEC_PATH = '.openapi.generated.json'

/**
 * Error code returned by `DELETE /worktrees/:id` when git refuses to remove a
 * worktree that still has modified or untracked files. The renderer keys off
 * this to offer a force-delete confirmation. Shared so server and renderer
 * agree on the exact string.
 */
export const WORKTREE_DIRTY_ERROR_CODE = 'WORKTREE_DIRTY'

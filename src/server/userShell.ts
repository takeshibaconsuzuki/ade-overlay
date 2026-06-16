import { userInfo } from 'node:os'

/**
 * The user's preferred login shell (e.g. `/bin/zsh`), used to source their
 * profile — and thus their real `PATH` — when spawning user-facing commands.
 *
 * A packaged app launched from the macOS Finder/Dock inherits only a minimal
 * `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so user-installed CLIs such as
 * `claude` (`~/.local/bin`) or `codex` (`/opt/homebrew/bin`) aren't found
 * unless the command runs through the login shell. Returns `undefined` when the
 * shell can't be determined, so callers can fall back to a direct spawn.
 */
export function getUserLoginShell(): string | undefined {
  if (process.env.SHELL) {
    return process.env.SHELL
  }

  try {
    return userInfo().shell ?? undefined
  } catch {
    return undefined
  }
}

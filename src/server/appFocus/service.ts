import { ADE_APP_ROLE, type AdeAppRole } from '../../api/server/appFocus'
import { type Logger } from '../../api/server/logger'

export class AppFocusService {
  private readonly roleOrder: AdeAppRole[] = [
    ADE_APP_ROLE.editor,
    ADE_APP_ROLE.chat,
  ]

  constructor(private readonly log: Logger) {}

  getPreferredRole(): AdeAppRole {
    return this.roleOrder[0]
  }

  recordFocused(role: AdeAppRole): void {
    this.moveRole(role, 'head')
    this.log.info({ role, roleOrder: this.roleOrder }, 'ade app focus changed')
  }

  recordClosed(role: AdeAppRole): void {
    this.moveRole(role, 'tail')
    this.log.info({ role, roleOrder: this.roleOrder }, 'ade app closed')
  }

  private moveRole(role: AdeAppRole, position: 'head' | 'tail'): void {
    const currentIndex = this.roleOrder.indexOf(role)
    if (currentIndex >= 0) {
      this.roleOrder.splice(currentIndex, 1)
    }
    if (position === 'head') {
      this.roleOrder.unshift(role)
    } else {
      this.roleOrder.push(role)
    }
  }
}

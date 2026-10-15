import type { Memento } from 'vscode'
import type {
  ChatTerminalIdentity,
  TerminalIdentityStore,
} from './terminal-identities'

export class WorkspaceTerminalIdentityStore implements TerminalIdentityStore {
  constructor(private readonly state: Memento) {}

  read(): Record<string, ChatTerminalIdentity> {
    return this.state.get<Record<string, ChatTerminalIdentity>>(
      'chatTerminals',
      {},
    )
  }

  write(identities: Record<string, ChatTerminalIdentity>): PromiseLike<void> {
    return this.state.update('chatTerminals', identities)
  }
}

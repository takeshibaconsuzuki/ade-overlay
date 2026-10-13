import type { Memento } from 'vscode'
import type { TerminalIdentityStore } from './terminal-identities'

export class WorkspaceTerminalIdentityStore implements TerminalIdentityStore {
  constructor(private readonly state: Memento) {}

  read(): Record<string, string> {
    return this.state.get<Record<string, string>>('chatTerminals', {})
  }

  write(identities: Record<string, string>): PromiseLike<void> {
    return this.state.update('chatTerminals', identities)
  }
}

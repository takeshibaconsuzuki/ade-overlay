import { setTimeout as delay } from 'node:timers/promises'

export interface ChatTerminal {
  readonly processId: PromiseLike<number | undefined>
  show(): void
}

export interface TerminalIdentityStore {
  read(): Record<string, string>
  write(identities: Record<string, string>): PromiseLike<void>
}

// Only resolved identities enter the live index or persistence queue. A failed
// process must never delay registration or focus of another terminal.
export class TerminalIdentities {
  private readonly identities: Record<string, string>
  private readonly resolving = new Map<ChatTerminal, AbortController>()
  private readonly live = new Map<ChatTerminal, { pid: number; id: string }>()
  private writes = Promise.resolve()

  constructor(private readonly store: TerminalIdentityStore) {
    this.identities = store.read()
  }

  track(terminal: ChatTerminal, id: string | undefined): void {
    // Restored terminals have no launch options; match their PID against saved identities.
    if (!id && !Object.keys(this.identities).length) return
    if (this.resolving.has(terminal) || this.live.has(terminal)) return
    const controller = new AbortController()
    this.resolving.set(terminal, controller)
    void this.resolve(terminal, id, controller)
  }

  private async resolve(
    terminal: ChatTerminal,
    id: string | undefined,
    controller: AbortController,
  ): Promise<void> {
    try {
      const pid = await Promise.race([
        terminal.processId,
        delay(10_000, undefined, { signal: controller.signal, ref: false }),
      ])
      if (controller.signal.aborted || pid === undefined) return
      id ??= this.identities[pid]
      if (!id) return
      this.live.set(terminal, { pid, id })
      this.identities[pid] = id
      this.save()
    } catch (error) {
      if (!controller.signal.aborted)
        console.error('Unable to resolve chat terminal identity', error)
    } finally {
      controller.abort()
      this.resolving.delete(terminal)
    }
  }

  forget(terminal: ChatTerminal): void {
    this.resolving.get(terminal)?.abort()
    const identity = this.live.get(terminal)
    this.live.delete(terminal)
    if (identity && this.identities[identity.pid] === identity.id) {
      delete this.identities[identity.pid]
      this.save()
    }
  }

  private save(): void {
    const snapshot = { ...this.identities }
    this.writes = this.writes
      .then(() => this.store.write(snapshot))
      .catch((error: unknown) => {
        console.error('Unable to save chat terminal identity', error)
      })
  }

  focus(id: string): boolean {
    const terminal = [...this.live].find(
      ([, identity]) => identity.id === id,
    )?.[0]
    if (!terminal) return false
    terminal.show()
    return true
  }

  dispose(): void {
    for (const controller of this.resolving.values()) controller.abort()
    this.resolving.clear()
    this.live.clear()
  }
}

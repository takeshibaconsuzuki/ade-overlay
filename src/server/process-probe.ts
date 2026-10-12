export interface ProcessProbe {
  isAlive(pid: number): boolean
}

export class NodeProcessProbe implements ProcessProbe {
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // Permission failures and unknown errors do not establish that a process died.
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }
}

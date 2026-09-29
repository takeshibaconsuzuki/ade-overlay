// The immutable unit of settings storage, transport and comparison.
export class SettingsSnapshot {
  readonly content: string
  readonly mtime: number

  constructor(content: string, mtime: number) {
    this.content = content
    this.mtime = mtime
    Object.freeze(this)
  }

  static from(
    value: Pick<SettingsSnapshot, 'content' | 'mtime'>,
  ): SettingsSnapshot {
    return new this(value.content, value.mtime)
  }

  equals(other: SettingsSnapshot): boolean {
    return this.content === other.content && this.mtime === other.mtime
  }
}

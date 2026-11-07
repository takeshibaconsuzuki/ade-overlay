import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

// Parsed records of a JSON Lines file; none when the file does not exist. Lines that are
// not JSON are skipped, such as a final line still being written or a line an interrupted
// write left behind.
export async function* readJsonLines(path: string): AsyncGenerator<unknown> {
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      yield record
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  } finally {
    lines.close()
    input.destroy()
  }
}

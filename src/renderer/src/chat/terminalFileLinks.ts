import {
  type IBufferCellPosition,
  type IBufferLine,
  type ILink,
  type ILinkProvider,
  type Terminal,
} from '@xterm/xterm'

export type TerminalFileLink = {
  text: string
  filePath: string
  startIndex: number
  endIndex: number
  line?: number
  column?: number
}

const FILE_TOKEN =
  /(?:(?:[A-Za-z]:[\\/](?![\\/])|[/~]|\.{1,2}[\\/])[^ \t\r\n"'`<>|]+|(?:[\w@.+-]+[\\/])+[\w@.+-]+|[\w@+.-]*[\w@+-]\.[A-Za-z][A-Za-z0-9]{0,11})(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?/g
const TRAILING_PUNCTUATION = /[),.;!?\]}]+$/
const LOCATION_SUFFIX = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$/
const URL_SCHEME_BEFORE_PATH = /[A-Za-z][A-Za-z0-9+.-]*:$/

/**
 * Extract file-looking tokens from one logical terminal line. Locations use
 * the common `path:line:column` and `path#LlineCcolumn` forms.
 */
export function findTerminalFileLinks(text: string): TerminalFileLink[] {
  const links: TerminalFileLink[] = []

  for (const match of text.matchAll(FILE_TOKEN)) {
    const startIndex = match.index
    let token = match[0].replace(TRAILING_PUNCTUATION, '')
    if (
      !token ||
      token.startsWith('//') ||
      URL_SCHEME_BEFORE_PATH.test(text.slice(0, startIndex))
    ) {
      continue
    }

    const location = token.match(LOCATION_SUFFIX)
    let line: number | undefined
    let column: number | undefined
    if (location) {
      line = Number(location[1] ?? location[3])
      column =
        location[2] || location[4]
          ? Number(location[2] ?? location[4])
          : undefined
      token = token.slice(0, -location[0].length)
    }
    if (!token) {
      continue
    }

    const endIndex =
      startIndex + match[0].replace(TRAILING_PUNCTUATION, '').length
    links.push({
      text: text.slice(startIndex, endIndex),
      filePath: token,
      startIndex,
      endIndex,
      line,
      column,
    })
  }

  return links
}

export function terminalFileLinkProvider(
  terminal: Terminal,
  activate: (link: TerminalFileLink) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const logicalLine = readLogicalLine(terminal, bufferLineNumber)
      if (!logicalLine) {
        callback(undefined)
        return
      }

      const links = findTerminalFileLinks(logicalLine.text)
        .map((link): ILink | undefined => {
          const start = logicalPosition(logicalLine.lines, link.startIndex)
          const end = logicalPosition(logicalLine.lines, link.endIndex - 1)
          if (
            !start ||
            !end ||
            bufferLineNumber < start.y ||
            bufferLineNumber > end.y
          ) {
            return undefined
          }
          return {
            range: { start, end },
            text: link.text,
            activate: () => activate(link),
          }
        })
        .filter((link): link is ILink => link !== undefined)

      callback(links.length > 0 ? links : undefined)
    },
  }
}

type LogicalBufferLine = {
  y: number
  line: IBufferLine
  text: string
}

function readLogicalLine(
  terminal: Terminal,
  bufferLineNumber: number,
): { text: string; lines: LogicalBufferLine[] } | undefined {
  const buffer = terminal.buffer.active
  let firstIndex = bufferLineNumber - 1
  let line = buffer.getLine(firstIndex)
  if (!line) {
    return undefined
  }

  while (line.isWrapped && firstIndex > 0) {
    firstIndex -= 1
    const previous = buffer.getLine(firstIndex)
    if (!previous) {
      break
    }
    line = previous
  }

  const lines: LogicalBufferLine[] = []
  for (let index = firstIndex; ; index += 1) {
    const current = buffer.getLine(index)
    if (!current || (index > firstIndex && !current.isWrapped)) {
      break
    }
    lines.push({
      y: index + 1,
      line: current,
      text: current.translateToString(true),
    })
  }

  return {
    text: lines.map((entry) => entry.text).join(''),
    lines,
  }
}

function logicalPosition(
  lines: LogicalBufferLine[],
  stringIndex: number,
): IBufferCellPosition | undefined {
  let remaining = stringIndex
  for (const entry of lines) {
    if (remaining < entry.text.length) {
      return { x: stringIndexToCell(entry.line, remaining), y: entry.y }
    }
    remaining -= entry.text.length
  }
  return undefined
}

function stringIndexToCell(line: IBufferLine, stringIndex: number): number {
  let offset = 0
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x)
    if (!cell) {
      continue
    }
    if (cell.getWidth() === 0) {
      continue
    }
    const cellLength = cell.getChars().length || 1
    if (stringIndex < offset + cellLength) {
      return x + 1
    }
    offset += cellLength
  }
  return line.length
}

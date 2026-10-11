import { parse, type ParseError } from 'jsonc-parser'

// Validates JSONC object structure, not individual VS Code setting names or values.
export function isVscodeSettingsDocument(content: unknown): content is string {
  if (typeof content !== 'string') return false
  const errors: ParseError[] = []
  const value: unknown = parse(content.replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true,
  })
  return (
    errors.length === 0 &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  )
}

const MAX_FIELD_LENGTH = 500

// Formula-injection defense (CLAUDE.md's "top real risk"): appendRow writes
// through the Sheets API with valueInputOption=RAW (see
// providers/googleSheets.ts), which stores content literally and never
// parses it as a formula — that alone prevents a scraped field starting
// with =, +, -, or @ from executing. No character-prefixing is added on
// top of that here, since prefixing would just insert a literal stray
// character into the cell rather than adding any protection RAW mode
// doesn't already provide. This function covers the other half of the
// CLAUDE.md requirement: length-capping.
export function sanitizeField(value: string): string {
  return value.length > MAX_FIELD_LENGTH ? value.slice(0, MAX_FIELD_LENGTH).trim() : value.trim()
}

export function sanitizeRow(row: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(row)) {
    sanitized[key] = sanitizeField(value)
  }
  return sanitized
}

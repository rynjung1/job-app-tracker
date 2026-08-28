export interface SheetRef {
  spreadsheetId: string
  sheetName: string
}

// Maps a known field name (e.g. "Company") to the actual header text used
// in a linked sheet — only exercised once existing-sheet linking (Phase 7)
// is built; the auto-create path always uses the known fields verbatim.
export type ColumnMapping = Record<string, string>

export interface SpreadsheetProvider {
  authenticate(): Promise<void>
  createSheet(templateColumns: string[]): Promise<SheetRef>
  readHeaders(sheetRef: SheetRef): Promise<string[]>
  mapColumns(existingHeaders: string[], knownFields: string[]): ColumnMapping
  appendRow(sheetRef: SheetRef, row: Record<string, string>): Promise<void>
}

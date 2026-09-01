export interface SheetRef {
  spreadsheetId: string
  sheetName: string
}

// Maps a known field name (e.g. "Company") to the actual header text used
// in a linked sheet — only exercised once existing-sheet linking (Phase 7)
// is built; the auto-create path always uses the known fields verbatim.
export type ColumnMapping = Record<string, string>

// Identifies exactly which row appendRow just wrote — CLAUDE.md's original
// interface had appendRow return void, which gave Phase 4's Undo/Edit no
// way to know which row to act on. Changed with explicit sign-off (see
// CLAUDE.md Spreadsheet backend, Phase 4 note) rather than working around
// it with an extra read that would've raced against concurrent edits.
export interface AppendedRow {
  sheetName: string
  rowNumber: number
}

export interface SpreadsheetProvider {
  authenticate(): Promise<void>
  createSheet(templateColumns: string[]): Promise<SheetRef>
  readHeaders(sheetRef: SheetRef): Promise<string[]>
  mapColumns(existingHeaders: string[], knownFields: string[]): ColumnMapping
  appendRow(sheetRef: SheetRef, row: Record<string, string>): Promise<AppendedRow>
  // NOT in CLAUDE.md's original locked interface — added for Phase 4's
  // Undo (mark Status) and Edit (overwrite Resume Version), which both
  // need to update one cell in an already-written row. Flagged as a new
  // addition beyond the previously-approved appendRow signature change,
  // not silently bundled into it.
  updateCell(
    sheetRef: SheetRef,
    rowNumber: number,
    columnName: string,
    value: string,
  ): Promise<void>
}

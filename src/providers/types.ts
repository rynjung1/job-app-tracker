export interface SheetRef {
  spreadsheetId: string
  sheetName: string
  // Excel only — the Table's id, captured from tables/add's response at
  // createSheet time rather than assumed as a fixed name like "Table1".
  // Optional and additive: GoogleSheetsProvider never sets it, and every
  // provider-agnostic caller (background worker, popup, options page)
  // treats SheetRef as an opaque token, so nothing else needs to change.
  tableId?: string
  // Excel only — the driveItem's real webUrl, captured at createSheet
  // time. Needed because (unlike Sheets' predictable
  // docs.google.com/spreadsheets/d/{id}/edit) OneDrive/SharePoint web URLs
  // are account/tenant-specific and can't be constructed from the item id
  // alone. Options page falls back to the Google URL construction when
  // this is absent.
  webUrl?: string
}

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
  // NOT in CLAUDE.md's original locked interface — added for the popup's
  // Edit/Undo-from-the-recent-list feature. updateCell/Undo are blind
  // positional writes by rowNumber with no identity check; making them
  // reachable indefinitely (not just the notification's short window)
  // meant the risk of a stale rowNumber pointing at a row the user has
  // since reordered/edited by hand needed an actual mitigation, not just
  // acceptance — this is what that mitigation reads before writing.
  readRow(sheetRef: SheetRef, rowNumber: number): Promise<Record<string, string>>
}

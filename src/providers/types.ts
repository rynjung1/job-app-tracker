export interface SheetRef {
  spreadsheetId: string
  sheetName: string
  // The numeric grid sheetId (not the string sheetName),
  // captured at createSheet time. batchUpdate's formatting requests
  // (repeatCell, addConditionalFormatRule, updateDimensionProperties) all
  // address ranges via this numeric id, not the sheet name, and it was
  // never previously captured since nothing needed it before createSheet
  // formatting (Phase: new-sheet formatting).
  sheetId?: number
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

// Added 2026-09-13 ("needs reconnect"), a flagged addition to the provider
// contract: a provider throws this when it can't get authorization without
// the user signing in again. For Google: the non-interactive token request
// fails while online, or a 401 survives the one retry. getActiveProvider()'s
// wrapper turns it into the "sign-in needed" flag (lib/authStatus.ts). The
// message keeps the provider's original error text.
export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthRequiredError'
  }
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
  // Added 2026-09-13 for the popup's live status chips: the named columns
  // of several rows in one read, returned in rowNumbers' order, each keyed
  // by column name. Read-only (CLAUDE.md, Logging behavior).
  readCells(sheetRef: SheetRef, rowNumbers: number[], columnNames: string[]): Promise<Record<string, string>[]>
  // Added 2026-09-14, a flagged addition: each logged application's Log
  // ID and the row it's on, for the offline-queue drain's duplicate check;
  // null when the sheet has no Log ID column (CLAUDE.md, Sheet setup).
  readLogIds(sheetRef: SheetRef): Promise<Map<string, number> | null>
}

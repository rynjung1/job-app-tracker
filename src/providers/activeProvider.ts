import { googleSheetsProvider } from './googleSheets'
import type { SpreadsheetProvider } from './types'

// The one place the rest of the extension gets its SpreadsheetProvider.
// Google Sheets is the only backend since Excel/OneDrive support was removed
// on 2026-09-13 (CLAUDE.md, Spreadsheet backend). The interface and this seam
// stay, so another backend could be added without touching the callers.
export async function getActiveProvider(): Promise<SpreadsheetProvider> {
  return googleSheetsProvider
}

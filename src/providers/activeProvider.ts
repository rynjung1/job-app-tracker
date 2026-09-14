import { googleSheetsProvider } from './googleSheets'
import { AuthRequiredError } from './types'
import type { SpreadsheetProvider } from './types'
import { reportAuthOk, reportAuthRequired } from '../lib/authStatus'

// The one place the rest of the extension gets its SpreadsheetProvider.
// Google Sheets is the only backend since Excel/OneDrive support was removed
// on 2026-09-13 (CLAUDE.md, Spreadsheet backend). The interface and this seam
// stay, so another backend could be added without touching the callers.
//
// "Needs reconnect" (2026-09-13): every method goes through `tracked`, so
// any call that fails with AuthRequiredError sets the "sign-in needed" flag
// and any call that succeeds clears it, whichever caller made it (an apply,
// the queue drain, the notification's Undo, a popup or Settings request).
// Updating the flag never changes the call's own result.
async function tracked<T>(call: () => Promise<T>): Promise<T> {
  let result: T
  try {
    result = await call()
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      await reportAuthRequired(err.message).catch((e) =>
        console.warn('[job-app-tracker] could not record sign-in needed:', e),
      )
    }
    throw err
  }
  await reportAuthOk().catch((e) => console.warn('[job-app-tracker] could not clear sign-in needed:', e))
  return result
}

const provider = googleSheetsProvider

// Listed method by method (not a Proxy), so adding a method to
// SpreadsheetProvider is a type error here until it's tracked too.
const trackedProvider: SpreadsheetProvider = {
  authenticate: () => tracked(() => provider.authenticate()),
  createSheet: (templateColumns) => tracked(() => provider.createSheet(templateColumns)),
  readHeaders: (sheetRef) => tracked(() => provider.readHeaders(sheetRef)),
  appendRow: (sheetRef, row) => tracked(() => provider.appendRow(sheetRef, row)),
  updateCell: (sheetRef, rowNumber, columnName, value) =>
    tracked(() => provider.updateCell(sheetRef, rowNumber, columnName, value)),
  readRow: (sheetRef, rowNumber) => tracked(() => provider.readRow(sheetRef, rowNumber)),
  readCells: (sheetRef, rowNumbers, columnNames) => tracked(() => provider.readCells(sheetRef, rowNumbers, columnNames)),
  readLogIds: (sheetRef) => tracked(() => provider.readLogIds(sheetRef)),
}

export async function getActiveProvider(): Promise<SpreadsheetProvider> {
  return trackedProvider
}

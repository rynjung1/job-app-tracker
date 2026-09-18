import { googleSheetsProvider } from './googleSheets'
import { AuthRequiredError, SheetMissingError } from './types'
import type { SpreadsheetProvider } from './types'
import { reportAuthOk, reportAuthRequired } from '../lib/authStatus'
import { clearSheetProblem, reportSheetProblem } from '../lib/sheetStatus'

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
//
// "Sheet in the trash or deleted" (2026-09-14, lib/sheetStatus.ts): a
// SheetMissingError sets the 'missing' state, and a call that reached the
// connected sheet clears it. Only isTrashed decides 'trashed', since the
// Sheets API answers a trashed sheet exactly like a healthy one.
const warn = (what: string) => (e: unknown) => console.warn(`[job-app-tracker] could not ${what}:`, e)

async function tracked<T>(call: () => Promise<T>, reachesSheet = false): Promise<T> {
  let result: T
  try {
    result = await call()
  } catch (err) {
    if (err instanceof AuthRequiredError) await reportAuthRequired(err.message).catch(warn('record sign-in needed'))
    if (err instanceof SheetMissingError) await reportSheetProblem('missing', err.message).catch(warn('record the sheet missing'))
    throw err
  }
  await reportAuthOk().catch(warn('clear sign-in needed'))
  if (reachesSheet) await clearSheetProblem('missing').catch(warn('clear the sheet missing'))
  return result
}

// Sign-in only (2026-09-17): for a sheet that ISN'T the connected one — the
// previous sheet, checked before a switch back. `tracked` sets and clears
// `sheetStatus`, which describes the *connected* sheet, so checking another
// sheet through it marked the connected one trashed or cleared a real
// 'missing' flag (audit finding, 2026-09-17: writes froze, SET_STATUS and
// SAVE_NOTE were refused and a false notification fired until the next tick).
// Whether Google will let us in at all is account-wide, not per-sheet, so
// that half of the tracking stays.
async function trackedAuthOnly<T>(call: () => Promise<T>): Promise<T> {
  let result: T
  try {
    result = await call()
  } catch (err) {
    if (err instanceof AuthRequiredError) await reportAuthRequired(err.message).catch(warn('record sign-in needed'))
    throw err
  }
  await reportAuthOk().catch(warn('clear sign-in needed'))
  return result
}

const provider = googleSheetsProvider

// The two reads a health check makes, for a sheet other than the connected
// one. Deliberately not a full SpreadsheetProvider: nothing else may be
// called on a sheet we aren't connected to.
export const otherSheetProvider: Pick<SpreadsheetProvider, 'readHeaders' | 'isTrashed'> = {
  readHeaders: (sheetRef) => trackedAuthOnly(() => provider.readHeaders(sheetRef)),
  isTrashed: (sheetRef) => trackedAuthOnly(() => provider.isTrashed(sheetRef)),
}

// Listed method by method (not a Proxy), so adding a method to
// SpreadsheetProvider is a type error here until it's tracked too.
const trackedProvider: SpreadsheetProvider = {
  authenticate: () => tracked(() => provider.authenticate()),
  createSheet: (templateColumns, title) => tracked(() => provider.createSheet(templateColumns, title)),
  readHeaders: (sheetRef) => tracked(() => provider.readHeaders(sheetRef), true),
  appendRow: (sheetRef, row) => tracked(() => provider.appendRow(sheetRef, row), true),
  updateCell: (sheetRef, rowNumber, columnName, value) =>
    tracked(() => provider.updateCell(sheetRef, rowNumber, columnName, value), true),
  readRow: (sheetRef, rowNumber) => tracked(() => provider.readRow(sheetRef, rowNumber), true),
  readCells: (sheetRef, rowNumbers, columnNames) =>
    tracked(() => provider.readCells(sheetRef, rowNumbers, columnNames), true),
  readLogIds: (sheetRef) => tracked(() => provider.readLogIds(sheetRef), true),
  readTitle: (sheetRef) => tracked(() => provider.readTitle(sheetRef), true),
  isTrashed: (sheetRef) =>
    tracked(async () => {
      const trashed = await provider.isTrashed(sheetRef)
      await (trashed
        ? reportSheetProblem('trashed', "Google Drive reports the sheet in its trash")
        : clearSheetProblem()
      ).catch(warn('record the trash check'))
      return trashed
    }, true),
}

export async function getActiveProvider(): Promise<SpreadsheetProvider> {
  return trackedProvider
}

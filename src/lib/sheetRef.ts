import type { SheetRef } from '../providers/types'
import { SHEET_REF_KEY } from './storageKeys'
import { withStorageLock } from './storageLock'

// Extracted out of background/index.ts so background/messageRouter.ts can
// share the exact same read/write without a circular import between the
// two (index.ts registers the onMessage listener that dispatches into
// messageRouter.ts, so messageRouter.ts can't import back from index.ts).
export async function getSheetRef(): Promise<SheetRef | undefined> {
  const stored = await chrome.storage.local.get(SHEET_REF_KEY)
  return stored[SHEET_REF_KEY] as SheetRef | undefined
}

// Locked since 2026-09-14, so a Connect's write can't land between
// updateStoredSheetName's read and write below.
export async function setSheetRef(sheetRef: SheetRef): Promise<void> {
  await withStorageLock(() => chrome.storage.local.set({ [SHEET_REF_KEY]: sheetRef }))
}

// A renamed tab's current name (providers/googleSheets.ts, withSheetRef),
// stored only if that spreadsheet is still the connected one: a Connect may
// have replaced it in the meantime.
export async function updateStoredSheetName(spreadsheetId: string, sheetName: string): Promise<void> {
  await withStorageLock(async () => {
    const stored = await getSheetRef()
    if (stored?.spreadsheetId !== spreadsheetId) return
    await chrome.storage.local.set({ [SHEET_REF_KEY]: { ...stored, sheetName } })
  })
}

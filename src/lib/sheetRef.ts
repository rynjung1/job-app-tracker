import type { SheetRef } from '../providers/types'
import { SHEET_REF_KEY } from './storageKeys'

// Extracted out of background/index.ts so background/messageRouter.ts can
// share the exact same read/write without a circular import between the
// two (index.ts registers the onMessage listener that dispatches into
// messageRouter.ts, so messageRouter.ts can't import back from index.ts).
export async function getSheetRef(): Promise<SheetRef | undefined> {
  const stored = await chrome.storage.local.get(SHEET_REF_KEY)
  return stored[SHEET_REF_KEY] as SheetRef | undefined
}

export async function setSheetRef(sheetRef: SheetRef): Promise<void> {
  await chrome.storage.local.set({ [SHEET_REF_KEY]: sheetRef })
}

import { getActiveProvider } from '../providers/activeProvider'
import { SheetMissingError } from '../providers/types'
import type { SheetRef } from '../providers/types'
import { getSheetRef } from '../lib/sheetRef'

// Asks Drive whether the connected sheet is in the trash; the provider
// wrapper records the answer (lib/sheetStatus.ts). Called after each
// application logged directly, when the popup opens, and on a retry-alarm
// tick while applications are waiting or the sheet is flagged (2026-09-14). Never throws: a check that
// fails (offline, a 500, a timeout) changes nothing, and signed out it
// sets "sign-in needed" through the same wrapper.
export async function checkSheetInTrash(): Promise<void> {
  const sheetRef = await getSheetRef()
  if (!sheetRef) return
  try {
    await (await getActiveProvider()).isTrashed(sheetRef)
  } catch (err) {
    console.warn('[job-app-tracker] trash check failed; the sheet flag is unchanged:', err)
  }
}

// Healthy means reachable (its header row reads) and not in Drive's trash.
// Used before Connect keeps a stored sheet and before "Create a new sheet"
// replaces one. Errors other than a deleted sheet are thrown, so nothing is
// replaced on, say, a network failure.
export type SheetHealth = 'healthy' | 'trashed' | 'missing'

export async function sheetHealth(sheetRef: SheetRef): Promise<SheetHealth> {
  const provider = await getActiveProvider()
  try {
    await provider.readHeaders(sheetRef)
    return (await provider.isTrashed(sheetRef)) ? 'trashed' : 'healthy'
  } catch (err) {
    if (err instanceof SheetMissingError) return 'missing'
    throw err
  }
}

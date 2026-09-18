import { getActiveProvider, otherSheetProvider } from '../providers/activeProvider'
import { AuthRequiredError, SheetMissingError } from '../providers/types'
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
// Used before Connect keeps a stored sheet, before "Create a new sheet"
// replaces one, and before a switch back adopts the previous one.
//
// A failure to *reach* the sheet that isn't a 404 is still thrown, so
// nothing is replaced on, say, a network failure. A failure of the trash
// check alone is not (audit finding, 2026-09-17): Drive being unreachable
// used to break Connect, "Create a new sheet" and the switch back entirely.
// It now reads as healthy — the trash detection is lost for that call, not
// the feature, and the next check notices the trash. A sign-in failure is
// still thrown: it's actionable, and Settings offers Reconnect for it.
//
// `connected` says whether this is the sheet the extension is connected to.
// For any other sheet the check runs through otherSheetProvider, which
// doesn't touch the connected sheet's trashed/missing flag.
export type SheetHealth = 'healthy' | 'trashed' | 'missing'

export async function sheetHealth(sheetRef: SheetRef, { connected = true } = {}): Promise<SheetHealth> {
  const provider = connected ? await getActiveProvider() : otherSheetProvider
  try {
    await provider.readHeaders(sheetRef)
  } catch (err) {
    if (err instanceof SheetMissingError) return 'missing'
    throw err
  }
  try {
    return (await provider.isTrashed(sheetRef)) ? 'trashed' : 'healthy'
  } catch (err) {
    if (err instanceof AuthRequiredError) throw err
    console.warn('[job-app-tracker] the trash check failed; treating the sheet as healthy:', err)
    return 'healthy'
  }
}

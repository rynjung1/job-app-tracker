import { SHEET_STATUS_KEY } from './storageKeys'
import { withStorageLock } from './storageLock'
import { applicationCount, getQueuedCount } from './authStatus'
import { refreshBadge } from './badge'

// The "sheet in Drive's trash or deleted" flag (2026-09-14, CLAUDE.md,
// Spreadsheet backend). Measured with scripts/sheet-probe.js on a real sheet:
// moving it to Drive's trash changes no Sheets API answer (reads and appends
// still succeed), while Drive's files.get reports trashed=true, and false
// again after a restore. So two states:
// - 'trashed': Drive says the connected sheet is in the trash (the provider's
//   isTrashed, recorded by providers/activeProvider.ts). Cleared only by a
//   later trashed=false.
// - 'missing': the spreadsheet is gone, a 404 confirmed by a second read of
//   it (SheetMissingError). Cleared by any later call that reaches it.
// While either is set nothing is written to the sheet: applications and the
// retry drain wait in the offline queue, and popup changes are refused.
// "Create a new sheet" (CREATE_NEW_SHEET) clears it. Kept in
// chrome.storage.local, like the sign-in flag; `reason` keeps the error text.
export type SheetProblem = 'trashed' | 'missing'

export interface SheetStatus {
  state: SheetProblem
  since: string
  reason: string
}

export const SHEET_PROBLEM_NOTIFICATION_ID = 'sheet-problem'

export async function getSheetStatus(): Promise<SheetStatus | undefined> {
  const stored = await chrome.storage.local.get(SHEET_STATUS_KEY)
  return stored[SHEET_STATUS_KEY] as SheetStatus | undefined
}

// The wording the notification, the popup banner and Settings share.
export function sheetProblemTitle(state: SheetProblem): string {
  return state === 'trashed' ? "Your sheet is in Google Drive's trash" : 'Your sheet was deleted'
}

export function sheetProblemMessage(state: SheetProblem, waiting: number): string {
  const count = waiting > 0 ? ` ${applicationCount(waiting)} ${waiting === 1 ? 'is' : 'are'} waiting.` : ''
  return state === 'trashed'
    ? `Restore it, or create a new sheet.${count} Anything logged before this was noticed is in the trashed sheet and comes back if you restore it.`
    : `Create a new sheet to keep logging.${count}`
}

// Everything below is background-only (chrome.action, chrome.notifications).

// Set and clear run under the storage lock, as for the sign-in flag, so
// concurrent reports notify once. A change of state (trashed, then deleted
// for good) counts as a new report.
export async function reportSheetProblem(state: SheetProblem, reason: string): Promise<void> {
  const changed = await withStorageLock(async () => {
    const current = await getSheetStatus()
    if (current?.state === state) return false
    const status: SheetStatus = { state, since: new Date().toISOString(), reason }
    await chrome.storage.local.set({ [SHEET_STATUS_KEY]: status })
    return true
  })
  if (changed) {
    await refreshBadge()
    await showSheetProblemNotification()
  }
}

// Clears the flag, or only a given state of it (a call that reached the
// sheet disproves 'missing' but says nothing about the trash).
export async function clearSheetProblem(only?: SheetProblem): Promise<void> {
  const cleared = await withStorageLock(async () => {
    const current = await getSheetStatus()
    if (!current || (only !== undefined && current.state !== only)) return false
    await chrome.storage.local.remove(SHEET_STATUS_KEY)
    return true
  })
  if (cleared) {
    await refreshBadge()
    await chrome.notifications.clear(SHEET_PROBLEM_NOTIFICATION_ID)
  }
}

// Fixed id: a newer one replaces it in place. Shown when the flag is first
// set, and again for each application queued while it's set
// (background/index.ts); never by the 5-minute check on its own.
export async function showSheetProblemNotification(): Promise<void> {
  const status = await getSheetStatus()
  if (!status) return
  await chrome.notifications.create(SHEET_PROBLEM_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: sheetProblemTitle(status.state),
    message: sheetProblemMessage(status.state, await getQueuedCount()),
    buttons: [{ title: 'Open Settings' }],
  })
}

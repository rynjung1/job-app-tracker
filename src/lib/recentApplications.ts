import { RECENT_APPLICATIONS_KEY } from './storageKeys'
import type { SheetRef, SpreadsheetProvider } from '../providers/types'
import { withStorageLock } from './storageLock'
import type { StatusValue } from './sheetTemplate'
import { LOG_ID_COLUMN } from './sheetTemplate'

// Named in CLAUDE.md's Tech Stack section ("chrome.storage.local for ...
// the cached recent-applications list") but not built until Phase 4, when
// Edit actually needed somewhere to render a just-logged entry.
export interface RecentApplication {
  id: string
  title: string
  company: string
  location: string | null
  url: string
  date: string
  status: string
  sheetName: string
  rowNumber: number
  // The row's hidden Log ID (2026-09-14), for rowStillMatches below, and so
  // the popup can leave out a waiting application once its saved entry exists
  // (lib/popupList.ts). Absent on entries logged before it and on rows of
  // sheets without the column.
  logId?: string
}

export const MAX_RECENT = 20

// Is this sheet row still the entry's? Checked by SAVE_RESUME_VERSION and
// SET_STATUS before writing (background/messageRouter.ts). Since 2026-09-14
// the Log ID decides when both the entry and the sheet have one: a row that
// moved is caught, and editing its Company in the sheet (a cryptic Workday
// tenant id, say) no longer blocks the popup. Otherwise Company and Title must
// both still match, as before.
export function rowStillMatches(row: Record<string, string>, entry: RecentApplication): boolean {
  if (entry.logId && LOG_ID_COLUMN in row) return row[LOG_ID_COLUMN] === entry.logId
  return row.Company === entry.company && row.Title === entry.title
}

export async function getRecentApplications(): Promise<RecentApplication[]> {
  const stored = await chrome.storage.local.get(RECENT_APPLICATIONS_KEY)
  return (stored[RECENT_APPLICATIONS_KEY] as RecentApplication[] | undefined) ?? []
}

// Locked — a read-modify-write against shared storage, real-demonstrated
// to silently lose data under two concurrent calls without this (see
// CLAUDE.md's concurrency-fix note for the reproduction).
export async function addRecentApplication(entry: RecentApplication): Promise<void> {
  await withStorageLock(async () => {
    const list = await getRecentApplications()
    list.unshift(entry)
    await chrome.storage.local.set({ [RECENT_APPLICATIONS_KEY]: list.slice(0, MAX_RECENT) })
  })
}

// Rows the offline-queue drain saved (background/offlineQueue.ts), added in
// one locked write. A drained row can be hours old (queued while signed out
// or offline), so the whole list is re-sorted by applied date, newest
// first, then capped: a row older than the 20th entry is saved to the sheet
// but doesn't enter the list. An unreadable date sorts last.
export async function addRecentApplications(entries: RecentApplication[]): Promise<void> {
  if (entries.length === 0) return
  await withStorageLock(async () => {
    const list = [...entries, ...(await getRecentApplications())]
    const appliedAt = (entry: RecentApplication) => Date.parse(entry.date) || 0
    list.sort((a, b) => appliedAt(b) - appliedAt(a))
    await chrome.storage.local.set({ [RECENT_APPLICATIONS_KEY]: list.slice(0, MAX_RECENT) })
  })
}

// Empties the list: after "Create a new sheet" (2026-09-14) its entries
// point at rows of the old, trashed or deleted sheet.
export async function clearRecentApplications(): Promise<void> {
  await withStorageLock(() => chrome.storage.local.remove(RECENT_APPLICATIONS_KEY))
}

export async function updateRecentApplication(
  id: string,
  patch: Partial<RecentApplication>,
): Promise<RecentApplication | undefined> {
  return withStorageLock(async () => {
    const list = await getRecentApplications()
    const index = list.findIndex((entry) => entry.id === id)
    if (index === -1) return undefined
    list[index] = { ...list[index], ...patch }
    await chrome.storage.local.set({ [RECENT_APPLICATIONS_KEY]: list })
    return list[index]
  })
}

// Shared by background/index.ts's notification Undo handler and the
// popup's own Undo (recent-applications-list feature) — no identity check
// here by design. The notification path's short window is trusted as-is;
// the popup path (reachable indefinitely) does its own readRow-based
// identity check before ever calling this, since a stale rowNumber is a
// real risk there in a way it isn't in the ~5-second notification case.
export async function cancelApplication(
  provider: SpreadsheetProvider,
  sheetRef: SheetRef,
  entry: RecentApplication,
): Promise<void> {
  await setApplicationStatus(provider, sheetRef, entry, 'Cancelled')
}

// The one way a status is written: the Status cell, then the cached entry.
// Used by the notification's Undo (through cancelApplication) and by
// SET_STATUS, the popup's status menu, which checks the row's identity
// first (background/messageRouter.ts).
export async function setApplicationStatus(
  provider: SpreadsheetProvider,
  sheetRef: SheetRef,
  entry: RecentApplication,
  status: StatusValue,
): Promise<RecentApplication | undefined> {
  await provider.updateCell(sheetRef, entry.rowNumber, 'Status', status)
  return updateRecentApplication(entry.id, { status })
}

// Dedicated mutex serializing GoogleSheetsProvider.appendRow — deliberately
// not a reuse of lib/storageLock.ts (fast storage-only operations) or
// lib/msTokenLock.ts (Excel token refresh). An append is a real network
// round trip, up to FETCH_TIMEOUT_MS (30s) in a slow case, and sharing
// either existing lock would stall an unrelated storage write or token
// refresh behind it.
//
// Why appends need serializing at all: appendRow uses
// insertDataOption=OVERWRITE (see googleSheets.ts for why not INSERT_ROWS),
// and a real test fired concurrent OVERWRITE appends at one sheet and lost
// 7 of 20 rows — concurrent requests were handed the same target row and
// silently overwrote each other. Serializing them in this realm is
// sufficient because the background service worker is the only caller of
// appendRow (handleJobApplicationLogged and drainOfflineQueue) and each
// install only ever writes to the sheet its own Connect created — no second
// writer exists. If that ever stops being true (e.g. existing-sheet linking,
// or sheetRef synced across devices), this lock stops being enough.
//
// Same promise-chaining shape as storageLock.ts/msTokenLock.ts, and safe
// across service worker suspension for the same reason: a killed worker's
// in-flight chain dies with whatever was genuinely in flight anyway, and a
// fresh worker starts with a clean, already-resolved tail.
let tail: Promise<void> = Promise.resolve()

export function withSheetAppendLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = tail.then(fn)
  // Always advance to a fulfilled tail regardless of this call's own
  // outcome — otherwise one failed append would permanently jam every later
  // append behind a rejected promise .then(fn) would never run past.
  tail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

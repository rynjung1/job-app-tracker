// A swap is replacing the connected sheet (2026-09-17, audit finding).
//
// Writes pick the sheet to write to and then spend a real network round trip
// on it. A swap landing in that window used to send the row to the
// spreadsheet the user had just left: Settings reported "saved 0", the row
// was in the abandoned file, and its recent-list entry pointed at a row
// number there. Writers check this flag and the stored id before they
// append, and queue or stop instead.
//
// A plain module-scope flag is enough for the same reason isDraining is: a
// swap and every append run in the background worker's own realm. It covers
// the swap's own storage writes only, not the drain that follows one —
// those rows are meant to land in the new sheet.
//
// Known remaining window: a writer that has already passed the check can
// still have a swap complete during its append, so that one row lands in
// the old sheet. Closing it needs a lock the swap and every append share,
// which would mean moving appendRow's own lock up a layer.
let swapping = false

export async function duringSheetSwap<T>(run: () => Promise<T>): Promise<T> {
  swapping = true
  try {
    return await run()
  } finally {
    swapping = false
  }
}

export function sheetSwapInProgress(): boolean {
  return swapping
}

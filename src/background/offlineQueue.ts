// The offline write queue (CLAUDE.md, Background service worker). Moved out
// of background/index.ts unchanged on 2026-09-13, so messageRouter.ts can
// drain it right after a Reconnect without a circular import. The one
// addition: drainOfflineQueue returns how many rows it saved.
import { getActiveProvider } from '../providers/activeProvider'
import { OFFLINE_QUEUE_KEY } from '../lib/storageKeys'
import { getSheetRef } from '../lib/sheetRef'
import { withStorageLock } from '../lib/storageLock'

export async function getOfflineQueue(): Promise<Record<string, string>[]> {
  const stored = await chrome.storage.local.get(OFFLINE_QUEUE_KEY)
  return (stored[OFFLINE_QUEUE_KEY] as Record<string, string>[] | undefined) ?? []
}

// Locked — a read-modify-write against shared storage, real-demonstrated
// to silently lose data under two concurrent calls without this (e.g. two
// applications logged in quick succession). See CLAUDE.md's concurrency-
// fix note for the reproduction.
export async function queueRow(row: Record<string, string>): Promise<void> {
  await withStorageLock(async () => {
    const queue = await getOfflineQueue()
    queue.push(row)
    await chrome.storage.local.set({ [OFFLINE_QUEUE_KEY]: queue })
  })
}

// Retries queued rows in original order, stopping at the first failure this
// pass (a systemic issue — expired auth, network down — shouldn't hammer
// the API once per queued row) and leaving the failed row plus everything
// after it queued for the next alarm.
//
// The closing write does NOT hold the lock for the whole function — only
// for the final read+write, after every appendRow (real network round
// trips) has already happened. Real-demonstrated bug this fixes: a row
// queued by a concurrent apply while a drain is mid-flight used to be
// silently discarded by an overwrite based on a stale snapshot taken
// before the drain started (see CLAUDE.md's concurrency-fix note). Fixed
// by re-reading the current queue inside the lock and dropping only the
// first `drainedCount` entries — correct by construction, not a
// heuristic: queueRow only ever appends to the end and this function only
// ever processes from the start in order, so nothing queued mid-drain can
// land anywhere but after the entries already being drained.
//
// Fixed 2026-09-10 (re-entrancy): a second, distinct real bug, not covered
// by the fix above — RETRY_ALARM_NAME fires every 5 minutes with no
// guarantee the previous invocation has finished, and (before this fix)
// no fetch() call in any provider had a timeout, so one genuinely stalled
// request could keep this function mid-loop past the next alarm. A second
// invocation starting then reads the *same* un-drained queue (per-row
// success was never flushed to storage incrementally, only the whole
// loop's closing write is), and re-appends whatever the first invocation
// already wrote — a real, reproduced double-append, not theoretical (see
// CLAUDE.md's offline-queue notes for the repro). isDraining is safe as a
// plain module-scope flag here specifically because this function only
// ever runs inside the background worker's own realm. Paired with
// FETCH_TIMEOUT_MS (lib/fetchWithTimeout.ts) so a stuck request now fails
// within 30s instead of indefinitely, shrinking the window this guard
// needs to cover in the first place.
//
// Returns the number of rows saved this pass: 0 when nothing was queued,
// nothing is connected, or another drain was already running (its rows are
// still saved, by that drain).
let isDraining = false

export async function drainOfflineQueue(): Promise<number> {
  if (isDraining) {
    console.log('[job-app-tracker] drain already in progress, skipping this call')
    return 0
  }
  isDraining = true
  try {
    const sheetRef = await getSheetRef()
    if (!sheetRef) return 0

    const queue = await getOfflineQueue()
    if (queue.length === 0) return 0

    const provider = await getActiveProvider()
    let drainedCount = 0
    for (const row of queue) {
      try {
        await provider.appendRow(sheetRef, row)
        console.log('[job-app-tracker] queued row written to sheet')
        drainedCount++
      } catch (err) {
        console.warn('[job-app-tracker] retry failed, stopping this pass:', err)
        break
      }
    }
    if (drainedCount === 0) return 0

    await withStorageLock(async () => {
      const current = await getOfflineQueue()
      await chrome.storage.local.set({ [OFFLINE_QUEUE_KEY]: current.slice(drainedCount) })
    })
    return drainedCount
  } finally {
    isDraining = false
  }
}

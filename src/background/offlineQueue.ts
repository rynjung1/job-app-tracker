// The offline write queue (CLAUDE.md, Background service worker). Moved out
// of background/index.ts unchanged on 2026-09-13, so messageRouter.ts can
// drain it right after a Connect or Reconnect without a circular import.
// Additions: drainOfflineQueue returns how many rows it saved, and each
// saved row now gets a recent-list entry (no "Logged" toast), so an
// application made while signed out or offline still shows in the popup
// with Edit, Undo and its live status once it's saved.
import { getActiveProvider } from '../providers/activeProvider'
import type { AppendedRow } from '../providers/types'
import { OFFLINE_QUEUE_KEY } from '../lib/storageKeys'
import { LOG_ID_COLUMN } from '../lib/sheetTemplate'
import { getSheetRef } from '../lib/sheetRef'
import { sheetSwapInProgress } from './sheetSwap'
import { getSheetStatus } from '../lib/sheetStatus'
import { withStorageLock } from '../lib/storageLock'
import { addRecentApplications } from '../lib/recentApplications'
import type { RecentApplication } from '../lib/recentApplications'

// A queued row keeps the sheet's column names (buildRow) and the ISO date
// the user applied, so the entry sorts by when they applied, not when it
// was saved. rowNumber comes from the append itself, as for a direct log.
function recentEntryFor(row: Record<string, string>, appended: AppendedRow): RecentApplication {
  return {
    id: crypto.randomUUID(),
    title: row.Title ?? '',
    company: row.Company ?? '',
    location: row.Location || null,
    url: row.URL ?? '',
    date: row.Date ?? '',
    status: row.Status || 'Applied',
    sheetName: appended.sheetName,
    rowNumber: appended.rowNumber,
    logId: row[LOG_ID_COLUMN] || undefined,
  }
}

// The alarm that runs drainOfflineQueue every 5 minutes (background/index.ts).
export const RETRY_ALARM_NAME = 'retryOfflineQueue'

// Called at the top level of the background worker, so it runs every time
// the worker starts, not only on install (2026-09-14): the alarms doc says
// alarms may not persist across browser restarts before Chrome 150 and to
// check for them on startup, and minimum_chrome_version is 110. Without the
// alarm, queued rows would wait for the next Connect or Reconnect. Creates
// it only when it's missing, so a wake-up doesn't push back its next run.
// chrome.alarms.create is not awaited: it returns a promise only from
// Chrome 111.
export async function ensureRetryAlarm(): Promise<void> {
  try {
    if (await chrome.alarms.get(RETRY_ALARM_NAME)) return
    chrome.alarms.create(RETRY_ALARM_NAME, { periodInMinutes: 5 })
  } catch (err) {
    console.warn('[job-app-tracker] could not check the retry alarm:', err)
  }
}

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
// within 20s instead of indefinitely, shrinking the window this guard
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
    // A sheet in Drive's trash or deleted (lib/sheetStatus.ts): nothing is
    // written; the rows wait for a restore or a new sheet (2026-09-14).
    if (await getSheetStatus()) return 0

    const queue = await getOfflineQueue()
    if (queue.length === 0) return 0

    const provider = await getActiveProvider()

    // Duplicate check (2026-09-14, CLAUDE.md Sheet setup, "Log ID"): an
    // append can succeed at Google while its response times out, which
    // queues the row anyway. One read of the sheet's Log IDs per pass tells
    // those rows apart; they're counted as saved (so they leave the queue)
    // and get their recent-list entry from the row found. A sheet without
    // the column returns null and every row is appended as before. If the
    // read fails, nothing is drained this pass.
    let loggedIds: Map<string, number> | null
    try {
      loggedIds = await provider.readLogIds(sheetRef)
    } catch (err) {
      console.warn('[job-app-tracker] could not read logged ids, stopping this pass:', err)
      return 0
    }

    let drainedCount = 0
    const saved: RecentApplication[] = []
    for (const row of queue) {
      // The connected sheet can change under a drain — each append is a real
      // round trip, and a swap only has to land between two of them (audit
      // finding, 2026-09-17). Stop rather than write the rest into the
      // spreadsheet the user just left; what's left stays queued for the
      // next pass, which the swap's own drain usually is.
      if (sheetSwapInProgress() || (await getSheetRef())?.spreadsheetId !== sheetRef.spreadsheetId) {
        console.log('[job-app-tracker] the connected sheet changed mid-drain; the rest waits for the new sheet')
        break
      }
      const logId = row[LOG_ID_COLUMN]
      const loggedAt = logId ? loggedIds?.get(logId) : undefined
      if (loggedAt !== undefined) {
        console.log('[job-app-tracker] queued row already in the sheet at row', loggedAt, '- not appended again')
        drainedCount++
        saved.push(recentEntryFor(row, { sheetName: sheetRef.sheetName, rowNumber: loggedAt }))
        continue
      }
      try {
        const appended = await provider.appendRow(sheetRef, row)
        console.log('[job-app-tracker] queued row written to sheet')
        drainedCount++
        saved.push(recentEntryFor(row, appended))
        if (logId) loggedIds?.set(logId, appended.rowNumber)
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
    // After the queue write, in its own lock: the rows are already saved
    // either way; this only makes them visible in the popup.
    await addRecentApplications(saved)
    return drainedCount
  } finally {
    isDraining = false
  }
}

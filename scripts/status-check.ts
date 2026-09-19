// Why isn't the Status updating? A read-only diagnostic for the connected
// sheet (2026-09-18). It changes nothing: it only reads storage and the
// spreadsheet, and it makes exactly the reads the two status paths make, so
// what it prints is what those paths would see.
//
//   popup -> sheet   SET_STATUS reads the entry's whole row (readRow) and
//                    refuses to write unless that row's Company and Title
//                    still equal the cached entry's (STALE_ROW).
//   sheet -> popup   GET_LIVE_STATUSES reads Company/Title/Status for every
//                    cached row in one batch (readCells) and keeps a status
//                    only when Company and Title match AND the Status cell
//                    isn't blank (lib/liveStatuses.ts); otherwise the popup
//                    keeps showing the status it had cached.
//
// For each entry it prints: the entry's id, whether it carries a Log ID,
// its row number, the sheet row's Company/Title/Status/Log ID, whether the
// identity check passes, what SET_STATUS would decide, and what the popup's
// chip would show and why.
//
// Bundle it (esbuild comes with Vite), then run it in the extension's
// service worker:
//   ./node_modules/.bin/esbuild scripts/status-check.ts --bundle \
//     --format=iife --platform=browser --outfile=/tmp/status-check-sw.js
//   pbcopy < /tmp/status-check-sw.js
// Paste into chrome://extensions > Job Application Tracker > "service
// worker" console and keep DevTools open until "DONE".
//
// Company and Title are printed as a fingerprint — the first three
// characters and the length — so the output can be pasted into a review
// without naming real applications. Set SHOW_TEXT to true below to print
// them in full; then the output is real application data, so keep it local.
//
// Real shipped code only: googleSheetsProvider's readHeaders, readRow and
// readCells, and the real matchLiveStatuses, called on the provider
// directly rather than through getActiveProvider()'s wrapper, so no
// sign-in or sheet-problem flag is set or cleared by running it. Nothing is
// written to the spreadsheet: no appendRow, no updateCell, no batchUpdate.
// The one storage write anywhere in what this bundles is the provider's own
// rename recovery (updateStoredSheetName), which fires only if a range
// stops parsing because the tab was renamed, and then only corrects the
// stored tab name for the sheet you're already connected to — which is the
// same correction any later write would make.
import { googleSheetsProvider } from '../src/providers/googleSheets'
import { LIVE_STATUS_COLUMNS, matchLiveStatuses } from '../src/lib/liveStatuses'
import { LOG_ID_COLUMN } from '../src/lib/sheetTemplate'
import type { RecentApplication } from '../src/lib/recentApplications'
import type { SheetRef } from '../src/providers/types'

const SHOW_TEXT = false

const fingerprint = (value: string | undefined | null): string => {
  if (!value) return '(blank)'
  return SHOW_TEXT ? value : `${value.slice(0, 3)}…(${value.length})`
}
const columnLetter = (index: number): string => String.fromCharCode(65 + index)

async function run() {
  const stored = await chrome.storage.local.get([
    'sheetRef',
    'previousSheetRef',
    'recentApplications',
    'authStatus',
    'sheetStatus',
    'offlineQueue',
  ])
  const sheetRef = stored.sheetRef as SheetRef | undefined
  const entries = (stored.recentApplications as RecentApplication[] | undefined) ?? []
  const sheetProblem = stored.sheetStatus as { state: string; since: string } | undefined
  const signIn = stored.authStatus as { since: string; reason: string } | undefined

  if (!sheetRef) {
    console.log('No sheet is connected (no sheetRef in storage): nothing to check.')
    return
  }

  const setup: Record<string, unknown> = {
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    spreadsheetId: sheetRef.spreadsheetId,
    storedTabName: sheetRef.sheetName,
    storedTabId: sheetRef.sheetId ?? '(none: a ref from before sheetId was stored)',
    storedTitle: sheetRef.title ?? '(none: filled in on the next Settings open)',
    previousSheetRemembered: stored.previousSheetRef ? 'yes' : 'no',
    // Either of these refuses SET_STATUS and SAVE_NOTE before any request.
    signInNeededFlag: signIn ? { since: signIn.since, reason: signIn.reason } : 'not set',
    sheetProblemFlag: sheetProblem ? { state: sheetProblem.state, since: sheetProblem.since } : 'not set',
    queued: Array.isArray(stored.offlineQueue) ? stored.offlineQueue.length : 0,
    cachedEntries: entries.length,
    entriesCarryingALogId: entries.filter((entry) => entry.logId).length,
  }

  // The tab and its headers, read the way every write does.
  let headers: string[] = []
  try {
    headers = await googleSheetsProvider.readHeaders(sheetRef)
    setup.headers = headers
    setup.hasLogIdColumn = headers.includes(LOG_ID_COLUMN)
    setup.statusColumn = headers.indexOf('Status') === -1 ? 'MISSING' : columnLetter(headers.indexOf('Status'))
  } catch (err) {
    setup.headersRead = `FAILED: ${(err as Error).message.slice(0, 200)}`
    console.log(JSON.stringify(setup, null, 2))
    console.log('The header read failed, so both status paths would fail here too. DONE')
    return
  }
  console.log(JSON.stringify(setup, null, 2))

  if (entries.length === 0) {
    console.log('The popup has no cached applications, so there is nothing for either path to update. DONE')
    return
  }

  // The popup's own read: Company, Title and Status for every cached row,
  // in one batch, then the real matching rule.
  let liveRows: Record<string, string>[] = []
  let liveStatuses: Record<string, string> = {}
  let liveReadError = ''
  try {
    liveRows = await googleSheetsProvider.readCells(
      sheetRef,
      entries.map((entry) => entry.rowNumber),
      LIVE_STATUS_COLUMNS,
    )
    liveStatuses = matchLiveStatuses(entries, liveRows)
  } catch (err) {
    liveReadError = (err as Error).message.slice(0, 200)
  }

  const report: Record<string, unknown>[] = []
  for (const [index, entry] of entries.entries()) {
    const row = await googleSheetsProvider.readRow(sheetRef, entry.rowNumber).catch((err: Error) => ({
      __error: err.message.slice(0, 200),
    }))
    const failed = '__error' in row ? (row as { __error: string }).__error : ''
    const sheetRow = row as Record<string, string>
    const empty = !failed && Object.values(sheetRow).every((value) => !value)
    const companyMatches = !failed && sheetRow.Company === entry.company
    const titleMatches = !failed && sheetRow.Title === entry.title

    let setStatusWouldDo: string
    if (sheetProblem) setStatusWouldDo = `refuse (SHEET_UNAVAILABLE): the sheet is flagged ${sheetProblem.state}`
    else if (failed) setStatusWouldDo = `fail reading the row: ${failed}`
    else if (empty) setStatusWouldDo = `refuse (STALE_ROW): row ${entry.rowNumber} is empty — the cached row number is past the data`
    else if (!companyMatches || !titleMatches) {
      setStatusWouldDo = `refuse (STALE_ROW): ${!companyMatches ? 'Company' : 'Title'} in the sheet differs from the cached entry`
    } else {
      const letter = headers.indexOf('Status') === -1 ? '?' : columnLetter(headers.indexOf('Status'))
      setStatusWouldDo = `write the Status cell at ${sheetRef.sheetName}!${letter}${entry.rowNumber}`
    }

    const liveRow = liveRows[index]
    let chipWouldShow: string
    if (liveReadError) chipWouldShow = `the cached status (the live read failed: ${liveReadError})`
    else if (!liveRow) chipWouldShow = 'the cached status (the live read returned no row here)'
    else if (liveRow.Company !== entry.company || liveRow.Title !== entry.title) {
      chipWouldShow = 'the cached status (Company/Title in the sheet no longer match this entry)'
    } else if (!liveRow.Status) {
      chipWouldShow = "the cached status (the sheet's Status cell is blank — a row logged before Applied became the default)"
    } else chipWouldShow = `the sheet's "${liveStatuses[entry.id] ?? liveRow.Status}"`

    report.push({
      entryId: entry.id,
      logId: entry.logId ? 'carried' : 'none (logged before Log IDs were cached)',
      rowNumber: entry.rowNumber,
      sheetName: entry.sheetName,
      cached: { company: fingerprint(entry.company), title: fingerprint(entry.title), status: entry.status },
      sheetRow: failed
        ? `READ FAILED: ${failed}`
        : {
            company: fingerprint(sheetRow.Company),
            title: fingerprint(sheetRow.Title),
            status: sheetRow.Status || '(blank)',
            logId: sheetRow[LOG_ID_COLUMN] ? 'present' : '(blank or no column)',
          },
      identityCheck: failed ? 'not reached' : companyMatches && titleMatches ? 'passes' : 'FAILS',
      setStatusWouldDo,
      popupChipWouldShow: chipWouldShow,
    })
  }

  console.log(JSON.stringify(report, null, 2))

  const wouldWrite = report.filter((row) => String(row.setStatusWouldDo).startsWith('write')).length
  const liveFromSheet = Object.keys(liveStatuses).length
  console.log(
    JSON.stringify(
      {
        entriesWhereAStatusChangeWouldWrite: `${wouldWrite} of ${entries.length}`,
        entriesWhoseChipComesFromTheSheet: `${liveFromSheet} of ${entries.length}`,
        liveReadError: liveReadError || 'none',
        note: 'Nothing was written. If the counts above are 0, the reasons per entry say why.',
      },
      null,
      2,
    ),
  )
  console.log('DONE')
}

run().catch((err) => console.error('status-check failed:', err))

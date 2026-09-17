// Checks the Summary tab (CLAUDE.md, Sheet setup, 2026-09-16) on a real,
// throwaway sheet — the five things the Node tests can't prove, since they
// only see the requests we send, not what Sheets does with them:
//   1. the formulas land as formulas, not text, and this sheet's locale
//      parses their comma-separated arguments as written;
//   2. rows built by the shipped path (buildRow + sanitizeRow) and appended
//      through the real appendRow update the totals, the week counts and the
//      bars, for a row in the current week and one in an earlier week — the
//      status totals should sum to Total logged, 3 Applied + 1 Cancelled;
//   3. a Cancelled row counts in the totals by status but not in the weekly
//      numbers;
//   4. renaming the applications tab rewrites the references and the numbers
//      survive;
//   5. deleting the Summary tab breaks nothing — the next append still works.
// It then moves the throwaway sheet to Drive's trash.
//
// Bundle it (esbuild comes with Vite), then run it in the extension's
// service worker:
//   ./node_modules/.bin/esbuild scripts/summary-check.ts --bundle \
//     --format=iife --platform=browser --outfile=/tmp/summary-check-sw.js
//   pbcopy < /tmp/summary-check-sw.js
// Paste into chrome://extensions > Job Application Tracker > "service
// worker" console (the extension must already be connected to Google) and
// keep DevTools open until "DONE". It prints one JSON verdict per check and
// the sheet's URL — open that URL before the run ends if you want the
// screenshot, since the last step trashes it.
//
// Real shipped code only: buildRow, sanitizeRow, createSheet, appendRow and
// updateCell, called on
// googleSheetsProvider directly rather than through getActiveProvider()'s
// wrapper, so it writes nothing to extension storage (no sheetRef, recent
// list, queue or sign-in flag) and touches no sheet of yours. Placeholder
// data only. Not part of the extension build (Vite only bundles src/).
import { googleSheetsProvider } from '../src/providers/googleSheets'
import { buildRow } from '../src/lib/buildRow'
import { sanitizeRow } from '../src/lib/sanitize'
import { SHEET_TEMPLATE_COLUMNS } from '../src/lib/sheetTemplate'

type Json = Record<string, unknown>
type TabProperties = { properties: { title: string; index?: number; sheetId?: number } }

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'
const DRIVE = 'https://www.googleapis.com/drive/v3/files'

async function token(): Promise<string> {
  const result = (await chrome.identity.getAuthToken({ interactive: true })) as unknown
  return typeof result === 'string' ? result : (result as { token: string }).token
}
async function api(path: string, init?: RequestInit): Promise<Json> {
  const response = await fetch(`${SHEETS}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}
// The Summary tab as Sheets holds it: what's in each cell (FORMULA) and what
// each one evaluates to (UNFORMATTED_VALUE).
async function summary(spreadsheetId: string, tab = 'Summary') {
  const range = `${encodeURIComponent(`'${tab}'!A1:E20`)}`
  const [formulas, values] = await Promise.all([
    api(`/${spreadsheetId}/values/${range}?valueRenderOption=FORMULA`),
    api(`/${spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`),
  ])
  const at = (grid: Json, row: number, col: number) =>
    (grid.values as unknown[][] | undefined)?.[row - 1]?.[col - 1] ?? ''
  return {
    formula: (row: number, col: number) => String(at(formulas, row, col)),
    value: (row: number, col: number) => at(values, row, col),
    statusTotals: Object.fromEntries([5, 6, 7, 8, 9].map((row) => [String(at(values, row, 1)), at(values, row, 2)])),
    totalLogged: at(values, 10, 2),
    thisWeek: at(values, 5, 5),
    lastWeek: at(values, 6, 5),
    weeks: [13, 14, 15].map((row) => ({ start: at(formulas, row, 1) && at(values, row, 1), count: at(values, row, 2), bar: String(at(values, row, 3)).length })),
  }
}
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()
// The shipped path, the same two calls handleJobApplicationLogged makes:
// buildRow then sanitizeRow. Writing a literal row here instead would prove
// nothing about what the extension actually appends — in particular about
// the Status a logged row starts with (2026-09-17). Only Date is
// overridden, and only to place a row in an earlier week, which is what a
// row logged days ago or drained from the queue looks like.
const shippedRow = (company: string, daysAgo = 0) => {
  const built = sanitizeRow(
    buildRow(
      { title: 'Placeholder Engineer', company, location: 'Remote', url: 'https://jobs.example.com/placeholder' },
      'SWE v1',
    ),
  )
  return daysAgo === 0 ? built : { ...built, Date: iso(daysAgo) }
}

async function run() {
  const out: Record<string, unknown> = {}
  const sheetRef = await googleSheetsProvider.createSheet([...SHEET_TEMPLATE_COLUMNS])
  const url = `https://docs.google.com/spreadsheets/d/${sheetRef.spreadsheetId}/edit`
  console.log('throwaway sheet:', url)

  // 1. Formulas, not text, parsed in this sheet's locale.
  const fresh = await summary(sheetRef.spreadsheetId)
  const meta = await api(`/${sheetRef.spreadsheetId}?fields=properties.locale,sheets.properties(title,index)`)
  out['1_formulas_landed'] = {
    locale: meta.properties?.locale,
    tabs: (meta.sheets as TabProperties[] | undefined)?.map((tab) => `${tab.properties.index}:${tab.properties.title}`),
    appliedCell: fresh.formula(5, 2),
    weekCountCell: fresh.formula(13, 2),
    barCell: fresh.formula(13, 3),
    // A formula that failed to parse would come back as text, or as an error
    // value here rather than a number.
    appliedValue: fresh.value(5, 2),
    weekCountValue: fresh.value(13, 2),
    verdict:
      fresh.formula(5, 2).startsWith('=COUNTIF(') && typeof fresh.value(5, 2) === 'number' && typeof fresh.value(13, 2) === 'number'
        ? 'PASS: stored as formulas and evaluating to numbers'
        : 'FAIL',
  }

  // 2 and 3. Appends update the numbers; Cancelled counts in the totals only.
  await googleSheetsProvider.appendRow(sheetRef, shippedRow('This Week Co A'))
  await googleSheetsProvider.appendRow(sheetRef, shippedRow('This Week Co B', 1))
  const cancelled = await googleSheetsProvider.appendRow(sheetRef, shippedRow('Cancelled Co'))
  await googleSheetsProvider.updateCell(sheetRef, cancelled.rowNumber, 'Status', 'Cancelled')
  await googleSheetsProvider.appendRow(sheetRef, shippedRow('Earlier Week Co', 9))
  const afterAppends = await summary(sheetRef.spreadsheetId)
  out['2_appends_update'] = {
    statusTotals: afterAppends.statusTotals,
    totalLogged: afterAppends.totalLogged,
    thisWeek: afterAppends.thisWeek,
    weeks: afterAppends.weeks,
    statusTotalsSum: Object.values(afterAppends.statusTotals).reduce((sum, n) => sum + (typeof n === 'number' ? n : 0), 0),
    verdict:
      afterAppends.totalLogged === 4 &&
      Object.values(afterAppends.statusTotals).reduce((sum, n) => sum + (typeof n === 'number' ? n : 0), 0) === 4 &&
      afterAppends.statusTotals['Applied'] === 3 &&
      afterAppends.weeks[0].count >= 2
        ? 'PASS: totals sum to Total logged (3 Applied + 1 Cancelled), weeks and bars moved'
        : 'CHECK the numbers above',
  }
  out['3_cancelled'] = {
    cancelledInTotals: afterAppends.statusTotals['Cancelled'],
    thisWeek: afterAppends.thisWeek,
    note: 'this week should count the two non-Cancelled rows dated in it, not the Cancelled one',
    verdict: afterAppends.statusTotals['Cancelled'] === 1 && afterAppends.thisWeek === 2 ? 'PASS' : 'CHECK',
  }

  // 4. Rename the applications tab: Sheets rewrites the references.
  const renamed = "Bob's Applications"
  await api(`/${sheetRef.spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ updateSheetProperties: { properties: { sheetId: sheetRef.sheetId, title: renamed }, fields: 'title' } }] }),
  })
  const afterRename = await summary(sheetRef.spreadsheetId)
  out['4_rename'] = {
    appliedCell: afterRename.formula(5, 2),
    totalLogged: afterRename.totalLogged,
    thisWeek: afterRename.thisWeek,
    verdict:
      afterRename.formula(5, 2).includes(renamed.replace("'", "''")) && afterRename.totalLogged === 4
        ? 'PASS: references rewritten, numbers unchanged'
        : 'CHECK',
  }

  // 5. Delete the Summary tab: the next append still works.
  const tabs = await api(`/${sheetRef.spreadsheetId}?fields=sheets.properties(title,sheetId)`)
  const summaryId = (tabs.sheets as TabProperties[]).find((tab) => tab.properties.title === 'Summary')?.properties.sheetId
  await api(`/${sheetRef.spreadsheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: [{ deleteSheet: { sheetId: summaryId } }] }) })
  const renamedRef = { ...sheetRef, sheetName: renamed }
  const appendedAfterDelete = await googleSheetsProvider.appendRow(renamedRef, shippedRow('After Delete Co'))
  out['5_delete_summary'] = {
    deletedSheetId: summaryId,
    appendedRow: appendedAfterDelete,
    verdict: appendedAfterDelete.rowNumber > 0 ? 'PASS: append still works with no Summary tab' : 'FAIL',
  }

  console.log(JSON.stringify(out, null, 2))

  // Trash the throwaway sheet.
  const trashed = await fetch(`${DRIVE}/${sheetRef.spreadsheetId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  })
  console.log('trashed:', trashed.status === 200 ? 'yes' : `NO (${trashed.status}) — trash ${url} by hand`)
  console.log('DONE')
}

run().catch((err) => console.error('summary-check failed:', err))

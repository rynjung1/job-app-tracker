// Checks "Start a new sheet" and the way back (CLAUDE.md, Sheet setup,
// 2026-09-17) on real, throwaway sheets — the parts the Node tests can't
// prove, since they only see the requests we send, not what Google does
// with them:
//   1. the first sheet is created as "Job Applications";
//   2. a sheet started later is created with its date in the name, as a
//      second file: two sheets, two names, the first one untouched;
//   3. after the swap, rows land in the new sheet and the old one is
//      unchanged — the swap only moves where rows go;
//   4. switching back: rows land in the first sheet again, and the health
//      check the switch runs first (Drive's trashed flag) says it can;
//   5. the refusal: with that sheet in Drive's trash, the same check says
//      trashed, which is what makes SWITCH_TO_PREVIOUS_SHEET refuse;
//   6. readTitle picks up a sheet renamed by hand in Drive — the lazy fill
//      behind Settings' "Connected to ...".
// It then moves both throwaway sheets to Drive's trash.
//
// Bundle it (esbuild comes with Vite), then run it in the extension's
// service worker:
//   ./node_modules/.bin/esbuild scripts/new-sheet-check.ts --bundle \
//     --format=iife --platform=browser --outfile=/tmp/new-sheet-check-sw.js
//   pbcopy < /tmp/new-sheet-check-sw.js
// Paste into chrome://extensions > Job Application Tracker > "service
// worker" console (the extension must already be connected to Google) and
// keep DevTools open until "DONE". It prints one JSON verdict per check and
// both sheets' URLs — open them before the run ends if you want to look,
// since the last step trashes them.
//
// Real shipped code only: createSheet, appendRow, readRow, readTitle and
// isTrashed, called on googleSheetsProvider directly rather than through
// getActiveProvider()'s wrapper, so it sets no flag and touches no list of
// yours (no previous sheet, recent list, queue or sign-in flag), and it
// neither reads nor swaps your connected sheet. The one storage write in
// the provider itself, updateStoredSheetName after a renamed tab, only
// writes when the ref it would update is the connected one, which a
// throwaway sheet created here never is. Placeholder data only. Not part of the extension
// build (Vite only bundles src/).
import { googleSheetsProvider } from '../src/providers/googleSheets'
import { buildRow } from '../src/lib/buildRow'
import { sanitizeRow } from '../src/lib/sanitize'
import { SHEET_TEMPLATE_COLUMNS } from '../src/lib/sheetTemplate'
import { DEFAULT_SHEET_TITLE, datedSheetTitle } from '../src/lib/sheetTitle'

type Json = Record<string, unknown>

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'
const DRIVE = 'https://www.googleapis.com/drive/v3/files'

async function token(): Promise<string> {
  const result = (await chrome.identity.getAuthToken({ interactive: true })) as unknown
  return typeof result === 'string' ? result : (result as { token: string }).token
}
async function api(url: string, init?: RequestInit): Promise<Json> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}
// The name Google holds for the file, read back from Drive rather than from
// the create response we sent the name in.
async function driveName(spreadsheetId: string): Promise<Json> {
  return api(`${DRIVE}/${spreadsheetId}?fields=id,name,trashed`)
}
// How many logged rows a sheet holds, from column B (Company).
async function companies(spreadsheetId: string, sheetName: string): Promise<string[]> {
  const range = encodeURIComponent(`'${sheetName.replace(/'/g, "''")}'!B2:B`)
  const read = await api(`${SHEETS}/${spreadsheetId}/values/${range}`)
  return ((read.values as string[][] | undefined) ?? []).map((row) => row[0] ?? '')
}
// The shipped path, the same two calls handleJobApplicationLogged makes.
const shippedRow = (company: string) =>
  sanitizeRow(
    buildRow(
      { title: 'Placeholder Engineer', company, location: 'Remote', url: 'https://jobs.example.com/placeholder' },
      'SWE v1',
    ),
  )

async function run() {
  const out: Record<string, unknown> = {}

  // 1. The first sheet keeps the plain name.
  const first = await googleSheetsProvider.createSheet([...SHEET_TEMPLATE_COLUMNS])
  console.log('first sheet:', `https://docs.google.com/spreadsheets/d/${first.spreadsheetId}/edit`)
  const firstInDrive = await driveName(first.spreadsheetId)
  out['1_first_sheet_name'] = {
    returnedTitle: first.title,
    driveName: firstInDrive.name,
    readTitle: await googleSheetsProvider.readTitle(first),
    verdict:
      first.title === DEFAULT_SHEET_TITLE && firstInDrive.name === DEFAULT_SHEET_TITLE
        ? `PASS: created as "${DEFAULT_SHEET_TITLE}"`
        : 'FAIL',
  }
  await googleSheetsProvider.appendRow(first, shippedRow('Logged Before The Swap'))

  // 2. A sheet started later carries its date, as a second file.
  const dated = datedSheetTitle()
  const second = await googleSheetsProvider.createSheet([...SHEET_TEMPLATE_COLUMNS], dated)
  console.log('second sheet:', `https://docs.google.com/spreadsheets/d/${second.spreadsheetId}/edit`)
  const secondInDrive = await driveName(second.spreadsheetId)
  const firstAfterCreate = await driveName(first.spreadsheetId)
  out['2_dated_name'] = {
    expected: dated,
    returnedTitle: second.title,
    driveName: secondInDrive.name,
    readTitle: await googleSheetsProvider.readTitle(second),
    twoFiles: first.spreadsheetId !== second.spreadsheetId,
    firstStillThere: { name: firstAfterCreate.name, trashed: firstAfterCreate.trashed },
    verdict:
      second.title === dated &&
      secondInDrive.name === dated &&
      first.spreadsheetId !== second.spreadsheetId &&
      firstAfterCreate.name === DEFAULT_SHEET_TITLE &&
      firstAfterCreate.trashed === false
        ? 'PASS: a second file with the dated name, the first one untouched and not trashed'
        : 'FAIL',
  }

  // 3. After the swap, rows land in the new sheet and the old one is
  //    unchanged. (The swap itself is one stored ref changing; what it has
  //    to produce on the real sheets is exactly this.)
  await googleSheetsProvider.appendRow(second, shippedRow('Logged After The Swap'))
  const afterSwap = { first: await companies(first.spreadsheetId, first.sheetName), second: await companies(second.spreadsheetId, second.sheetName) }
  out['3_rows_follow_the_swap'] = {
    ...afterSwap,
    verdict:
      afterSwap.first.join() === 'Logged Before The Swap' && afterSwap.second.join() === 'Logged After The Swap'
        ? 'PASS: the new sheet took the new row, the old sheet is unchanged'
        : 'FAIL',
  }

  // 4. Switching back: the health check first, then rows land in the first
  //    sheet again.
  const firstHealthy = await googleSheetsProvider.isTrashed(first)
  await googleSheetsProvider.appendRow(first, shippedRow('Logged After Switching Back'))
  const afterBack = { first: await companies(first.spreadsheetId, first.sheetName), second: await companies(second.spreadsheetId, second.sheetName) }
  out['4_switch_back'] = {
    previousSheetTrashed: firstHealthy,
    ...afterBack,
    verdict:
      firstHealthy === false &&
      afterBack.first.join() === 'Logged Before The Swap,Logged After Switching Back' &&
      afterBack.second.join() === 'Logged After The Swap'
        ? 'PASS: the check says the previous sheet can take rows, and the next row lands there'
        : 'FAIL',
  }

  // 5. The refusal: the same check on a sheet that's been trashed since.
  await api(`${DRIVE}/${second.spreadsheetId}`, { method: 'PATCH', body: JSON.stringify({ trashed: true }) })
  const trashedCheck = await googleSheetsProvider.isTrashed(second)
  out['5_refusal_check'] = {
    trashedAfterMovingItToTrash: trashedCheck,
    note: 'SWITCH_TO_PREVIOUS_SHEET refuses (PREVIOUS_UNAVAILABLE) when this is true',
    verdict: trashedCheck === true ? 'PASS: a sheet in the trash is seen as trashed, so the switch would be refused' : 'FAIL',
  }

  // 6. A sheet renamed by hand: readTitle picks the new name up.
  const renamed = `${DEFAULT_SHEET_TITLE} (renamed by hand)`
  await api(`${DRIVE}/${first.spreadsheetId}`, { method: 'PATCH', body: JSON.stringify({ name: renamed }) })
  const readBack = await googleSheetsProvider.readTitle(first)
  out['6_renamed_in_drive'] = {
    renamedTo: renamed,
    readTitle: readBack,
    verdict: readBack === renamed ? 'PASS: Settings would show the new name' : 'FAIL',
  }

  console.log(JSON.stringify(out, null, 2))

  // Trash both throwaway sheets (the second one already is).
  const trashed = await fetch(`${DRIVE}/${first.spreadsheetId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  })
  console.log('trashed:', trashed.status === 200 ? 'both' : `first sheet NOT trashed (${trashed.status}) — trash it by hand`)
  console.log('DONE')
}

run().catch((err) => console.error('new-sheet-check failed:', err))

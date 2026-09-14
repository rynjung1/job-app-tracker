import { AuthRequiredError } from './types'
import type { AppendedRow, SheetRef, SpreadsheetProvider } from './types'
import { columnIndexToLetter } from '../lib/columnLetter'
import { isoToLocalDateSerial } from '../lib/dateSerial'
import { fetchWithTimeout } from '../lib/fetchWithTimeout'
import { withSheetAppendLock } from '../lib/sheetAppendLock'
import { updateStoredSheetName } from '../lib/sheetRef'
import { LOG_ID_COLUMN, STATUS_VALUES } from '../lib/sheetTemplate'
import type { StatusValue } from '../lib/sheetTemplate'

const API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

class SheetsApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

// No manual token storage anywhere in this file — chrome.identity caches
// the token internally against the extension. authenticate() (interactive)
// is only ever called from the options page on explicit user action;
// everything else here requests non-interactively and lets the caller
// see a clear failure if nothing is cached yet, rather than silently
// popping an OAuth consent screen mid-flow.
async function getToken(interactive: boolean): Promise<string> {
  const result = await chrome.identity.getAuthToken({ interactive })
  if (!result.token) {
    throw new Error('No auth token returned from chrome.identity.getAuthToken')
  }
  return result.token
}

async function apiFetch(path: string, token: string, init?: RequestInit): Promise<unknown> {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new SheetsApiError(res.status, `Sheets API ${res.status}: ${body}`)
  }
  if (res.status === 204) return undefined
  return res.json()
}

// Gets a non-interactive token, runs fn, and retries exactly once with a
// forcibly-refreshed token on a 401 — this is the "manage OAuth token
// lifecycle (refresh, expiry)" requirement from CLAUDE.md, kept inside the
// provider so the background worker doesn't need provider-specific
// knowledge of what "refresh" means for this backend.
//
// "Needs reconnect" (2026-09-13): the two ways a call can fail for lack of
// sign-in now throw AuthRequiredError. Before, a failing non-interactive
// getAuthToken escaped as a plain error, so logging queued and retried
// forever and the popup quietly kept its saved statuses (found when a
// lapsed sign-in hid a live status until Ryan clicked Reconnect).
async function withAuth<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const token = await getTokenForCall()
  try {
    return await fn(token)
  } catch (err) {
    if (!(err instanceof SheetsApiError && err.status === 401)) throw err
    await chrome.identity.removeCachedAuthToken({ token })
    const freshToken = await getTokenForCall()
    try {
      return await fn(freshToken)
    } catch (retryErr) {
      // A 401 on a token Chrome has just issued: the grant itself is gone.
      if (retryErr instanceof SheetsApiError && retryErr.status === 401) {
        throw new AuthRequiredError(`Google sign-in needed: ${retryErr.message}`)
      }
      throw retryErr
    }
  }
}

// getAuthToken({ interactive: false }) rejects when Chrome has no usable
// token and can't get one without the user (access revoked, or the sign-in
// lapsed). Offline it can also fail only because Google can't be reached:
// an ordinary failure, queued and retried, so only an online failure means
// sign-in is needed.
async function getTokenForCall(): Promise<string> {
  try {
    return await getToken(false)
  } catch (err) {
    if (navigator.onLine) {
      throw new AuthRequiredError(`Google sign-in needed: ${err instanceof Error ? err.message : String(err)}`)
    }
    throw err
  }
}

// Sheets API range format is "SheetName!A5:H5" (or "'Sheet Name'!A5:H5" if
// the sheet name needs quoting) — pulls out the sheet name and the row
// number of the first cell in the range.
// A quoted name has any ' doubled ('Bob''s Jobs'!A2:I2).
function parseAppendedRange(updatedRange: string): AppendedRow {
  const match = updatedRange.match(/^(?:'((?:[^']|'')+)'|([^!]+))!([A-Z]+)(\d+)/)
  if (!match) {
    throw new Error(`Could not parse appended range: ${updatedRange}`)
  }
  const sheetName = match[1] !== undefined ? match[1].replace(/''/g, "'") : match[2]
  return { sheetName, rowNumber: Number(match[4]) }
}

// Every A1 range quotes the tab name (2026-09-14): 'Name'!A1, with any '
// doubled. Unquoted, a tab the user renamed to something with a space, an
// apostrophe or a cell-like name ("A1") doesn't parse. Quoting is always
// valid, Sheet1 included.
function quoteSheetName(sheetName: string): string {
  return `'${sheetName.replace(/'/g, "''")}'`
}

function rangeIn(sheetName: string, cells: string): string {
  return `${quoteSheetName(sheetName)}!${cells}`
}

// A renamed tab (2026-09-14): the ranges name the tab stored at Connect, so
// after the user renames it Sheets answers 400 "Unable to parse range". The
// tab's numeric sheetId survives a rename, so withSheetRef looks its current
// title up by that id, stores it (lib/sheetRef.ts) and retries once. A
// deleted tab (no tab with that id), an unchanged title, or a sheetRef
// without a sheetId keeps the original error. Retrying is safe: a range that
// didn't parse wrote nothing.
function isUnparsableRange(err: unknown): boolean {
  return err instanceof SheetsApiError && err.status === 400 && err.message.includes('Unable to parse range')
}

async function currentSheetName(sheetRef: SheetRef): Promise<string | null> {
  const data = (await withAuth((token) =>
    apiFetch(`/${sheetRef.spreadsheetId}?fields=sheets.properties`, token),
  )) as { sheets?: Array<{ properties?: { sheetId?: number; title?: string } }> }
  const tab = data.sheets?.find((sheet) => sheet.properties?.sheetId === sheetRef.sheetId)
  return tab?.properties?.title ?? null
}

async function withSheetRef<T>(sheetRef: SheetRef, fn: (ref: SheetRef) => Promise<T>): Promise<T> {
  try {
    return await fn(sheetRef)
  } catch (err) {
    if (!isUnparsableRange(err) || sheetRef.sheetId === undefined) throw err
    const sheetName = await currentSheetName(sheetRef)
    if (!sheetName || sheetName === sheetRef.sheetName) throw err
    await updateStoredSheetName(sheetRef.spreadsheetId, sheetName)
    console.log('[job-app-tracker] the sheet tab was renamed; using its current name')
    return fn({ ...sheetRef, sheetName })
  }
}

// The header row, which fixes the column order for every other call.
async function readHeadersAt(sheetRef: SheetRef): Promise<string[]> {
  const range = rangeIn(sheetRef.sheetName, '1:1')
  const data = (await withAuth((token) =>
    apiFetch(`/${sheetRef.spreadsheetId}/values/${encodeURIComponent(range)}`, token),
  )) as { values?: string[][] }
  return data.values?.[0] ?? []
}

// New-sheet visual formatting (createSheet only — never applied to an
// already-existing sheet). Real Sheets conditional-format rules, not
// colors painted at write time, so they keep re-evaluating live even if
// the user retypes a Status value by hand later. The whole set below was
// previewed on a throwaway sheet on 2026-09-13 and checked on rows logged
// through the real appendRow, including rows past the original grid
// (CLAUDE.md, Sheet setup).
type Rgb = { red: number; green: number; blue: number }

function hexToRgb(hex: string): Rgb {
  return {
    red: parseInt(hex.slice(1, 3), 16) / 255,
    green: parseInt(hex.slice(3, 5), 16) / 255,
    blue: parseInt(hex.slice(5, 7), 16) / 255,
  }
}

const BRAND_BLUE = hexToRgb('#2563EB') // the extension icon's blue
const WHITE = hexToRgb('#FFFFFF')
const BAND_COLOR = hexToRgb('#F5F7FB')
const FONT_FAMILY = 'Roboto'
const HEADER_ROW_PIXELS = 32

// Cancelled is grey with grey text, distinct from Rejected's red and
// matching the popup's status chip.
// Keyed by StatusValue, so a status added to STATUS_VALUES without a colour
// here is a type error.
const STATUS_COLORS: Record<StatusValue, { background: Rgb; text?: Rgb }> = {
  Offer: { background: { red: 0.72, green: 0.88, blue: 0.72 } },
  Interview: { background: { red: 0.78, green: 0.86, blue: 0.98 } },
  Applied: { background: { red: 1, green: 0.94, blue: 0.6 } },
  Rejected: { background: { red: 0.96, green: 0.78, blue: 0.78 } },
  Cancelled: { background: hexToRgb('#E5E7EB'), text: hexToRgb('#4B5563') },
}

// A pixel width for every template column; a column missing here keeps
// Sheets' default width.
const COLUMN_WIDTHS: Record<string, number> = {
  Date: 130,
  Company: 180,
  Title: 280,
  Location: 170,
  URL: 200,
  'Resume Version': 140,
  Status: 120,
  Notes: 280,
}

// appendRow writes Date as a date serial (see toDateCellValue), which
// shows as a bare number like 46276.85 without a date format on the cell.
const DATE_COLUMN = 'Date'
const DATE_NUMBER_FORMAT = { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm' }

// Date is written as a real date value, not buildRow's ISO string, so
// Sheets treats it as a date (sorts and filters as one) instead of text.
// It still goes through the RAW append: RAW keeps a JSON number a number
// and still stores every scraped string field literally, so the
// formula-injection defense is unchanged. Only this provider converts —
// buildRow, the offline queue and the recent list all keep the ISO
// string. A value that doesn't parse as a date is written through as-is.
function toDateCellValue(value: string | undefined): string | number {
  if (!value) return ''
  return isoToLocalDateSerial(value) ?? value
}

// Column indices computed from the actual templateColumns passed in,
// never hardcoded — self-correcting the same way readHeaders-driven
// column order already is elsewhere in this file, in case the template
// ever changes shape.
function buildFormattingRequests(sheetId: number, templateColumns: string[]): unknown[] {
  // The hidden Log ID column (kept last in the template) gets no banding;
  // it's hidden at the end of this function.
  const logIdColumnIndex = templateColumns.indexOf(LOG_ID_COLUMN)
  const visibleColumnCount = logIdColumnIndex === -1 ? templateColumns.length : logIdColumnIndex
  const requests: unknown[] = [
    // Frozen header row, no gridlines (the banding separates rows), and a
    // brand-coloured sheet tab.
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { frozenRowCount: 1, hideGridlines: true },
          tabColorStyle: { rgbColor: BRAND_BLUE },
        },
        fields: 'gridProperties.frozenRowCount,gridProperties.hideGridlines,tabColorStyle',
      },
    },
    // Header: brand blue, bold white text, vertically centred, taller row.
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: BRAND_BLUE,
            textFormat: { bold: true, foregroundColor: WHITE, fontFamily: FONT_FAMILY },
            verticalAlignment: 'MIDDLE',
            padding: { left: 6, right: 6 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,padding)',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: HEADER_ROW_PIXELS },
        fields: 'pixelSize',
      },
    },
    // Data rows: same font, vertically centred, long text clipped rather
    // than spilling into the next cell (Notes wraps instead, below). The
    // field mask leaves the Date column's number format alone.
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { fontFamily: FONT_FAMILY }, verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP' } },
        fields: 'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy',
      },
    },
    // Alternating row colours on data rows only; the header is styled above.
    // The preview confirmed the banded range grows with rows appended past
    // the grid.
    {
      addBanding: {
        bandedRange: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: visibleColumnCount },
          rowProperties: { firstBandColor: WHITE, secondBandColor: BAND_COLOR },
        },
      },
    },
  ]

  const statusColumnIndex = templateColumns.indexOf('Status')
  if (statusColumnIndex !== -1) {
    let ruleIndex = 0
    for (const [statusValue, color] of Object.entries(STATUS_COLORS)) {
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: statusColumnIndex, endColumnIndex: statusColumnIndex + 1 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: statusValue }] },
              format: {
                backgroundColor: color.background,
                ...(color.text ? { textFormat: { foregroundColor: color.text } } : {}),
              },
            },
          },
          index: ruleIndex++,
        },
      })
    }

    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: statusColumnIndex, endColumnIndex: statusColumnIndex + 1 },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat.horizontalAlignment',
      },
    })

    // Dropdown restricted to exactly the 5 values CLAUDE.md's Status field
    // section already locks in. strict:true (reject, not just warn) —
    // the conditional-format rules above do an exact TEXT_EQ match, so a
    // typo or wrong case would silently get no color at all; rejecting it
    // outright protects that feature, not just this one. showCustomUi:true
    // is what actually renders the dropdown chevron in the cell.
    requests.push({
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: statusColumnIndex, endColumnIndex: statusColumnIndex + 1 },
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: STATUS_VALUES.map((value) => ({ userEnteredValue: value })),
          },
          strict: true,
          showCustomUi: true,
        },
      },
    })
  }

  // From row 2 down, same anchoring as the Status rules. Appends land in
  // these pre-formatted cells because appendRow uses OVERWRITE, not
  // INSERT_ROWS.
  const dateColumnIndex = templateColumns.indexOf(DATE_COLUMN)
  if (dateColumnIndex !== -1) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: dateColumnIndex, endColumnIndex: dateColumnIndex + 1 },
        cell: { userEnteredFormat: { numberFormat: DATE_NUMBER_FORMAT } },
        fields: 'userEnteredFormat.numberFormat',
      },
    })
  }

  // Notes is the one column that wraps: a long note grows its row instead of
  // being cut off (Sheets fits the row height to the wrapped text).
  const notesColumnIndex = templateColumns.indexOf('Notes')
  if (notesColumnIndex !== -1) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: notesColumnIndex, endColumnIndex: notesColumnIndex + 1 },
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat.wrapStrategy',
      },
    })
  }

  templateColumns.forEach((columnName, columnIndex) => {
    const pixelSize = COLUMN_WIDTHS[columnName]
    if (!pixelSize) return
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: columnIndex, endIndex: columnIndex + 1 },
        properties: { pixelSize },
        fields: 'pixelSize',
      },
    })
  })

  // Log ID: hidden and narrow. It's only for the drain's duplicate check,
  // never shown in the popup (CLAUDE.md, Sheet setup).
  if (logIdColumnIndex !== -1) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: logIdColumnIndex, endIndex: logIdColumnIndex + 1 },
        properties: { hiddenByUser: true, pixelSize: 60 },
        fields: 'hiddenByUser,pixelSize',
      },
    })
  }

  return requests
}

export const googleSheetsProvider: SpreadsheetProvider = {
  async authenticate() {
    // Best-effort: clear whatever's cached first (even a stale/revoked
    // token) so this always forces a genuinely fresh interactive prompt,
    // rather than potentially handing back what's already cached — Chrome
    // doesn't proactively check with Google whether a cached token is
    // still valid. Errors here just mean nothing was cached; fine to
    // ignore and proceed to the interactive request either way.
    try {
      const existing = await chrome.identity.getAuthToken({ interactive: false })
      if (existing.token) {
        await chrome.identity.removeCachedAuthToken({ token: existing.token })
      }
    } catch {
      // Nothing cached, or the non-interactive fetch itself failed.
    }
    await getToken(true)
  },

  async createSheet(templateColumns: string[]): Promise<SheetRef> {
    const created = (await withAuth((token) =>
      apiFetch('', token, {
        method: 'POST',
        body: JSON.stringify({ properties: { title: 'Job Applications' } }),
      }),
    )) as { spreadsheetId: string; sheets?: Array<{ properties?: { title?: string; sheetId?: number } }> }

    const spreadsheetId = created.spreadsheetId
    // Read the real sheet name back from the response rather than assuming
    // "Sheet1" — that's the usual default but not a guaranteed one.
    const sheetName = created.sheets?.[0]?.properties?.title ?? 'Sheet1'
    // The numeric grid id — batchUpdate's formatting requests below
    // address ranges by this, not by sheetName.
    const sheetId = created.sheets?.[0]?.properties?.sheetId ?? 0

    const range = rangeIn(sheetName, 'A1')
    await withAuth((token) =>
      apiFetch(`/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, token, {
        method: 'PUT',
        body: JSON.stringify({ values: [templateColumns] }),
      }),
    )

    await withAuth((token) =>
      apiFetch(`/${spreadsheetId}:batchUpdate`, token, {
        method: 'POST',
        body: JSON.stringify({ requests: buildFormattingRequests(sheetId, templateColumns) }),
      }),
    )

    return { spreadsheetId, sheetName, sheetId }
  },

  async readHeaders(sheetRef: SheetRef): Promise<string[]> {
    return withSheetRef(sheetRef, readHeadersAt)
  },

  async appendRow(sheetRef: SheetRef, row: Record<string, string>): Promise<AppendedRow> {
    // OVERWRITE, not INSERT_ROWS: INSERT_ROWS inserts each new row directly
    // under the header, so (a) it inherits the header's formatting (blue
    // fill, bold white text) and (b) every insert pushes createSheet's
    // Status dropdown + colour rules (anchored at row 2) down one row —
    // after N appends they start at row N+2, below every logged row.
    // Reproduced for real on a throwaway sheet built by the same
    // createSheet calls (rules at row 5, A2 header-styled, no G2 dropdown
    // after 3 appends). OVERWRITE writes into the existing empty rows
    // instead, so neither happens.
    //
    // The lock is required, not optional: OVERWRITE on its own lost 7 of
    // 20 rows in a real concurrency test (concurrent requests handed the
    // same target row, silently overwriting each other). readHeaders and
    // the append run inside the same lock so each append sees the previous
    // one's committed row. See lib/sheetAppendLock.ts for why an in-memory
    // lock is sufficient here.
    // A renamed tab is resolved inside the lock too (withSheetRef), so the
    // retry is still serialized with every other append.
    return withSheetAppendLock(() =>
      withSheetRef(sheetRef, async (ref) => {
        // Reads the sheet's actual current headers to determine column order,
        // rather than trusting Object.values(row) insertion order — self-
        // correcting if the user ever reorders columns by hand, and the only
        // correct behavior once existing-sheet linking (Phase 7) is in play.
        const headers = await readHeadersAt(ref)
        const values = headers.map((header) =>
          header === DATE_COLUMN ? toDateCellValue(row[header]) : (row[header] ?? ''),
        )

        const range = rangeIn(ref.sheetName, 'A1')
        const result = (await withAuth((token) =>
          apiFetch(
            `/${ref.spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`,
            token,
            {
              method: 'POST',
              body: JSON.stringify({ values: [values] }),
            },
          ),
        )) as { updates?: { updatedRange?: string } }

        const updatedRange = result.updates?.updatedRange
        if (!updatedRange) {
          throw new Error('Sheets API append response missing updates.updatedRange')
        }
        return parseAppendedRange(updatedRange)
      }),
    )
  },

  async updateCell(
    sheetRef: SheetRef,
    rowNumber: number,
    columnName: string,
    value: string,
  ): Promise<void> {
    await withSheetRef(sheetRef, async (ref) => {
      const headers = await readHeadersAt(ref)
      const columnIndex = headers.indexOf(columnName)
      if (columnIndex === -1) {
        throw new Error(`Column "${columnName}" not found in sheet headers: ${headers.join(', ')}`)
      }
      const range = rangeIn(ref.sheetName, `${columnIndexToLetter(columnIndex)}${rowNumber}`)
      await withAuth((token) =>
        apiFetch(`/${ref.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, token, {
          method: 'PUT',
          body: JSON.stringify({ values: [[value]] }),
        }),
      )
    })
  },

  async readRow(sheetRef: SheetRef, rowNumber: number): Promise<Record<string, string>> {
    return withSheetRef(sheetRef, async (ref) => {
      const headers = await readHeadersAt(ref)
      const range = rangeIn(ref.sheetName, `${rowNumber}:${rowNumber}`)
      const data = (await withAuth((token) =>
        apiFetch(`/${ref.spreadsheetId}/values/${encodeURIComponent(range)}`, token),
      )) as { values?: string[][] }
      const rowValues = data.values?.[0] ?? []
      const row: Record<string, string> = {}
      headers.forEach((header, i) => {
        row[header] = rowValues[i] ?? ''
      })
      return row
    })
  },

  async readCells(sheetRef: SheetRef, rowNumbers: number[], columnNames: string[]): Promise<Record<string, string>[]> {
    if (rowNumbers.length === 0) return []
    if (!rowNumbers.every((n) => Number.isInteger(n) && n >= 1)) {
      throw new Error(`Invalid row numbers: ${rowNumbers.join(', ')}`)
    }
    return withSheetRef(sheetRef, (ref) => readCellsAt(ref, rowNumbers, columnNames))
  },

  // Where each logged application's Log ID sits (id -> row number), for the
  // offline-queue drain's duplicate check: the headers, then one read of
  // that column from row 2 down. null when the sheet has no Log ID column
  // (created before 2026-09-14); the drain then appends as before.
  async readLogIds(sheetRef: SheetRef): Promise<Map<string, number> | null> {
    return withSheetRef(sheetRef, async (ref) => {
      const headers = await readHeadersAt(ref)
      const columnIndex = headers.indexOf(LOG_ID_COLUMN)
      if (columnIndex === -1) return null
      const letter = columnIndexToLetter(columnIndex)
      const range = rangeIn(ref.sheetName, `${letter}2:${letter}`)
      const data = (await withAuth((token) =>
        apiFetch(`/${ref.spreadsheetId}/values/${encodeURIComponent(range)}?majorDimension=COLUMNS`, token),
      )) as { values?: string[][] }
      const ids = new Map<string, number>()
      ;(data.values?.[0] ?? []).forEach((id, i) => {
        if (id) ids.set(id, i + 2)
      })
      return ids
    })
  },
}

// readCells' reads, run through withSheetRef by the method above.
async function readCellsAt(sheetRef: SheetRef, rowNumbers: number[], columnNames: string[]): Promise<Record<string, string>[]> {
  const headers = await readHeadersAt(sheetRef)
  // A named column the sheet doesn't have is left out of every record
  // (2026-09-14; it used to throw): the live chips ask for Log ID, which
  // sheets made before 2026-09-14 don't have.
  const present = columnNames.filter((name) => headers.includes(name))
  if (present.length === 0) return rowNumbers.map(() => ({}))
  const letters = present.map((name) => columnIndexToLetter(headers.indexOf(name)))
  // One range per column spanning every requested row (e.g. B2:B21), so
  // the read is a single batchGet however many rows are asked for. The
  // recent list is the latest rows, so the span stays close to their
  // count. With majorDimension=COLUMNS each range comes back as one array
  // starting at row `first`; the API leaves out trailing empty cells,
  // hence the ?? ''. valueRanges come back in the order requested.
  const first = Math.min(...rowNumbers)
  const last = Math.max(...rowNumbers)
  const ranges = letters
    .map((letter) => `ranges=${encodeURIComponent(rangeIn(sheetRef.sheetName, `${letter}${first}:${letter}${last}`))}`)
    .join('&')
  const data = (await withAuth((token) =>
    apiFetch(`/${sheetRef.spreadsheetId}/values:batchGet?${ranges}&majorDimension=COLUMNS`, token),
  )) as { valueRanges?: Array<{ values?: string[][] }> }
  return rowNumbers.map((rowNumber) => {
    const record: Record<string, string> = {}
    present.forEach((name, i) => {
      record[name] = data.valueRanges?.[i]?.values?.[0]?.[rowNumber - first] ?? ''
    })
    return record
  })
}

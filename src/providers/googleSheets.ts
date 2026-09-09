import type { AppendedRow, SheetRef, SpreadsheetProvider } from './types'
import { columnIndexToLetter } from '../lib/columnLetter'

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
  const res = await fetch(`${API_BASE}${path}`, {
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
async function withAuth<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const token = await getToken(false)
  try {
    return await fn(token)
  } catch (err) {
    if (err instanceof SheetsApiError && err.status === 401) {
      await chrome.identity.removeCachedAuthToken({ token })
      const freshToken = await getToken(false)
      return fn(freshToken)
    }
    throw err
  }
}

// Sheets API range format is "SheetName!A5:H5" (or "'Sheet Name'!A5:H5" if
// the sheet name needs quoting) — pulls out the sheet name and the row
// number of the first cell in the range.
function parseAppendedRange(updatedRange: string): AppendedRow {
  const match = updatedRange.match(/^(?:'([^']+)'|([^!]+))!([A-Z]+)(\d+)/)
  if (!match) {
    throw new Error(`Could not parse appended range: ${updatedRange}`)
  }
  const sheetName = match[1] ?? match[2]
  return { sheetName, rowNumber: Number(match[4]) }
}

// New-sheet visual formatting (createSheet only — never applied to an
// already-existing sheet). Real Sheets conditional-format rules, not
// colors painted at write time, so they keep re-evaluating live even if
// the user retypes a Status value by hand later, unlike the Excel side
// (see excel.ts — Graph has no conditional-formatting endpoint at all,
// confirmed by checking Microsoft's own Excel-in-Graph reference, which
// covers worksheets/tables/charts/ranges/functions exhaustively but never
// mentions it).
const HEADER_BACKGROUND_COLOR = { red: 0.2, green: 0.4, blue: 0.8 } // #3366CC
const HEADER_TEXT_COLOR = { red: 1, green: 1, blue: 1 }

const STATUS_COLORS: Record<string, { red: number; green: number; blue: number }> = {
  Offer: { red: 0.72, green: 0.88, blue: 0.72 },
  Interview: { red: 0.78, green: 0.86, blue: 0.98 },
  Applied: { red: 1, green: 0.94, blue: 0.6 },
  Rejected: { red: 0.96, green: 0.78, blue: 0.78 },
  Cancelled: { red: 0.96, green: 0.78, blue: 0.78 },
}

const WIDE_COLUMNS = ['URL', 'Notes']
const WIDE_COLUMN_PIXELS = 250

// Column indices computed from the actual templateColumns passed in,
// never hardcoded — self-correcting the same way readHeaders-driven
// column order already is elsewhere in this file, in case the template
// ever changes shape.
function buildFormattingRequests(sheetId: number, templateColumns: string[]): unknown[] {
  const requests: unknown[] = [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: HEADER_BACKGROUND_COLOR,
            textFormat: { bold: true, foregroundColor: HEADER_TEXT_COLOR },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
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
              format: { backgroundColor: color },
            },
          },
          index: ruleIndex++,
        },
      })
    }

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
            values: Object.keys(STATUS_COLORS).map((value) => ({ userEnteredValue: value })),
          },
          strict: true,
          showCustomUi: true,
        },
      },
    })
  }

  for (const columnName of WIDE_COLUMNS) {
    const columnIndex = templateColumns.indexOf(columnName)
    if (columnIndex === -1) continue
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: columnIndex, endIndex: columnIndex + 1 },
        properties: { pixelSize: WIDE_COLUMN_PIXELS },
        fields: 'pixelSize',
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

    const range = `${sheetName}!A1`
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
    const range = `${sheetRef.sheetName}!1:1`
    const data = (await withAuth((token) =>
      apiFetch(`/${sheetRef.spreadsheetId}/values/${encodeURIComponent(range)}`, token),
    )) as { values?: string[][] }
    return data.values?.[0] ?? []
  },

  async appendRow(sheetRef: SheetRef, row: Record<string, string>): Promise<AppendedRow> {
    // Reads the sheet's actual current headers to determine column order,
    // rather than trusting Object.values(row) insertion order — self-
    // correcting if the user ever reorders columns by hand, and the only
    // correct behavior once existing-sheet linking (Phase 7) is in play.
    const headers = await this.readHeaders(sheetRef)
    const values = headers.map((header) => row[header] ?? '')

    const range = `${sheetRef.sheetName}!A1`
    const result = (await withAuth((token) =>
      apiFetch(
        `/${sheetRef.spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
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
  },

  async updateCell(
    sheetRef: SheetRef,
    rowNumber: number,
    columnName: string,
    value: string,
  ): Promise<void> {
    const headers = await this.readHeaders(sheetRef)
    const columnIndex = headers.indexOf(columnName)
    if (columnIndex === -1) {
      throw new Error(`Column "${columnName}" not found in sheet headers: ${headers.join(', ')}`)
    }
    const range = `${sheetRef.sheetName}!${columnIndexToLetter(columnIndex)}${rowNumber}`
    await withAuth((token) =>
      apiFetch(`/${sheetRef.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, token, {
        method: 'PUT',
        body: JSON.stringify({ values: [[value]] }),
      }),
    )
  },

  async readRow(sheetRef: SheetRef, rowNumber: number): Promise<Record<string, string>> {
    const headers = await this.readHeaders(sheetRef)
    const range = `${sheetRef.sheetName}!${rowNumber}:${rowNumber}`
    const data = (await withAuth((token) =>
      apiFetch(`/${sheetRef.spreadsheetId}/values/${encodeURIComponent(range)}`, token),
    )) as { values?: string[][] }
    const rowValues = data.values?.[0] ?? []
    const row: Record<string, string> = {}
    headers.forEach((header, i) => {
      row[header] = rowValues[i] ?? ''
    })
    return row
  },
}

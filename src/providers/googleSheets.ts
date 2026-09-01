import type { AppendedRow, ColumnMapping, SheetRef, SpreadsheetProvider } from './types'

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

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
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

// Sheets API addresses columns by letter, not index — A, B, ... Z, AA, AB,
// ... This is the standard base-26 (no zero digit) conversion, correct
// past 26 columns even though this project only has 8 right now.
function columnIndexToLetter(index: number): string {
  let letter = ''
  let n = index
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter
    n = Math.floor(n / 26) - 1
  }
  return letter
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
    )) as { spreadsheetId: string; sheets?: Array<{ properties?: { title?: string } }> }

    const spreadsheetId = created.spreadsheetId
    // Read the real sheet name back from the response rather than assuming
    // "Sheet1" — that's the usual default but not a guaranteed one.
    const sheetName = created.sheets?.[0]?.properties?.title ?? 'Sheet1'

    const range = `${sheetName}!A1`
    await withAuth((token) =>
      apiFetch(`/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, token, {
        method: 'PUT',
        body: JSON.stringify({ values: [templateColumns] }),
      }),
    )

    return { spreadsheetId, sheetName }
  },

  async readHeaders(sheetRef: SheetRef): Promise<string[]> {
    const range = `${sheetRef.sheetName}!1:1`
    const data = (await withAuth((token) =>
      apiFetch(`/${sheetRef.spreadsheetId}/values/${encodeURIComponent(range)}`, token),
    )) as { values?: string[][] }
    return data.values?.[0] ?? []
  },

  // "Fuzzy matching" per CLAUDE.md is defined narrowly here: case-insensitive,
  // ignoring punctuation/whitespace differences — not typo-tolerant matching.
  mapColumns(existingHeaders: string[], knownFields: string[]): ColumnMapping {
    const mapping: ColumnMapping = {}
    for (const field of knownFields) {
      const target = normalizeHeader(field)
      const match = existingHeaders.find((header) => normalizeHeader(header) === target)
      if (match) mapping[field] = match
    }
    return mapping
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
}

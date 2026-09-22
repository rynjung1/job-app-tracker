import type { RecentApplication } from './recentApplications'
import { rowStillMatches } from './recentApplications'
import { LOG_ID_COLUMN } from './sheetTemplate'

// The columns the popup's live status chips read (CLAUDE.md, Logging
// behavior, "live status chips"). Log ID since 2026-09-14; a sheet without
// that column just returns the other three (readCells leaves a missing
// column out).
export const LIVE_STATUS_COLUMNS = ['Company', 'Title', 'Status', LOG_ID_COLUMN]

// rows[i] is the sheet's current Company/Title/Status/Log ID for
// entries[i]. A live status is kept only when the row is still that
// application, by the same rule Edit and the status menu check before
// writing (rowStillMatches): the Log ID when the entry and the row have one,
// Company and Title otherwise. So a Company edited in the sheet (a Workday
// tenant id, say) doesn't freeze the chip. A mismatched row (moved, edited
// or deleted by hand) or an empty Status cell leaves the entry out, and the
// popup keeps showing its cached status. Nothing here writes anywhere.
export function matchLiveStatuses(
  entries: RecentApplication[],
  rows: Record<string, string>[],
): Record<string, string> {
  const statuses: Record<string, string> = {}
  entries.forEach((entry, i) => {
    const row = rows[i]
    if (row && rowStillMatches(row, entry) && row.Status) {
      statuses[entry.id] = row.Status
    }
  })
  return statuses
}

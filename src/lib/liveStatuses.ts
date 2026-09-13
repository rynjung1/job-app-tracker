import type { RecentApplication } from './recentApplications'

// The columns the popup's live status chips read (CLAUDE.md, Logging
// behavior, "live status chips").
export const LIVE_STATUS_COLUMNS = ['Company', 'Title', 'Status']

// rows[i] is the sheet's current Company/Title/Status for entries[i].
// A live status is kept only when the row is still that application:
// the same Company/Title identity rule Edit and Undo check before
// writing. A mismatched row (sorted, edited or deleted by hand) or an
// empty Status cell leaves the entry out, and the popup keeps showing its
// cached status. Nothing here writes anywhere.
export function matchLiveStatuses(
  entries: RecentApplication[],
  rows: Record<string, string>[],
): Record<string, string> {
  const statuses: Record<string, string> = {}
  entries.forEach((entry, i) => {
    const row = rows[i]
    if (row && row.Company === entry.company && row.Title === entry.title && row.Status) {
      statuses[entry.id] = row.Status
    }
  })
  return statuses
}

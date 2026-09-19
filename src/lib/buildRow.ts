import type { JobPostingData } from '../parsers/types'
import { LOG_ID_COLUMN } from './sheetTemplate'

// Status starts at 'Applied' (2026-09-17, decided by Ryan; a flagged change
// to the locked "Status field" rule, which had every row start blank). A
// blank cell showed no colour and no dropdown value until the user set one,
// left the Summary tab's totals by status unable to sum to Total logged, and
// disagreed with the popup, which already showed such entries as Applied.
// It stays a manual field: nothing detects a status change, the cell is
// ordinary and editable, 'Applied' is one of the five the strict dropdown
// accepts, and the sheet's TEXT_EQ rule colours it. Notes stays blank.
// Resume Version was removed 2026-09-18 (decided by Ryan; a flagged change
// to the locked sheet template): new sheets have no such column, and on a
// sheet created before that they keep theirs and appendRow, which maps by
// header name, simply leaves that cell blank.
//
// Log ID (2026-09-14): a random id made here, once per application, and
// kept on the row through sanitizeRow and the offline queue, so the drain
// can find a row that already reached the sheet (CLAUDE.md, Sheet setup).
export function buildRow(data: JobPostingData): Record<string, string> {
  return {
    Date: new Date().toISOString(),
    Company: data.company,
    Title: data.title,
    Location: data.location ?? '',
    URL: data.url,
    Status: 'Applied',
    Notes: '',
    [LOG_ID_COLUMN]: crypto.randomUUID(),
  }
}

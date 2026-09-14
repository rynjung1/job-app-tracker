import type { JobPostingData } from '../parsers/types'
import { LOG_ID_COLUMN } from './sheetTemplate'

// Status, Notes are intentionally blank — manual fields by design
// (CLAUDE.md "Status field"). Resume Version is passed in rather than
// computed here — see lib/resumeVersion.ts for the role-type-keyed
// last-used lookup (CLAUDE.md Phase 4); kept out of this function so
// buildRow stays a pure sync mapping, no storage access.
//
// Log ID (2026-09-14): a random id made here, once per application, and
// kept on the row through sanitizeRow and the offline queue, so the drain
// can find a row that already reached the sheet (CLAUDE.md, Sheet setup).
export function buildRow(data: JobPostingData, resumeVersion: string): Record<string, string> {
  return {
    Date: new Date().toISOString(),
    Company: data.company,
    Title: data.title,
    Location: data.location ?? '',
    URL: data.url,
    'Resume Version': resumeVersion,
    Status: '',
    Notes: '',
    [LOG_ID_COLUMN]: crypto.randomUUID(),
  }
}

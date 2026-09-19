// Locked column list, see CLAUDE.md "Sheet setup" — Location was added
// 2026-08-27 (Phase 3) after the LinkedIn parser started extracting it with
// nowhere to put it.
export const SHEET_TEMPLATE_COLUMNS = [
  'Date',
  'Company',
  'Title',
  'Location',
  'URL',
  'Status',
  'Notes',
  // Added 2026-09-14 (CLAUDE.md, Sheet setup): a hidden column holding each
  // logged application's random id, so the offline-queue drain can tell an
  // append whose response timed out after it had succeeded from one that
  // really failed. Keep it last: createSheet's banding stops before it.
  'Log ID',
] as const

export const LOG_ID_COLUMN = 'Log ID'

// The five Status values (CLAUDE.md, Status field), in workflow order. One
// list for the sheet's dropdown and colour rules (googleSheets.ts), the
// popup's status menu and SET_STATUS's check, so they can't drift apart.
export const STATUS_VALUES = ['Applied', 'Interview', 'Offer', 'Rejected', 'Cancelled'] as const
export type StatusValue = (typeof STATUS_VALUES)[number]

export function isStatusValue(value: unknown): value is StatusValue {
  return typeof value === 'string' && (STATUS_VALUES as readonly string[]).includes(value)
}

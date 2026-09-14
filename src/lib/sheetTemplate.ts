// Locked column list, see CLAUDE.md "Sheet setup" — Location was added
// 2026-08-27 (Phase 3) after the LinkedIn parser started extracting it with
// nowhere to put it.
export const SHEET_TEMPLATE_COLUMNS = [
  'Date',
  'Company',
  'Title',
  'Location',
  'URL',
  'Resume Version',
  'Status',
  'Notes',
] as const

// The five Status values (CLAUDE.md, Status field), in workflow order. One
// list for the sheet's dropdown and colour rules (googleSheets.ts), the
// popup's status menu and SET_STATUS's check, so they can't drift apart.
export const STATUS_VALUES = ['Applied', 'Interview', 'Offer', 'Rejected', 'Cancelled'] as const
export type StatusValue = (typeof STATUS_VALUES)[number]

export function isStatusValue(value: unknown): value is StatusValue {
  return typeof value === 'string' && (STATUS_VALUES as readonly string[]).includes(value)
}

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

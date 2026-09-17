// The spreadsheet's own name (2026-09-17, decided by Ryan). The first sheet
// a user gets is "Job Applications"; every sheet made after that — by
// "Start a new sheet" in Settings, or to replace one in Drive's trash or
// deleted — carries the date it was created, because the old one is still
// sitting in Drive under the old name and nothing else distinguishes them.
export const DEFAULT_SHEET_TITLE = 'Job Applications'

export function datedSheetTitle(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  // The local date, the day the user is having, not UTC's.
  return `${DEFAULT_SHEET_TITLE} (from ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())})`
}

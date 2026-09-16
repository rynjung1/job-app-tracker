// The popup's error texts, shared by App.tsx and the note editor. Moved out of
// App.tsx unchanged on 2026-09-15, plus the two note texts.
export const STALE_ROW_STATUS =
  "This row may have changed since it was logged, so its status wasn't changed. You can still change it in your spreadsheet."
export const STALE_ROW_RESUME =
  "This row may have changed since it was logged, so it wasn't updated. You can still change it in your spreadsheet."
export const STALE_ROW_NOTE =
  "This row may have changed since it was logged, so its note wasn't opened or saved. You can still change it in your spreadsheet."
// SAVE_NOTE's NOTE_CHANGED (wording decided by Ryan, 2026-09-15).
export const NOTE_CHANGED = 'This note changed in your sheet; reopen to see it.'
export const SIGN_IN_NEEDED = 'Google sign-in needed. Reconnect, then try again.'
export const SHEET_UNAVAILABLE = "Your sheet is in Google Drive's trash or was deleted, so nothing was changed. See the note above."
export const GENERIC_ERROR = 'Something went wrong. Please try again.'

export function errorMessage(code: string | undefined, staleMessage: string): string {
  if (code === 'STALE_ROW') return staleMessage
  if (code === 'NOTE_CHANGED') return NOTE_CHANGED
  if (code === 'AUTH_REQUIRED') return SIGN_IN_NEEDED
  if (code === 'SHEET_UNAVAILABLE') return SHEET_UNAVAILABLE
  return GENERIC_ERROR
}

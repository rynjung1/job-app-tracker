export const SHEET_REF_KEY = 'sheetRef'
// The sheet that was connected before the last swap (2026-09-17), so
// Settings can offer "Switch back to the previous sheet" — see
// lib/sheetRef.ts. One level of history: switching back remembers the sheet
// it just left.
export const PREVIOUS_SHEET_REF_KEY = 'previousSheetRef'
export const OFFLINE_QUEUE_KEY = 'offlineQueue'
export const RECENT_APPLICATIONS_KEY = 'recentApplications'
// chrome.storage.session, not local — see lib/pendingApplications.ts.
export const PENDING_APPLICATIONS_KEY = 'pendingApplications'
export const LAST_RESUME_VERSION_KEY = 'lastResumeVersionByRoleType'
// The "sign-in needed" flag — see lib/authStatus.ts.
export const AUTH_STATUS_KEY = 'authStatus'
// The "sheet in Drive's trash or deleted" flag — see lib/sheetStatus.ts.
export const SHEET_STATUS_KEY = 'sheetStatus'
// chrome.storage.session — see background/settingsWindow.ts.
export const SETTINGS_WINDOW_KEY = 'settingsWindowId'
// Left behind by the Excel/OneDrive support removed 2026-09-13 (a Microsoft
// token and the provider choice). Deleted on extension update — see
// background/index.ts's onInstalled.
export const REMOVED_EXCEL_KEYS = ['msToken', 'activeProvider']

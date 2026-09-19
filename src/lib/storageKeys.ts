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
// The "sign-in needed" flag — see lib/authStatus.ts.
export const AUTH_STATUS_KEY = 'authStatus'
// The "sheet in Drive's trash or deleted" flag — see lib/sheetStatus.ts.
export const SHEET_STATUS_KEY = 'sheetStatus'
// chrome.storage.session — see background/settingsWindow.ts.
export const SETTINGS_WINDOW_KEY = 'settingsWindowId'
// Keys an earlier version wrote that nothing reads any more, deleted on
// extension update (background/index.ts's onInstalled): the Excel/OneDrive
// support removed 2026-09-13 left a Microsoft token and the provider
// choice, and the Resume Version column removed 2026-09-18 left the
// last-used-per-role-type map.
export const REMOVED_KEYS = ['msToken', 'activeProvider', 'lastResumeVersionByRoleType']

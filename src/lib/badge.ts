import { AUTH_STATUS_KEY, SHEET_STATUS_KEY } from './storageKeys'

// The toolbar badge and tooltip, from both warning flags (2026-09-14): a "!"
// while Google sign-in is needed (lib/authStatus.ts) or while the connected
// sheet is in Drive's trash or deleted (lib/sheetStatus.ts). The tooltip
// names sign-in first: nothing about the sheet can be checked without it.
// Background-only (chrome.action).
const ACTION_TITLE = 'Job Application Tracker'
const BADGE_COLOR = '#B45309' // white "!" on it: 5.02:1

export async function refreshBadge(): Promise<void> {
  const stored = await chrome.storage.local.get([AUTH_STATUS_KEY, SHEET_STATUS_KEY])
  const signInNeeded = stored[AUTH_STATUS_KEY] !== undefined
  const sheet = stored[SHEET_STATUS_KEY] as { state?: string } | undefined
  const on = signInNeeded || sheet !== undefined
  await chrome.action.setBadgeText({ text: on ? '!' : '' })
  if (on) {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR })
    await chrome.action.setBadgeTextColor({ color: '#FFFFFF' })
  }
  const warning = signInNeeded
    ? 'Google sign-in needed'
    : sheet?.state === 'trashed'
      ? "your sheet is in Google Drive's trash"
      : sheet
        ? 'your sheet was deleted'
        : null
  await chrome.action.setTitle({ title: warning ? `${ACTION_TITLE}: ${warning}` : ACTION_TITLE })
}

import { AUTH_STATUS_KEY, OFFLINE_QUEUE_KEY } from './storageKeys'
import { withStorageLock } from './storageLock'

// The "sign-in needed" flag (CLAUDE.md, "needs reconnect"). Set when a
// provider call fails with AuthRequiredError, cleared by the next provider
// call that succeeds; getActiveProvider()'s wrapper does both, so every
// caller is covered. Kept in chrome.storage.local so it survives a browser
// restart, like the lapsed sign-in it describes. `reason` keeps the
// original error text.
export interface AuthStatus {
  since: string
  reason: string
}

export const NEEDS_RECONNECT_NOTIFICATION_ID = 'needs-reconnect'
const ACTION_TITLE = 'Job Application Tracker'
const BADGE_COLOR = '#B45309' // white "!" on it: 5.02:1

export async function getAuthStatus(): Promise<AuthStatus | undefined> {
  const stored = await chrome.storage.local.get(AUTH_STATUS_KEY)
  return stored[AUTH_STATUS_KEY] as AuthStatus | undefined
}

// Rows in the offline queue: applications not yet saved to the sheet.
export async function getQueuedCount(): Promise<number> {
  const stored = await chrome.storage.local.get(OFFLINE_QUEUE_KEY)
  return (stored[OFFLINE_QUEUE_KEY] as unknown[] | undefined)?.length ?? 0
}

export function applicationCount(n: number): string {
  return n === 1 ? '1 application' : `${n} applications`
}

// Everything below is background-only (chrome.action, chrome.notifications).

// Both run under the storage lock: two failures at once (a drain and an
// apply) must see each other's write, so exactly one of them sets the flag
// and only it notifies. Every storage-lock call site was checked to make no
// provider call inside the lock, so this can't wait on itself.
export async function reportAuthRequired(reason: string): Promise<void> {
  const firstFailure = await withStorageLock(async () => {
    if (await getAuthStatus()) return false
    const status: AuthStatus = { since: new Date().toISOString(), reason }
    await chrome.storage.local.set({ [AUTH_STATUS_KEY]: status })
    return true
  })
  if (firstFailure) {
    await showBadge(true)
    await showNeedsReconnectNotification()
  }
}

export async function reportAuthOk(): Promise<void> {
  const wasSet = await withStorageLock(async () => {
    if (!(await getAuthStatus())) return false
    await chrome.storage.local.remove(AUTH_STATUS_KEY)
    return true
  })
  if (wasSet) {
    await showBadge(false)
    await chrome.notifications.clear(NEEDS_RECONNECT_NOTIFICATION_ID)
  }
}

// Fixed id, like 'not-connected': a newer one replaces it in place. Shown
// when the flag is first set, and again for each application queued while
// it's set (background/index.ts); never by the 5-minute drain on its own.
export async function showNeedsReconnectNotification(): Promise<void> {
  const waiting = await getQueuedCount()
  await chrome.notifications.create(NEEDS_RECONNECT_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Sign-in needed',
    message:
      waiting > 0
        ? `Logging is paused. ${applicationCount(waiting)} ${waiting === 1 ? 'is' : 'are'} waiting — reconnect to save ${waiting === 1 ? 'it' : 'them'}.`
        : 'Logging is paused until you reconnect Google Sheets.',
    buttons: [{ title: 'Reconnect' }],
  })
}

// The toolbar badge doesn't survive a browser restart, so the worker
// re-applies it from the stored flag on startup and install/update.
export async function syncBadge(): Promise<void> {
  await showBadge((await getAuthStatus()) !== undefined)
}

async function showBadge(on: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text: on ? '!' : '' })
  if (on) {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR })
    await chrome.action.setBadgeTextColor({ color: '#FFFFFF' })
  }
  await chrome.action.setTitle({ title: on ? `${ACTION_TITLE}: Google sign-in needed` : ACTION_TITLE })
}

// Background service worker.
// Owns OAuth tokens and spreadsheet API calls (see CLAUDE.md — Trust boundary).
// Content scripts and other components must never write to a spreadsheet directly.

import { getActiveProvider } from '../providers/activeProvider'
import { AuthRequiredError } from '../providers/types'
import type { AppendedRow } from '../providers/types'
import type { JobPostingData } from '../parsers/types'
import { buildRow } from '../lib/buildRow'
import { sanitizeRow } from '../lib/sanitize'
import { REMOVED_EXCEL_KEYS } from '../lib/storageKeys'
import { getSheetRef } from '../lib/sheetRef'
import { getDefaultResumeVersion } from '../lib/resumeVersion'
import { addRecentApplication, cancelApplication, getRecentApplications } from '../lib/recentApplications'
import type { RecentApplication } from '../lib/recentApplications'
import { recordPendingApplication, takePendingApplication } from '../lib/pendingApplications'
import { NEEDS_RECONNECT_NOTIFICATION_ID, showNeedsReconnectNotification, syncBadge } from '../lib/authStatus'
import { handleInternalMessage, isInternalMessage } from './messageRouter'
import { openSettingsWindow } from './settingsWindow'
import { drainOfflineQueue, queueRow } from './offlineQueue'

const TRUSTED_ORIGINS = ['https://www.linkedin.com', 'https://job-boards.greenhouse.io']
// This extension's own pages (popup, options) — used to distinguish an
// internal RPC message from a content-script message. See the onMessage
// listener below for why this is sender.origin, not sender.tab or
// sender.id.
const OWN_ORIGIN = `chrome-extension://${chrome.runtime.id}`
const RETRY_ALARM_NAME = 'retryOfflineQueue'
const NOTIFICATION_CLEAR_ALARM_PREFIX = 'clearNotification:'
// Chrome's own alarms API has a practical minimum around a few seconds in
// MV3; this is a best-effort "~5 seconds" per CLAUDE.md, not a guarantee —
// the native OS notification banner's own on-screen duration is partly
// outside the extension's control (see CLAUDE.md Logging behavior note).
const NOTIFICATION_CLEAR_DELAY_MINUTES = 5 / 60
// Fixed, not per-call random — a second queued-while-disconnected
// application replaces this notification in place (Chrome's own
// documented create() behavior: reusing an id clears the existing one
// first) rather than stacking up identical repeats on rapid-fire.
const NOT_CONNECTED_NOTIFICATION_ID = 'not-connected'
// Fixed id, no buttons, no auto-clear: a notification Undo that failed.
const UNDO_FAILED_NOTIFICATION_ID = 'undo-failed'

// reason check matters here — onInstalled also fires on 'update' and
// 'chrome_update', not just a genuine first install. Gating strictly on
// 'install' avoids re-opening Settings after every routine extension
// auto-update, a real, documented pitfall of this API.
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[job-app-tracker] background service worker installed')
  chrome.alarms.create(RETRY_ALARM_NAME, { periodInMinutes: 5 })
  syncBadge()
  if (details.reason === 'install') {
    openSettingsWindow()
  }
  // Excel/OneDrive support was removed 2026-09-13: delete the Microsoft
  // token and provider choice an earlier version may have stored, so the
  // extension keeps no credential of its own.
  if (details.reason === 'update') {
    chrome.storage.local.remove(REMOVED_EXCEL_KEYS)
  }
})

// The "sign-in needed" badge doesn't survive a browser restart; re-apply it
// from the stored flag (lib/authStatus.ts).
chrome.runtime.onStartup.addListener(() => {
  syncBadge()
})

// Fires the proactive "Logged: Company — Title" toast (a real
// chrome.notifications system notification — see CLAUDE.md Logging
// behavior, Phase 4 note for why this isn't literally "the popup" opening
// itself) and records the entry so the popup's recent-applications list
// and the Edit window both have something to show. Only called on an
// immediate successful write. A row that only succeeds later via the
// offline-queue drain gets a list entry from the drain itself
// (offlineQueue.ts, since 2026-09-13) but no toast: the correction window
// is for the moment of applying, which has long passed by then.
async function notifyApplicationLogged(payload: JobPostingData, row: Record<string, string>, appended: AppendedRow) {
  const id = crypto.randomUUID()
  const entry: RecentApplication = {
    id,
    title: payload.title,
    company: payload.company,
    location: payload.location,
    url: payload.url,
    date: row.Date,
    resumeVersion: row['Resume Version'],
    status: 'Applied',
    sheetName: appended.sheetName,
    rowNumber: appended.rowNumber,
  }
  await addRecentApplication(entry)

  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Logged',
    message: `${payload.company} — ${payload.title}`,
    buttons: [{ title: 'Undo' }, { title: 'Edit' }],
  })

  chrome.alarms.create(`${NOTIFICATION_CLEAR_ALARM_PREFIX}${id}`, {
    delayInMinutes: NOTIFICATION_CLEAR_DELAY_MINUTES,
  })
}

async function handleJobApplicationLogged(payload: JobPostingData) {
  const resumeVersion = await getDefaultResumeVersion(payload.title)
  const row = sanitizeRow(buildRow(payload, resumeVersion))
  const sheetRef = await getSheetRef()

  if (!sheetRef) {
    console.warn(
      '[job-app-tracker] no sheet connected — open the extension options page and click "Connect Google Sheets". Queuing this row for once it is.',
    )
    await queueRow(row)
    // Real user-visible guidance, not just a console line no real user
    // will ever open (test-pass finding — fresh-install gap). Fixed id,
    // no auto-clear (an alarm-based ~5s clear fits a self-expiring
    // correction window, not a heads-up the user still needs to act on),
    // fires every time, same as the "Logged" toast.
    chrome.notifications.create(NOT_CONNECTED_NOTIFICATION_ID, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Not connected',
      message: 'Application queued — connect a spreadsheet in Settings to save it.',
      buttons: [{ title: 'Open Settings' }],
    })
    return
  }

  try {
    const provider = await getActiveProvider()
    const appended = await provider.appendRow(sheetRef, row)
    console.log('[job-app-tracker] row written to sheet, row', appended.rowNumber)
    await notifyApplicationLogged(payload, row, appended)
  } catch (err) {
    console.warn('[job-app-tracker] appendRow failed, queuing for retry:', err)
    await queueRow(row)
    // Signed out: the user just applied and gets no "Logged" toast, so tell
    // them why, every time (the fixed id replaces it in place). Queued
    // first, so the count includes this application.
    if (err instanceof AuthRequiredError) {
      await showNeedsReconnectNotification()
    }
  }
}

// Two-phase logging (Greenhouse — CLAUDE.md, Logging behavior): the Submit
// click only records the job as pending, and the row is written when the
// site's confirmation page loads for the same application, so a Submit that
// fails validation (no confirmation) never logs. Keys are scoped by the
// sender's origin so two sites can't collide, and a confirmation with
// nothing pending (a reload, a revisit, a pasted URL) is ignored.
const APPLICATION_KEY_FORMAT = /^[\w.~-]+(?:\/[\w.~-]+)*$/

function scopedApplicationKey(origin: string, key: unknown): string | null {
  if (typeof key !== 'string' || key.length > 200 || !APPLICATION_KEY_FORMAT.test(key)) return null
  return `${origin}|${key}`
}

async function handleJobApplicationConfirmed(scopedKey: string) {
  // Read-and-delete happens inside the storage lock; logging happens after
  // it's released (see lib/pendingApplications.ts for why).
  const payload = await takePendingApplication(scopedKey)
  if (!payload) {
    console.log('[job-app-tracker] confirmation with no pending application, ignored')
    return
  }
  await handleJobApplicationLogged(payload)
}

// The offline queue itself (queueRow, drainOfflineQueue, its re-entrancy
// guard) lives in ./offlineQueue.ts.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM_NAME) {
    drainOfflineQueue()
    return
  }
  if (alarm.name.startsWith(NOTIFICATION_CLEAR_ALARM_PREFIX)) {
    const id = alarm.name.slice(NOTIFICATION_CLEAR_ALARM_PREFIX.length)
    chrome.notifications.clear(id)
  }
})

// Undo: marks the row Cancelled rather than deleting it — safer against a
// row having shifted if the user's since sorted/edited the sheet by hand
// (CLAUDE.md Logging behavior, Phase 4 note). Edit: opens the popup's own
// HTML as a standalone window rather than a new UI surface, since the
// popup already needs to render the recent-applications list.
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  // Checked before the sheetRef guard below — sheetRef is genuinely
  // undefined in exactly this notification's own scenario, so the guard
  // would otherwise silently swallow this button click entirely.
  if (notificationId === NOT_CONNECTED_NOTIFICATION_ID) {
    openSettingsWindow()
    chrome.notifications.clear(notificationId)
    return
  }

  // Reconnect runs in the Settings window, which shows how it went.
  if (notificationId === NEEDS_RECONNECT_NOTIFICATION_ID) {
    openSettingsWindow({ reconnect: true })
    chrome.notifications.clear(notificationId)
    return
  }

  const sheetRef = await getSheetRef()
  if (!sheetRef) return

  if (buttonIndex === 0) {
    const entries = await getRecentApplications()
    const entry = entries.find((e) => e.id === notificationId)
    if (!entry) return
    try {
      const provider = await getActiveProvider()
      await cancelApplication(provider, sheetRef, entry)
      console.log('[job-app-tracker] undo: marked row', entry.rowNumber, 'Cancelled')
    } catch (err) {
      // Used to be console-only, so a failed Undo looked like it worked:
      // the "Logged" notification closed either way. Signed out, show
      // "Sign-in needed" again (the wrapper only shows it on the first
      // failure); otherwise say the row is still logged and where to retry.
      console.warn('[job-app-tracker] undo failed:', err)
      if (err instanceof AuthRequiredError) {
        await showNeedsReconnectNotification()
      } else {
        chrome.notifications.create(UNDO_FAILED_NOTIFICATION_ID, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: "Undo didn't go through",
          message: `${entry.company} — ${entry.title} is still logged. Use Undo in the extension's popup.`,
        })
      }
    }
    chrome.notifications.clear(notificationId)
  } else if (buttonIndex === 1) {
    chrome.windows.create({
      type: 'popup',
      url: chrome.runtime.getURL(`src/popup/index.html?edit=${notificationId}`),
      // Taller than the original 320: the restyled edit panel (label,
      // input, Cancel/Save) needs the room.
      width: 360,
      height: 480,
    })
    chrome.notifications.clear(notificationId)
  }
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Extension-page messages (popup, options) — checked via sender.origin,
  // not sender.tab or sender.id. Confirmed live in a real Chrome instance
  // with a real loaded extension, not assumed: sender.tab is set for BOTH
  // a content script AND this project's own options page, since
  // options_page opens as a genuine browser tab, not an embedded surface —
  // a !sender.tab check (the first fix attempted here) would have
  // rejected every real CONNECT_PROVIDER/RECONNECT_PROVIDER message from
  // options.html. sender.id is equally unusable: it identifies which
  // extension sent a message, not what kind of context sent it —
  // content/linkedin.ts and content/greenhouse.ts share this same
  // extension's id too. sender.origin is the field that actually differs:
  // an extension's own page (popup or a tab-hosted options page alike)
  // always reports its own chrome-extension://<id> origin, while a
  // content script's sender.origin is the origin of the *web page* it's
  // injected into (confirmed live: a real content script's sender.origin
  // was the real page's origin, never a chrome-extension:// one) — not
  // something a compromised page script can forge, same trust basis the
  // TRUSTED_ORIGINS check below already relies on.
  if (sender.origin === OWN_ORIGIN && isInternalMessage(message)) {
    handleInternalMessage(message, sendResponse)
    return true // keep the channel open for the async sendResponse above
  }

  if (!sender.origin || !TRUSTED_ORIGINS.includes(sender.origin)) {
    console.warn('[job-app-tracker] rejected message from unverified origin', sender.origin)
    return false
  }

  if (message?.type === 'JOB_APPLICATION_LOGGED') {
    handleJobApplicationLogged(message.payload as JobPostingData)
  }

  if (message?.type === 'JOB_APPLICATION_PENDING' || message?.type === 'JOB_APPLICATION_CONFIRMED') {
    const key = scopedApplicationKey(sender.origin, message.key)
    if (!key) {
      console.warn('[job-app-tracker] rejected application message with a malformed key')
      return false
    }
    if (message.type === 'JOB_APPLICATION_PENDING') {
      recordPendingApplication(key, message.payload as JobPostingData)
    } else {
      handleJobApplicationConfirmed(key)
    }
  }

  return false
})

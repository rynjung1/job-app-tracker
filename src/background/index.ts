// Background service worker.
// Owns OAuth tokens and spreadsheet API calls (see CLAUDE.md — Trust boundary).
// Content scripts and other components must never write to a spreadsheet directly.

import { getActiveProvider } from '../providers/activeProvider'
import type { AppendedRow } from '../providers/types'
import type { JobPostingData } from '../parsers/types'
import { buildRow } from '../lib/buildRow'
import { sanitizeRow } from '../lib/sanitize'
import { OFFLINE_QUEUE_KEY } from '../lib/storageKeys'
import { getSheetRef } from '../lib/sheetRef'
import { getDefaultResumeVersion } from '../lib/resumeVersion'
import { addRecentApplication, cancelApplication, getRecentApplications } from '../lib/recentApplications'
import type { RecentApplication } from '../lib/recentApplications'
import { withStorageLock } from '../lib/storageLock'
import { handleInternalMessage, isInternalMessage } from './messageRouter'

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

// reason check matters here — onInstalled also fires on 'update' and
// 'chrome_update', not just a genuine first install. Gating strictly on
// 'install' avoids re-opening the options page after every routine
// extension auto-update, a real, documented pitfall of this API.
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[job-app-tracker] background service worker installed')
  chrome.alarms.create(RETRY_ALARM_NAME, { periodInMinutes: 5 })
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage()
  }
})

async function getOfflineQueue(): Promise<Record<string, string>[]> {
  const stored = await chrome.storage.local.get(OFFLINE_QUEUE_KEY)
  return (stored[OFFLINE_QUEUE_KEY] as Record<string, string>[] | undefined) ?? []
}

// Locked — a read-modify-write against shared storage, real-demonstrated
// to silently lose data under two concurrent calls without this (e.g. two
// applications logged in quick succession). See CLAUDE.md's concurrency-
// fix note for the reproduction.
async function queueRow(row: Record<string, string>): Promise<void> {
  await withStorageLock(async () => {
    const queue = await getOfflineQueue()
    queue.push(row)
    await chrome.storage.local.set({ [OFFLINE_QUEUE_KEY]: queue })
  })
}

// Fires the proactive "Logged: Company — Title" toast (a real
// chrome.notifications system notification — see CLAUDE.md Logging
// behavior, Phase 4 note for why this isn't literally "the popup" opening
// itself) and records the entry so the popup's recent-applications list
// and the Edit window both have something to show. Only called on an
// immediate successful write — a row that only succeeds later via the
// offline-queue drain does not get a toast or a list entry; known Phase 4
// scope boundary, not an oversight.
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
  }
}

// Retries queued rows in original order, stopping at the first failure this
// pass (a systemic issue — expired auth, network down — shouldn't hammer
// the API once per queued row) and leaving the failed row plus everything
// after it queued for the next alarm.
//
// The closing write does NOT hold the lock for the whole function — only
// for the final read+write, after every appendRow (real network round
// trips) has already happened. Real-demonstrated bug this fixes: a row
// queued by a concurrent apply while a drain is mid-flight used to be
// silently discarded by an overwrite based on a stale snapshot taken
// before the drain started (see CLAUDE.md's concurrency-fix note). Fixed
// by re-reading the current queue inside the lock and dropping only the
// first `drainedCount` entries — correct by construction, not a
// heuristic: queueRow only ever appends to the end and this function only
// ever processes from the start in order, so nothing queued mid-drain can
// land anywhere but after the entries already being drained.
//
// Fixed 2026-09-10 (re-entrancy): a second, distinct real bug, not covered
// by the fix above — RETRY_ALARM_NAME fires every 5 minutes with no
// guarantee the previous invocation has finished, and (before this fix)
// no fetch() call in any provider had a timeout, so one genuinely stalled
// request could keep this function mid-loop past the next alarm. A second
// invocation starting then reads the *same* un-drained queue (per-row
// success was never flushed to storage incrementally, only the whole
// loop's closing write is), and re-appends whatever the first invocation
// already wrote — a real, reproduced double-append, not theoretical (see
// CLAUDE.md's offline-queue notes for the repro). isDraining is safe as a
// plain module-scope flag here specifically because this function only
// ever runs inside the background worker's own realm — no popup/options
// caller exists for it, unlike the still-open MS_TOKEN_KEY cross-realm
// question. Paired with FETCH_TIMEOUT_MS (lib/fetchWithTimeout.ts) so a
// stuck request now fails within 30s instead of indefinitely, shrinking
// the window this guard needs to cover in the first place.
let isDraining = false

async function drainOfflineQueue() {
  if (isDraining) {
    console.log('[job-app-tracker] drain already in progress, skipping this alarm fire')
    return
  }
  isDraining = true
  try {
    const sheetRef = await getSheetRef()
    if (!sheetRef) return

    const queue = await getOfflineQueue()
    if (queue.length === 0) return

    const provider = await getActiveProvider()
    let drainedCount = 0
    for (const row of queue) {
      try {
        await provider.appendRow(sheetRef, row)
        console.log('[job-app-tracker] queued row written to sheet')
        drainedCount++
      } catch (err) {
        console.warn('[job-app-tracker] retry failed, stopping this pass:', err)
        break
      }
    }
    if (drainedCount === 0) return

    await withStorageLock(async () => {
      const current = await getOfflineQueue()
      await chrome.storage.local.set({ [OFFLINE_QUEUE_KEY]: current.slice(drainedCount) })
    })
  } finally {
    isDraining = false
  }
}

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
    chrome.runtime.openOptionsPage()
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
      console.warn('[job-app-tracker] undo failed:', err)
    }
    chrome.notifications.clear(notificationId)
  } else if (buttonIndex === 1) {
    chrome.windows.create({
      type: 'popup',
      url: chrome.runtime.getURL(`src/popup/index.html?edit=${notificationId}`),
      width: 360,
      height: 320,
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

  return false
})

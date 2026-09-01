// Background service worker.
// Owns OAuth tokens and spreadsheet API calls (see CLAUDE.md — Trust boundary).
// Content scripts and other components must never write to a spreadsheet directly.

import { googleSheetsProvider } from '../providers/googleSheets'
import type { AppendedRow, SheetRef } from '../providers/types'
import type { JobPostingData } from '../parsers/types'
import { buildRow } from '../lib/buildRow'
import { sanitizeRow } from '../lib/sanitize'
import { SHEET_REF_KEY, OFFLINE_QUEUE_KEY } from '../lib/storageKeys'
import { getDefaultResumeVersion } from '../lib/resumeVersion'
import { addRecentApplication, getRecentApplications, updateRecentApplication } from '../lib/recentApplications'
import type { RecentApplication } from '../lib/recentApplications'

const TRUSTED_ORIGINS = ['https://www.linkedin.com']
const RETRY_ALARM_NAME = 'retryOfflineQueue'
const NOTIFICATION_CLEAR_ALARM_PREFIX = 'clearNotification:'
// Chrome's own alarms API has a practical minimum around a few seconds in
// MV3; this is a best-effort "~5 seconds" per CLAUDE.md, not a guarantee —
// the native OS notification banner's own on-screen duration is partly
// outside the extension's control (see CLAUDE.md Logging behavior note).
const NOTIFICATION_CLEAR_DELAY_MINUTES = 5 / 60

chrome.runtime.onInstalled.addListener(() => {
  console.log('[job-app-tracker] background service worker installed')
  chrome.alarms.create(RETRY_ALARM_NAME, { periodInMinutes: 5 })
})

async function getSheetRef(): Promise<SheetRef | undefined> {
  const stored = await chrome.storage.local.get(SHEET_REF_KEY)
  return stored[SHEET_REF_KEY] as SheetRef | undefined
}

async function getOfflineQueue(): Promise<Record<string, string>[]> {
  const stored = await chrome.storage.local.get(OFFLINE_QUEUE_KEY)
  return (stored[OFFLINE_QUEUE_KEY] as Record<string, string>[] | undefined) ?? []
}

async function queueRow(row: Record<string, string>): Promise<void> {
  const queue = await getOfflineQueue()
  queue.push(row)
  await chrome.storage.local.set({ [OFFLINE_QUEUE_KEY]: queue })
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
    return
  }

  try {
    const appended = await googleSheetsProvider.appendRow(sheetRef, row)
    console.log('[job-app-tracker] row written to sheet:', row)
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
async function drainOfflineQueue() {
  const sheetRef = await getSheetRef()
  if (!sheetRef) return

  const queue = await getOfflineQueue()
  if (queue.length === 0) return

  let i = 0
  for (; i < queue.length; i++) {
    try {
      await googleSheetsProvider.appendRow(sheetRef, queue[i])
      console.log('[job-app-tracker] queued row written to sheet:', queue[i])
    } catch (err) {
      console.warn('[job-app-tracker] retry failed, stopping this pass:', err)
      break
    }
  }
  await chrome.storage.local.set({ [OFFLINE_QUEUE_KEY]: queue.slice(i) })
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
  const sheetRef = await getSheetRef()
  if (!sheetRef) return

  if (buttonIndex === 0) {
    const entries = await getRecentApplications()
    const entry = entries.find((e) => e.id === notificationId)
    if (!entry) return
    try {
      await googleSheetsProvider.updateCell(sheetRef, entry.rowNumber, 'Status', 'Cancelled')
      await updateRecentApplication(notificationId, { status: 'Cancelled' })
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

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!sender.origin || !TRUSTED_ORIGINS.includes(sender.origin)) {
    console.warn('[job-app-tracker] rejected message from unverified origin', sender.origin)
    return false
  }

  if (message?.type === 'JOB_APPLICATION_LOGGED') {
    handleJobApplicationLogged(message.payload as JobPostingData)
  }

  return false
})

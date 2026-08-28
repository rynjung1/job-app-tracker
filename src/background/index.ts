// Background service worker.
// Owns OAuth tokens and spreadsheet API calls (see CLAUDE.md — Trust boundary).
// Content scripts and other components must never write to a spreadsheet directly.

import { googleSheetsProvider } from '../providers/googleSheets'
import type { SheetRef } from '../providers/types'
import type { JobPostingData } from '../parsers/types'
import { buildRow } from '../lib/buildRow'
import { sanitizeRow } from '../lib/sanitize'
import { SHEET_REF_KEY, OFFLINE_QUEUE_KEY } from '../lib/storageKeys'

const TRUSTED_ORIGINS = ['https://www.linkedin.com']
const RETRY_ALARM_NAME = 'retryOfflineQueue'

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

async function handleJobApplicationLogged(payload: JobPostingData) {
  const row = sanitizeRow(buildRow(payload))
  const sheetRef = await getSheetRef()

  if (!sheetRef) {
    console.warn(
      '[job-app-tracker] no sheet connected — open the extension options page and click "Connect Google Sheets". Queuing this row for once it is.',
    )
    await queueRow(row)
    return
  }

  try {
    await googleSheetsProvider.appendRow(sheetRef, row)
    console.log('[job-app-tracker] row written to sheet:', row)
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

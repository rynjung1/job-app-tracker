// Background service worker.
// Owns OAuth tokens and spreadsheet API calls (see CLAUDE.md — Trust boundary).
// Content scripts and other components must never write to a spreadsheet directly.

const TRUSTED_ORIGINS = ['https://www.linkedin.com']

chrome.runtime.onInstalled.addListener(() => {
  console.log('[job-app-tracker] background service worker installed')
})

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!sender.origin || !TRUSTED_ORIGINS.includes(sender.origin)) {
    console.warn('[job-app-tracker] rejected message from unverified origin', sender.origin)
    return false
  }

  if (message?.type === 'JOB_APPLICATION_LOGGED') {
    // SpreadsheetProvider isn't implemented yet (Phase 3) — just prove the
    // trust boundary and message path work end-to-end for now.
    console.log('[job-app-tracker] application logged (not yet written to a sheet):', message.payload)
  }

  return false
})

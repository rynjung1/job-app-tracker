// Background service worker.
// Owns OAuth tokens and spreadsheet API calls (see CLAUDE.md — Trust boundary).
// Content scripts and other components must never write to a spreadsheet directly.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[job-app-tracker] background service worker installed')
})

chrome.runtime.onMessage.addListener((message, sender) => {
  console.log('[job-app-tracker] received message', message, 'from', sender)
  return false
})

// Switch-day health check (web-store-deploy skill, steps 3 and 6). Paste
// this into the extension's service-worker console: chrome://extensions >
// Job Application Tracker > "service worker". Read-only: it only reads
// storage, the toolbar badge and the retry alarm, and changes nothing. It
// prints the spreadsheet id but no application data.
;(async () => {
  const stored = await chrome.storage.local.get(['sheetRef', 'offlineQueue', 'authStatus', 'recentApplications'])
  const queued = Array.isArray(stored.offlineQueue) ? stored.offlineQueue.length : 0
  const report = {
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    spreadsheetId: stored.sheetRef?.spreadsheetId ?? null,
    offlineQueue: queued,
    authStatus: stored.authStatus ? { since: stored.authStatus.since, reason: stored.authStatus.reason } : 'no sign-in flag',
    recentApplications: Array.isArray(stored.recentApplications) ? stored.recentApplications.length : 0,
    badgeText: await chrome.action.getBadgeText({}),
    retryAlarm: (await chrome.alarms.get('retryOfflineQueue')) ? 'present' : 'MISSING',
  }
  console.log(JSON.stringify(report, null, 2))
  console.log(
    queued === 0
      ? 'VERDICT: safe to switch (the offline queue is empty).'
      : `VERDICT: NOT safe to switch: ${queued} queued application(s) would be stranded on this extension ID. Reconnect, or wait for the 5-minute retry, then run this again.`,
  )
})()

import { useEffect, useState } from 'react'
import { getAuthStatus, getQueuedCount } from '../lib/authStatus'
import type { AuthStatus } from '../lib/authStatus'
import { getSheetStatus } from '../lib/sheetStatus'
import type { SheetStatus } from '../lib/sheetStatus'
import { AUTH_STATUS_KEY, OFFLINE_QUEUE_KEY, SHEET_STATUS_KEY } from '../lib/storageKeys'

// The "sign-in needed" flag, the "sheet in the trash or deleted" flag
// (2026-09-14) and the number of queued applications, kept current while the
// page is open: the popup's own live read and trash check can set a flag,
// and a Reconnect, a restore or a new sheet clears it and empties the queue.
export function useSyncStatus(): { authStatus: AuthStatus | undefined; sheetStatus: SheetStatus | undefined; queued: number } {
  const [authStatus, setAuthStatus] = useState<AuthStatus | undefined>()
  const [sheetStatus, setSheetStatus] = useState<SheetStatus | undefined>()
  const [queued, setQueued] = useState(0)

  useEffect(() => {
    const refresh = () => {
      getAuthStatus().then(setAuthStatus)
      getSheetStatus().then(setSheetStatus)
      getQueuedCount().then(setQueued)
    }
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && (AUTH_STATUS_KEY in changes || SHEET_STATUS_KEY in changes || OFFLINE_QUEUE_KEY in changes)) {
        refresh()
      }
    }
    refresh()
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  return { authStatus, sheetStatus, queued }
}

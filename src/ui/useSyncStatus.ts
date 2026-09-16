import { useEffect, useState } from 'react'
import { getAuthStatus } from '../lib/authStatus'
import type { AuthStatus } from '../lib/authStatus'
import { getSheetStatus } from '../lib/sheetStatus'
import type { SheetStatus } from '../lib/sheetStatus'
import { AUTH_STATUS_KEY, OFFLINE_QUEUE_KEY, SHEET_STATUS_KEY } from '../lib/storageKeys'

// The "sign-in needed" flag, the "sheet in the trash or deleted" flag
// (2026-09-14) and the queued applications, kept current while the page is
// open: the popup's own live read and trash check can set a flag, and a
// Reconnect, a restore or a new sheet clears it and empties the queue. The
// popup lists the queued rows themselves as waiting applications
// (2026-09-15); Settings only needs their count.
export function useSyncStatus(): {
  authStatus: AuthStatus | undefined
  sheetStatus: SheetStatus | undefined
  queued: number
  queue: Record<string, string>[]
} {
  const [authStatus, setAuthStatus] = useState<AuthStatus | undefined>()
  const [sheetStatus, setSheetStatus] = useState<SheetStatus | undefined>()
  const [queue, setQueue] = useState<Record<string, string>[]>([])

  useEffect(() => {
    const refresh = () => {
      getAuthStatus().then(setAuthStatus)
      getSheetStatus().then(setSheetStatus)
      chrome.storage.local
        .get(OFFLINE_QUEUE_KEY)
        .then((stored) => setQueue((stored[OFFLINE_QUEUE_KEY] as Record<string, string>[] | undefined) ?? []))
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

  return { authStatus, sheetStatus, queued: queue.length, queue }
}

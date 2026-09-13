import { useEffect, useState } from 'react'
import { getAuthStatus, getQueuedCount } from '../lib/authStatus'
import type { AuthStatus } from '../lib/authStatus'
import { AUTH_STATUS_KEY, OFFLINE_QUEUE_KEY } from '../lib/storageKeys'

// The "sign-in needed" flag and the number of queued applications, kept
// current while the page is open: the popup's own live read can set the
// flag, and a Reconnect clears it and empties the queue.
export function useSyncStatus(): { authStatus: AuthStatus | undefined; queued: number } {
  const [authStatus, setAuthStatus] = useState<AuthStatus | undefined>()
  const [queued, setQueued] = useState(0)

  useEffect(() => {
    const refresh = () => {
      getAuthStatus().then(setAuthStatus)
      getQueuedCount().then(setQueued)
    }
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && (AUTH_STATUS_KEY in changes || OFFLINE_QUEUE_KEY in changes)) refresh()
    }
    refresh()
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  return { authStatus, queued }
}

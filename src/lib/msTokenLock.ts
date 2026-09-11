// Dedicated mutex for MS_TOKEN_KEY only — deliberately not a reuse of
// lib/storageLock.ts's shared lock. That lock's own design comment
// justifies one shared lock across OFFLINE_QUEUE_KEY/
// RECENT_APPLICATIONS_KEY specifically because those operations are fast
// (a few ms of storage I/O). Excel token refresh is a real network round
// trip — up to FETCH_TIMEOUT_MS (30s) in a slow case — and sharing the
// existing lock would mean a slow Excel refresh could stall an unrelated,
// fast queueRow/addRecentApplication call for no reason. Same
// promise-chaining shape as storageLock.ts otherwise, and safe across
// service worker suspension for the same reason: a killed worker's
// in-flight chain dies with whatever was genuinely in flight anyway, and
// a fresh worker starts with a clean, already-resolved tail.
let tail: Promise<void> = Promise.resolve()

export function withMsTokenLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = tail.then(fn)
  // Always advance to a fulfilled tail regardless of this call's own
  // outcome — otherwise one failed refresh (a real invalid_grant, say)
  // would permanently jam every later caller behind a rejected promise
  // .then(fn) would never run past. Same reasoning as storageLock.ts.
  tail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

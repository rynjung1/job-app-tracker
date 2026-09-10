// Minimal in-memory promise-chaining mutex serializing chrome.storage.local
// read-modify-write sequences in the background service worker. Confirmed
// chrome.storage has no compare-and-swap/transaction primitive of any kind
// (checked the real API reference — get/set/remove/clear/getBytesInUse/
// getKeys/setAccessLevel, nothing conditional) before writing this.
//
// Shared across every read-modify-write call site regardless of which
// storage key it touches — one lock, not one per key. These operations are
// rare (a user applying to jobs) and fast (a few ms of storage I/O), so the
// contention cost of over-serializing unrelated keys is negligible next to
// the simplicity of a single lock.
//
// Safe across service worker suspension: if Chrome kills the worker,
// whatever was mid-chain dies with it, but so does any operation that was
// genuinely in flight — a fresh worker instance starts with a fresh,
// already-resolved tail and there's nothing left over to conflict with.
let tail: Promise<void> = Promise.resolve()

export function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = tail.then(fn)
  // Always advance to a fulfilled tail regardless of this call's own
  // outcome — otherwise one failed operation permanently jams every later
  // caller behind a rejected promise .then(fn) would never run past.
  tail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

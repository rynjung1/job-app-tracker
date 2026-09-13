import type { JobPostingData } from '../parsers/types'
import { PENDING_APPLICATIONS_KEY } from './storageKeys'
import { withStorageLock } from './storageLock'

// Two-phase logging, for sites whose Submit click can fail validation and
// stay on the form (Greenhouse — see CLAUDE.md, Logging behavior): the click
// records the job here, and the site's confirmation page takes it back out
// so the background can log it. chrome.storage.session: in memory, survives
// the service worker being suspended between the click and the confirmation
// page load, cleared when the browser closes, and not readable by content
// scripts (TRUSTED_CONTEXTS is its default access level).
//
// Both functions run inside withStorageLock, so a confirmation's
// read-and-delete can never interleave with a pending write still in flight.
// Callers log only after takePendingApplication has returned, outside the
// lock: logging calls queueRow, which takes the same lock, and this
// promise-chain lock isn't re-entrant.
export const PENDING_WINDOW_MS = 30 * 60 * 1000

interface PendingApplication {
  payload: JobPostingData
  at: number
}

type PendingMap = Record<string, PendingApplication>

async function readPending(): Promise<PendingMap> {
  const stored = await chrome.storage.session.get(PENDING_APPLICATIONS_KEY)
  return (stored[PENDING_APPLICATIONS_KEY] as PendingMap | undefined) ?? {}
}

function withoutExpired(map: PendingMap, now: number): PendingMap {
  return Object.fromEntries(Object.entries(map).filter(([, entry]) => now - entry.at <= PENDING_WINDOW_MS))
}

// A later Submit click for the same application replaces the earlier one, so
// a failed attempt followed by a successful one logs once, with the data from
// the final click.
export function recordPendingApplication(key: string, payload: JobPostingData): Promise<void> {
  return withStorageLock(async () => {
    const now = Date.now()
    const map = withoutExpired(await readPending(), now)
    map[key] = { payload, at: now }
    await chrome.storage.session.set({ [PENDING_APPLICATIONS_KEY]: map })
  })
}

// Deletes the entry before returning it, so two loads of the same
// confirmation page can't both log it. Null if nothing is pending for the key
// or it's older than the window.
export function takePendingApplication(key: string): Promise<JobPostingData | null> {
  return withStorageLock(async () => {
    const now = Date.now()
    const map = await readPending()
    const entry = map[key]
    const kept = withoutExpired(map, now)
    delete kept[key]
    await chrome.storage.session.set({ [PENDING_APPLICATIONS_KEY]: kept })
    return entry && now - entry.at <= PENDING_WINDOW_MS ? entry.payload : null
  })
}

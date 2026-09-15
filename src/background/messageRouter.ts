// Central RPC handler for privileged actions requested by extension pages
// (popup, options) — see CLAUDE.md's Trust boundary section. Every
// SpreadsheetProvider call that used to happen inside popup/App.tsx's or
// options/App.tsx's own document now happens here instead, so the
// background worker is the only realm that ever calls a provider, and the
// in-memory locks in lib/ (storageLock, sheetAppendLock) cover every caller.
//
// Dispatched from background/index.ts's onMessage listener via a second,
// narrower branch — sender.origin === this extension's own
// chrome-extension://<id> origin — checked separately from the job-site
// TRUSTED_ORIGINS check used for content-script messages. Deliberately
// not sender.tab or sender.id: both were tried and found to not actually
// test "this is an extension page, not a content script" (confirmed live
// against a real Chrome instance — see background/index.ts's onMessage
// listener for the full reasoning and evidence).

import { getActiveProvider } from '../providers/activeProvider'
import type { SheetRef } from '../providers/types'
import { SHEET_TEMPLATE_COLUMNS } from '../lib/sheetTemplate'
import { getSheetRef, setSheetRef } from '../lib/sheetRef'
import { getRecentApplications, rowStillMatches, setApplicationStatus, updateRecentApplication } from '../lib/recentApplications'
import { isStatusValue } from '../lib/sheetTemplate'
import type { StatusValue } from '../lib/sheetTemplate'
import { AuthRequiredError, SheetMissingError } from '../providers/types'
import { clearSheetProblem, getSheetStatus } from '../lib/sheetStatus'
import { clearRecentApplications } from '../lib/recentApplications'
import { checkSheetInTrash, sheetHealth } from './sheetHealth'
import type { RecentApplication } from '../lib/recentApplications'
import { setLastResumeVersion } from '../lib/resumeVersion'
import { LIVE_STATUS_COLUMNS, matchLiveStatuses } from '../lib/liveStatuses'
import { openSettingsWindow } from './settingsWindow'
import { drainOfflineQueue, getOfflineQueue } from './offlineQueue'

export type BackgroundRequest =
  | { type: 'CONNECT_PROVIDER' }
  | { type: 'RECONNECT_PROVIDER' }
  | {
      type: 'SAVE_RESUME_VERSION'
      payload: { entryId: string; resumeVersion: string; skipIdentityCheck: boolean }
    }
  | { type: 'SET_STATUS'; payload: { entryId: string; status: StatusValue } }
  | { type: 'GET_LIVE_STATUSES' }
  | { type: 'CREATE_NEW_SHEET' }
  | { type: 'OPEN_SETTINGS'; payload?: { reconnect?: boolean } }

// RECONNECT_PROVIDER's result: rows the immediate drain saved, and rows
// still queued after it (Settings shows both).
export interface ReconnectResult {
  saved: number
  waiting: number
}

// CONNECT_PROVIDER's result: the new sheet, plus the same drain counts.
export interface ConnectResult extends ReconnectResult {
  sheetRef: SheetRef
}

// `code` distinguishes the one error case a caller needs to react to
// differently (a stale rowNumber — popup shows a specific message and
// does not retry) from every other failure (network, auth, etc.), which
// all render the same generic message. The exact user-facing wording for
// STALE_ROW stays in popup/App.tsx (it differs between Edit and Undo) —
// this file only reports which case happened, not how to phrase it.
//
// AUTH_REQUIRED (2026-09-13): the call failed because Google sign-in is
// needed (AuthRequiredError); the popup says so instead of the generic
// message, and the "needs reconnect" flag is already set by then.
export type BackgroundResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: 'STALE_ROW' | 'AUTH_REQUIRED' | 'SHEET_UNAVAILABLE' | 'SHEET_HEALTHY' }

// SHEET_UNAVAILABLE (2026-09-14): the sheet is in Drive's trash or deleted
// (lib/sheetStatus.ts), so the change wasn't written. SHEET_HEALTHY: "Create
// a new sheet" refused because the connected one is reachable and not
// trashed.
const SHEET_UNAVAILABLE_ERROR = "Your sheet is in Google Drive's trash or was deleted, so nothing was written"

const INTERNAL_MESSAGE_TYPES = [
  'CONNECT_PROVIDER',
  'RECONNECT_PROVIDER',
  'SAVE_RESUME_VERSION',
  'SET_STATUS',
  'GET_LIVE_STATUSES',
  'OPEN_SETTINGS',
  'CREATE_NEW_SHEET',
] as const

export function isInternalMessage(message: unknown): message is BackgroundRequest {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (INTERNAL_MESSAGE_TYPES as readonly string[]).includes((message as { type: unknown }).type as string)
  )
}

// The onMessage listener itself must return `true` synchronously to keep
// the channel open for sendResponse — that's the listener's job in
// background/index.ts, not this function's. This just resolves the work
// and calls sendResponse once it's done.
export function handleInternalMessage(
  message: BackgroundRequest,
  sendResponse: (response: BackgroundResponse<unknown>) => void,
): void {
  dispatch(message).then(sendResponse)
}

async function dispatch(message: BackgroundRequest): Promise<BackgroundResponse<unknown>> {
  try {
    switch (message.type) {
      case 'CONNECT_PROVIDER':
        return await handleConnectProvider()
      case 'RECONNECT_PROVIDER':
        return await handleReconnectProvider()
      case 'SAVE_RESUME_VERSION':
        return await handleSaveResumeVersion(message.payload)
      case 'SET_STATUS':
        return await handleSetStatus(message.payload)
      case 'GET_LIVE_STATUSES':
        return await handleGetLiveStatuses()
      case 'CREATE_NEW_SHEET':
        return await handleCreateNewSheet()
      case 'OPEN_SETTINGS':
        await openSettingsWindow({ reconnect: message.payload?.reconnect === true })
        return { ok: true, data: undefined }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    if (err instanceof AuthRequiredError) return { ok: false, error, code: 'AUTH_REQUIRED' }
    if (err instanceof SheetMissingError) return { ok: false, error, code: 'SHEET_UNAVAILABLE' }
    return { ok: false, error }
  }
}

// One sheet per extension, however Connect is clicked (2026-09-14). The
// Settings page swaps Connect for a disabled "Connecting…" button while it
// runs, so one page can't send two; but two pages can (the Settings window
// and the options tab from chrome://extensions), and a page opened before a
// Connect keeps showing Connect afterwards. Each of those used to create a
// sheet and swap it in, leaving the earlier one orphaned. Now Connects that
// overlap share one run, and a Connect with a sheet already connected signs
// in and keeps that sheet.
let connectInFlight: Promise<BackgroundResponse<ConnectResult>> | null = null

// Connect and "Create a new sheet" never interleave: each waits for the
// other to finish, so the second sees the first's sheet (2026-09-14).
let sheetWork: Promise<unknown> = Promise.resolve()
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = sheetWork.then(work, work)
  sheetWork = run.catch(() => undefined)
  return run
}

function handleConnectProvider(): Promise<BackgroundResponse<ConnectResult>> {
  connectInFlight ??= oneAtATime(connect).finally(() => {
    connectInFlight = null
  })
  return connectInFlight
}

// "Create a new sheet" (2026-09-14, a flagged addition to the internal
// messages): the one path that replaces the connected sheet, and only when
// that sheet is in Drive's trash or deleted; refused (SHEET_HEALTHY) while
// it's reachable and not trashed. Overlapping requests share one run. It
// signs in only non-interactively: signed out, it fails with AUTH_REQUIRED
// and Settings offers Reconnect.
let createInFlight: Promise<BackgroundResponse<ConnectResult>> | null = null

function handleCreateNewSheet(): Promise<BackgroundResponse<ConnectResult>> {
  createInFlight ??= oneAtATime(createNewSheet).finally(() => {
    createInFlight = null
  })
  return createInFlight
}

async function createNewSheet(): Promise<BackgroundResponse<ConnectResult>> {
  const existing = await getSheetRef()
  if (!existing) return { ok: false, error: 'No sheet is connected yet: use Connect.' }
  if ((await sheetHealth(existing)) === 'healthy') {
    return { ok: false, code: 'SHEET_HEALTHY', error: 'Your sheet is still there and not in the trash, so it was kept.' }
  }
  return { ok: true, data: await replaceSheet() }
}

// A new sheet in place of a trashed or deleted one: create it, connect it,
// clear the flag, forget the recent list (its rows are in the old sheet), and
// save the waiting applications into the new one.
async function replaceSheet(): Promise<ConnectResult> {
  const provider = await getActiveProvider()
  const sheetRef = await provider.createSheet([...SHEET_TEMPLATE_COLUMNS])
  await setSheetRef(sheetRef)
  await clearSheetProblem()
  await clearRecentApplications()
  return { sheetRef, ...(await drainAfterSignIn()) }
}

async function connect(): Promise<BackgroundResponse<ConnectResult>> {
  const provider = await getActiveProvider()
  // Interactive — this is one of the few places allowed to trigger a
  // provider's OAuth consent popup, since it's a direct result of the
  // user clicking Connect on the options page, not something firing
  // mid-apply. Mirrors options/App.tsx's original handleConnect exactly,
  // just relocated.
  await provider.authenticate()
  const existing = await getSheetRef()
  if (!existing) {
    const created = await provider.createSheet([...SHEET_TEMPLATE_COLUMNS])
    await setSheetRef(created)
    return { ok: true, data: { sheetRef: created, ...(await drainAfterSignIn()) } }
  }
  // A sheet is already connected: kept while it exists, in Drive's trash
  // too (the flag is then set, and Settings offers to restore or replace
  // it); a deleted one is replaced (2026-09-14). Any other failure of the
  // check fails the Connect, and nothing is created.
  if ((await sheetHealth(existing)) === 'missing') return { ok: true, data: await replaceSheet() }
  const sheetRef = existing
  // Save what queued before a sheet was connected (the "Not connected"
  // notification's case) now, not at the next 5-minute alarm, the same way
  // Reconnect does, so Settings can say so.
  return { ok: true, data: { sheetRef, ...(await drainAfterSignIn()) } }
}

async function handleReconnectProvider(): Promise<BackgroundResponse<ReconnectResult>> {
  const provider = await getActiveProvider()
  await provider.authenticate()
  // Keep the existing sheetRef — only the OAuth grant needed refreshing,
  // not the sheet itself. Calling createSheet() here would orphan the
  // current sheet and silently swap in a new one (same reasoning as
  // options/App.tsx's original handleReconnect).
  //
  // Then save what queued while signed out now, not at the next 5-minute
  // alarm, so Settings can say so. If the alarm's drain is already running,
  // this one returns 0 and those rows are saved by that drain instead.
  return { ok: true, data: await drainAfterSignIn() }
}

// The drain after a Connect or Reconnect never fails the message: by then
// the sheet is connected and the user signed in. drainOfflineQueue can
// still throw outside its per-row catch (a storage read or write, the
// recent-list update), and for Connect an error would offer "Try again",
// which creates and swaps in a second sheet: the bug phase B fixed for
// Reconnect. So a throw is logged and counts as saved 0; the rows stay
// queued and the next alarm retries them.
async function drainAfterSignIn(): Promise<ReconnectResult> {
  let saved = 0
  try {
    saved = await drainOfflineQueue()
  } catch (err) {
    console.warn('[job-app-tracker] drain after sign-in failed; queued rows stay for the next retry:', err)
  }
  let waiting = 0
  try {
    waiting = (await getOfflineQueue()).length
  } catch (err) {
    console.warn('[job-app-tracker] could not read the offline queue after sign-in:', err)
  }
  return { saved, waiting }
}

async function findEntryOrThrow(entryId: string): Promise<RecentApplication> {
  const entries = await getRecentApplications()
  const entry = entries.find((e) => e.id === entryId)
  if (!entry) throw new Error(`No recent application found for id ${entryId}`)
  return entry
}

async function requireSheetRefOrThrow(): Promise<SheetRef> {
  const sheetRef = await getSheetRef()
  if (!sheetRef) throw new Error('No spreadsheet connected')
  return sheetRef
}

// The same cap the sheet's scraped fields get (lib/sanitize.ts); the popup's
// input stops at it too.
export const MAX_RESUME_VERSION_LENGTH = 500

async function handleSaveResumeVersion(payload: {
  entryId: unknown
  resumeVersion: unknown
  skipIdentityCheck: unknown
}): Promise<BackgroundResponse<RecentApplication>> {
  // Checked before anything is read or written (2026-09-14), like SET_STATUS.
  if (typeof payload?.resumeVersion !== 'string' || payload.resumeVersion.length > MAX_RESUME_VERSION_LENGTH) {
    return { ok: false, error: `Resume version must be text of at most ${MAX_RESUME_VERSION_LENGTH} characters` }
  }
  if (typeof payload.entryId !== 'string') return { ok: false, error: 'Missing entry id' }
  if (await getSheetStatus()) return { ok: false, code: 'SHEET_UNAVAILABLE', error: SHEET_UNAVAILABLE_ERROR }
  const { entryId, resumeVersion } = payload
  const skipIdentityCheck = payload.skipIdentityCheck === true
  const sheetRef = await requireSheetRefOrThrow()
  const entry = await findEntryOrThrow(entryId)
  const provider = await getActiveProvider()

  // skipIdentityCheck replaces the old isOriginalNotificationEdit closure
  // check that used to live in popup/App.tsx — same one exception (a
  // standalone Edit window opened directly for this exact entry via the
  // notification's Edit button skips the check), now an explicit payload
  // field instead of something background would otherwise have to infer.
  if (!skipIdentityCheck) {
    const row = await provider.readRow(sheetRef, entry.rowNumber)
    if (!rowStillMatches(row, entry)) {
      return { ok: false, code: 'STALE_ROW', error: 'The row no longer matches the cached entry' }
    }
  }

  await provider.updateCell(sheetRef, entry.rowNumber, 'Resume Version', resumeVersion)
  await setLastResumeVersion(entry.title, resumeVersion)
  const updated = await updateRecentApplication(entry.id, { resumeVersion })
  if (!updated) throw new Error('Recent application entry disappeared mid-update')
  return { ok: true, data: updated }
}

// The popup's status menu (added 2026-09-13, a flagged addition to the
// internal messages; it replaces CANCEL_APPLICATION, whose only sender was
// the popup's old Undo button). Same Company/Title identity check as
// SAVE_RESUME_VERSION before writing: a mismatch writes nothing (STALE_ROW).
// The status is checked before anything is read, so an unknown value never
// reaches the sheet.
async function handleSetStatus(payload: { entryId: unknown; status: unknown }): Promise<BackgroundResponse<RecentApplication>> {
  if (!isStatusValue(payload?.status)) return { ok: false, error: `Unknown status: ${String(payload?.status)}` }
  if (typeof payload.entryId !== 'string') return { ok: false, error: 'Missing entry id' }
  if (await getSheetStatus()) return { ok: false, code: 'SHEET_UNAVAILABLE', error: SHEET_UNAVAILABLE_ERROR }
  const sheetRef = await requireSheetRefOrThrow()
  const entry = await findEntryOrThrow(payload.entryId)
  const provider = await getActiveProvider()

  const row = await provider.readRow(sheetRef, entry.rowNumber)
  if (!rowStillMatches(row, entry)) {
    return { ok: false, code: 'STALE_ROW', error: 'The row no longer matches the cached entry' }
  }

  const updated = await setApplicationStatus(provider, sheetRef, entry, payload.status)
  if (!updated) throw new Error('Recent application entry disappeared mid-update')
  return { ok: true, data: updated }
}

// The popup's live status chips: entry id -> the sheet's current Status,
// only for rows that still match (lib/liveStatuses.ts). One batched read,
// never a write, and the cached list isn't updated from it.
async function handleGetLiveStatuses(): Promise<BackgroundResponse<Record<string, string>>> {
  // The popup opening is also when Drive is asked whether the sheet is in
  // the trash (2026-09-14). Not awaited, so the chips don't wait for it.
  checkSheetInTrash()
  const sheetRef = await getSheetRef()
  const entries = await getRecentApplications()
  if (!sheetRef || entries.length === 0) return { ok: true, data: {} }
  const provider = await getActiveProvider()
  const rows = await provider.readCells(
    sheetRef,
    entries.map((entry) => entry.rowNumber),
    LIVE_STATUS_COLUMNS,
  )
  return { ok: true, data: matchLiveStatuses(entries, rows) }
}

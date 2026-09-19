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
import {
  getPreviousSheetRef,
  getSheetRef,
  setSheetRef,
  setSwappedSheetRefs,
  updateStoredSheetTitle,
} from '../lib/sheetRef'
import { duringSheetSwap } from './sheetSwap'
import { datedSheetTitle } from '../lib/sheetTitle'
import { getRecentApplications, setApplicationStatus } from '../lib/recentApplications'
import { isStatusValue } from '../lib/sheetTemplate'
import type { StatusValue } from '../lib/sheetTemplate'
import { AuthRequiredError, SheetMissingError } from '../providers/types'
import { clearSheetProblem, getSheetStatus } from '../lib/sheetStatus'
import { clearRecentApplications } from '../lib/recentApplications'
import { checkSheetInTrash, sheetHealth } from './sheetHealth'
import type { RecentApplication } from '../lib/recentApplications'
import { LIVE_STATUS_COLUMNS, matchLiveStatuses } from '../lib/liveStatuses'
import { openSettingsWindow } from './settingsWindow'
import { drainOfflineQueue, getOfflineQueue } from './offlineQueue'
import { MAX_NOTE_LENGTH, NOTES_COLUMN } from '../lib/notes'

export type BackgroundRequest =
  | { type: 'CONNECT_PROVIDER' }
  | { type: 'RECONNECT_PROVIDER' }
  | { type: 'SET_STATUS'; payload: { entryId: string; status: StatusValue } }
  | { type: 'GET_LIVE_STATUSES' }
  // replaceHealthy (2026-09-17): Settings' "Start a new sheet" for a sheet
  // that's perfectly fine. Absent — every other sender — keeps the
  // SHEET_HEALTHY refusal below, which is what stops a flaky read from
  // swapping out a good sheet.
  | { type: 'CREATE_NEW_SHEET'; payload?: { replaceHealthy?: boolean } }
  | { type: 'SWITCH_TO_PREVIOUS_SHEET' }
  | { type: 'REFRESH_SHEET_TITLE' }
  | { type: 'OPEN_SETTINGS'; payload?: { reconnect?: boolean } }
  | { type: 'GET_NOTE'; payload: { entryId: string } }
  | { type: 'SAVE_NOTE'; payload: { entryId: string; note: string; expected: string } }

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
  | {
      ok: false
      error: string
      code?: 'STALE_ROW' | 'AUTH_REQUIRED' | 'SHEET_UNAVAILABLE' | 'SHEET_HEALTHY' | 'NOTE_CHANGED' | 'PREVIOUS_UNAVAILABLE'
    }

// SHEET_UNAVAILABLE (2026-09-14): the sheet is in Drive's trash or deleted
// (lib/sheetStatus.ts), so the change wasn't written. SHEET_HEALTHY: "Create
// a new sheet" refused because the connected one is reachable and not
// trashed. NOTE_CHANGED (2026-09-15): SAVE_NOTE refused because the Notes
// cell no longer holds what the editor opened with.
const SHEET_UNAVAILABLE_ERROR = "Your sheet is in Google Drive's trash or was deleted, so nothing was written"

const INTERNAL_MESSAGE_TYPES = [
  'CONNECT_PROVIDER',
  'RECONNECT_PROVIDER',
  'SET_STATUS',
  'GET_LIVE_STATUSES',
  'OPEN_SETTINGS',
  'CREATE_NEW_SHEET',
  'GET_NOTE',
  'SAVE_NOTE',
  'SWITCH_TO_PREVIOUS_SHEET',
  'REFRESH_SHEET_TITLE',
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
      case 'SET_STATUS':
        return await handleSetStatus(message.payload)
      case 'GET_LIVE_STATUSES':
        return await handleGetLiveStatuses()
      case 'CREATE_NEW_SHEET':
        return await handleCreateNewSheet(message.payload?.replaceHealthy === true)
      case 'SWITCH_TO_PREVIOUS_SHEET':
        return await handleSwitchToPreviousSheet()
      case 'REFRESH_SHEET_TITLE':
        return await handleRefreshSheetTitle()
      case 'OPEN_SETTINGS':
        await openSettingsWindow({ reconnect: message.payload?.reconnect === true })
        return { ok: true, data: undefined }
      case 'GET_NOTE':
        return await handleGetNote(message.payload)
      case 'SAVE_NOTE':
        return await handleSaveNote(message.payload)
      // A message type this version doesn't know — a page left open across
      // an update, say. Found 2026-09-18 while removing SAVE_RESUME_VERSION:
      // without this the switch fell through, dispatch resolved undefined,
      // sendResponse was never called with anything useful, and the caller
      // waited forever.
      default:
        return { ok: false, error: `Unknown message type: ${String((message as { type?: unknown }).type)}` }
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
//
// The in-flight run is shared only with a request that asked for the same
// thing (audit finding, 2026-09-17): sharing it with any caller meant a
// plain CREATE_NEW_SHEET — which must be refused while the sheet is healthy
// — could be answered with a deliberate swap's brand new sheet. A request
// with the other flag waits its turn through oneAtATime and has the guard
// evaluated again, against whatever sheet is connected by then.
let createInFlight: { replaceHealthy: boolean; run: Promise<BackgroundResponse<ConnectResult>> } | null = null

function handleCreateNewSheet(replaceHealthy: boolean): Promise<BackgroundResponse<ConnectResult>> {
  if (createInFlight?.replaceHealthy === replaceHealthy) return createInFlight.run
  const run = oneAtATime(() => createNewSheet(replaceHealthy)).finally(() => {
    if (createInFlight?.run === run) createInFlight = null
  })
  createInFlight = { replaceHealthy, run }
  return run
}

async function createNewSheet(replaceHealthy: boolean): Promise<BackgroundResponse<ConnectResult>> {
  const existing = await getSheetRef()
  if (!existing) return { ok: false, error: 'No sheet is connected yet: use Connect.' }
  // The guard stays on unless the sender says, in as many words, that it
  // means to replace a healthy sheet (Settings' "Start a new sheet", behind
  // its own confirmation). Every other sender still gets SHEET_HEALTHY.
  if (!replaceHealthy && (await sheetHealth(existing)) === 'healthy') {
    return { ok: false, code: 'SHEET_HEALTHY', error: 'Your sheet is still there and not in the trash, so it was kept.' }
  }
  return { ok: true, data: await replaceSheet(existing) }
}

// A new sheet in place of the connected one — trashed, deleted, or perfectly
// fine and being left behind on purpose. Create it (with the dated name,
// since the old one is still in Drive under the old one), remember the sheet
// we're leaving so Settings can offer a way back, connect the new one, clear
// the flag, forget the recent list (its rows are in the old sheet), and save
// the waiting applications into the new one. The old spreadsheet is never
// touched: nothing here deletes, trashes or writes to it.
async function replaceSheet(previous: SheetRef): Promise<ConnectResult> {
  const provider = await getActiveProvider()
  const sheetRef = await provider.createSheet([...SHEET_TEMPLATE_COLUMNS], datedSheetTitle())
  // Both refs in one write, the new sheet first, and with writers held off
  // while the connected sheet changes under them (2026-09-17, audit).
  await duringSheetSwap(async () => {
    await setSwappedSheetRefs(sheetRef, previous)
    await clearSheetProblem()
    await clearRecentApplications()
  })
  // Outside the guard: these rows are meant for the new sheet.
  return { sheetRef, ...(await drainAfterSignIn()) }
}

// "Switch back to the previous sheet" (2026-09-17): offered in Settings for
// as long as a previous sheet is remembered, since a mistaken swap may only
// be noticed days later. It refuses unless that sheet is reachable and not
// in the trash — a deleted or trashed one can't take rows — and otherwise
// mirrors a swap: the sheet being left becomes the remembered one, the
// recent list is cleared (its rows are in the sheet we're leaving), and the
// queue drains into the sheet we're returning to.
let switchInFlight: Promise<BackgroundResponse<ConnectResult>> | null = null

function handleSwitchToPreviousSheet(): Promise<BackgroundResponse<ConnectResult>> {
  switchInFlight ??= oneAtATime(switchToPreviousSheet).finally(() => {
    switchInFlight = null
  })
  return switchInFlight
}

async function switchToPreviousSheet(): Promise<BackgroundResponse<ConnectResult>> {
  const previous = await getPreviousSheetRef()
  if (!previous) return { ok: false, error: 'No previous sheet is remembered.' }
  const leaving = await getSheetRef()
  // The two refs pointing at one spreadsheet means a half-finished swap was
  // interrupted (audit finding, 2026-09-17). Switching "back" there would
  // clear the recent list to arrive where we already are, so it's refused
  // and the offer is dropped.
  if (leaving && leaving.spreadsheetId === previous.spreadsheetId) {
    return {
      ok: false,
      code: 'PREVIOUS_UNAVAILABLE',
      error: 'The previous sheet is the one you are already connected to.',
    }
  }
  // The previous sheet isn't the connected one, so this check must not
  // touch the connected sheet's trashed/deleted flag.
  const health = await sheetHealth(previous, { connected: false })
  if (health !== 'healthy') {
    return {
      ok: false,
      code: 'PREVIOUS_UNAVAILABLE',
      error:
        health === 'trashed'
          ? "The previous sheet is in Google Drive's trash. Restore it there, then switch back."
          : 'The previous sheet was deleted, so there is nothing to switch back to.',
    }
  }
  await duringSheetSwap(async () => {
    if (leaving) await setSwappedSheetRefs(previous, leaving)
    else await setSheetRef(previous)
    await clearSheetProblem()
    await clearRecentApplications()
  })
  return { ok: true, data: { sheetRef: previous, ...(await drainAfterSignIn()) } }
}

// The spreadsheet's name for Settings' card (2026-09-17): refs stored before
// SheetRef carried one, and a file the user renamed in Drive. Stored only if
// that spreadsheet is still the connected one.
async function handleRefreshSheetTitle(): Promise<BackgroundResponse<SheetRef>> {
  const sheetRef = await requireSheetRefOrThrow()
  const provider = await getActiveProvider()
  const title = await provider.readTitle(sheetRef)
  if (!title || title === sheetRef.title) return { ok: true, data: sheetRef }
  return { ok: true, data: (await updateStoredSheetTitle(sheetRef.spreadsheetId, title)) ?? sheetRef }
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
  if ((await sheetHealth(existing)) === 'missing') return { ok: true, data: await replaceSheet(existing) }
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

// The popup's status menu (added 2026-09-13, a flagged addition to the
// internal messages; it replaces CANCEL_APPLICATION, whose only sender was
// the popup's old Undo button). The row's Company and Title must still
// match the cached entry before anything is written: a mismatch writes
// nothing (STALE_ROW).
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
  if (row.Company !== entry.company || row.Title !== entry.title) {
    return { ok: false, code: 'STALE_ROW', error: 'Row Company/Title no longer match the cached entry' }
  }

  const updated = await setApplicationStatus(provider, sheetRef, entry, payload.status)
  if (!updated) throw new Error('Recent application entry disappeared mid-update')
  return { ok: true, data: updated }
}

// The popup's note editor (2026-09-15, decided by Ryan; two flagged additions
// to the internal messages). GET_NOTE reads the entry's row with the same
// Company/Title identity check as SET_STATUS and returns its Notes cell, to
// prefill the editor. SAVE_NOTE writes the edited note back as an edit of
// that cell, never an append, and only if the cell still holds what the
// editor opened with (`expected`): a note changed in the sheet since then is
// never overwritten (NOTE_CHANGED). Both are refused while the sheet is in
// the trash or deleted; a sign-in failure is AUTH_REQUIRED. Never queued.
// Written RAW like every other cell, so a note starting with = stays text.
async function handleGetNote(payload: { entryId: unknown }): Promise<BackgroundResponse<{ note: string }>> {
  if (typeof payload?.entryId !== 'string') return { ok: false, error: 'Missing entry id' }
  if (await getSheetStatus()) return { ok: false, code: 'SHEET_UNAVAILABLE', error: SHEET_UNAVAILABLE_ERROR }
  const sheetRef = await requireSheetRefOrThrow()
  const entry = await findEntryOrThrow(payload.entryId)
  const provider = await getActiveProvider()
  const row = await provider.readRow(sheetRef, entry.rowNumber)
  if (row.Company !== entry.company || row.Title !== entry.title) {
    return { ok: false, code: 'STALE_ROW', error: 'Row Company/Title no longer match the cached entry' }
  }
  return { ok: true, data: { note: row[NOTES_COLUMN] ?? '' } }
}

async function handleSaveNote(payload: {
  entryId: unknown
  note: unknown
  expected: unknown
}): Promise<BackgroundResponse<{ note: string }>> {
  // Checked before anything is read or written, like SET_STATUS.
  if (typeof payload?.note !== 'string' || payload.note.length > MAX_NOTE_LENGTH) {
    return { ok: false, error: `A note must be text of at most ${MAX_NOTE_LENGTH} characters` }
  }
  if (typeof payload.expected !== 'string') return { ok: false, error: 'Missing the note the editor opened with' }
  if (typeof payload.entryId !== 'string') return { ok: false, error: 'Missing entry id' }
  if (await getSheetStatus()) return { ok: false, code: 'SHEET_UNAVAILABLE', error: SHEET_UNAVAILABLE_ERROR }
  const sheetRef = await requireSheetRefOrThrow()
  const entry = await findEntryOrThrow(payload.entryId)
  const provider = await getActiveProvider()
  const row = await provider.readRow(sheetRef, entry.rowNumber)
  if (row.Company !== entry.company || row.Title !== entry.title) {
    return { ok: false, code: 'STALE_ROW', error: 'Row Company/Title no longer match the cached entry' }
  }
  if ((row[NOTES_COLUMN] ?? '') !== payload.expected) {
    return { ok: false, code: 'NOTE_CHANGED', error: 'The Notes cell changed since the editor opened' }
  }
  await provider.updateCell(sheetRef, entry.rowNumber, NOTES_COLUMN, payload.note)
  return { ok: true, data: { note: payload.note } }
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

// Central RPC handler for privileged actions requested by extension pages
// (popup, options) — see CLAUDE.md's Trust boundary section. Every
// SpreadsheetProvider call that used to happen inside popup/App.tsx's or
// options/App.tsx's own document now happens here instead, closing two
// separate real findings with one change: options/App.tsx previously
// called authenticate()/createSheet() directly from its own realm, and
// msAuth.ts's MS_TOKEN_KEY read-modify-write had no cross-realm locking —
// two independent JS realms (background and any extension page) could
// both refresh the same Excel refresh token concurrently (see
// lib/fetchWithTimeout.ts's CLAUDE.md note for the unrelated re-entrancy
// fix, and the still-open MS_TOKEN_KEY race this change actually closes).
// Collapsing every provider call into this one realm is what makes the
// existing withStorageLock pattern (lib/storageLock.ts) actually
// applicable to MS_TOKEN_KEY — a plain in-memory flag like
// drainOfflineQueue's isDraining would not have been enough, since that
// only works within a single realm and this problem spans two.
//
// Dispatched from background/index.ts's onMessage listener via a second,
// narrower branch — sender.origin === this extension's own
// chrome-extension://<id> origin — checked separately from the job-site
// TRUSTED_ORIGINS check used for content-script messages. Deliberately
// not sender.tab or sender.id: both were tried and found to not actually
// test "this is an extension page, not a content script" (confirmed live
// against a real Chrome instance — see background/index.ts's onMessage
// listener for the full reasoning and evidence).

import type { ProviderId } from '../providers/activeProvider'
import { getActiveProvider, getProvider, setActiveProviderId } from '../providers/activeProvider'
import type { SheetRef } from '../providers/types'
import { SHEET_TEMPLATE_COLUMNS } from '../lib/sheetTemplate'
import { getSheetRef, setSheetRef } from '../lib/sheetRef'
import { cancelApplication, getRecentApplications, updateRecentApplication } from '../lib/recentApplications'
import type { RecentApplication } from '../lib/recentApplications'
import { setLastResumeVersion } from '../lib/resumeVersion'

export type BackgroundRequest =
  | { type: 'CONNECT_PROVIDER'; payload: { providerId: ProviderId } }
  | { type: 'RECONNECT_PROVIDER'; payload: { providerId: ProviderId } }
  | {
      type: 'SAVE_RESUME_VERSION'
      payload: { entryId: string; resumeVersion: string; skipIdentityCheck: boolean }
    }
  | { type: 'CANCEL_APPLICATION'; payload: { entryId: string } }

// `code` distinguishes the one error case a caller needs to react to
// differently (a stale rowNumber — popup shows a specific message and
// does not retry) from every other failure (network, auth, etc.), which
// all render the same generic message. The exact user-facing wording for
// STALE_ROW stays in popup/App.tsx (it differs between Edit and Undo) —
// this file only reports which case happened, not how to phrase it.
export type BackgroundResponse<T> = { ok: true; data: T } | { ok: false; error: string; code?: 'STALE_ROW' }

const INTERNAL_MESSAGE_TYPES = [
  'CONNECT_PROVIDER',
  'RECONNECT_PROVIDER',
  'SAVE_RESUME_VERSION',
  'CANCEL_APPLICATION',
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
        return await handleConnectProvider(message.payload)
      case 'RECONNECT_PROVIDER':
        return await handleReconnectProvider(message.payload)
      case 'SAVE_RESUME_VERSION':
        return await handleSaveResumeVersion(message.payload)
      case 'CANCEL_APPLICATION':
        return await handleCancelApplication(message.payload)
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function handleConnectProvider({
  providerId,
}: {
  providerId: ProviderId
}): Promise<BackgroundResponse<SheetRef>> {
  const provider = getProvider(providerId)
  // Interactive — this is one of the few places allowed to trigger a
  // provider's OAuth consent popup, since it's a direct result of the
  // user clicking Connect on the options page, not something firing
  // mid-apply. Mirrors options/App.tsx's original handleConnect exactly,
  // just relocated.
  await provider.authenticate()
  const sheetRef = await provider.createSheet([...SHEET_TEMPLATE_COLUMNS])
  await setSheetRef(sheetRef)
  await setActiveProviderId(providerId)
  return { ok: true, data: sheetRef }
}

async function handleReconnectProvider({
  providerId,
}: {
  providerId: ProviderId
}): Promise<BackgroundResponse<undefined>> {
  const provider = getProvider(providerId)
  await provider.authenticate()
  // Keep the existing sheetRef — only the OAuth grant needed refreshing,
  // not the sheet itself. Calling createSheet() here would orphan the
  // current sheet and silently swap in a new one (same reasoning as
  // options/App.tsx's original handleReconnect).
  return { ok: true, data: undefined }
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

async function handleSaveResumeVersion({
  entryId,
  resumeVersion,
  skipIdentityCheck,
}: {
  entryId: string
  resumeVersion: string
  skipIdentityCheck: boolean
}): Promise<BackgroundResponse<RecentApplication>> {
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
    if (row.Company !== entry.company || row.Title !== entry.title) {
      return { ok: false, code: 'STALE_ROW', error: 'Row Company/Title no longer match the cached entry' }
    }
  }

  await provider.updateCell(sheetRef, entry.rowNumber, 'Resume Version', resumeVersion)
  await setLastResumeVersion(entry.title, resumeVersion)
  const updated = await updateRecentApplication(entry.id, { resumeVersion })
  if (!updated) throw new Error('Recent application entry disappeared mid-update')
  return { ok: true, data: updated }
}

async function handleCancelApplication({
  entryId,
}: {
  entryId: string
}): Promise<BackgroundResponse<RecentApplication>> {
  const sheetRef = await requireSheetRefOrThrow()
  const entry = await findEntryOrThrow(entryId)
  const provider = await getActiveProvider()

  const row = await provider.readRow(sheetRef, entry.rowNumber)
  if (row.Company !== entry.company || row.Title !== entry.title) {
    return { ok: false, code: 'STALE_ROW', error: 'Row Company/Title no longer match the cached entry' }
  }

  await cancelApplication(provider, sheetRef, entry)
  return { ok: true, data: { ...entry, status: 'Cancelled' } }
}

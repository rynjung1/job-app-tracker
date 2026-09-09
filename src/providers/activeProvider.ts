import { googleSheetsProvider } from './googleSheets'
import { excelProvider } from './excel'
import type { SpreadsheetProvider } from './types'
import { ACTIVE_PROVIDER_KEY } from '../lib/storageKeys'

export type ProviderId = 'google' | 'excel'

const PROVIDERS: Record<ProviderId, SpreadsheetProvider> = {
  google: googleSheetsProvider,
  excel: excelProvider,
}

// Synchronous — for call sites that already know which provider they mean
// (the options page's own connect buttons, right after the user picked one).
export function getProvider(id: ProviderId): SpreadsheetProvider {
  return PROVIDERS[id]
}

// Defaults to 'google' when unset — every sheetRef stored before this
// preference existed was written by GoogleSheetsProvider, so an existing
// install with no ACTIVE_PROVIDER_KEY yet must keep resolving to it.
export async function getActiveProviderId(): Promise<ProviderId> {
  const stored = await chrome.storage.local.get(ACTIVE_PROVIDER_KEY)
  return (stored[ACTIVE_PROVIDER_KEY] as ProviderId | undefined) ?? 'google'
}

export async function getActiveProvider(): Promise<SpreadsheetProvider> {
  return getProvider(await getActiveProviderId())
}

export async function setActiveProviderId(id: ProviderId): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_PROVIDER_KEY]: id })
}

import { RECENT_APPLICATIONS_KEY } from './storageKeys'

// Named in CLAUDE.md's Tech Stack section ("chrome.storage.local for ...
// the cached recent-applications list") but not built until Phase 4, when
// Edit actually needed somewhere to render a just-logged entry.
export interface RecentApplication {
  id: string
  title: string
  company: string
  location: string | null
  url: string
  date: string
  resumeVersion: string
  status: string
  sheetName: string
  rowNumber: number
}

const MAX_RECENT = 20

export async function getRecentApplications(): Promise<RecentApplication[]> {
  const stored = await chrome.storage.local.get(RECENT_APPLICATIONS_KEY)
  return (stored[RECENT_APPLICATIONS_KEY] as RecentApplication[] | undefined) ?? []
}

export async function addRecentApplication(entry: RecentApplication): Promise<void> {
  const list = await getRecentApplications()
  list.unshift(entry)
  await chrome.storage.local.set({ [RECENT_APPLICATIONS_KEY]: list.slice(0, MAX_RECENT) })
}

export async function updateRecentApplication(
  id: string,
  patch: Partial<RecentApplication>,
): Promise<RecentApplication | undefined> {
  const list = await getRecentApplications()
  const index = list.findIndex((entry) => entry.id === id)
  if (index === -1) return undefined
  list[index] = { ...list[index], ...patch }
  await chrome.storage.local.set({ [RECENT_APPLICATIONS_KEY]: list })
  return list[index]
}

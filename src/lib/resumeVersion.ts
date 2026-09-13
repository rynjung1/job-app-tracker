import { inferRoleType } from './roleType'
import { LAST_RESUME_VERSION_KEY } from './storageKeys'
import { withStorageLock } from './storageLock'

type ResumeVersionsByRoleType = Partial<Record<'SWE' | 'DE', string>>

async function getStoredVersions(): Promise<ResumeVersionsByRoleType> {
  const stored = await chrome.storage.local.get(LAST_RESUME_VERSION_KEY)
  return (stored[LAST_RESUME_VERSION_KEY] as ResumeVersionsByRoleType | undefined) ?? {}
}

// "defaults to whichever version was last used for that role type" per
// CLAUDE.md — stateful, not a static keyword->resume-name table. Unmatched
// role types and never-yet-used ones both default to empty string.
export async function getDefaultResumeVersion(title: string): Promise<string> {
  const roleType = inferRoleType(title)
  if (roleType === 'unknown') return ''
  const versions = await getStoredVersions()
  return versions[roleType] ?? ''
}

// Locked, like every other chrome.storage read-modify-write (see
// lib/storageLock.ts): two Edit saves at once (the popup and a
// notification's Edit window) could otherwise each read the old map and
// the later write drop the other's role type. Its only caller,
// handleSaveResumeVersion (background/messageRouter.ts), calls it outside
// any lock, so this can't wait on itself.
export async function setLastResumeVersion(title: string, resumeVersion: string): Promise<void> {
  const roleType = inferRoleType(title)
  if (roleType === 'unknown') return
  await withStorageLock(async () => {
    const versions = await getStoredVersions()
    versions[roleType] = resumeVersion
    await chrome.storage.local.set({ [LAST_RESUME_VERSION_KEY]: versions })
  })
}

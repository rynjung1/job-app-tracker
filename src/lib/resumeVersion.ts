import { inferRoleType } from './roleType'
import { LAST_RESUME_VERSION_KEY } from './storageKeys'

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

export async function setLastResumeVersion(title: string, resumeVersion: string): Promise<void> {
  const roleType = inferRoleType(title)
  if (roleType === 'unknown') return
  const versions = await getStoredVersions()
  versions[roleType] = resumeVersion
  await chrome.storage.local.set({ [LAST_RESUME_VERSION_KEY]: versions })
}

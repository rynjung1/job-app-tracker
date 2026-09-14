import type { JobPostingData } from '../parsers/types'

// Checks what a content script sent before the background uses it
// (2026-09-14, CLAUDE.md, Security). The sender's origin is already
// verified, but the payload is still data from a web page's realm: title,
// company and url must be non-empty strings, location a string or null, each
// within a length cap, and url an https address. Anything else is rejected,
// not repaired. Only the four known fields are kept.
export const MAX_JOB_FIELD_LENGTH = 500
export const MAX_JOB_URL_LENGTH = 2048

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max
}

export function parseJobPostingData(value: unknown): JobPostingData | null {
  if (typeof value !== 'object' || value === null) return null
  const { title, company, location, url } = value as Record<string, unknown>
  if (!isText(title, MAX_JOB_FIELD_LENGTH) || !isText(company, MAX_JOB_FIELD_LENGTH)) return null
  if (!isText(url, MAX_JOB_URL_LENGTH) || !url.startsWith('https://')) return null
  if (location !== null && (typeof location !== 'string' || location.length > MAX_JOB_FIELD_LENGTH)) return null
  return { title, company, location, url }
}

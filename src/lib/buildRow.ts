import type { JobPostingData } from '../parsers/types'

// Status, Notes are intentionally blank — manual fields by design
// (CLAUDE.md "Status field"). Resume Version is passed in rather than
// computed here — see lib/resumeVersion.ts for the role-type-keyed
// last-used lookup (CLAUDE.md Phase 4); kept out of this function so
// buildRow stays a pure sync mapping, no storage access.
export function buildRow(data: JobPostingData, resumeVersion: string): Record<string, string> {
  return {
    Date: new Date().toISOString(),
    Company: data.company,
    Title: data.title,
    Location: data.location ?? '',
    URL: data.url,
    'Resume Version': resumeVersion,
    Status: '',
    Notes: '',
  }
}

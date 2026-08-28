import type { JobPostingData } from '../parsers/types'

// Resume Version, Status, Notes are intentionally blank here:
// - Resume Version: inference isn't built yet (CLAUDE.md assigns this to
//   Phase 4's popup toast — "defaults to whichever version was last used
//   for that role type, inferred from job title keywords"). Known gap, not
//   a bug.
// - Status, Notes: manual fields by design (CLAUDE.md "Status field").
export function buildRow(data: JobPostingData): Record<string, string> {
  return {
    Date: new Date().toISOString(),
    Company: data.company,
    Title: data.title,
    Location: data.location ?? '',
    URL: data.url,
    'Resume Version': '',
    Status: '',
    Notes: '',
  }
}

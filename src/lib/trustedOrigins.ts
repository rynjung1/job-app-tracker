// The job-site origins whose content-script messages the background accepts
// (CLAUDE.md, Trust boundary). LinkedIn, Greenhouse, and Lever's and
// Ashby's hosts are exact origins — never a suffix match, so a lookalike
// like evil-jobs.lever.co or jobs.lever.co.evil.example is refused.
// Workday (2026-09-14) is any tenant under the two career-site domains the
// manifest matches, https only, no port; lookalikes such as
// evil-myworkdayjobs.com, myworkdayjobs.com.example.com, or Workday's
// employee app *.myworkday.com are refused.
const EXACT_ORIGINS = [
  'https://www.linkedin.com',
  'https://job-boards.greenhouse.io',
  'https://jobs.lever.co',
  'https://jobs.eu.lever.co',
  'https://jobs.ashbyhq.com',
]
const WORKDAY_ORIGIN = /^https:\/\/(?:[a-z0-9-]+\.)+(?:myworkdayjobs|myworkdaysite)\.com$/

export function isTrustedJobSiteOrigin(origin: string | undefined): origin is string {
  if (!origin) return false
  return EXACT_ORIGINS.includes(origin) || WORKDAY_ORIGIN.test(origin)
}

// The job-site origins whose content-script messages the background accepts
// (CLAUDE.md, Trust boundary). LinkedIn and Greenhouse are exact origins.
// Workday (2026-09-14) is any tenant under the two career-site domains the
// manifest matches, https only, no port; lookalikes such as
// evil-myworkdayjobs.com, myworkdayjobs.com.example.com, or Workday's
// employee app *.myworkday.com are refused.
const EXACT_ORIGINS = ['https://www.linkedin.com', 'https://job-boards.greenhouse.io']
const WORKDAY_ORIGIN = /^https:\/\/(?:[a-z0-9-]+\.)+(?:myworkdayjobs|myworkdaysite)\.com$/

export function isTrustedJobSiteOrigin(origin: string | undefined): origin is string {
  if (!origin) return false
  return EXACT_ORIGINS.includes(origin) || WORKDAY_ORIGIN.test(origin)
}

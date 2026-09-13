export interface JobPostingData {
  title: string
  company: string
  location: string | null
  url: string
}

// Where the current page sits in one application's flow, for sites that log
// only after a confirmed submission (two-phase logging).
export interface ApplicationState {
  // Identifies the application on both its form page and its confirmation page.
  key: string
  onConfirmationPage: boolean
}

export interface JobPageParser {
  siteId: string
  detect(): boolean
  extract(): JobPostingData | null
  getApplyButtonSelector(): string
  // Optional (added 2026-09-12). Sites that implement it log on the site's
  // confirmation page instead of at the Apply click; null means the current
  // page isn't part of an application flow. See lib/pendingApplications.ts.
  applicationState?(): ApplicationState | null
}

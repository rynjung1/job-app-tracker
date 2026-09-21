import type { JobPageParser, JobPostingData } from './types'

// Workday career sites (added 2026-09-14 on the workday branch; CLAUDE.md,
// Site parsers, Workday). Checked read-only on public postings of 12 tenants:
//   https://{tenant}.wdN.myworkdayjobs.com/[xx-XX/]{site}/job/{location}/{slug}_{reqId}
//   https://wdN.myworkdaysite.com/[xx-XX/]recruiting/{tenant}/{site}/job/{location}/{slug}_{reqId}
// The application flow keeps the job path and adds routes after it (/apply,
// /apply/applyManually, /apply/autofillWithResume, /apply/useMyLastApplication),
// all served by the same single-page app. Never *.myworkday.com: that's
// Workday's employee HR app, not a career site.
const WORKDAY_HOST = /^(?:[a-z0-9-]+\.)+(myworkdayjobs|myworkdaysite)\.com$/i
const LOCALE_SEGMENT = /^[a-z]{2}(?:-[A-Z]{2})?$/

export interface WorkdayJob {
  // The Company column: the tenant id from the address, as is ("nvidia",
  // "bmo", "wf"). Decided 2026-09-14: no page element or field names the
  // company reliably (the JSON's hiringOrganization is a legal entity like
  // "2100 NVIDIA USA", empty for some tenants).
  tenant: string
  // The row's URL and the 24-hour repeat key: no locale, query, hash, or
  // anything after the {slug}_{reqId} segment. Equal to the job JSON's
  // externalUrl on every tenant checked.
  normalizedUrl: string
  // The public job JSON behind the career site, on the same origin.
  jobJsonUrl: string
}

export function parseWorkdayJobUrl(href: string): WorkdayJob | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const host = url.hostname.match(WORKDAY_HOST)
  if (!host) return null
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] && LOCALE_SEGMENT.test(segments[0])) segments.shift()

  let tenant: string
  let sitePath: string[]
  if (host[1].toLowerCase() === 'myworkdaysite') {
    if (segments[0] !== 'recruiting' || segments.length < 3) return null
    tenant = segments[1]
    sitePath = segments.splice(0, 3)
  } else {
    tenant = url.hostname.split('.')[0]
    sitePath = segments.splice(0, 1)
  }
  const site = sitePath[sitePath.length - 1]
  if (!site || segments[0] !== 'job') return null

  // The job segment is the first one holding an underscore ({slug}_{reqId};
  // a reqId can hold one too, e.g. TD's "_R_1468577-1"). At most one
  // location segment comes before it; the apply routes come after it.
  const afterJob = segments.slice(1)
  const jobIndex = afterJob.findIndex((segment) => segment.includes('_'))
  if (jobIndex === -1 || jobIndex > 1) return null
  const jobPath = afterJob.slice(0, jobIndex + 1)

  return {
    tenant,
    normalizedUrl: `${url.origin}/${[...sitePath, 'job', ...jobPath].join('/')}`,
    jobJsonUrl: `${url.origin}/wday/cxs/${tenant}/${site}/job/${jobPath.join('/')}`,
  }
}

// What the content script keeps from a posting until the final Submit.
export interface WorkdayCapture {
  posting: JobPostingData
  // Kept with the capture, not logged: the sheet has no column for it.
  reqId: string | null
}

const collapsed = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

// The posting page, read when the user clicks its Apply control. Same
// automation ids on all 7 tenants rendered: the title in
// h2[data-automation-id="jobPostingHeader"], the locations and requisition id
// as <dd>s. The first location is the posting's primary one (the job JSON's
// `location`); a multi-location posting lists more. Null off a posting page.
export function captureFromPostingDom(root: ParentNode, href: string): WorkdayCapture | null {
  const job = parseWorkdayJobUrl(href)
  if (!job) return null
  const title = collapsed(root.querySelector('[data-automation-id="jobPostingHeader"]'))
  if (!title) return null
  return {
    posting: {
      title,
      company: job.tenant,
      location: collapsed(root.querySelector('[data-automation-id="locations"] dd')) || null,
      url: job.normalizedUrl,
    },
    reqId: collapsed(root.querySelector('[data-automation-id="requisitionId"] dd')) || null,
  }
}

// The fallback at the final Submit when no capture exists: the same-origin
// job JSON (jobPostingInfo.title, .location, .jobReqId).
export function captureFromJobJson(json: unknown, href: string): WorkdayCapture | null {
  const job = parseWorkdayJobUrl(href)
  const info = (json as { jobPostingInfo?: Record<string, unknown> } | null)?.jobPostingInfo
  if (!job || !info) return null
  const text = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')
  const title = text(info.title)
  if (!title) return null
  return {
    posting: { title, company: job.tenant, location: text(info.location) || null, url: job.normalizedUrl },
    reqId: text(info.jobReqId) || null,
  }
}

// The posting page's Apply control, on all 7 tenants rendered:
// <a role="button" data-automation-id="adventureButton" href=".../apply">.
export const WORKDAY_APPLY_CONTROL_SELECTOR = '[data-automation-id="adventureButton"]'

// The final Submit control, pinned by Ryan's observation of 2026-09-21
// (scripts/workday-observe.js PART A, on a second tenant; CLAUDE.md has the
// output). It is NOT a control of its own: the Review page's Submit button
// carries the same data-automation-id as every earlier step's Next button,
// and its only sibling is pageFooterBackButton. So the selector alone can't
// be the trigger — the page has to be the Review page too, which is what
// isFinalReviewStep below decides.
export const WORKDAY_SUBMIT_CONTROL_SELECTOR = '[data-automation-id="pageFooterNextButton"]'

// Two independent marks of the Review step, either of which is enough
// (decided 2026-09-21). The first is the page's own container; the second is
// the progress bar's active step reading "N of N".
const WORKDAY_REVIEW_PAGE_SELECTOR = '[data-automation-id="applyFlowReviewPage"]'
const WORKDAY_ACTIVE_STEP_SELECTOR = '[data-automation-id="progressBarActiveStep"]'
// The job's title on the Review page, sent with the submit message as a
// fallback for the background's job-JSON read.
const WORKDAY_REVIEW_TITLE_SELECTOR = '[data-automation-id="jobTitleHeading"]'

// "current step 8 of 8" -> true; "step 3 of 8" -> false. Read off the digits,
// never the words: the label is translated, the numerals mostly aren't. A
// label with fewer than two numbers, or one that doesn't end in a pair, is
// simply not a match.
function isLastStep(label: string): boolean {
  const numbers = label.match(/\d+/g)
  if (!numbers || numbers.length < 2) return false
  const [current, total] = numbers.slice(-2)
  return current === total
}

// Is this the application's final Review step? Either mark is accepted, so a
// rename of one doesn't stop a real application being logged; if Workday
// renames both, nothing logs, which is the failure this trades against
// logging on every Next click (CLAUDE.md, Site parsers, Workday).
export function isFinalReviewStep(root: ParentNode): boolean {
  if (root.querySelector(WORKDAY_REVIEW_PAGE_SELECTOR)) return true
  const step = root.querySelector(WORKDAY_ACTIVE_STEP_SELECTOR)
  if (!step) return false
  const label = `${step.getAttribute('aria-label') ?? ''} ${step.textContent ?? ''}`
  return isLastStep(label)
}

// The Review page's job title, for the background to fall back on if the job
// JSON can't be read. Empty when the heading isn't there.
export function reviewPageJobTitle(root: ParentNode): string {
  return collapsed(root.querySelector(WORKDAY_REVIEW_TITLE_SELECTOR))
}

export const workdayParser: JobPageParser = {
  siteId: 'workday',

  // Any page of a job's route: the posting and every application step.
  detect() {
    return parseWorkdayJobUrl(window.location.href) !== null
  },

  extract() {
    return captureFromPostingDom(document, window.location.href)?.posting ?? null
  },

  // The logging trigger, the final Submit click (decided 2026-09-14, pinned
  // 2026-09-21). The selector matches the footer's Next/Submit button on
  // every step; content/workday.ts logs only when isFinalReviewStep also
  // says the Review page is showing.
  getApplyButtonSelector() {
    return WORKDAY_SUBMIT_CONTROL_SELECTOR
  },
}

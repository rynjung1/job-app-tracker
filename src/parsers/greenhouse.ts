import type { JobPageParser, JobPostingData } from './types'

// {company}/jobs/{id} — confirmed via real fetches (Figma, PlanetScale) on
// job-boards.greenhouse.io. No container-class check, same reasoning as
// LinkedIn: nothing here has been checked for class-name stability, and
// the only call site (content script, gating the submit-button bind)
// fails safe with no container check.
const JOB_PAGE_PATH = /^\/[^/]+\/jobs\/\d+/

const TITLE_PREFIX = 'Job Application for '
const TITLE_COMPANY_SEPARATOR = ' at '

// document.title format confirmed live on two real, independently
// rendered postings: "Job Application for {Title} at {Company}". Anchored
// from the END (lastIndexOf) rather than the first " at ", since both
// confirmed real titles contained an em dash — proof titles carry
// arbitrary punctuation, and could plausibly contain the word "at" too.
// Same reasoning as LinkedIn's " | "-anchoring.
function parseDocumentTitle(): { title?: string; company?: string } {
  if (!document.title.startsWith(TITLE_PREFIX)) return {}
  const rest = document.title.slice(TITLE_PREFIX.length)
  const separatorIndex = rest.lastIndexOf(TITLE_COMPANY_SEPARATOR)
  if (separatorIndex === -1) return {}
  const title = rest.slice(0, separatorIndex).trim()
  const company = rest.slice(separatorIndex + TITLE_COMPANY_SEPARATOR.length).trim()
  return { title: title || undefined, company: company || undefined }
}

// Confirmed live on two real postings: og:description holds the location
// text, not a description — a Greenhouse-specific convention, not the
// standard meaning of that tag.
function readLocation(): string | null {
  const content = document
    .querySelector('meta[property="og:description"]')
    ?.getAttribute('content')
    ?.trim()
  return content || null
}

export const greenhouseParser: JobPageParser = {
  siteId: 'greenhouse',

  detect() {
    return JOB_PAGE_PATH.test(window.location.pathname)
  },

  extract() {
    const { title, company } = parseDocumentTitle()
    if (!title || !company) return null

    const data: JobPostingData = {
      title,
      company,
      location: readLocation(),
      url: window.location.href.split('?')[0],
    }
    return data
  },

  getApplyButtonSelector() {
    // Confirmed via real DOM inspection on two postings: the actual final
    // submission control is <button type="submit" ...>Submit application
    // </button> — genuinely distinct from the earlier "Apply" button that
    // just reveals the form (that one is type="button", not "submit").
    // Confirmed unique on both real postings (exactly 1 button[type=submit]
    // each, 0 input[type=submit]) — not just assumed.
    return 'button[type="submit"]'
  },
}

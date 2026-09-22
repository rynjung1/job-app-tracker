import type { JobPageParser, JobPostingData } from './types'

// Lever's own hosted job sites (2026-09-15). EU tenants live only on
// jobs.eu.lever.co: jobs.lever.co/{company} 404s for them. Boards embedded on
// a company's own domain link back here, so they're out of scope the same way
// custom-domain Greenhouse boards are.
export const LEVER_HOSTS = ['jobs.lever.co', 'jobs.eu.lever.co']

// The application form page, /{company}/{postingId}/apply: where the submit
// happens and where the fields are read, so the parser only looks at it.
const APPLY_PATH = /^\/([^/]+)\/([^/]+)\/apply\/?$/

// The trigger (decided by Ryan, 2026-09-15): the form's own submit event, not
// the visible button's click. Lever's inline script runs hCaptcha on that
// click and only then clicks a hidden type=submit button, precisely so the
// fields' `required` attributes are checked (its own comment says calling
// submit() directly would skip them). So the submit event fires only after
// hCaptcha and the browser's required-field checks pass, and an attempt the
// page rejects never reaches it. Not the /thanks page: a company can send
// candidates to its own success page instead ("Application Success Page URL"),
// and those applications would be lost with nothing to show for it.
export const LEVER_FORM_SELECTOR = 'form#application-form'

const TITLE_SEPARATOR = ' - '

// document.title is "{Company} - {Title}", confirmed on real postings. Split
// at the FIRST separator: job titles carry their own dashes ("Android
// Engineer - Experience"), company names rarely do. Both halves are trimmed,
// since one real posting's title had two spaces before the dash.
function parseTitle(documentTitle: string): { title?: string; company?: string } {
  const index = documentTitle.indexOf(TITLE_SEPARATOR)
  if (index === -1) return {}
  const company = documentTitle.slice(0, index).trim()
  const title = documentTitle.slice(index + TITLE_SEPARATOR.length).trim()
  return { title: title || undefined, company: company || undefined }
}

function readText(doc: Document, selector: string): string | null {
  const text = doc.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim()
  return text || null
}

export function isLeverApplyPage(href: string): boolean {
  const url = new URL(href)
  return LEVER_HOSTS.includes(url.hostname) && APPLY_PATH.test(url.pathname)
}

// Takes the document and the address, so fixtures can run it at any Lever
// address (the parser below passes the page's own).
export function extractLeverJob(doc: Document, href: string): JobPostingData | null {
  const url = new URL(href)
  const match = url.pathname.match(APPLY_PATH)
  if (!match || !LEVER_HOSTS.includes(url.hostname)) return null
  // The apply page's own header: the title in .posting-header h2 and the
  // location in .posting-categories .location, both read from a real
  // posting's apply page. (The posting page uses .posting-headline h2, which
  // the apply page doesn't have.) document.title is the fallback for the
  // title and the only source for the company: the apply page carries no
  // JSON-LD.
  const fromTitle = parseTitle(doc.title)
  const title = readText(doc, '.posting-header h2') ?? fromTitle.title
  const company = fromTitle.company
  if (!title || !company) return null

  return {
    title,
    company,
    location: readText(doc, '.posting-categories .location'),
    // The posting, not this form page: og:url here is the /apply address.
    url: `https://${url.hostname}/${match[1]}/${match[2]}`,
  }
}

export const leverParser: JobPageParser = {
  siteId: 'lever',

  detect() {
    return isLeverApplyPage(window.location.href)
  },

  extract() {
    return extractLeverJob(document, window.location.href)
  },

  getApplyButtonSelector() {
    // Part of the interface, not the trigger (LEVER_FORM_SELECTOR is, above).
    // The visible control is #btn-submit, a type="button"; a
    // button[type="submit"] selector would match only the hidden hCaptcha
    // button the user never clicks.
    return '#btn-submit'
  },
}

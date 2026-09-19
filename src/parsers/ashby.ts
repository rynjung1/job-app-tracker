import type { JobPageParser, JobPostingData } from './types'

// Ashby's hosted job boards (2026-09-15). Boards embedded on a company's own
// domain load this host in an iframe; the content script doesn't run in
// frames, so they're out of scope like the other ATSes' custom domains. A
// company can also turn its hosted board off, and then nothing is reachable.
export const ASHBY_HOST = 'jobs.ashbyhq.com'

// /{org}/{postingId}/application. Ashby is a React single-page app and the
// Overview and Application tabs are client-side routes, so the script is
// matched on the whole host and checks the path when the button is clicked.
const APPLICATION_PATH = /^\/([^/]+)\/([^/]+)\/application\/?$/

// The trigger (decided by Ryan, 2026-09-15): this button's click, with the
// background's 24-hour repeat skip. The page has no <form> and no type=submit
// element, and success only swaps in a container whose class comes from the
// same constants list as this button
// (ashby-application-form-success-container). Watching that class would stop
// logging silently if Ashby renamed it, while a row logged for an attempt
// Ashby then rejects is visible in the popup and can be cancelled.
export const ASHBY_SUBMIT_SELECTOR = '.ashby-application-form-submit-button'

const TITLE_SEPARATOR = ' @ '

// document.title is "{Title} @ {Company}". Only a fallback: the rendered page
// carries a second <title> element, so this is trusted less than the DOM
// below. Anchored from the end, since titles can contain "@".
function parseTitle(documentTitle: string): { title?: string; company?: string } {
  const index = documentTitle.lastIndexOf(TITLE_SEPARATOR)
  if (index === -1) return {}
  const title = documentTitle.slice(0, index).trim()
  const company = documentTitle.slice(index + TITLE_SEPARATOR.length).trim()
  return { title: title || undefined, company: company || undefined }
}

function readText(doc: Document, selector: string): string | null {
  const text = doc.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim()
  return text || null
}

// The left pane's "Location" section: an <h2> heading followed by a <p>.
// Ashby's own classes here are hashed per build, so the English heading text
// is what identifies it. A posting with several locations lists them in that
// one paragraph, separated by "; ".
function readLocation(doc: Document): string | null {
  const heading = [...doc.querySelectorAll('h2')].find((h2) => h2.textContent?.trim() === 'Location')
  const text = heading?.nextElementSibling?.textContent?.replace(/\s+/g, ' ').trim()
  return text || null
}

export function isAshbyApplicationPage(href: string): boolean {
  const url = new URL(href)
  return url.hostname === ASHBY_HOST && APPLICATION_PATH.test(url.pathname)
}

// Takes the document and the address, so fixtures can run it at any Ashby
// address (the parser below passes the page's own).
export function extractAshbyJob(doc: Document, href: string): JobPostingData | null {
  const url = new URL(href)
  const match = url.pathname.match(APPLICATION_PATH)
  if (!match || url.hostname !== ASHBY_HOST) return null
  const fromTitle = parseTitle(doc.title)
  // The heading and the header's logo alt, both read from a real posting's
  // application page; the title falls back to document.title, and the company
  // to its other half when a board has no logo image.
  const title = readText(doc, 'h1.ashby-job-posting-heading') ?? fromTitle.title
  const company =
    doc.querySelector('.ashby-job-posting-header img[alt]')?.getAttribute('alt')?.trim() || fromTitle.company
  if (!title || !company) return null

  // og:url is the posting's address, without /application.
  const canonical = doc.querySelector('meta[property="og:url"]')?.getAttribute('content')?.trim()
  return {
    title,
    company,
    location: readLocation(doc),
    url: canonical || `https://${ASHBY_HOST}/${match[1]}/${match[2]}`,
  }
}

export const ashbyParser: JobPageParser = {
  siteId: 'ashby',

  detect() {
    return isAshbyApplicationPage(window.location.href)
  },

  extract() {
    return extractAshbyJob(document, window.location.href)
  },

  getApplyButtonSelector() {
    return ASHBY_SUBMIT_SELECTOR
  },
}
